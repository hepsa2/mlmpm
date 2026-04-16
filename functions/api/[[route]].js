export async function onRequest(context) {
  const { request, env } = context;

  const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers: HEADERS });

  const url  = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');

  const ok  = (data)       => new Response(JSON.stringify(data), { headers: HEADERS });
  const err = (msg, s=400) => new Response(JSON.stringify({ error: msg }), { status: s, headers: HEADERS });

  try {

    // ── 顺带清理过期房间（每次请求执行，用 created_at 判断，无需额外字段）
    // Pages Functions 不支持 Cron，所以用请求触发代替定时任务
    // 三条语句都很轻量（索引扫描），对免费额度影响极小
    if (path !== '/cleanup') {
      const expireThreshold = Date.now() - 24 * 60 * 60 * 1000;
      await env.DB.prepare(
        'DELETE FROM messages WHERE room_id IN (SELECT id FROM rooms WHERE created_at < ?)'
      ).bind(expireThreshold).run();
      await env.DB.prepare(
        'DELETE FROM members WHERE room_id IN (SELECT id FROM rooms WHERE created_at < ?)'
      ).bind(expireThreshold).run();
      await env.DB.prepare(
        'DELETE FROM rooms WHERE created_at < ?'
      ).bind(expireThreshold).run();
    }

    // ── POST /api/create ────────────────────────────────────────
    if (path === '/create' && request.method === 'POST') {
      const { roomId, nickname } = await request.json();
      if (!/^[A-Za-z0-9]{8}$/.test(roomId)) return err('房间号必须是8位字母+数字组合');
      if (!nickname?.trim()) return err('昵称不能为空');

      const id   = roomId.toUpperCase();
      const nick = nickname.trim();

      const existing = await env.DB.prepare('SELECT id FROM rooms WHERE id = ?').bind(id).first();
      if (existing) return err('该房间号已被使用，请换一个');

      const hostToken   = crypto.randomUUID();
      const memberToken = crypto.randomUUID();
      const now = Date.now();

      await env.DB.prepare('INSERT INTO rooms (id, host, host_token, created_at) VALUES (?, ?, ?, ?)')
        .bind(id, nick, hostToken, now).run();
      await env.DB.prepare('INSERT INTO members (room_id, nickname, token, last_seen) VALUES (?, ?, ?, ?)')
        .bind(id, nick, memberToken, now).run();

      return ok({ roomId: id, nickname: nick, isHost: true, token: memberToken, hostToken });
    }

    // ── POST /api/join ──────────────────────────────────────────
    if (path === '/join' && request.method === 'POST') {
      const { roomId, nickname } = await request.json();
      if (!/^[A-Za-z0-9]{8}$/.test(roomId)) return err('房间号格式不正确');
      if (!nickname?.trim()) return err('昵称不能为空');

      const id   = roomId.toUpperCase();
      const nick = nickname.trim();
      const room = await env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first();
      if (!room) return err('房间不存在，请确认房间号');

      const memberToken = crypto.randomUUID();
      const now = Date.now();

      await env.DB.prepare(`
        INSERT INTO members (room_id, nickname, token, last_seen) VALUES (?, ?, ?, ?)
        ON CONFLICT(room_id, nickname) DO UPDATE SET token = excluded.token, last_seen = excluded.last_seen
      `).bind(id, nick, memberToken, now).run();

      const isHost = nick === room.host;
      return ok({
        roomId: id, nickname: nick, isHost,
        token: memberToken,
        hostToken: isHost ? room.host_token : undefined,
      });
    }

    // ── GET /api/state ──────────────────────────────────────────
    if (path === '/state' && request.method === 'GET') {
      const roomId   = url.searchParams.get('roomId');
      const nickname = decodeURIComponent(url.searchParams.get('nickname') || '');
      const token    = url.searchParams.get('token');

      const room = await env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first();
      if (!room) return err('房间不存在', 404);

      // 同时取 last_seen，心跳节流判断必须用到这个字段
      const member = await env.DB.prepare(
        'SELECT nickname, last_seen FROM members WHERE room_id = ? AND nickname = ? AND token = ?'
      ).bind(roomId, nickname, token).first();
      if (!member) return err('身份验证失败', 401);

      const now = Date.now();

      // 节流：30秒内不重复写入（必须 < 活跃窗口90秒，否则会误判离线）
      if (now - member.last_seen > 30000) {
        await env.DB.prepare(
          'UPDATE members SET last_seen = ? WHERE room_id = ? AND nickname = ?'
        ).bind(now, roomId, nickname).run();
      }

      // 活跃窗口：90秒内有心跳视为在线
      // 3秒轮询 + 30秒节流 → 最坏情况30秒才更新一次，90秒窗口留有足够余量
      const activeMembersResult = await env.DB.prepare(
        'SELECT nickname FROM members WHERE room_id = ? AND last_seen > ?'
      ).bind(roomId, now - 90000).all();

      // 全量消息（会议消息量有限，全量查询比增量更安全，避免置顶消息丢失）
      const messagesResult = await env.DB.prepare(
        'SELECT * FROM messages WHERE room_id = ? ORDER BY time ASC'
      ).bind(roomId).all();

      const requiredMembers = JSON.parse(room.required_members || '[]');
      const isRequired = requiredMembers.includes(nickname);

      let activeAnnouncement = null;
      if (room.announcement && room.announcement_time && now - room.announcement_time < 15000) {
        activeAnnouncement = room.announcement;
      }

      return ok({
        id: room.id,
        host: room.host,
        members: activeMembersResult.results.map(m => m.nickname),
        fileContent: room.file_content || null,
        fileName: room.file_name || null,
        pinnedMessageId: room.pinned_message_id || null,
        messages: messagesResult.results,
        isRequired,
        announcement: activeAnnouncement,
        announcementTime: room.announcement_time,
      });
    }

    // ── POST /api/message ───────────────────────────────────────
    if (path === '/message' && request.method === 'POST') {
      const { roomId, nickname, token, content } = await request.json();
      const room = await env.DB.prepare('SELECT host FROM rooms WHERE id = ?').bind(roomId).first();
      if (!room) return err('房间不存在', 404);

      const member = await env.DB.prepare(
        'SELECT nickname FROM members WHERE room_id = ? AND nickname = ? AND token = ?'
      ).bind(roomId, nickname, token).first();
      if (!member) return err('身份验证失败', 401);
      if (!content?.trim()) return err('消息不能为空');

      const msgId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO messages (id, room_id, nickname, content, is_host, time) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(msgId, roomId, nickname, content.trim(), nickname === room.host ? 1 : 0, Date.now()).run();

      return ok({ success: true, id: msgId });
    }

    // ── POST /api/upload-file ───────────────────────────────────
    if (path === '/upload-file' && request.method === 'POST') {
      const { roomId, nickname, hostToken, content, fileName } = await request.json();
      const room = await env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first();
      if (!room) return err('房间不存在', 404);
      if (room.host !== nickname || room.host_token !== hostToken) return err('权限不足', 403);

      await env.DB.prepare('UPDATE rooms SET file_content = ?, file_name = ? WHERE id = ?')
        .bind(content, fileName, roomId).run();
      return ok({ success: true });
    }

    // ── POST /api/pin ───────────────────────────────────────────
    if (path === '/pin' && request.method === 'POST') {
      const { roomId, nickname, hostToken, messageId } = await request.json();
      const room = await env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first();
      if (!room) return err('房间不存在', 404);
      if (room.host !== nickname || room.host_token !== hostToken) return err('权限不足', 403);

      await env.DB.prepare('UPDATE rooms SET pinned_message_id = ? WHERE id = ?')
        .bind(messageId, roomId).run();
      return ok({ success: true });
    }

    // ── POST /api/require-answer ────────────────────────────────
    if (path === '/require-answer' && request.method === 'POST') {
      const { roomId, nickname, hostToken, members } = await request.json();
      const room = await env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first();
      if (!room) return err('房间不存在', 404);
      if (room.host !== nickname || room.host_token !== hostToken) return err('权限不足', 403);

      await env.DB.prepare('UPDATE rooms SET required_members = ? WHERE id = ?')
        .bind(JSON.stringify(members), roomId).run();
      return ok({ success: true });
    }

    // ── POST /api/clear-required ────────────────────────────────
    if (path === '/clear-required' && request.method === 'POST') {
      const { roomId, nickname, token } = await request.json();
      const room = await env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first();
      if (!room) return err('房间不存在', 404);

      const member = await env.DB.prepare(
        'SELECT nickname FROM members WHERE room_id = ? AND nickname = ? AND token = ?'
      ).bind(roomId, nickname, token).first();
      if (!member) return err('身份验证失败', 401);

      const required = JSON.parse(room.required_members || '[]');
      const updated  = required.filter(m => m !== nickname);
      await env.DB.prepare('UPDATE rooms SET required_members = ? WHERE id = ?')
        .bind(JSON.stringify(updated), roomId).run();
      return ok({ success: true });
    }

    // ── POST /api/announcement ──────────────────────────────────
    if (path === '/announcement' && request.method === 'POST') {
      const { roomId, nickname, hostToken, content } = await request.json();
      const room = await env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first();
      if (!room) return err('房间不存在', 404);
      if (room.host !== nickname || room.host_token !== hostToken) return err('权限不足', 403);

      await env.DB.prepare('UPDATE rooms SET announcement = ?, announcement_time = ? WHERE id = ?')
        .bind(content, Date.now(), roomId).run();
      return ok({ success: true });
    }

    // ── POST /api/clear-messages ────────────────────────────────
    if (path === '/clear-messages' && request.method === 'POST') {
      const { roomId, nickname, hostToken } = await request.json();
      const room = await env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first();
      if (!room) return err('房间不存在', 404);
      if (room.host !== nickname || room.host_token !== hostToken) return err('权限不足', 403);

      await env.DB.prepare('DELETE FROM messages WHERE room_id = ?').bind(roomId).run();
      await env.DB.prepare('UPDATE rooms SET pinned_message_id = NULL WHERE id = ?').bind(roomId).run();
      return ok({ success: true });
    }

    // ── POST /api/dissolve ──────────────────────────────────────
    if (path === '/dissolve' && request.method === 'POST') {
      const { roomId, nickname, hostToken } = await request.json();
      const room = await env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first();
      if (!room) return err('房间不存在', 404);
      if (room.host !== nickname || room.host_token !== hostToken) return err('权限不足', 403);

      await env.DB.prepare('DELETE FROM messages WHERE room_id = ?').bind(roomId).run();
      await env.DB.prepare('DELETE FROM members  WHERE room_id = ?').bind(roomId).run();
      await env.DB.prepare('DELETE FROM rooms    WHERE id = ?').bind(roomId).run();
      return ok({ success: true });
    }

    // ── POST /api/cleanup （手动触发，同时也被每次请求顺带执行）──
    if (path === '/cleanup' && request.method === 'POST') {
      const expireThreshold = Date.now() - 24 * 60 * 60 * 1000;
      const expired = await env.DB.prepare(
        'SELECT id FROM rooms WHERE created_at < ?'
      ).bind(expireThreshold).all();
      await env.DB.prepare(
        'DELETE FROM messages WHERE room_id IN (SELECT id FROM rooms WHERE created_at < ?)'
      ).bind(expireThreshold).run();
      await env.DB.prepare(
        'DELETE FROM members WHERE room_id IN (SELECT id FROM rooms WHERE created_at < ?)'
      ).bind(expireThreshold).run();
      await env.DB.prepare(
        'DELETE FROM rooms WHERE created_at < ?'
      ).bind(expireThreshold).run();
      return ok({ success: true, message: '已清理过期会议室', cleanedCount: expired.results.length });
    }

    return new Response('Not Found', { status: 404, headers: HEADERS });

  } catch(e) {
    console.error(e);
    return new Response(JSON.stringify({ error: '服务器错误: ' + e.message }), { status: 500, headers: HEADERS });
  }
}

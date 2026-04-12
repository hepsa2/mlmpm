CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  host_token TEXT NOT NULL,
  file_content TEXT,
  file_name TEXT,
  pinned_message_id TEXT,
  required_members TEXT DEFAULT '[]',
  announcement TEXT,
  announcement_time INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  room_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  token TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (room_id, nickname)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  content TEXT NOT NULL,
  is_host INTEGER DEFAULT 0,
  time INTEGER NOT NULL
);

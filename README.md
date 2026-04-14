# 在线会议室
### 文件结构
```
your-repo/
├── schema.sql                    ← D1 数据库建表语句
├── functions/
│   └── api/
│       └── [[route]].js          ← 后端 API（Workers）
└── public/
    ├── index.html                ← 创建/加入房间
    ├── room.html                 ← 会议主界面
    └── host.html                 ← 主持人控制台
```
### 加密原理
```
创建房间
  └─ 浏览器生成随机 256 位密钥
  └─ 密钥放入 URL fragment：xxx.pages.dev/?room=ROOM1234#key=xxxxxxx
  └─ 主持人把这条链接分享给成员

成员加入
  └─ 访问链接，密钥自动从 #fragment 提取（不发送给服务器）
  └─ 进入 index.html 填昵称，点加入

发送消息 / 上传文件 / 发布通告
  └─ 浏览器用 AES-GCM 加密 → 密文存入 D1
  └─ 服务器只见到 "ENC:xxxx.yyyy" 格式的密文

收到数据
  └─ 浏览器用密钥解密 → 显示明文
  └─ 没有密钥的人看到 "🔒 [需要密钥才能查看]"
```
### 查看会议室数据是否清除 
```
SELECT * FROM rooms ORDER BY created_at DESC;
```

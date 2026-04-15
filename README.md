# 在线加密会议室
## 特点
- 全免费手机可部署
- 无需花钱租用服务器
- 采用AES-256加密
- 无语音功能，声纹无忧
- 支持.txt.md.pdf
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
### cloudflare端
分三大段把sql代码分三次上传cloudflareD1数据库,console页面
### cf的D1数据库
- 名称meeting-db
- 绑定时进入设置→functions,值写DB
### 注意
cloudflare必须识别仓库代码成pages而不是workers

pages才可绑定D1数据库。

为此可以先采用迷惑性手段，如先绑定不加js的html

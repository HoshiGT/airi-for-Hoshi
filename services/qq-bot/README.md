# `@proj-airi/qq-bot`

通过 NapCat（OneBot v11）让 Airi 接收并回复 QQ 消息。

## 前置条件

- NapCat 运行中，开启正向 WebSocket 服务（默认 `ws://localhost:3001`）
- Airi server 运行中（默认 `ws://localhost:6121/ws`）

## 配置

```shell
cd services/qq-bot
cp .env .env.local
```

编辑 `.env.local`：

```shell
NAPCAT_WS_URL='ws://localhost:3001'   # NapCat WS 地址
NAPCAT_HTTP_URL='http://localhost:3000' # NapCat HTTP API 地址
NAPCAT_TOKEN=''                         # NapCat access_token（没有留空）
QQ_BOT_UIN='123456789'                  # bot 自身的 QQ 号
AIRI_URL='ws://localhost:6121/ws'       # Airi server 地址
AIRI_TOKEN=''                           # Airi token
```

## 启动

```shell
pnpm run -F @proj-airi/qq-bot start
```

## 行为

- **私聊**：收到任意消息都回复
- **群聊**：仅在被 @ 时回复
- Session 隔离：私聊按用户、群聊按群分别维护独立上下文

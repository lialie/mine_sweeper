# MSN 双人踩雷夺旗 · Vercel + Redis 版

本版基于原 `msn-minesweeper-web-v2` 改造：保留静态界面与游戏规则，移除 `better-sqlite3`，改为 Redis 持久化；使用 Socket.IO Redis adapter 在不同 Vercel Function 实例间转发事件。

## 重要说明

- Vercel 的 WebSocket 支持于 2026-10 正式 GA；Socket.IO 客户端必须使用 `transports: ['websocket']`，不能使用默认的 polling-first 握手。
- 所有棋局状态存 Redis，不能依赖单个 Function 的内存。
- 使用 `@socket.io/redis-adapter` 通过 Redis Pub/Sub 跨实例广播。
- 房间更新使用 Redis 分布式锁，避免两个实例同时修改同一盘棋。
- 玩家在线状态用 Redis TTL 心跳维护；断线后 90 秒内过期，刷新/重连后会重新加入原房间。
- Vercel Function 达到最大执行时长时，WebSocket 会断开；前端会自动重连并重新加入房间。Redis 保证棋盘、分数、轮次和玩家 token 不因断线丢失。

## 1. 创建 Redis

建议用 Upstash Redis，创建数据库时选择靠近 Vercel Function 的区域。在 Upstash 控制台找到 **Redis protocol / ioredis** 连接串，格式通常如下：

```text
rediss://default:YOUR_PASSWORD@YOUR_HOST:6379
```

请使用 Redis TCP/TLS 连接串 `REDIS_URL`，不要把 `UPSTASH_REDIS_REST_URL`（HTTP REST 地址）直接填入 `REDIS_URL`；Socket.IO Redis adapter 需要 Redis Pub/Sub 协议。

在 Vercel 项目 `Settings → Environment Variables` 添加：

- `REDIS_URL` = 上面完整的 `rediss://...` 连接串
- `ROOM_TTL_DAYS` = `30`（可选；房间每次更新都会刷新过期时间）

将变量添加到 Production、Preview 和 Development 对应环境，然后重新部署。不要把 Redis 密码提交到 Git。

## 2. 推送 GitHub

在项目根目录执行：

```bash
git init
git add .
git commit -m "Deploy MSN Minesweeper on Vercel with Redis"
```

创建 GitHub 仓库后按 GitHub 页面提示添加 remote 并 push。不要提交 `.env`、Redis 密码或 `node_modules`。

建议 `.gitignore` 至少包含：

```gitignore
node_modules/
.env
.env.local
.vercel/
*.log
```

## 3. 导入 Vercel

1. 打开 https://vercel.com/new 并导入 GitHub 仓库。
2. 使用 Node.js 22.x；`package.json` 已指定 `engines.node`。
3. Framework Preset 选择自动检测 / Other（若 Vercel 检测到 Express，则保持 Express 配置）。
4. Build Command 不需要；Install Command 使用默认 `npm install`；Output Directory 留空，不要只发布 `public`，因为后端 Socket.IO 也需要部署。
5. 在项目 Settings 配置 `REDIS_URL`，然后部署。

项目入口 `index.js` 导出 `server.js` 中创建的 HTTP Server。`server.js` 在 Vercel 导入时不会调用 `listen()`；本地 `npm start` 才会监听端口。

## 4. 本地运行和验证

需要 Node.js 22、npm，以及可连接的 Redis。可用 Docker 启动本地 Redis：

```bash
docker run --rm --name msn-redis -p 6379:6379 redis:7-alpine
```

另开终端执行：

```bash
cd msn-minesweeper-vercel
npm install
REDIS_URL=redis://127.0.0.1:6379 npm start
```

访问 http://localhost:3000 。两个浏览器分别创建/加入房间。健康检查：

```bash
curl -i http://localhost:3000/health
```

预期 JSON 中包含 `"ok":true` 和 `"redis":"ok"`。

本地语法检查：

```bash
npm run check
```

## 5. 部署后测试清单

1. 打开 `https://你的项目.vercel.app/health`，应返回 HTTP 200 和 `ok: true`。
2. 两个不同浏览器/设备打开主页，玩家 A 创建房间，玩家 B 通过房间码加入。
3. 翻格后两边棋盘、分数和回合应同步。
4. 刷新一边页面，应该自动恢复原玩家身份和房间。
5. 暂时断开一边网络，再恢复；90 秒 TTL 内会通过心跳/重新加入恢复在线状态。若离线超过 TTL，重连仍能恢复棋盘，但对手在线状态可能短暂显示断线，直到其重新连接。
6. 在 Vercel Logs 检查 `[redis] connected; Socket.IO Redis adapter enabled`，并确认没有 `NOAUTH`、TLS 或连接超时错误。

## 环境变量

| 变量 | 必需 | 用途 |
|---|---|---|
| `REDIS_URL` | 是 | Redis TCP/TLS 连接串，供持久化、分布式锁、Pub/Sub 使用 |
| `ROOM_TTL_DAYS` | 否 | 房间无更新后 Redis 自动过期天数，默认 30 |
| `PORT` | 本地可选 | 本地服务端口，默认 3000 |

## 设计边界与排障

- 此版需要支持 WebSocket 的 Vercel Functions/Fluid Compute 环境；客户端禁用了 polling fallback，这是为了避免多实例路由下的 Socket.IO polling session 问题。
- Redis adapter 负责跨实例实时广播；Redis JSON key 保存权威棋局状态；分布式锁负责串行化同一房间内的操作。
- 如果 `/health` 返回 503，先检查 `REDIS_URL` 是否存在、是否为 Redis 协议连接串，以及 Redis 密码、TLS 和网络访问设置。
- 如果页面能打开但 Socket.IO 连接失败，检查 Vercel 日志、WebSocket 支持/Fluid Compute 设置，以及浏览器开发者工具 Network → WS。
- 如果连接正常但不同玩家不能同步，检查 Redis adapter 连接和 Pub/Sub 权限。
- 生产使用前建议加上 Redis 连接限流、房间创建限速和更严格的房间码防猜测措施。

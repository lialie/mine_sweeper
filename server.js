'use strict';

const express = require('express');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const helmet = require('helmet');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');

const ROWS = 16, COLS = 16, MINES = 51, TARGET = 26;
const ROOM_TTL_SECONDS = Math.max(86400, Number(process.env.ROOM_TTL_DAYS || 30) * 86400);
const PRESENCE_TTL_SECONDS = 90;
const LOCK_TTL_MS = 10000;
const LOCK_RETRIES = 60;
const REDIS_URL = process.env.REDIS_URL;

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1h' }));

const server = http.createServer(app);
const io = new Server(server, {
  // Vercel functions do not guarantee sticky routing for Socket.IO polling.
  // The browser therefore forces WebSocket transport in public/app.js.
  pingInterval: 25000,
  pingTimeout: 60000,
  connectTimeout: 20000,
  maxHttpBufferSize: 1e5,
  transports: ['websocket']
});

let redis = null;
let pubClient = null;
let subClient = null;
let redisReady = null;
if (REDIS_URL) {
  const options = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy(times) { return Math.min(times * 250, 3000); }
  };
  redis = new Redis(REDIS_URL, options);
  pubClient = new Redis(REDIS_URL, options);
  subClient = new Redis(REDIS_URL, options);
  redis.on('error', err => console.error('[redis:command]', err.message));
  pubClient.on('error', err => console.error('[redis:pub]', err.message));
  subClient.on('error', err => console.error('[redis:sub]', err.message));
}

async function ensureRedis() {
  if (!REDIS_URL || !redis || !pubClient || !subClient) {
    throw new Error('缺少 REDIS_URL 环境变量；请在 Vercel 项目设置中配置 Redis 连接串。');
  }
  if (!redisReady) {
    redisReady = Promise.all([redis.ping(), pubClient.ping(), subClient.ping()])
      .then(() => {
        io.adapter(createAdapter(pubClient, subClient));
        console.log('[redis] connected; Socket.IO Redis adapter enabled');
      })
      .catch(err => {
        redisReady = null;
        throw err;
      });
  }
  await redisReady;
}

io.use((socket, next) => {
  ensureRedis().then(() => next()).catch(err => {
    console.error('[socket middleware]', err.message);
    next(new Error('实时服务暂不可用，请稍后重试。'));
  });
});

app.get('/health', async (_req, res) => {
  try {
    await ensureRedis();
    await redis.ping();
    res.status(200).json({ ok: true, redis: 'ok', time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message, time: new Date().toISOString() });
  }
});

const now = () => Date.now();
const randomHex = n => crypto.randomBytes(n).toString('hex');
const newToken = () => randomHex(32);
const cleanRoom = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const cleanName = v => String(v || '玩家').trim().replace(/[<>]/g, '').slice(0, 18) || '玩家';
const validToken = v => typeof v === 'string' && /^[a-f0-9]{48,128}$/i.test(v);
const safeInt = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
const gameKey = room => `msnflags:game:${room}`;
const lockKey = room => `msnflags:lock:${room}`;
const presenceKey = (room, index) => `msnflags:presence:${room}:${index}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const RELEASE_LOCK_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const CLEAR_PRESENCE_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const REFRESH_PRESENCE_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end";

async function withRoomLock(room, work) {
  await ensureRedis();
  const key = lockKey(room), lockToken = randomHex(16);
  let acquired = false;
  for (let i = 0; i < LOCK_RETRIES; i++) {
    if (await redis.set(key, lockToken, 'PX', LOCK_TTL_MS, 'NX') === 'OK') {
      acquired = true;
      break;
    }
    await sleep(35 + Math.floor(Math.random() * 25));
  }
  if (!acquired) throw new Error('房间正在处理其他操作，请稍后重试。');
  try {
    return await work();
  } finally {
    try { await redis.eval(RELEASE_LOCK_LUA, 1, key, lockToken); }
    catch (err) { console.error('[redis lock release]', err.message); }
  }
}

function generateBoard() {
  const board = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => ({ mine: false, n: 0, open: false, by: null })));
  let placed = 0;
  while (placed < MINES) {
    const r = crypto.randomInt(ROWS), c = crypto.randomInt(COLS);
    if (!board[r][c].mine) { board[r][c].mine = true; placed++; }
  }
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (board[r][c].mine) continue;
    let count = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if ((dr || dc) && board[r + dr]?.[c + dc]?.mine) count++;
    }
    board[r][c].n = count;
  }
  return board;
}
function newGame(room) {
  return {
    room, rows: ROWS, cols: COLS, mines: MINES, target: TARGET,
    board: generateBoard(), players: [], turn: 0, status: 'waiting', winner: null,
    moves: 0, createdAt: now(), updatedAt: now(), version: 1
  };
}
async function loadGame(room) {
  const raw = await redis.get(gameKey(room));
  if (!raw) return null;
  try {
    const g = JSON.parse(raw);
    if (!g || g.room !== room || !Array.isArray(g.board) || !Array.isArray(g.players)) return null;
    for (const p of g.players) if (typeof p.socketId !== 'string') p.socketId = null;
    return g;
  } catch (err) {
    console.error('[game JSON parse]', room, err.message);
    return null;
  }
}
async function getGame(room) {
  return (await loadGame(room)) || newGame(room);
}
async function persist(g) {
  g.updatedAt = now();
  await redis.set(gameKey(g.room), JSON.stringify(g), 'EX', ROOM_TTL_SECONDS);
}
function playerIndex(g, token) { return g.players.findIndex(p => p.token === token); }
async function isOnline(g, index) {
  const p = g.players[index];
  if (!p || !p.socketId) return false;
  return (await redis.get(presenceKey(g.room, index))) === p.socketId;
}
async function publicState(g, token) {
  const you = playerIndex(g, token);
  const connected = await Promise.all(g.players.map((_p, i) => isOnline(g, i)));
  return {
    room: g.room, rows: g.rows, cols: g.cols, mines: g.mines, target: g.target,
    status: g.status, turn: g.turn, winner: g.winner, moves: g.moves,
    version: g.version, you,
    players: g.players.map((p, index) => ({
      name: p.name, connected: Boolean(connected[index]), index,
      score: p.score || 0, bombUsed: Boolean(p.bombUsed)
    })),
    board: g.board.map(row => row.map(cell => ({
      open: cell.open,
      mine: cell.open && cell.mine,
      n: cell.open && !cell.mine ? cell.n : null,
      by: cell.open ? cell.by : null
    })))
  };
}
async function saveAndBroadcast(g) {
  await persist(g);
  for (const p of g.players) {
    if (!p.socketId) continue;
    const index = playerIndex(g, p.token);
    if (index < 0 || !(await isOnline(g, index))) continue;
    io.to(p.socketId).emit('state', await publicState(g, p.token));
  }
}
function sendNotice(g, message, type = 'info') {
  for (const p of g.players) if (p.socketId) io.to(p.socketId).emit('notice', { message, type });
}
function fail(socket, message) { socket.emit('notice', { type: 'error', message }); }
function finish(g, winner) { g.status = 'finished'; g.winner = winner; g.version++; g.updatedAt = now(); }
function countUnopenedMines(g) { return g.board.flat().filter(c => c.mine && !c.open).length; }
function revealArea(g, r, c, radius, player) {
  let captured = 0;
  const r0 = Math.max(0, r - radius), r1 = Math.min(ROWS - 1, r + radius);
  const c0 = Math.max(0, c - radius), c1 = Math.min(COLS - 1, c + radius);
  for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) {
    const cell = g.board[y][x];
    if (cell.open) continue;
    cell.open = true; cell.by = player;
    if (cell.mine) { g.players[player].score++; captured++; }
  }
  return captured;
}
function floodReveal(g, startR, startC, player) {
  const queue = [[startR, startC]], seen = new Set();
  while (queue.length) {
    const [r, c] = queue.shift(), key = `${r},${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cell = g.board[r]?.[c];
    if (!cell || cell.mine) continue;
    if (!cell.open) { cell.open = true; cell.by = player; }
    if (cell.n === 0) {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc, next = g.board[nr]?.[nc];
        if (next && !next.open && !next.mine && !seen.has(`${nr},${nc}`)) queue.push([nr, nc]);
      }
    }
  }
}
function checkWinner(g, player) {
  if (g.players[player].score >= TARGET) { finish(g, player); return true; }
  if (countUnopenedMines(g) === 0) {
    const a = g.players[0].score, b = g.players[1].score;
    finish(g, a === b ? null : (a > b ? 0 : 1));
    return true;
  }
  return false;
}
async function currentPlayer(socket) {
  const room = socket.data.room, token = socket.data.token;
  if (!room || !validToken(token)) return { error: '请先加入房间。' };
  const g = await loadGame(room);
  if (!g) return { error: '房间不存在或已过期，请重新加入。' };
  const index = playerIndex(g, token);
  if (index < 0 || g.players[index].socketId !== socket.id) return { error: '玩家身份已失效，请重新连接房间。' };
  if (!(await isOnline(g, index))) return { error: '连接状态已过期，请等待自动重连。' };
  if (g.status !== 'playing') return { error: g.status === 'finished' ? '本局已经结束。' : '等待另一位玩家加入。' };
  if (g.players.length !== 2) return { error: '等待另一位玩家加入。' };
  const online = await Promise.all(g.players.map((_p, i) => isOnline(g, i)));
  if (online.some(v => !v)) return { error: '对手暂时断线，等待对手重连后继续。' };
  if (g.turn !== index) return { error: '现在不是你的回合。' };
  return { g, index };
}
async function runRoomEvent(socket, work) {
  try {
    const room = socket.data && socket.data.room;
    if (!room) return fail(socket, '请先加入房间。');
    await withRoomLock(room, async () => work(room));
  } catch (err) {
    console.error('[socket event]', err.stack || err.message || err);
    fail(socket, err.message || '服务器暂时无法处理请求，请重试。');
  }
}

io.on('connection', socket => {
  socket.on('join', (payload = {}) => {
    const room = cleanRoom(payload.room);
    const token = String(payload.token || '');
    const name = cleanName(payload.name);
    if (room.length < 4) return fail(socket, '房间码至少需要 4 位。');
    if (!validToken(token)) return fail(socket, '游客身份凭证无效，请刷新页面重试。');
    withRoomLock(room, async () => {
      const g = await getGame(room);
      let index = playerIndex(g, token);
      if (index < 0) {
        if (g.status === 'finished') return fail(socket, '本房间已经结束，请创建新房间开始下一局。');
        if (g.players.length >= 2) return fail(socket, '房间已满。请使用原浏览器保存的游客身份加入。');
        index = g.players.length;
        g.players.push({ token, name, score: 0, bombUsed: false, socketId: null });
      }
      const p = g.players[index];
      if (p.socketId && p.socketId !== socket.id) io.to(p.socketId).emit('session-replaced');
      p.name = name;
      p.socketId = socket.id;
      socket.data = { room, token };
      socket.join(room);
      await redis.set(presenceKey(room, index), socket.id, 'EX', PRESENCE_TTL_SECONDS);
      if (g.players.length === 2 && g.status === 'waiting') {
        g.status = 'playing';
        g.version++;
        sendNotice(g, '两位玩家已就位，游戏开始！');
      }
      socket.emit('joined', { room, playerIndex: index });
      await saveAndBroadcast(g);
    }).catch(err => {
      console.error('[join]', err.stack || err.message || err);
      fail(socket, err.message || '加入房间失败，请重试。');
    });
  });

  socket.on('presence', async () => {
    try {
      const { room, token } = socket.data || {};
      if (!room || !validToken(token)) return;
      const g = await loadGame(room);
      if (!g) return;
      const index = playerIndex(g, token);
      if (index < 0 || g.players[index].socketId !== socket.id) return;
      await redis.eval(REFRESH_PRESENCE_LUA, 1, presenceKey(room, index), socket.id, PRESENCE_TTL_SECONDS);
    } catch (err) { console.error('[presence]', err.message); }
  });

  socket.on('reveal', payload => runRoomEvent(socket, async room => {
    const g = await loadGame(room);
    if (!g) return fail(socket, '房间不存在或已过期。');
    const auth = await currentPlayer(socket);
    if (auth.error) { fail(socket, auth.error); await saveAndBroadcast(g); return; }
    const current = auth.g;
    const { index } = auth;
    const r = Number(payload?.r), c = Number(payload?.c);
    if (!safeInt(r, 0, ROWS - 1) || !safeInt(c, 0, COLS - 1)) return fail(socket, '棋盘坐标无效。');
    const cell = current.board[r][c];
    if (cell.open) return fail(socket, '这个格子已经翻开。');
    current.moves++;
    current.version++;
    if (cell.mine) {
      cell.open = true; cell.by = index;
      current.players[index].score++;
      if (!checkWinner(current, index)) sendNotice(current, `${current.players[index].name} 找到一颗地雷！继续行动。`);
      else sendNotice(current, current.winner === null ? '所有地雷已找到，平局！' : `${current.players[current.winner].name} 获胜！`);
    } else {
      cell.open = true; cell.by = index;
      if (cell.n === 0) floodReveal(current, r, c, index);
      if (!checkWinner(current, index)) current.turn = 1 - index;
      else sendNotice(current, current.winner === null ? '所有地雷已找到，平局！' : `${current.players[current.winner].name} 获胜！`);
    }
    await saveAndBroadcast(current);
  }));

  socket.on('bomb', payload => runRoomEvent(socket, async room => {
    const auth = await currentPlayer(socket);
    if (auth.error) return fail(socket, auth.error);
    const { g, index } = auth;
    const r = Number(payload?.r), c = Number(payload?.c);
    if (!safeInt(r, 0, ROWS - 1) || !safeInt(c, 0, COLS - 1)) return fail(socket, '炸弹中心坐标无效。');
    if (g.players[index].bombUsed) return fail(socket, '你已经使用过本局炸弹。');
    if (g.players[index].score >= g.players[1 - index].score) return fail(socket, '只有落后时才能使用炸弹。');
    g.players[index].bombUsed = true;
    g.moves++;
    const captured = revealArea(g, r, c, 2, index);
    g.version++;
    if (!checkWinner(g, index)) {
      g.turn = 1 - index;
      sendNotice(g, `${g.players[index].name} 使用炸弹，夺得 ${captured} 颗地雷。`);
    } else sendNotice(g, g.winner === null ? '所有地雷已找到，平局！' : `${g.players[g.winner].name} 获胜！`);
    await saveAndBroadcast(g);
  }));

  socket.on('new-round', () => runRoomEvent(socket, async room => {
    const old = await loadGame(room);
    const token = socket.data?.token;
    if (!old || playerIndex(old, token) !== 0 || old.players[0].socketId !== socket.id) return fail(socket, '只有房主可以开始新一局。');
    if (old.status !== 'finished') return fail(socket, '当前对局尚未结束。');
    const online = await Promise.all(old.players.map((_p, i) => isOnline(old, i)));
    if (old.players.length !== 2 || online.some(v => !v)) return fail(socket, '需要两位玩家都在线才能开始新一局。');
    const players = old.players.map(p => ({ ...p, score: 0, bombUsed: false }));
    const g = newGame(room);
    g.players = players;
    g.status = 'playing';
    g.turn = 0;
    g.version = old.version + 1;
    sendNotice(g, '新一局开始！');
    await saveAndBroadcast(g);
  }));

  socket.on('disconnect', () => {
    const { room, token } = socket.data || {};
    if (!room || !validToken(token)) return;
    withRoomLock(room, async () => {
      const g = await loadGame(room);
      if (!g) return;
      const index = playerIndex(g, token);
      // A replaced/stale socket must not disconnect the newer session.
      if (index >= 0 && g.players[index].socketId === socket.id) {
        await redis.eval(CLEAR_PRESENCE_LUA, 1, presenceKey(room, index), socket.id);
        g.players[index].socketId = null;
        g.version++;
        sendNotice(g, `${g.players[index].name} 已断线，棋局暂停，等待重连。`);
        await saveAndBroadcast(g);
      }
    }).catch(err => console.error('[disconnect]', err.message));
  });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => console.log(`Minesweeper Flags listening on 0.0.0.0:${port}`));
}

// Vercel's Express/Node entrypoint imports the HTTP server; do not call listen there.
module.exports = server;

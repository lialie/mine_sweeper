(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const TOKEN_KEY = 'msn-flags-guest-token-v2';
  const ROOM_KEY = 'msn-flags-last-room-v2';
  const NAME_KEY = 'msn-flags-guest-name-v2';
  const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.35,
    timeout: 20000,
    transports: ['websocket']
  });
  function makeToken() {
    const bytes = new Uint8Array(32);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i=0;i<bytes.length;i++) bytes[i]=Math.floor(Math.random()*256);
    return Array.from(bytes, b=>b.toString(16).padStart(2,'0')).join('');
  }
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    token = makeToken();
    localStorage.setItem(TOKEN_KEY, token);
  }
  let room = localStorage.getItem(ROOM_KEY) || '';
  let state = null;
  let bombMode = false;
  let joinRequested = false;
  const connection = $('connection');
  $('name').value = localStorage.getItem(NAME_KEY) || '玩家';

  function setConnection(status, message) {
    connection.className = 'connection ' + status;
    connection.lastChild && (connection.lastChild.textContent = message);
    if (!connection.lastChild || connection.lastChild.nodeType !== Node.TEXT_NODE) {
      connection.textContent = message;
      const dot = document.createElement('i');
      connection.prepend(dot);
    }
  }
  function setMessage(message, error=false) {
    const el = $('game').classList.contains('hidden') ? $('lobbyMsg') : $('gameMsg');
    el.textContent = message || '';
    el.style.color = error ? '#bf4e55' : '#398367';
  }
  function persistIdentity() {
    localStorage.setItem(TOKEN_KEY, token);
    if (room) localStorage.setItem(ROOM_KEY, room);
    localStorage.setItem(NAME_KEY, $('name').value.trim() || '玩家');
  }
  function joinRoom(code, automatic=false) {
    const cleaned = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0,8);
    if (cleaned.length < 4) { setMessage('请输入至少 4 位房间码。', true); return; }
    room = cleaned;
    persistIdentity();
    if (!socket.connected) {
      if (!automatic) setMessage('网络正在恢复，连接成功后会自动加入房间。');
      return;
    }
    joinRequested = true;
    socket.emit('join', { room, token, name: $('name').value.trim() || '玩家' });
  }

  socket.on('connect', () => {
    setConnection('online', '已连接');
    if (room) joinRoom(room, true);
  });
  socket.on('disconnect', () => setConnection('offline', '连接中断，自动重连中…'));
  socket.on('connect_error', () => setConnection('offline', '连接失败，正在重试…'));
  socket.io.on('reconnect_attempt', () => setConnection('offline', '正在恢复连接…'));
  socket.on('joined', data => {
    room = data.room;
    persistIdentity();
    $('roomCode').textContent = room;
    $('lobby').classList.add('hidden');
    $('game').classList.remove('hidden');
    $('lobbyMsg').textContent = '';
    setMessage('');
  });
  socket.on('state', incoming => {
    // Ignore stale state packets if a newer version has already been rendered.
    if (state && incoming.room === state.room && incoming.version < state.version) return;
    state = incoming;
    render(incoming);
  });
  socket.on('notice', n => setMessage(n.message || '', n.type === 'error'));
  socket.on('session-replaced', () => {
    setConnection('offline', '此身份已在另一连接中使用');
    setMessage('同一游客身份已在另一连接中接管。如果这是你自己的新标签页，可继续使用当前页面。', true);
  });
  socket.on('connect', () => { joinRequested = false; });
  // Redis presence expires after 90 seconds; renew it while this tab is connected.
  window.setInterval(() => { if (socket.connected) socket.emit('presence'); }, 20000);

  $('create').addEventListener('click', () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i=0;i<6;i++) code += chars[crypto.getRandomValues(new Uint8Array(1))[0] % chars.length];
    $('roomInput').value = code;
    joinRoom(code);
  });
  $('join').addEventListener('click', () => joinRoom($('roomInput').value));
  $('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('roomInput').value); });
  $('name').addEventListener('change', () => {
    persistIdentity();
    if (room && socket.connected) joinRoom(room, true);
  });
  $('copy').addEventListener('click', async () => {
    const invite = `${location.origin}/?room=${room}`;
    try {
      await navigator.clipboard.writeText(invite);
      setMessage('邀请链接已复制，发给朋友即可加入。');
    } catch {
      setMessage(`请分享网址 ${invite}，并告知房间码 ${room}`);
    }
  });
  $('bombMode').addEventListener('click', () => {
    if (!state) return;
    bombMode = !bombMode;
    $('bombMode').textContent = bombMode ? '取消选择炸弹' : '选择炸弹中心';
    $('bombHint').textContent = bombMode ? '现在点击棋盘中的中心格。' : '仅在分数落后时可用。';
    $('board').classList.toggle('bomb-select', bombMode);
    render(state);
  });
  $('newRound').addEventListener('click', () => socket.emit('new-round'));

  function canAct(s) {
    return s.status === 'playing' && s.you === s.turn &&
      s.players.length === 2 && s.players.every(p => p.connected);
  }
  function render(s) {
    $('roomCode').textContent = s.room;
    for (let i=0;i<2;i++) {
      const p=s.players[i];
      $(`name${i}`).textContent = p ? p.name : (i===0?'蓝方':'红方');
      $(`score${i}`).textContent = p ? String(p.score).padStart(2,'0') : '00';
      $(`online${i}`).textContent = !p ? '等待加入' : (p.connected ? (s.status==='playing' && s.turn===i ? '正在行动' : '在线') : '断线，等待重连');
      $(`p${i}`).classList.toggle('active', Boolean(p && s.status==='playing' && s.turn===i));
    }
    const headline=$('headline'), sub=$('subline'), badge=$('turnBadge');
    if (s.status === 'waiting') {
      headline.textContent='等待朋友加入'; sub.textContent='分享房间码，对方加入后自动开始。';
      badge.textContent='等待开始'; badge.className='turn-badge wait';
    } else if (s.status === 'finished') {
      headline.textContent=s.winner===null?'本局平局':(s.winner===s.you?'你赢了！':`${s.players[s.winner]?.name || '对手'} 获胜`);
      sub.textContent=`最终比分 ${s.players[0]?.score ?? 0} : ${s.players[1]?.score ?? 0}`;
      badge.textContent='本局结束'; badge.className='turn-badge';
    } else {
      const online=s.players.length===2 && s.players.every(p=>p.connected);
      headline.textContent=!online?'等待对手重连':(s.turn===s.you?'轮到你行动':'等待对手行动');
      sub.textContent=s.turn===s.you?'找到地雷得分并继续；数字格会交换回合。':`${s.players[s.turn]?.name || '对手'} 正在寻找地雷。`;
      badge.textContent=!online?'棋局已暂停':(s.turn===s.you?'你的回合':'对手的回合');
      badge.className='turn-badge '+(!online?'wait':(s.turn===s.you?'my-turn':''));
    }
    const mineScore=s.players[s.you]?.score ?? 0, otherScore=s.players[1-s.you]?.score ?? 0;
    const bombAvailable=canAct(s) && mineScore<otherScore && !s.players[s.you]?.bombUsed;
    $('bombMode').disabled=!bombAvailable;
    if (!bombAvailable && bombMode) {
      bombMode=false; $('board').classList.remove('bomb-select'); $('bombMode').textContent='选择炸弹中心';
    }
    $('bombHint').textContent=s.players[s.you]?.bombUsed?'本局炸弹已使用。':(mineScore<otherScore?'你正在落后，可以使用一次炸弹。':'只有分数落后时可用。');
    $('newRound').classList.toggle('hidden', !(s.status==='finished' && s.you===0));
    const board=$('board'); board.innerHTML='';
    s.board.forEach((row,r)=>row.forEach((cell,c)=>{
      const b=document.createElement('button');
      b.type='button'; b.className='cell';
      const actionAllowed=canAct(s);
      b.disabled=!actionAllowed || (cell.open && !bombMode);
      if (cell.open) {
        b.classList.add('open');
        if (cell.mine) {
          b.classList.add('mine', cell.by===0?'blue':'red');
          b.textContent='✹';
          b.title=cell.by===null?'地雷':`${s.players[cell.by]?.name || '玩家'} 获得地雷`;
        } else if (cell.n>0) {
          b.textContent=cell.n;
          b.classList.add('n'+cell.n);
        }
      } else {
        b.setAttribute('aria-label', `第 ${r+1} 行第 ${c+1} 列，未翻开`);
        if (bombMode && actionAllowed) b.classList.add('bomb-target');
      }
      b.addEventListener('click', () => {
        if (!actionAllowed || cell.open) return;
        if (bombMode) {
          socket.emit('bomb', {r,c});
          bombMode=false; $('board').classList.remove('bomb-select');
          $('bombMode').textContent='选择炸弹中心';
        } else socket.emit('reveal', {r,c});
      });
      board.appendChild(b);
    }));
  }

  // Restore room from an invite URL first, otherwise from the last-used room in localStorage.
  const url = new URL(location.href);
  const queryRoom = url.searchParams.get('room');
  if (queryRoom) {
    room = queryRoom.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);
    $('roomInput').value = room;
    history.replaceState({}, '', location.pathname);
  } else if (room) $('roomInput').value = room;
  if (room) {
    // If socket is not connected yet, connect handler will perform the join.
    if (socket.connected) joinRoom(room, true);
  }
})();
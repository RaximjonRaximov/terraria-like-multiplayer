/* global io */

const TILE_SIZE = 32;
const CHUNK_W = 64;
const CHUNK_H = 64;

const T = {
  AIR: 0,
  GROUND: 1,
  BRICK: 2,
  PLATFORM: 3,
  PIPE: 4,
  SPIKE: 5,
  SWITCH: 6,
  GATE: 7,
  POLE: 8,
  FLAG: 9
};

const BIOME_SKY = {
  grass: ['#60a5fa', '#e0f2fe'],
  desert: ['#38bdf8', '#fde68a'],
  snow: ['#94a3b8', '#f1f5f9'],
  cave: ['#1e1b4b', '#312e81'],
  forest: ['#166534', '#dcfce7']
};

const BIOME_GROUND = {
  grass: { top: '#4ade80', body: '#5d4037' },
  desert: { top: '#fcd34d', body: '#d97706' },
  snow: { top: '#f8fafc', body: '#94a3b8' },
  cave: { top: '#475569', body: '#1e293b' },
  forest: { top: '#22c55e', body: '#3f2e18' }
};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const screens = {
  lobby: document.getElementById('lobby'),
  room: document.getElementById('room'),
  game: document.getElementById('game')
};
const ui = {
  rooms: document.getElementById('rooms'),
  roomId: document.getElementById('room-id'),
  roomPlayers: document.getElementById('room-players'),
  btnStart: document.getElementById('btn-start'),
  btnCreate: document.getElementById('btn-create'),
  btnJoin: document.getElementById('btn-join'),
  btnLeave: document.getElementById('btn-leave'),
  inputName: document.getElementById('player-name'),
  inputCode: document.getElementById('room-code'),
  hudCoins: document.getElementById('hud-coins'),
  hudScore: document.getElementById('hud-score'),
  hudMission: document.getElementById('hud-mission'),
  hudBiome: document.getElementById('hud-biome'),
  health: document.getElementById('health'),
  players: document.getElementById('players'),
  banner: document.getElementById('banner')
};

const socket = io();
const input = { left: false, right: false, jump: false };
const state = {
  me: null,
  chunks: new Map(),
  players: new Map(),
  entities: new Map(),
  camera: { x: 0, y: 0, targetX: 0, targetY: 0 },
  mission: null,
  biome: 'grass',
  connected: false,
  inGame: false,
  role: null,
  roomId: null,
  frame: 0
};

let assets = {};

class Sprite {
  constructor(img, frameSize, cols, rows, frames) {
    this.img = img;
    this.frameSize = frameSize;
    this.cols = cols;
    this.rows = rows;
    this.frames = frames;
  }
  draw(ctx, x, y, w, h, frame, flip) {
    const f = frame % this.frames;
    const sx = (f % this.cols) * this.frameSize;
    const sy = Math.floor(f / this.cols) * this.frameSize;
    ctx.save();
    if (flip) {
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(this.img, sx, sy, this.frameSize, this.frameSize, 0, 0, w, h);
    } else {
      ctx.drawImage(this.img, sx, sy, this.frameSize, this.frameSize, x, y, w, h);
    }
    ctx.restore();
  }
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function removeBackground(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  try {
    const id = cx.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    // sample background color from top-left corner
    const bgR = d[0], bgG = d[1], bgB = d[2];
    const tol = 35;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - bgR) + Math.abs(d[i + 1] - bgG) + Math.abs(d[i + 2] - bgB) < tol * 3) {
        d[i + 3] = 0;
      }
    }
    cx.putImageData(id, 0, 0);
  } catch (e) { /* cross-origin */ }
  return c;
}

async function loadAssets() {
  const [player, slime, bat] = await Promise.all([
    loadImage('assets/player.png'),
    loadImage('assets/slime.png'),
    loadImage('assets/bat.png')
  ]);
  if (player) assets.player = new Sprite(removeBackground(player), 512, 2, 2, 4);
  if (slime) assets.slime = new Sprite(removeBackground(slime), 512, 2, 2, 4);
  if (bat) assets.bat = new Sprite(removeBackground(bat), 512, 2, 2, 4);
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function showBanner(text, duration = 2000) {
  ui.banner.textContent = text;
  ui.banner.classList.remove('hidden');
  setTimeout(() => ui.banner.classList.add('hidden'), duration);
}

function setMissionText(m) {
  if (!m) { ui.hudMission.textContent = '---'; return; }
  let txt = `${m.type.toUpperCase()}: ${m.current}/${m.target}`;
  if (m.type === 'score') txt = `Score ${m.current}/${m.target}`;
  if (m.type === 'distance') txt = `Distance ${m.current*100}/${m.target*100}m`;
  ui.hudMission.textContent = txt;
}

function updateHealth(health, max) {
  ui.health.innerHTML = '';
  for (let i = 0; i < max; i++) {
    const span = document.createElement('span');
    span.className = 'heart' + (i < health ? '' : ' empty');
    span.textContent = '♥';
    ui.health.appendChild(span);
  }
}

function renderRooms(list) {
  ui.rooms.innerHTML = '';
  if (!list.length) { ui.rooms.innerHTML = '<div class="room-item"><span class="info">Ochiq xona yo\'q</span></div>'; return; }
  for (const r of list) {
    const div = document.createElement('div');
    div.className = 'room-item';
    div.innerHTML = `<div><span class="code">${r.id}</span> <span class="info">${r.name} · ${r.players}/${r.max}</span></div><button class="secondary">Join</button>`;
    div.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); joinRoom(r.id); });
    div.addEventListener('click', () => joinRoom(r.id));
    ui.rooms.appendChild(div);
  }
}

function joinRoom(code) {
  const name = ui.inputName.value.trim();
  socket.emit('join-room', { roomId: (code || ui.inputCode.value).toUpperCase().trim(), playerName: name });
}

function leaveRoom() {
  location.reload();
}

function startGame() {
  socket.emit('start-game');
}

function bindTouch(id, action) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const set = (v) => { input[action] = v; };
  ['pointerdown', 'touchstart'].forEach(ev => btn.addEventListener(ev, (e) => { e.preventDefault(); set(true); }));
  ['pointerup', 'pointerleave', 'touchend', 'touchcancel'].forEach(ev => btn.addEventListener(ev, (e) => { e.preventDefault(); set(false); }));
}
bindTouch('btn-left', 'left');
bindTouch('btn-right', 'right');
bindTouch('btn-jump', 'jump');

ui.btnCreate.addEventListener('click', () => {
  const name = ui.inputName.value.trim();
  socket.emit('create-room', { playerName: name, name: name || undefined });
});
ui.btnJoin.addEventListener('click', () => joinRoom());
ui.btnLeave.addEventListener('click', leaveRoom);
ui.btnStart.addEventListener('click', startGame);
ui.inputCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

function createRoom() {
  const name = ui.inputName.value.trim();
  socket.emit('create-room', { playerName: name, name: name || undefined });
}

socket.on('connect', () => { state.connected = true; });
socket.on('disconnect', () => { state.connected = false; });
socket.on('rooms', renderRooms);
socket.on('room-update', updateRoomUI);

socket.on('joined-room', (d) => {
  state.role = d.role;
  state.roomId = d.roomId;
  state.me = d.playerId;
  showScreen('room');
  ui.roomId.textContent = d.roomId;
  if (d.role === 'host') ui.btnStart.classList.remove('hidden');
  else ui.btnStart.classList.add('hidden');
});

socket.on('error', (msg) => { showBanner('Xatolik: ' + msg, 3000); });

socket.on('game-start', (data) => {
  state.inGame = true;
  state.chunks.clear();
  state.players.clear();
  state.entities.clear();
  for (const c of data.chunks) addChunk(c);
  state.mission = data.mission;
  state.me = data.id;
  showScreen('game');
  setMissionText(data.mission);
  requestAnimationFrame(gameLoop);
});

socket.on('state', (data) => {
  if (!state.inGame) return;
  for (const c of data.chunks) addChunk(c);
  state.players.clear();
  for (const p of data.players) state.players.set(p.id, p);
  state.entities.clear();
  for (const e of data.entities) state.entities.set(e.id, e);
  state.mission = data.mission;
  state.biome = currentBiome();
  updateHUD();
  if (data.events) {
    for (const ev of data.events) {
      if (ev.type === 'switch') showBanner('Gate opened!');
      if (ev.type === 'mission-complete') showBanner('Mission complete! +' + ev.reward);
    }
  }
});

socket.on('die', () => { showBanner('You died! Score penalty', 2500); });
socket.on('gates-open', () => { showBanner('Gates opened!'); });

function updateRoomUI(info) {
  if (!info || info.id !== state.roomId) return;
  ui.roomPlayers.innerHTML = '';
  for (const p of info.playerList || []) {
    const div = document.createElement('div');
    div.className = 'room-player';
    div.textContent = p.name + (p.id === state.me ? ' (siz)' : '');
    if (p.id === info.hostId) div.innerHTML += '<span class="host-tag">HOST</span>';
    ui.roomPlayers.appendChild(div);
  }
  if (state.role === 'host') ui.btnStart.classList.remove('hidden');
}

function addChunk(c) {
  const tiles = new Uint8Array(c.tiles);
  state.chunks.set(c.cx, { cx: c.cx, biome: c.biome, tiles });
}

function getChunk(cx) { return state.chunks.get(cx); }

function globalTile(gx, gy) {
  const cx = Math.floor(gx / CHUNK_W);
  const chunk = getChunk(cx);
  if (!chunk) return 0;
  const tx = gx - cx * CHUNK_W;
  if (tx < 0 || tx >= CHUNK_W || gy < 0 || gy >= CHUNK_H) return 0;
  return chunk.tiles[gy * CHUNK_W + tx];
}

function currentBiome() {
  const me = state.players.get(state.me);
  if (!me) return 'grass';
  const cx = Math.floor(me.x / CHUNK_W / TILE_SIZE);
  const chunk = getChunk(cx);
  return chunk ? chunk.biome : 'grass';
}

function updateHUD() {
  const me = state.players.get(state.me);
  if (!me) return;
  ui.hudCoins.textContent = me.coins || 0;
  ui.hudScore.textContent = me.score || 0;
  ui.hudBiome.textContent = state.biome;
  updateHealth(me.health, me.maxHealth);
  setMissionText(state.mission);
  let list = '';
  for (const p of state.players.values()) {
    if (p.id === state.me) list += `<div><b>${p.name}</b>: ${p.score}</div>`;
    else list += `<div>${p.name}: ${p.score}</div>`;
  }
  ui.players.innerHTML = list;
}

const keyMap = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'jump', KeyW: 'jump', Space: 'jump'
};
window.addEventListener('keydown', (e) => {
  const a = keyMap[e.code];
  if (a) { input[a] = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  const a = keyMap[e.code];
  if (a) { input[a] = false; e.preventDefault(); }
});

setInterval(() => {
  if (state.connected) socket.emit('input', input);
}, 1000 / 60);

function drawSky() {
  const colors = BIOME_SKY[state.biome] || BIOME_SKY.grass;
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, colors[0]);
  grad.addColorStop(1, colors[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // distant hills
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath();
  ctx.moveTo(0, canvas.height);
  for (let x = 0; x <= canvas.width; x += 40) {
    const y = canvas.height - 120 - Math.sin((x + state.camera.x * 0.2) / 200) * 40;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(canvas.width, canvas.height);
  ctx.fill();
}

function drawTile(tx, ty, t, biome) {
  const x = tx * TILE_SIZE - state.camera.x;
  const y = ty * TILE_SIZE - state.camera.y;
  const pal = BIOME_GROUND[biome] || BIOME_GROUND.grass;
  if (t === T.GROUND) {
    ctx.fillStyle = pal.body;
    ctx.fillRect(x, y + 4, TILE_SIZE, TILE_SIZE - 4);
    ctx.fillStyle = pal.top;
    ctx.fillRect(x, y, TILE_SIZE, 8);
  } else if (t === T.BRICK) {
    ctx.fillStyle = '#a0522d';
    ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(x + 2, y + 14, TILE_SIZE - 4, 4);
    ctx.fillRect(x + 14, y + 2, 4, TILE_SIZE - 4);
  } else if (t === T.PLATFORM) {
    ctx.fillStyle = '#8b5a2b';
    ctx.fillRect(x, y, TILE_SIZE, 8);
    ctx.fillStyle = '#5c3a1e';
    ctx.fillRect(x, y + 8, TILE_SIZE, TILE_SIZE - 8);
  } else if (t === T.PIPE) {
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
    ctx.fillStyle = '#15803d';
    ctx.fillRect(x, y + TILE_SIZE - 4, TILE_SIZE, 4);
    ctx.fillRect(x + TILE_SIZE - 4, y, 4, TILE_SIZE);
  } else if (t === T.SPIKE) {
    ctx.fillStyle = '#94a3b8';
    ctx.beginPath();
    ctx.moveTo(x, y + TILE_SIZE);
    ctx.lineTo(x + TILE_SIZE / 2, y);
    ctx.lineTo(x + TILE_SIZE, y + TILE_SIZE);
    ctx.fill();
  } else if (t === T.SWITCH) {
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(x + 4, y + TILE_SIZE - 10, TILE_SIZE - 8, 10);
    ctx.fillStyle = '#b91c1c';
    ctx.fillRect(x + 8, y + 4, TILE_SIZE - 16, TILE_SIZE - 14);
  } else if (t === T.GATE) {
    ctx.fillStyle = 'rgba(100,116,139,0.6)';
    ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
  }
}

function drawCoin(e) {
  const x = e.x - state.camera.x;
  const y = e.y - state.camera.y;
  ctx.fillStyle = '#facc15';
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ca8a04';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#fff7ed';
  ctx.beginPath();
  ctx.arc(x - 3, y - 3, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawSaw(e) {
  const x = e.x + e.w / 2 - state.camera.x;
  const y = e.y + e.h / 2 - state.camera.y;
  const r = e.w / 2;
  const angle = e.sawAngle || 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = '#64748b';
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    const a2 = ((i + 0.5) / 8) * Math.PI * 2;
    ctx.lineTo(Math.cos(a2) * (r * 0.6), Math.sin(a2) * (r * 0.6));
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawEntity(e) {
  const x = e.x - state.camera.x;
  const y = e.y - state.camera.y;
  if (e.type === 'coin') return drawCoin(e);
  if (e.type === 'saw') return drawSaw(e);

  let sprite = null;
  if (e.type === 'walker' || e.type === 'jumper' || e.type === 'spikebug') sprite = assets.slime;
  if (e.type === 'flyer') sprite = assets.bat;
  const frame = Math.floor(state.frame / 8) % 4;
  const flip = e.dir < 0;
  const vw = e.w * 1.8;
  const vh = e.h * 1.8;
  const vx = x - (vw - e.w) / 2;
  const vy = y - (vh - e.h) + 4;
  if (sprite && sprite.img) {
    sprite.draw(ctx, vx, vy, vw, vh, frame, flip);
  } else {
    ctx.fillStyle = e.type === 'flyer' ? '#a855f7' : '#ef4444';
    ctx.fillRect(x, y, e.w, e.h);
  }
}

function drawPlayer(p) {
  const x = p.x - state.camera.x;
  const y = p.y - state.camera.y;
  const w = p.w;
  const h = p.h;
  const flip = p.facing < 0;
  const isMoving = Math.abs(p.vx) > 0.5;
  const inAir = Math.abs(p.vy) > 0.5;
  let frame = 0;
  if (inAir) frame = 2;
  else if (isMoving) frame = Math.floor(state.frame / 6) % 4;

  if (assets.player && assets.player.img) {
    const sw = 56, sh = 56;
    const sx = x + (w - sw) / 2;
    const sy = y + h - sh + 2;
    ctx.globalAlpha = p.invincible > 0 && Math.floor(state.frame / 4) % 2 === 0 ? 0.5 : 1;
    assets.player.draw(ctx, sx, sy, sw, sh, frame, flip);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = p.color;
    ctx.fillRect(x, y, w, h);
  }

  // name tag
  ctx.fillStyle = '#fff';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, x + w / 2, y - 6);
}

function drawWorld() {
  const startTX = Math.floor(state.camera.x / TILE_SIZE) - 1;
  const endTX = startTX + Math.ceil(canvas.width / TILE_SIZE) + 2;
  const startTY = Math.floor(state.camera.y / TILE_SIZE) - 1;
  const endTY = startTY + Math.ceil(canvas.height / TILE_SIZE) + 2;

  for (let gx = startTX; gx <= endTX; gx++) {
    const cx = Math.floor(gx / CHUNK_W);
    const chunk = getChunk(cx);
    if (!chunk) continue;
    const tx = gx - cx * CHUNK_W;
    if (tx < 0 || tx >= CHUNK_W) continue;
    for (let ty = startTY; ty <= endTY; ty++) {
      if (ty < 0 || ty >= CHUNK_H) continue;
      const t = chunk.tiles[ty * CHUNK_W + tx];
      if (t !== T.AIR) drawTile(gx, ty, t, chunk.biome);
    }
  }
}

function gameLoop() {
  if (!state.inGame) return;
  state.frame++;

  const me = state.players.get(state.me);
  if (me) {
    state.camera.targetX = me.x + me.w / 2 - canvas.width / 2;
    state.camera.targetY = me.y + me.h / 2 - canvas.height / 2;
  }
  state.camera.x += (state.camera.targetX - state.camera.x) * 0.12;
  state.camera.y += (state.camera.targetY - state.camera.y) * 0.12;
  if (state.camera.x < 0) state.camera.x = 0;

  drawSky();
  drawWorld();
  for (const e of state.entities.values()) drawEntity(e);
  for (const p of state.players.values()) drawPlayer(p);

  requestAnimationFrame(gameLoop);
}

loadAssets().then(() => {
  console.log('assets loaded', Object.keys(assets));
});

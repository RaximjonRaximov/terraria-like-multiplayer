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

const BIOME_PARALLAX = {
  grass: ['rgba(34,197,94,0.12)', 'rgba(34,197,94,0.18)'],
  desert: ['rgba(217,119,6,0.12)', 'rgba(251,191,36,0.18)'],
  snow: ['rgba(255,255,255,0.15)', 'rgba(255,255,255,0.22)'],
  cave: ['rgba(15,23,42,0.2)', 'rgba(30,41,59,0.25)'],
  forest: ['rgba(22,101,52,0.15)', 'rgba(21,128,61,0.22)']
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
  hudBest: document.getElementById('hud-best'),
  hudDist: document.getElementById('hud-dist'),
  hudMission: document.getElementById('hud-mission'),
  hudBiome: document.getElementById('hud-biome'),
  hudFps: document.getElementById('hud-fps'),
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
const particles = [];
const weather = [];

class Particle {
  constructor(x, y, vx, vy, life, color, size) {
    this.x = x; this.y = y; this.vx = vx; this.vy = vy;
    this.life = life; this.maxLife = life;
    this.color = color; this.size = size || 3;
  }
  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.vy += 0.2;
    this.life--;
  }
  draw(ctx) {
    const a = this.life / this.maxLife;
    ctx.globalAlpha = a;
    ctx.fillStyle = this.color;
    ctx.fillRect(this.x - state.camera.x, this.y - state.camera.y, this.size, this.size);
    ctx.globalAlpha = 1;
  }
}

function spawnParticles(x, y, count, color, speed = 3, size = 3) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = Math.random() * speed;
    particles.push(new Particle(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 2, 30 + Math.random() * 20, color, size));
  }
}

function updateWeather() {
  const biome = state.biome;
  const spawnChance = biome === 'snow' ? 0.4 : (biome === 'forest' ? 0.12 : 0);
  if (spawnChance > 0 && Math.random() < spawnChance) {
    const isSnow = biome === 'snow';
    weather.push({
      x: state.camera.x + Math.random() * canvas.width,
      y: state.camera.y - 5,
      vx: isSnow ? 0.4 : -0.4,
      vy: isSnow ? 1.8 : 0.8,
      life: isSnow ? 140 : 100,
      color: isSnow ? '#ffffff' : '#a3e635',
      size: isSnow ? 2 : 3
    });
  }
  for (let i = weather.length - 1; i >= 0; i--) {
    const w = weather[i];
    w.x += w.vx; w.y += w.vy; w.life--;
    if (w.y > state.camera.y + canvas.height || w.life <= 0) weather.splice(i, 1);
  }
}

function drawWeather() {
  for (const w of weather) {
    const a = Math.min(1, w.life / 50);
    ctx.globalAlpha = a;
    ctx.fillStyle = w.color;
    ctx.beginPath();
    ctx.arc(w.x - state.camera.x, w.y - state.camera.y, w.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

let audioCtx = null;
function initAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function playSound(type) {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  const beep = (startFreq, endFreq, dur, vol, wave = 'sine') => {
    osc.type = wave;
    osc.frequency.setValueAtTime(startFreq, now);
    if (endFreq > startFreq) osc.frequency.linearRampToValueAtTime(endFreq, now + dur);
    else osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), now + dur);
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + dur);
    osc.start(now);
    osc.stop(now + dur);
  };

  if (type === 'coin') beep(1200, 1800, 0.12, 0.08);
  if (type === 'jump') beep(200, 450, 0.15, 0.06, 'square');
  if (type === 'stomp') beep(180, 70, 0.14, 0.12, 'triangle');
  if (type === 'flag') {
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.08, now + i * 0.08);
      g.gain.exponentialRampToValueAtTime(0.01, now + i * 0.08 + 0.18);
      o.start(now + i * 0.08); o.stop(now + i * 0.08 + 0.18);
    });
  }
  if (type === 'star') {
    for (let i = 0; i < 4; i++) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = 'square'; o.frequency.value = 880 + i * 220;
      g.gain.setValueAtTime(0.05, now + i * 0.05);
      g.gain.exponentialRampToValueAtTime(0.01, now + i * 0.05 + 0.1);
      o.start(now + i * 0.05); o.stop(now + i * 0.05 + 0.1);
    }
  }
}

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
  ['pointerdown', 'touchstart'].forEach(ev => btn.addEventListener(ev, (e) => { e.preventDefault(); initAudio(); set(true); }));
  ['pointerup', 'pointerleave', 'touchend', 'touchcancel'].forEach(ev => btn.addEventListener(ev, (e) => { e.preventDefault(); set(false); }));
}
bindTouch('btn-left', 'left');
bindTouch('btn-right', 'right');
bindTouch('btn-jump', 'jump');
bindTouch('btn-run', 'run');

function saveName() {
  try { localStorage.setItem('endlessPlayerName', ui.inputName.value.trim()); } catch (e) {}
}
function loadName() {
  try { ui.inputName.value = localStorage.getItem('endlessPlayerName') || ''; } catch (e) {}
}
loadName();

ui.btnCreate.addEventListener('click', () => {
  initAudio();
  const name = ui.inputName.value.trim();
  saveName();
  socket.emit('create-room', { playerName: name, name: name || undefined });
});
ui.btnJoin.addEventListener('click', () => { initAudio(); saveName(); joinRoom(); });
ui.btnLeave.addEventListener('click', leaveRoom);
ui.btnStart.addEventListener('click', () => { initAudio(); startGame(); });
ui.inputCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { initAudio(); saveName(); joinRoom(); } });

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

  const prevPlayers = new Map(state.players);
  state.players.clear();
  for (const p of data.players) {
    state.players.set(p.id, p);
    const prev = prevPlayers.get(p.id);
    p.prevGrounded = prev ? prev.grounded : false;
    if (prev && prev.grounded && !p.grounded && p.vy < 0) {
      spawnParticles(p.x + p.w / 2, p.y + p.h, 6, '#e2e8f0', 2, 2);
      playSound('jump');
    }
  }

  state.entities.clear();
  for (const e of data.entities) state.entities.set(e.id, e);

  state.mission = data.mission;
  const prevBiome = state.biome;
  state.biome = currentBiome();
  if (prevBiome && state.biome !== prevBiome) {
    showBanner(state.biome.toUpperCase() + ' biome!', 2500);
  }
  updateHUD();

  if (data.events) {
    for (const ev of data.events) {
      if (ev.type === 'switch') { showBanner('Gate opened!'); spawnParticles(ev.x, ev.y, 15, '#facc15', 4); if (ev.gx !== undefined) setTileAt(ev.gx, ev.gy, T.AIR); }
      if (ev.type === 'question') { spawnParticles(ev.x, ev.y, 15, '#f59e0b', 4); playSound('coin'); if (ev.gx !== undefined) setTileAt(ev.gx, ev.gy, T.BRICK); }
      if (ev.type === 'mission-complete') { showBanner('Mission complete! +' + ev.reward); spawnParticles(canvas.width / 2 + state.camera.x, canvas.height / 2 + state.camera.y, 30, '#fbbf24', 6); playSound('flag'); }
      if (ev.type === 'coin') { spawnParticles(ev.x, ev.y, 5, '#facc15', 3, 2); playSound('coin'); }
      if (ev.type === 'stomp') { spawnParticles(ev.x, ev.y, 10, '#94a3b8', 3, 3); playSound('stomp'); }
      if (ev.type === 'heart') { spawnParticles(ev.x, ev.y, 8, '#ef4444', 3, 3); showBanner('+Health'); playSound('coin'); }
      if (ev.type === 'star') { spawnParticles(ev.x, ev.y, 12, '#facc15', 5, 4); showBanner('Star Power!'); playSound('star'); }
      if (ev.type === 'wing') { spawnParticles(ev.x, ev.y, 10, '#38bdf8', 4, 3); showBanner('Double Jump!'); playSound('jump'); }
      if (ev.type === 'flag') { spawnParticles(ev.x, ev.y, 20, '#fbbf24', 5); showBanner(ev.biome + ' flag! +100', 2500); playSound('flag'); }
    }
  }
});

socket.on('die', () => { showBanner('You died! Score penalty', 2500); });
socket.on('gates-open', () => {
  showBanner('Gates opened!');
  for (const chunk of state.chunks.values()) {
    for (let i = 0; i < chunk.tiles.length; i++) {
      if (chunk.tiles[i] === T.GATE) chunk.tiles[i] = T.AIR;
    }
  }
});

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

function setTileAt(gx, gy, t) {
  const cx = Math.floor(gx / CHUNK_W);
  const chunk = getChunk(cx);
  if (!chunk) return;
  const tx = gx - cx * CHUNK_W;
  if (tx < 0 || tx >= CHUNK_W || gy < 0 || gy >= CHUNK_H) return;
  chunk.tiles[gy * CHUNK_W + tx] = t;
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
  ui.hudDist.textContent = Math.floor((me.distance || 0) / 10);
  try {
    const best = Math.max(parseInt(localStorage.getItem('endlessHighScore') || '0', 10), me.score || 0);
    localStorage.setItem('endlessHighScore', best);
    ui.hudBest.textContent = best;
  } catch (e) {}
  ui.hudBiome.textContent = state.biome;
  updateHealth(me.health, me.maxHealth);
  setMissionText(state.mission);
  if (me.starTimer > 0) {
    if (!document.getElementById('hud-star')) {
      const s = document.createElement('div');
      s.id = 'hud-star';
      s.textContent = '⭐ ' + Math.ceil(me.starTimer / 60) + 's';
      s.style.color = '#facc15';
      s.style.fontSize = '13px';
      document.getElementById('hud-left').appendChild(s);
    } else {
      document.getElementById('hud-star').textContent = '⭐ ' + Math.ceil(me.starTimer / 60) + 's';
    }
  } else {
    const s = document.getElementById('hud-star');
    if (s) s.remove();
  }
  if (me.wingTimer > 0) {
    if (!document.getElementById('hud-wing')) {
      const w = document.createElement('div');
      w.id = 'hud-wing';
      w.textContent = '🪽 ' + Math.ceil(me.wingTimer / 60) + 's';
      w.style.color = '#38bdf8';
      w.style.fontSize = '13px';
      document.getElementById('hud-left').appendChild(w);
    } else {
      document.getElementById('hud-wing').textContent = '🪽 ' + Math.ceil(me.wingTimer / 60) + 's';
    }
  } else {
    const w = document.getElementById('hud-wing');
    if (w) w.remove();
  }
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
  ArrowUp: 'jump', KeyW: 'jump', Space: 'jump',
  ShiftLeft: 'run', ShiftRight: 'run'
};
window.addEventListener('keydown', (e) => {
  initAudio();
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

  // clouds
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  for (let i = 0; i < 6; i++) {
    const cx = ((i * 300 - state.camera.x * 0.05) % (canvas.width + 400)) - 200;
    const cy = 60 + Math.sin(i + state.frame * 0.01) * 20;
    ctx.beginPath();
    ctx.arc(cx, cy, 40, 0, Math.PI * 2);
    ctx.arc(cx + 30, cy - 10, 50, 0, Math.PI * 2);
    ctx.arc(cx + 70, cy, 40, 0, Math.PI * 2);
    ctx.fill();
  }

  // parallax hills/trees per biome
  const par = BIOME_PARALLAX[state.biome] || BIOME_PARALLAX.grass;
  drawParallaxLayer(par[0], 0.15, 150, 40, 3);
  drawParallaxLayer(par[1], 0.35, 100, 30, 2);
}

function drawParallaxLayer(color, speed, height, amp, freq) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height);
  for (let x = 0; x <= canvas.width; x += 20) {
    const worldX = x + state.camera.x * speed;
    const y = canvas.height - height - Math.sin(worldX / (100 * freq)) * amp - Math.cos(worldX / (60 * freq)) * amp * 0.5;
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
  } else if (t === T.QUESTION) {
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
    ctx.fillStyle = '#78350f';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', x + TILE_SIZE / 2, y + TILE_SIZE / 2 + 2);
    ctx.strokeStyle = '#b45309';
    ctx.strokeRect(x + 2, y + 2, TILE_SIZE - 4, TILE_SIZE - 4);
  } else if (t === T.POLE) {
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(x + 12, y, 8, TILE_SIZE);
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(x + 8, y + TILE_SIZE - 4, TILE_SIZE - 16, 4);
  } else if (t === T.FLAG) {
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE * 0.6);
    ctx.fillStyle = '#b91c1c';
    ctx.beginPath();
    ctx.moveTo(x + TILE_SIZE, y);
    ctx.lineTo(x + TILE_SIZE, y + TILE_SIZE * 0.6);
    ctx.lineTo(x + TILE_SIZE / 2, y + TILE_SIZE * 0.3);
    ctx.fill();
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(x + 14, y + TILE_SIZE * 0.6, 4, TILE_SIZE * 0.4);
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

function drawHeart(x, y, w, h) {
  ctx.fillStyle = '#ef4444';
  const s = Math.min(w, h);
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(s / 18, s / 18);
  ctx.beginPath();
  ctx.moveTo(0, 4);
  ctx.bezierCurveTo(-8, -6, -16, 2, 0, 14);
  ctx.bezierCurveTo(16, 2, 8, -6, 0, 4);
  ctx.fill();
  ctx.restore();
}

function drawStar(cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.45;
    const px = cx + Math.cos(a) * rr;
    const py = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function drawWing(x, y, w, h) {
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.ellipse(x + w * 0.2, y + h * 0.4, w * 0.35, h * 0.15, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x + w * 0.8, y + h * 0.4, w * 0.35, h * 0.15, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#38bdf8';
  ctx.fillRect(x + w * 0.35, y + h * 0.25, w * 0.3, h * 0.3);
}

function drawEntity(e) {
  const x = e.x - state.camera.x;
  const y = e.y - state.camera.y;
  if (e.type === 'coin') return drawCoin(e);
  if (e.type === 'saw') return drawSaw(e);
  if (e.type === 'heart') return drawHeart(x, y, e.w, e.h);
  if (e.type === 'star') {
    const pulse = 1 + Math.sin(state.frame * 0.15) * 0.15;
    return drawStar(x + e.w / 2, y + e.h / 2, (e.w / 2) * pulse, '#facc15');
  }
  if (e.type === 'wing') return drawWing(x, y, e.w, e.h);

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
    if (p.starTimer > 0) {
      ctx.fillStyle = `hsla(${state.frame * 8 % 360}, 100%, 50%, 0.25)`;
      ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
    }
    if (p.wingTimer > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.ellipse(sx + sw * 0.15, sy + sh * 0.35, 10, 6, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(sx + sw * 0.85, sy + sh * 0.35, 10, 6, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = p.color;
    ctx.fillRect(x, y, w, h);
  }

  // health bar
  const hp = p.health / p.maxHealth;
  ctx.fillStyle = '#374151';
  ctx.fillRect(x, y - 12, w, 5);
  ctx.fillStyle = hp > 0.5 ? '#22c55e' : (hp > 0.25 ? '#facc15' : '#ef4444');
  ctx.fillRect(x + 1, y - 11, (w - 2) * hp, 3);

  // name tag
  ctx.fillStyle = '#fff';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, x + w / 2, y - 16);
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

let fpsFrameCount = 0;
let fpsLastTime = performance.now();

function gameLoop() {
  if (!state.inGame) return;
  state.frame++;
  fpsFrameCount++;
  const now = performance.now();
  if (now - fpsLastTime >= 1000) {
    ui.hudFps.textContent = Math.round(fpsFrameCount * 1000 / (now - fpsLastTime));
    fpsFrameCount = 0;
    fpsLastTime = now;
  }

  const me = state.players.get(state.me);
  if (me) {
    state.camera.targetX = me.x + me.w / 2 - canvas.width / 2;
    state.camera.targetY = me.y + me.h / 2 - canvas.height / 2;
  }
  state.camera.x += (state.camera.targetX - state.camera.x) * 0.12;
  state.camera.y += (state.camera.targetY - state.camera.y) * 0.12;
  if (state.camera.x < 0) state.camera.x = 0;

  // update particles
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].update();
    if (particles[i].life <= 0) particles.splice(i, 1);
  }
  updateWeather();

  drawSky();
  drawWorld();
  for (const e of state.entities.values()) drawEntity(e);
  for (const p of state.players.values()) drawPlayer(p);
  for (const pt of particles) pt.draw(ctx);
  drawWeather();

  // cave lighting vignette
  if (state.biome === 'cave') {
    const me = state.players.get(state.me);
    if (me) {
      const sx = me.x + me.w / 2 - state.camera.x;
      const sy = me.y + me.h / 2 - state.camera.y;
      const grad = ctx.createRadialGradient(sx, sy, 50, sx, sy, 420);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.6)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  requestAnimationFrame(gameLoop);
}

loadAssets().then(() => {
  console.log('assets loaded', Object.keys(assets));
});

/* global io */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const scoresEl = document.getElementById('scores');
const winEl = document.getElementById('win');
const winnerEl = document.getElementById('winner');

const socket = io();

let TILE_SIZE = 32;
let WORLD_WIDTH = 0;
let WORLD_HEIGHT = 0;
let WORLD_TS_W = 0;
let WORLD_TS_H = 0;

const T = {
  AIR: 0,
  GROUND: 1,
  BRICK: 2,
  QBLOCK: 3,
  PIPE_TOP: 4,
  PIPE_BODY: 5,
  PLATFORM: 6,
  POLE: 7,
  FLAG: 8
};

const COLORS = {
  [T.GROUND]: '#7a5',
  [T.BRICK]: '#a53',
  [T.QBLOCK]: '#d82',
  [T.PIPE_TOP]: '#2a5',
  [T.PIPE_BODY]: '#2a5',
  [T.PLATFORM]: '#964',
  [T.POLE]: '#fff',
  [T.FLAG]: '#f22'
};

const input = { left: false, right: false, jump: false };
const state = {
  me: null,
  players: {},
  coins: [],
  enemies: [],
  camera: { x: 0, y: 0 },
  connected: false,
  ready: false
};

let world = null;

function widx(x, y) { return y * WORLD_WIDTH + x; }

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

const keyMap = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowUp: 'jump',
  KeyW: 'jump',
  Space: 'jump'
};

window.addEventListener('keydown', (e) => {
  const a = keyMap[e.code];
  if (a) { input[a] = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  const a = keyMap[e.code];
  if (a) { input[a] = false; e.preventDefault(); }
});

function bindBtn(id, action) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const set = (v) => { input[action] = v; };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); set(true); });
  btn.addEventListener('pointerup', (e) => { e.preventDefault(); set(false); });
  btn.addEventListener('pointerleave', (e) => { e.preventDefault(); set(false); });
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); set(true); });
  btn.addEventListener('touchend', (e) => { e.preventDefault(); set(false); });
}

bindBtn('btn-left', 'left');
bindBtn('btn-right', 'right');
bindBtn('btn-jump', 'jump');

socket.on('connect', () => { statusEl.textContent = 'Connected'; state.connected = true; });
socket.on('disconnect', () => { statusEl.textContent = 'Disconnected'; state.connected = false; });

socket.on('init', (data) => {
  state.me = data.id;
  TILE_SIZE = data.tileSize;
  WORLD_WIDTH = data.worldWidth;
  WORLD_HEIGHT = data.worldHeight;
  WORLD_TS_W = WORLD_WIDTH * TILE_SIZE;
  WORLD_TS_H = WORLD_HEIGHT * TILE_SIZE;

  world = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT);
  for (const tile of data.tiles) {
    if (tile.x >= 0 && tile.x < WORLD_WIDTH && tile.y >= 0 && tile.y < WORLD_HEIGHT) {
      world[widx(tile.x, tile.y)] = tile.t;
    }
  }

  state.players[data.id] = { id: data.id, x: data.x, y: data.y, vx: 0, vy: 0, color: '#fff', name: 'You', score: 0 };
  state.coins = data.coins || [];
  state.enemies = data.enemies || [];
  state.ready = true;
  statusEl.textContent = `ID: ${data.id.slice(0, 6)}`;
});

socket.on('state', (data) => {
  state.players = {};
  for (const p of data.players) state.players[p.id] = p;
  state.coins = data.coins || [];
  state.enemies = data.enemies || [];
  updateScores();
});

socket.on('coin-remove', ({ id }) => {
  state.coins = state.coins.filter(c => c.id !== id);
});

socket.on('enemy-remove', ({ id }) => {
  state.enemies = state.enemies.filter(e => e.id !== id);
});

socket.on('win', ({ name }) => {
  winnerEl.textContent = name || 'Somebody';
  winEl.classList.remove('hidden');
  setTimeout(() => winEl.classList.add('hidden'), 4000);
});

socket.on('player-left', ({ id }) => { delete state.players[id]; });

setInterval(() => {
  if (state.connected) socket.emit('input', input);
}, 1000 / 60);

function getTile(x, y) {
  if (x < 0 || x >= WORLD_WIDTH || y < 0 || y >= WORLD_HEIGHT) return 0;
  return world[widx(x, y)];
}

function drawTile(tx, ty, t) {
  const x = tx * TILE_SIZE - state.camera.x;
  const y = ty * TILE_SIZE - state.camera.y;
  ctx.fillStyle = COLORS[t] || '#888';
  ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);

  if (t === T.BRICK || t === T.QBLOCK || t === T.GROUND || t === T.PLATFORM) {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(x, y + TILE_SIZE - 3, TILE_SIZE, 3);
    ctx.fillRect(x + TILE_SIZE - 3, y, 3, TILE_SIZE);
  }

  if (t === T.QBLOCK) {
    ctx.fillStyle = '#ffd700';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', x + TILE_SIZE / 2, y + TILE_SIZE / 2);
  }

  if (t === T.FLAG) {
    ctx.fillStyle = '#f22';
    ctx.beginPath();
    ctx.moveTo(x + 4, y + 4);
    ctx.lineTo(x + TILE_SIZE - 4, y + TILE_SIZE / 2);
    ctx.lineTo(x + 4, y + TILE_SIZE - 4);
    ctx.fill();
  }
}

function drawCoin(c) {
  const x = c.x - state.camera.x;
  const y = c.y - state.camera.y;
  ctx.fillStyle = '#ffd700';
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#d4af37';
  ctx.stroke();
  ctx.fillStyle = '#fff8';
  ctx.beginPath();
  ctx.arc(x - 3, y - 3, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawEnemy(e) {
  const x = e.x - state.camera.x;
  const y = e.y - state.camera.y;
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(x - 5, y - 5, 36, 36);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 5, y - 5, 36, 36);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + (e.dir > 0 ? 18 : 4), y + 6, 4, 4);
  ctx.fillStyle = '#330000';
  ctx.fillRect(x + 5, y + 18, 16, 4);
}

function drawPlayer(p) {
  const x = p.x - state.camera.x;
  const y = p.y - state.camera.y;
  ctx.fillStyle = p.color;
  ctx.fillRect(x, y, 24, 36);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + (p.vx > 0 ? 16 : 4), y + 8, 4, 4);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(x, y + 34, 24, 2);
  ctx.fillStyle = '#fff';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(p.name || p.id.slice(0, 4), x + 12, y - 8);
}

function updateScores() {
  const list = Object.values(state.players).sort((a, b) => b.score - a.score);
  let html = `<div>Coins: ${state.coins.length} Enemies: ${state.enemies.length}</div>`;
  html += list.map(p => `<div>${p.name || p.id.slice(0, 4)}: ${p.score}</div>`).join('');
  scoresEl.innerHTML = html;
}

function clampCamera() {
  const cw = canvas.width;
  const ch = canvas.height;
  state.camera.x = Math.max(0, Math.min(state.camera.x, WORLD_TS_W - cw));
  state.camera.y = Math.max(0, Math.min(state.camera.y, WORLD_TS_H - ch));
  if (WORLD_TS_W < cw) state.camera.x = (WORLD_TS_W - cw) / 2;
  if (WORLD_TS_H < ch) state.camera.y = (WORLD_TS_H - ch) / 2;
}

function gameLoop() {
  const me = state.players[state.me];
  if (me) {
    state.camera.x = me.x + 12 - canvas.width / 2;
    state.camera.y = me.y + 18 - canvas.height / 2;
  }
  clampCamera();

  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#87CEEB');
  grad.addColorStop(1, '#e0f7fa');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state.ready) {
    const startX = Math.floor(state.camera.x / TILE_SIZE) - 1;
    const endX = startX + Math.ceil(canvas.width / TILE_SIZE) + 2;
    const startY = Math.floor(state.camera.y / TILE_SIZE) - 1;
    const endY = startY + Math.ceil(canvas.height / TILE_SIZE) + 2;

    for (let x = startX; x <= endX; x++) {
      for (let y = startY; y <= endY; y++) {
        const t = getTile(x, y);
        if (t !== T.AIR) drawTile(x, y, t);
      }
    }
  }


  for (const c of state.coins) drawCoin(c);
  for (const e of state.enemies) drawEnemy(e);
  for (const id in state.players) drawPlayer(state.players[id]);

  if (me) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Coins left: ${state.coins.length}  Enemies: ${state.enemies.length}`, 8, canvas.height - 12);
  }

  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);

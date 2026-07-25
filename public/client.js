/* global io */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const nameInput = document.getElementById('name');

const socket = io();

let TILE_SIZE = 32;
let WORLD_WIDTH = 512;
let WORLD_HEIGHT = 256;

const state = {
  me: null,
  players: {},
  blocks: new Map(),
  camera: { x: 0, y: 0 },
  connected: false
};

function bkey(x, y) { return `${x},${y}`; }

function setBlock(x, y, type) {
  if (type === null || type === undefined) state.blocks.delete(bkey(x, y));
  else state.blocks.set(bkey(x, y), { type });
}

const input = { left: false, right: false, jump: false };
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
  const action = keyMap[e.code];
  if (action) {
    input[action] = true;
    e.preventDefault();
  }
});

window.addEventListener('keyup', (e) => {
  const action = keyMap[e.code];
  if (action) {
    input[action] = false;
    e.preventDefault();
  }
});

nameInput.addEventListener('change', () => {
  socket.emit('set-name', nameInput.value);
});

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

socket.on('connect', () => {
  statusEl.textContent = 'Connected';
  state.connected = true;
});

socket.on('disconnect', () => {
  statusEl.textContent = 'Disconnected';
  state.connected = false;
});

socket.on('init', (data) => {
  state.me = data.id;
  TILE_SIZE = data.tileSize;
  WORLD_WIDTH = data.worldWidth;
  WORLD_HEIGHT = data.worldHeight;
  if (data.chunk) {
    for (const tile of data.chunk) setBlock(tile.x, tile.y, tile.type);
  }
  statusEl.textContent = `Connected as ${data.id.slice(0, 6)}`;
});

socket.on('state', (data) => {
  state.players = {};
  for (const p of data.players) state.players[p.id] = p;
});

socket.on('block', (tile) => {
  setBlock(tile.x, tile.y, tile.type);
});

socket.on('chunk', (data) => {
  for (const tile of data.tiles) setBlock(tile.x, tile.y, tile.type);
});

socket.on('player-joined', (p) => {
  state.players[p.id] = { ...p, x: 0, y: 0, vx: 0, vy: 0 };
});

socket.on('player-left', (p) => {
  delete state.players[p.id];
});

setInterval(() => {
  if (state.connected) socket.emit('input', input);
}, 1000 / 60);

function getMouseTile(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const wx = sx + state.camera.x;
  const wy = sy + state.camera.y;
  return { tx: Math.floor(wx / TILE_SIZE), ty: Math.floor(wy / TILE_SIZE) };
}

canvas.addEventListener('mousedown', (e) => {
  const t = getMouseTile(e);
  if (e.button === 0) socket.emit('action', { type: 'mine', tx: t.tx, ty: t.ty });
  else if (e.button === 2) socket.emit('action', { type: 'build', tx: t.tx, ty: t.ty });
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const BLOCK_COLORS = {
  grass: ['#5a9', '#487'],
  dirt: ['#864', '#643'],
  stone: ['#888', '#555'],
  wood: ['#753', '#432'],
  leaves: ['#3a5', '#273'],
  torch: ['#fc0', '#c80']
};

function drawTile(tx, ty, type) {
  const x = tx * TILE_SIZE - state.camera.x;
  const y = ty * TILE_SIZE - state.camera.y;
  const colors = BLOCK_COLORS[type] || ['#aaa', '#777'];
  ctx.fillStyle = colors[0];
  ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
  ctx.fillStyle = colors[1];
  ctx.fillRect(x, y + TILE_SIZE - 4, TILE_SIZE, 4);
  ctx.fillRect(x + TILE_SIZE - 4, y, 4, TILE_SIZE);
  if (type === 'torch') {
    ctx.fillStyle = 'rgba(255, 200, 50, 0.25)';
    ctx.beginPath();
    ctx.arc(x + TILE_SIZE / 2, y + TILE_SIZE / 2, TILE_SIZE * 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPlayer(p) {
  const x = p.x - state.camera.x;
  const y = p.y - state.camera.y;
  ctx.fillStyle = p.color || '#0ff';
  ctx.fillRect(x, y, 28, 46);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + (p.vx > 0 ? 18 : 6), y + 10, 4, 4);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(x, y + 44, 28, 2);
  ctx.fillStyle = '#fff';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(p.name || p.id.slice(0, 4), x + 14, y - 8);
}

function requestChunks() {
  const me = state.players[state.me];
  if (!me) return;
  const cx = Math.floor((me.x + 14) / TILE_SIZE);
  const cy = Math.floor((me.y + 23) / TILE_SIZE);
  const radius = Math.ceil(Math.max(canvas.width, canvas.height) / TILE_SIZE / 2) + 4;
  socket.emit('chunk', { cx, cy, radius });
}

let lastChunkTime = 0;

function gameLoop() {
  const me = state.players[state.me];
  if (me) {
    state.camera.x = me.x + 14 - canvas.width / 2;
    state.camera.y = me.y + 23 - canvas.height / 2;
  }

  ctx.fillStyle = '#87CEEB';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (me) {
    const now = performance.now();
    if (now - lastChunkTime > 300) {
      requestChunks();
      lastChunkTime = now;
    }
  }

  const startX = Math.floor(state.camera.x / TILE_SIZE) - 1;
  const endX = startX + Math.ceil(canvas.width / TILE_SIZE) + 2;
  const startY = Math.floor(state.camera.y / TILE_SIZE) - 1;
  const endY = startY + Math.ceil(canvas.height / TILE_SIZE) + 2;

  for (let x = startX; x <= endX; x++) {
    for (let y = startY; y <= endY; y++) {
      const b = state.blocks.get(bkey(x, y));
      if (b) drawTile(x, y, b.type);
    }
  }

  for (const id in state.players) {
    drawPlayer(state.players[id]);
  }

  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Players online: ${Object.keys(state.players).length}`, 10, canvas.height - 20);

  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);

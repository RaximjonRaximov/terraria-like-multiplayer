const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const TILE_SIZE = 32;
const WORLD_WIDTH = 512;
const WORLD_HEIGHT = 256;
const GRAVITY = 0.6;
const FRICTION = 0.8;
const ACCEL = 1.0;
const MAX_SPEED = 6;
const JUMP = -14;
const PLAYER_W = 28;
const PLAYER_H = 46;
const REACH = 6 * TILE_SIZE;

const blocks = new Map();
const players = new Map();

function bkey(x, y) { return `${x},${y}`; }

function getBlock(x, y) {
  if (x < 0 || x >= WORLD_WIDTH || y < 0 || y >= WORLD_HEIGHT) return null;
  return blocks.get(bkey(x, y)) || null;
}

function setBlock(x, y, type) {
  if (type === null || type === undefined) blocks.delete(bkey(x, y));
  else blocks.set(bkey(x, y), { type });
}

function isSolid(x, y) {
  const b = getBlock(x, y);
  return b && b.type !== 'torch';
}

function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 70%, 55%)`;
}

function generateWorld() {
  for (let x = 0; x < WORLD_WIDTH; x++) {
    const surface = 60 + Math.floor(Math.sin(x / 40) * 10 + Math.sin(x / 15) * 3 + (Math.random() - 0.5) * 2);
    for (let y = surface; y < WORLD_HEIGHT; y++) {
      if (y === surface) setBlock(x, y, 'grass');
      else if (y < surface + 5) setBlock(x, y, 'dirt');
      else setBlock(x, y, 'stone');
    }

    if (Math.random() < 0.06 && x > 3 && x < WORLD_WIDTH - 4) {
      const height = 2 + Math.floor(Math.random() * 4);
      for (let i = 1; i <= height; i++) setBlock(x, surface - i, 'wood');
      const top = surface - height - 1;
      setBlock(x - 1, top, 'leaves');
      setBlock(x, top, 'leaves');
      setBlock(x + 1, top, 'leaves');
      setBlock(x, top - 1, 'leaves');
    }
  }

  for (let i = 0; i < 500; i++) {
    const cx = Math.floor(Math.random() * WORLD_WIDTH);
    const cy = 70 + Math.floor(Math.random() * (WORLD_HEIGHT - 80));
    const r = 2 + Math.floor(Math.random() * 5);
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        if (Math.hypot(x - cx, y - cy) <= r && getBlock(x, y)?.type === 'stone') {
          setBlock(x, y, null);
        }
      }
    }
  }
}

function surfaceYAt(x) {
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    if (isSolid(x, y)) return y;
  }
  return 60;
}

function spawnPlayer() {
  const x = 40 + Math.floor(Math.random() * 40);
  const yTile = surfaceYAt(x) - 1;
  return { x: x * TILE_SIZE, y: yTile * TILE_SIZE - PLAYER_H };
}

function resolveX(p) {
  const left = Math.floor(p.x / TILE_SIZE);
  const right = Math.floor((p.x + p.w) / TILE_SIZE);
  const top = Math.floor(p.y / TILE_SIZE);
  const bottom = Math.floor((p.y + p.h) / TILE_SIZE);

  if (p.vx > 0) {
    for (let ty = top; ty <= bottom; ty++) {
      if (isSolid(right, ty)) {
        p.x = right * TILE_SIZE - p.w - 0.001;
        p.vx = 0;
        return;
      }
    }
  } else if (p.vx < 0) {
    for (let ty = top; ty <= bottom; ty++) {
      if (isSolid(left, ty)) {
        p.x = (left + 1) * TILE_SIZE + 0.001;
        p.vx = 0;
        return;
      }
    }
  }
}

function resolveY(p) {
  const left = Math.floor(p.x / TILE_SIZE);
  const right = Math.floor((p.x + p.w) / TILE_SIZE);
  const top = Math.floor(p.y / TILE_SIZE);
  const bottom = Math.floor((p.y + p.h) / TILE_SIZE);

  p.grounded = false;

  if (p.vy > 0) {
    for (let tx = left; tx <= right; tx++) {
      if (isSolid(tx, bottom)) {
        p.y = bottom * TILE_SIZE - p.h - 0.001;
        p.vy = 0;
        p.grounded = true;
        return;
      }
    }
  } else if (p.vy < 0) {
    for (let tx = left; tx <= right; tx++) {
      if (isSolid(tx, top)) {
        p.y = (top + 1) * TILE_SIZE + 0.001;
        p.vy = 0;
        return;
      }
    }
  }
}

function updatePlayer(p) {
  if (p.input.left) p.vx -= ACCEL;
  if (p.input.right) p.vx += ACCEL;
  p.vx *= FRICTION;
  p.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, p.vx));

  if (p.grounded && p.input.jump) {
    p.vy = JUMP;
    p.grounded = false;
  }

  p.vy += GRAVITY;
  p.y += p.vy;
  resolveY(p);

  p.x += p.vx;
  resolveX(p);

  p.x = Math.max(0, Math.min(p.x, WORLD_WIDTH * TILE_SIZE - p.w));
  p.y = Math.min(p.y, WORLD_HEIGHT * TILE_SIZE - p.h);
}

function hasAdjacentSolid(tx, ty) {
  return isSolid(tx - 1, ty) || isSolid(tx + 1, ty) || isSolid(tx, ty - 1) || isSolid(tx, ty + 1);
}

function getChunk(cx, cy, radius) {
  const r = Math.min(radius, 48);
  const tiles = [];
  for (let x = cx - r; x <= cx + r; x++) {
    for (let y = cy - r; y <= cy + r; y++) {
      const b = getBlock(x, y);
      if (b) tiles.push({ x, y, type: b.type });
    }
  }
  return tiles;
}

function playersArray() {
  return Array.from(players.values()).map(p => ({
    id: p.id,
    x: p.x,
    y: p.y,
    color: p.color,
    vx: p.vx,
    vy: p.vy,
    name: p.name
  }));
}

generateWorld();

io.on('connection', (socket) => {
  const spawn = spawnPlayer();
  const player = {
    id: socket.id,
    name: `Player ${socket.id.slice(0, 4)}`,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    w: PLAYER_W,
    h: PLAYER_H,
    color: randomColor(),
    grounded: false,
    input: {}
  };
  players.set(socket.id, player);

  const cx = Math.floor(player.x / TILE_SIZE);
  const cy = Math.floor(player.y / TILE_SIZE);

  socket.emit('init', {
    id: socket.id,
    x: player.x,
    y: player.y,
    color: player.color,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    tileSize: TILE_SIZE,
    chunk: getChunk(cx, cy, 40)
  });

  socket.broadcast.emit('player-joined', { id: player.id, name: player.name, color: player.color });
  socket.emit('state', { players: playersArray() });

  socket.on('input', (data) => {
    player.input = data || {};
  });

  socket.on('action', ({ type, tx, ty }) => {
    if (typeof tx !== 'number' || typeof ty !== 'number') return;
    const bx = tx * TILE_SIZE + TILE_SIZE / 2;
    const by = ty * TILE_SIZE + TILE_SIZE / 2;
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h / 2;
    if (Math.hypot(bx - cx, by - cy) > REACH) return;

    if (type === 'mine') {
      if (getBlock(tx, ty)) {
        setBlock(tx, ty, null);
        io.emit('block', { x: tx, y: ty, type: null });
      }
    } else if (type === 'build') {
      if (!getBlock(tx, ty) && hasAdjacentSolid(tx, ty)) {
        setBlock(tx, ty, 'dirt');
        io.emit('block', { x: tx, y: ty, type: 'dirt' });
      }
    }
  });

  socket.on('chunk', ({ cx, cy, radius }) => {
    if (typeof cx !== 'number' || typeof cy !== 'number') return;
    socket.emit('chunk', { tiles: getChunk(cx, cy, radius || 32), cx, cy, radius: radius || 32 });
  });

  socket.on('set-name', (name) => {
    if (typeof name === 'string' && name.length <= 20) {
      player.name = name.trim() || player.name;
    }
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('player-left', { id: socket.id });
  });
});

setInterval(() => {
  for (const p of players.values()) updatePlayer(p);
  io.emit('state', { players: playersArray() });
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Terraria-like server listening on http://localhost:${PORT}`);
});

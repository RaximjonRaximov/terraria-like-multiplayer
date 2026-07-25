const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const TILE_SIZE = 32;
const WORLD_WIDTH = 400;
const WORLD_HEIGHT = 100;
const GRAVITY = 0.65;
const FRICTION = 0.88;
const ACCEL = 0.7;
const MAX_SPEED = 6;
const JUMP = -14;
const PLAYER_W = 24;
const PLAYER_H = 36;
const ENEMY_W = 26;
const ENEMY_H = 26;
const COIN_RADIUS = 10;

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

const SOLID = { [T.GROUND]: true, [T.BRICK]: true, [T.QBLOCK]: true, [T.PIPE_TOP]: true, [T.PIPE_BODY]: true };
const ONE_WAY = { [T.PLATFORM]: true };

const world = new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT);
const players = new Map();
const enemies = [];
const coins = [];

let enemyIdCounter = 1;
let coinIdCounter = 1;

function idx(x, y) { return y * WORLD_WIDTH + x; }

function inBounds(x, y) {
  return x >= 0 && x < WORLD_WIDTH && y >= 0 && y < WORLD_HEIGHT;
}

function getTile(x, y) {
  if (x < 0 || x >= WORLD_WIDTH) return T.GROUND;
  if (y < 0 || y >= WORLD_HEIGHT) return T.AIR;
  return world[idx(x, y)];
}

function setTile(x, y, t) {
  if (inBounds(x, y)) world[idx(x, y)] = t;
}

function isSolidTile(x, y) {
  const t = getTile(x, y);
  return SOLID[t] || ONE_WAY[t] || false;
}

function isBlocked(x, y) {
  const t = getTile(x, y);
  return SOLID[t] || false;
}

function isGround(x, y) {
  const t = getTile(x, y);
  return SOLID[t] || ONE_WAY[t] || false;
}

function baseGround(x) {
  return 50 + Math.floor(Math.sin(x / 35) * 4 + Math.cos(x / 18) * 2);
}

function generateLevel() {
  world.fill(T.AIR);

  const pits = [];
  let x = 60;
  while (x < WORLD_WIDTH - 50) {
    const len = 2 + Math.floor(Math.random() * 3);
    pits.push([x, x + len]);
    x += len + 40 + Math.floor(Math.random() * 40);
  }

  function isPit(px) {
    return pits.some(([s, e]) => px >= s && px <= e);
  }

  for (let x = 0; x < WORLD_WIDTH; x++) {
    if (isPit(x)) continue;
    const g = baseGround(x);
    for (let y = g; y < WORLD_HEIGHT; y++) setTile(x, y, T.GROUND);
  }

  for (let x = 25; x < WORLD_WIDTH - 25; x += 20 + Math.floor(Math.random() * 15)) {
    if (isPit(x)) continue;
    const g = baseGround(x);
    const y = g - 7 - Math.floor(Math.random() * 5);
    const w = 4 + Math.floor(Math.random() * 5);
    for (let dx = 0; dx < w; dx++) {
      if (x + dx >= WORLD_WIDTH || isPit(x + dx)) continue;
      setTile(x + dx, y, T.PLATFORM);
      if (Math.random() < 0.4) addCoin((x + dx) * TILE_SIZE + 16, (y - 1) * TILE_SIZE + 16);
    }
  }

  for (let x = 30; x < WORLD_WIDTH - 30; x += 25 + Math.floor(Math.random() * 20)) {
    if (isPit(x) || isPit(x + 1)) continue;
    const g = baseGround(x);
    const h = 2 + Math.floor(Math.random() * 3);
    setTile(x, g - 1, T.PIPE_TOP);
    for (let dy = 1; dy <= h; dy++) setTile(x, g - 1 - dy, T.PIPE_BODY);
  }

  for (let x = 12; x < WORLD_WIDTH - 20; x += 4 + Math.floor(Math.random() * 4)) {
    if (isPit(x)) { x++; continue; }
    const g = baseGround(x);
    if (getTile(x, g - 4) === T.AIR) {
      setTile(x, g - 4, Math.random() < 0.25 ? T.QBLOCK : T.BRICK);
    }
  }

  for (let x = 8; x < WORLD_WIDTH - 20; x += 5 + Math.floor(Math.random() * 4)) {
    if (isPit(x)) continue;
    const g = baseGround(x);
    const cy = g - 5;
    if (cy > 3 && getTile(x, cy) === T.AIR && getTile(x, cy - 1) === T.AIR) {
      const pattern = Math.floor(Math.random() * 3);
      for (let i = 0; i < 3; i++) {
        if (pattern === 0) addCoin(x * TILE_SIZE + 16, (cy - i) * TILE_SIZE + 16);
        else if (pattern === 1 && i < 3) addCoin((x + i) * TILE_SIZE + 16, cy * TILE_SIZE + 16);
        else addCoin(x * TILE_SIZE + 16, cy * TILE_SIZE + 16);
      }
    }
  }

  for (let x = 12; x < WORLD_WIDTH - 30; x += 16 + Math.floor(Math.floor(Math.random() * 12))) {
    if (isPit(x) || isPit(x + 1)) continue;
    const g = baseGround(x);
    if (getTile(x, g - 1) === T.AIR && getTile(x + 1, g - 1) === T.AIR) {
      enemies.push({ id: enemyIdCounter++, x: x * TILE_SIZE, y: (g - 1) * TILE_SIZE - ENEMY_H, w: ENEMY_W, h: ENEMY_H, vx: 1 + Math.random(), vy: 0, prevY: (g - 1) * TILE_SIZE - ENEMY_H, dir: 1, dead: false });
    }
  }

  const fx = WORLD_WIDTH - 15;
  const g = baseGround(fx);
  for (let dy = 0; dy < 9; dy++) setTile(fx, g - 1 - dy, T.POLE);
  setTile(fx + 1, g - 8, T.FLAG);

  for (let x = 0; x < 15; x++) {
    const g = baseGround(x);
    for (let y = g; y < WORLD_HEIGHT; y++) setTile(x, y, T.GROUND);
  }
}

function addCoin(px, py) {
  coins.push({ id: coinIdCounter++, x: px, y: py, collected: false });
}

function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 75%, 55%)`;
}

function getWorldTiles() {
  const tiles = [];
  for (let x = 0; x < WORLD_WIDTH; x++) {
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      const t = world[idx(x, y)];
      if (t !== T.AIR) tiles.push({ x, y, t });
    }
  }
  return tiles;
}

function resolveXEntity(e, w, h) {
  const left = Math.floor(e.x / TILE_SIZE);
  const right = Math.floor((e.x + w) / TILE_SIZE);
  const top = Math.floor(e.y / TILE_SIZE);
  const bottom = Math.floor((e.y + h) / TILE_SIZE);

  if (e.vx > 0) {
    for (let ty = top; ty <= bottom; ty++) {
      if (isBlocked(right, ty)) {
        e.x = right * TILE_SIZE - w - 0.001;
        e.vx = 0;
        return true;
      }
    }
  } else if (e.vx < 0) {
    for (let ty = top; ty <= bottom; ty++) {
      if (isBlocked(left, ty)) {
        e.x = (left + 1) * TILE_SIZE + 0.001;
        e.vx = 0;
        return true;
      }
    }
  }
  return false;
}

function resolveYEntity(e, h, isPlayer) {
  const prevBottom = e.prevY !== undefined ? e.prevY + h : e.y + h;
  const left = Math.floor(e.x / TILE_SIZE);
  const right = Math.floor((e.x + e.w) / TILE_SIZE);
  const top = Math.floor(e.y / TILE_SIZE);
  const bottom = Math.floor((e.y + h) / TILE_SIZE);

  e.grounded = false;

  if (e.vy > 0) {
    for (let tx = left; tx <= right; tx++) {
      const t = getTile(tx, bottom);
      if (SOLID[t] || (ONE_WAY[t] && prevBottom <= bottom * TILE_SIZE + 0.1)) {
        e.y = bottom * TILE_SIZE - h - 0.001;
        e.vy = 0;
        e.grounded = true;
        return;
      }
    }
  } else if (e.vy < 0) {
    for (let tx = left; tx <= right; tx++) {
      const t = getTile(tx, top);
      if (SOLID[t]) {
        e.y = (top + 1) * TILE_SIZE + 0.001;
        e.vy = 0;
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

  p.prevY = p.y;
  p.y += p.vy;
  resolveYEntity(p, p.h, true);

  p.x += p.vx;
  resolveXEntity(p, p.w, p.h);

  p.x = Math.max(0, Math.min(p.x, WORLD_WIDTH * TILE_SIZE - p.w));
  p.y = Math.min(p.y, WORLD_HEIGHT * TILE_SIZE - p.h);
  if (p.y < 0) { p.y = 0; p.vy = 0; }

  checkCoins(p);
  checkEnemies(p);
  checkFlag(p);

  if (p.y > (WORLD_HEIGHT - 2) * TILE_SIZE) {
    p.x = 5 * TILE_SIZE;
    p.y = (baseGround(5) - 2) * TILE_SIZE;
    p.vx = 0;
    p.vy = 0;
    p.score = Math.max(0, p.score - 50);
  }
}

function checkCoins(p) {
  for (const c of coins) {
    if (c.collected) continue;
    const dx = p.x + p.w / 2 - c.x;
    const dy = p.y + p.h / 2 - c.y;
    if (Math.hypot(dx, dy) < COIN_RADIUS + Math.min(p.w, p.h) / 2) {
      c.collected = true;
      p.score += 10;
      io.emit('coin-remove', { id: c.id, by: p.id });
    }
  }
}

function checkEnemies(p) {
  for (const e of enemies) {
    if (e.dead) continue;
    if (rectIntersect(p.x, p.y, p.w, p.h, e.x, e.y, ENEMY_W, ENEMY_H)) {
      const playerBottom = p.y + p.h;
      const prevPlayerBottom = p.prevY + p.h;
      if (p.vy > 0 && playerBottom > e.y && prevPlayerBottom <= e.y + 10) {
        e.dead = true;
        p.vy = JUMP * 0.7;
        p.score += 20;
        io.emit('enemy-remove', { id: e.id, by: p.id });
      } else {
        p.x = 5 * TILE_SIZE;
        p.y = (baseGround(5) - 2) * TILE_SIZE;
        p.vx = 0;
        p.vy = 0;
        p.score = Math.max(0, p.score - 30);
      }
    }
  }
}

function checkFlag(p) {
  const fx = (WORLD_WIDTH - 15) * TILE_SIZE;
  const fy = (baseGround(WORLD_WIDTH - 15) - 1) * TILE_SIZE - 8 * TILE_SIZE;
  if (rectIntersect(p.x, p.y, p.w, p.h, fx, fy, TILE_SIZE, TILE_SIZE * 8)) {
    if (!p.finished) {
      p.finished = true;
      p.score += 100;
      io.emit('win', { id: p.id, name: p.name });
    }
  }
}

function rectIntersect(x1, y1, w1, h1, x2, y2, w2, h2) {
  return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
}

function updateEnemies() {
  for (const e of enemies) {
    if (e.dead) continue;

    e.prevY = e.y;
    e.vy += GRAVITY;
    e.y += e.vy;
    resolveYEntity(e, ENEMY_H, false);

    const nextX = e.x + e.vx * e.dir;
    const frontX = e.dir > 0 ? Math.floor((nextX + e.w) / TILE_SIZE) : Math.floor(nextX / TILE_SIZE);
    const bodyY = Math.floor((e.y + e.h / 2) / TILE_SIZE);
    const footY = Math.floor((e.y + e.h) / TILE_SIZE) + 1;
    const frontFootX = e.dir > 0 ? Math.floor((nextX + e.w) / TILE_SIZE) + 1 : Math.floor(nextX / TILE_SIZE) - 1;

    if (isBlocked(frontX, bodyY) || !isGround(frontFootX, footY)) {
      e.dir *= -1;
    } else {
      e.x = nextX;
    }

    e.x = Math.max(0, Math.min(e.x, WORLD_WIDTH * TILE_SIZE - e.w));
    if (e.y > (WORLD_HEIGHT - 2) * TILE_SIZE) e.dead = true;
  }
}

function playersArray() {
  return Array.from(players.values()).map(p => ({
    id: p.id,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    color: p.color,
    name: p.name,
    score: p.score,
    finished: p.finished
  }));
}

function enemiesArray() {
  return enemies.filter(e => !e.dead).map(e => ({ id: e.id, x: e.x, y: e.y, dir: e.dir }));
}

function coinsArray() {
  return coins.filter(c => !c.collected).map(c => ({ id: c.id, x: c.x, y: c.y }));
}

generateLevel();

io.on('connection', (socket) => {
  const spawnX = 5 * TILE_SIZE;
  const spawnY = (baseGround(5) - 2) * TILE_SIZE;
  const player = {
    id: socket.id,
    name: `Player ${socket.id.slice(0, 4)}`,
    x: spawnX,
    y: spawnY,
    vx: 0,
    vy: 0,
    prevY: spawnY,
    w: PLAYER_W,
    h: PLAYER_H,
    color: randomColor(),
    score: 0,
    grounded: false,
    finished: false,
    input: {}
  };
  players.set(socket.id, player);

  socket.emit('init', {
    id: socket.id,
    x: player.x,
    y: player.y,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    tileSize: TILE_SIZE,
    tiles: getWorldTiles(),
    coins: coinsArray(),
    enemies: enemiesArray()
  });

  socket.broadcast.emit('player-joined', { id: player.id, name: player.name, color: player.color });
  socket.emit('state', { players: playersArray(), enemies: enemiesArray(), coins: coinsArray() });

  socket.on('input', (data) => {
    player.input = data || {};
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

let lastBroadcast = 0;
const physicsInterval = setInterval(() => {
  for (const p of players.values()) updatePlayer(p);
  updateEnemies();

  const now = Date.now();
  if (now - lastBroadcast > 33) {
    lastBroadcast = now;
    io.emit('state', {
      players: playersArray(),
      enemies: enemiesArray(),
      coins: coinsArray()
    });
  }
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mario-like server listening on http://localhost:${PORT}`);
});

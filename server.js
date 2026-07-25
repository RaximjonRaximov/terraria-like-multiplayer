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
const CHUNK_W = 64;
const CHUNK_H = 64;
const MAX_PLAYERS = 4;
const PHYSICS_FPS = 60;
const TICK_MS = 1000 / PHYSICS_FPS;

const BIOMES = ['grass', 'desert', 'snow', 'cave', 'forest'];
const BIOME_LENGTH_CHUNKS = 6;

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
  FLAG: 9,
  QUESTION: 10
};

const SOLID = {
  [T.GROUND]: true,
  [T.BRICK]: true,
  [T.PIPE]: true,
  [T.GATE]: true,
  [T.QUESTION]: true
};
const ONE_WAY = { [T.PLATFORM]: true };
const HAZARD = { [T.SPIKE]: true };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function rectIntersect(x1, y1, w1, h1, x2, y2, w2, h2) {
  return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
}
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

class Chunk {
  constructor(room, cx) {
    this.room = room;
    this.cx = cx;
    this.biome = this.pickBiome(cx);
    this.tiles = new Uint8Array(CHUNK_W * CHUNK_H);
    this.entities = [];
    this.loadedBy = new Set();
    this.flagsCollected = new Set();
    this.generate();
  }

  pickBiome(cx) {
    const idx = Math.floor(Math.abs(cx) / BIOME_LENGTH_CHUNKS) % BIOMES.length;
    return BIOMES[idx];
  }

  idx(x, y) { return y * CHUNK_W + x; }
  inBounds(x, y) { return x >= 0 && x < CHUNK_W && y >= 0 && y < CHUNK_H; }
  getTile(x, y) {
    if (!this.inBounds(x, y)) return T.AIR;
    return this.tiles[this.idx(x, y)];
  }
  setTile(x, y, t) {
    if (this.inBounds(x, y)) this.tiles[this.idx(x, y)] = t;
  }

  generate() {
    const rng = mulberry32(this.room.seed + this.cx * 12345 + 9999);
    const groundBase = 44 + Math.floor(Math.sin(this.cx / 4) * 4);
    const biome = this.biome;
    const difficulty = Math.floor(Math.abs(this.cx) / 3);

    // biome-specific generation tweaks
    let pitExtra = 0, enemyExtra = 0, featureExtra = 0, sawExtra = 0;
    let flyerThresh = 0.7, jumperThresh = 0.9;
    if (biome === 'desert') { pitExtra = 1; enemyExtra = -1; sawExtra = 1; }
    if (biome === 'snow') { featureExtra = 2; }
    if (biome === 'cave') { enemyExtra = 1; sawExtra = 1; flyerThresh = 0.55; jumperThresh = 0.85; }
    if (biome === 'forest') { featureExtra = 1; sawExtra = -1; }

    // ground
    for (let tx = 0; tx < CHUNK_W; tx++) {
      const globalX = this.cx * CHUNK_W + tx;
      const h = groundBase + Math.floor(Math.sin(globalX / 10) * 3 + Math.cos(globalX / 6) * 2);
      for (let ty = h; ty < CHUNK_H; ty++) this.setTile(tx, ty, T.GROUND);
    }

    // pits
    const pitCount = Math.floor(rng() * (1 + difficulty * 0.2)) + 1 + pitExtra;
    for (let i = 0; i < pitCount; i++) {
      const start = Math.floor(rng() * (CHUNK_W - 8)) + 2;
      const len = 2 + Math.floor(rng() * 3);
      for (let tx = start; tx < start + len; tx++) {
        for (let ty = 0; ty < CHUNK_H; ty++) this.setTile(tx, ty, T.AIR);
      }
    }

    // platforms / bricks / coins
    const featureCount = 4 + Math.floor(rng() * 5) + difficulty + featureExtra;
    for (let i = 0; i < featureCount; i++) {
      const tx = Math.floor(rng() * (CHUNK_W - 6)) + 1;
      const g = this.findGroundY(tx);
      if (g < 10) continue;
      const kind = rng();
      if (kind < 0.25) {
        // brick/question block
        const y = g - 4 - Math.floor(rng() * 2);
        if (this.getTile(tx, y) === T.AIR) this.setTile(tx, y, rng() < 0.4 ? T.QUESTION : T.BRICK);
      } else if (kind < 0.55) {
        // platform with coins
        const y = g - 5 - Math.floor(rng() * 4);
        const w = 3 + Math.floor(rng() * 4);
        for (let dx = 0; dx < w; dx++) {
          if (tx + dx >= CHUNK_W) break;
          this.setTile(tx + dx, y, T.PLATFORM);
          if (rng() < 0.4) this.addCoin((tx + dx) * TILE_SIZE + TILE_SIZE / 2, (y - 1) * TILE_SIZE + TILE_SIZE / 2);
        }
      } else if (kind < 0.75) {
        // pipe
        const y = g - 1;
        const ph = 2 + Math.floor(rng() * 3);
        this.setTile(tx, y, T.PIPE);
        for (let dy = 1; dy <= ph; dy++) this.setTile(tx, y - dy, T.PIPE);
      } else if (kind < 0.85) {
        // switch + gate puzzle
        const gateY = g - 4 - Math.floor(rng() * 3);
        const gateX = Math.min(CHUNK_W - 2, tx + 2 + Math.floor(rng() * 4));
        this.setTile(gateX, gateY, T.GATE);
        const swY = g - 1 - Math.floor(rng() * 2);
        this.setTile(tx, swY, T.SWITCH);
      } else {
        // spikes
        const y = g - 1;
        for (let dx = 0; dx < 2 + Math.floor(rng() * 3); dx++) {
          if (tx + dx < CHUNK_W && this.getTile(tx + dx, y) === T.GROUND) this.setTile(tx + dx, y, T.SPIKE);
        }
      }
    }

    // enemies
    const enemyCount = 2 + Math.floor(rng() * 3) + Math.floor(difficulty / 2) + enemyExtra;
    for (let i = 0; i < enemyCount; i++) {
      const tx = Math.floor(rng() * (CHUNK_W - 4)) + 2;
      const g = this.findGroundY(tx);
      if (g < 6 || g > CHUNK_H - 4) continue;
      const roll = rng();
      const x = this.cx * CHUNK_W * TILE_SIZE + tx * TILE_SIZE;
      const y = g * TILE_SIZE - 40;
      if (roll < 0.45) this.addEnemy('walker', x, y);
      else if (roll < flyerThresh) this.addEnemy('flyer', x, y - 80 - rng() * 60);
      else if (roll < jumperThresh) this.addEnemy('jumper', x, y);
      else this.addEnemy('spikebug', x, y);
    }

    // moving saws
    const sawCount = Math.max(0, Math.floor(rng() * 2) + Math.floor(difficulty / 3) + sawExtra);
    for (let i = 0; i < sawCount; i++) {
      const tx = Math.floor(rng() * (CHUNK_W - 4)) + 2;
      const g = this.findGroundY(tx);
      const x = this.cx * CHUNK_W * TILE_SIZE + tx * TILE_SIZE;
      this.addEnemy('saw', x, (g - 3 - rng() * 3) * TILE_SIZE);
    }

    // coins on ground arcs
    const coinArcs = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < coinArcs; i++) {
      const tx = Math.floor(rng() * (CHUNK_W - 6)) + 2;
      const g = this.findGroundY(tx);
      if (g < 8) continue;
      const y = (g - 2) * TILE_SIZE + TILE_SIZE / 2;
      const pattern = Math.floor(rng() * 3);
      for (let k = 0; k < 4; k++) {
        if (pattern === 0) this.addCoin((tx + k) * TILE_SIZE + TILE_SIZE / 2, y);
        else if (pattern === 1) this.addCoin(tx * TILE_SIZE + TILE_SIZE / 2, (g - 2 - k) * TILE_SIZE + TILE_SIZE / 2);
        else this.addCoin((tx + (k % 2)) * TILE_SIZE + TILE_SIZE / 2, (g - 2 - Math.floor(k / 2)) * TILE_SIZE + TILE_SIZE / 2);
      }
      // powerups occasionally above coin arcs
      if (rng() < 0.12) this.addPowerUp('heart', tx * TILE_SIZE + TILE_SIZE / 2, (g - 6) * TILE_SIZE + TILE_SIZE / 2);
      if (rng() < 0.08) this.addPowerUp('star', tx * TILE_SIZE + TILE_SIZE / 2, (g - 7) * TILE_SIZE + TILE_SIZE / 2);
      if (rng() < 0.06) this.addPowerUp('wing', tx * TILE_SIZE + TILE_SIZE / 2, (g - 5) * TILE_SIZE + TILE_SIZE / 2);
    }

    // biome transition flag pole at the end of each biome (last chunk)
    if (this.cx > 0 && (this.cx + 1) % BIOME_LENGTH_CHUNKS === 0) {
      const flagX = CHUNK_W - 5;
      const g = this.findGroundY(flagX);
      if (g > 5 && g < CHUNK_H - 3) {
        for (let dy = 0; dy < 6; dy++) this.setTile(flagX, g - 1 - dy, T.POLE);
        this.setTile(flagX + 1, g - 7, T.FLAG);
      }
    }
  }

  findGroundY(tx) {
    for (let ty = 0; ty < CHUNK_H; ty++) if (this.tiles[this.idx(tx, ty)] === T.GROUND) return ty;
    return CHUNK_H - 4;
  }

  addCoin(px, py) {
    this.entities.push({
      id: this.room.nextEntityId++,
      type: 'coin',
      x: px, y: py, w: 16, h: 16,
      collected: false,
      chunkX: this.cx
    });
  }

  addPowerUp(kind, px, py) {
    this.entities.push({
      id: this.room.nextEntityId++,
      type: kind,
      x: px, y: py, w: 20, h: 20,
      collected: false,
      chunkX: this.cx
    });
  }

  addEnemy(kind, px, py) {
    let w = 30, h = 36, vx = 1.2 + Math.random(), vy = 0, hp = 1;
    if (kind === 'flyer') { w = 34; h = 28; vx = 1.8; vy = 0; }
    if (kind === 'jumper') { w = 30; h = 34; vx = 1.0; }
    if (kind === 'spikebug') { w = 32; h = 26; vx = 1.4; }
    if (kind === 'saw') { w = 34; h = 34; vx = 1.6; }
    this.entities.push({
      id: this.room.nextEntityId++,
      type: kind,
      x: px, y: py, w, h, vx, vy,
      dir: 1,
      hp,
      dead: false,
      prevY: py,
      jumpTimer: Math.random() * 120,
      sawAngle: 0,
      chunkX: this.cx
    });
  }

  serialize() {
    return { cx: this.cx, biome: this.biome, tiles: Array.from(this.tiles) };
  }
}

class Room {
  constructor(hostId, name) {
    this.id = makeCode();
    this.name = name || `Room ${this.id}`;
    this.hostId = hostId;
    this.players = new Map();
    this.sockets = new Map();
    this.chunks = new Map();
    this.seed = Math.floor(Math.random() * 1e9);
    this.nextEntityId = 1;
    this.started = false;
    this.maxPlayers = MAX_PLAYERS;
    this.mission = { type: 'coins', target: 10, current: 0, reward: 50, level: 1 };
    this.missionCount = 0;
    this.events = [];
  }

  publicInfo() {
    return {
      id: this.id,
      name: this.name,
      host: this.players.get(this.hostId)?.name || 'Host',
      hostId: this.hostId,
      players: this.players.size,
      playerList: Array.from(this.players.values()).map(p => ({ id: p.id, name: p.name })),
      max: this.maxPlayers,
      started: this.started
    };
  }

  addPlayer(socket) {
    const p = {
      id: socket.id,
      socket,
      name: `Player ${socket.id.slice(0, 4)}`,
      color: `hsl(${Math.floor(Math.random() * 360)}, 75%, 55%)`,
      x: 0, y: 0, vx: 0, vy: 0, prevY: 0,
      w: 24, h: 36,
      score: 0, coins: 0, kills: 0,
      health: 3, maxHealth: 3,
      invincible: 0,
      starTimer: 0,
      wingTimer: 0,
      airJumps: 0,
      grounded: false,
      input: {},
      loadedChunks: new Set(),
      distance: 0,
      mission: null,
      checkpointChunk: 0,
      checkpointTx: 3
    };
    this.players.set(socket.id, p);
    this.sockets.set(socket.id, socket);
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.sockets.delete(id);
    if (this.hostId === id) {
      const next = this.players.keys().next().value;
      this.hostId = next || null;
    }
    if (this.players.size === 0) {
      return true;
    }
    return false;
  }

  start() {
    this.started = true;
    this.generateSpawnChunks();
    let i = 0;
    for (const p of this.players.values()) {
      p.checkpointChunk = 0;
      p.checkpointTx = Math.min(CHUNK_W - 4, 3 + i * 2);
      p.x = p.checkpointTx * TILE_SIZE;
      p.y = (this.findGroundY(Math.floor(p.x / TILE_SIZE)) - 3) * TILE_SIZE;
      p.prevY = p.y;
      i++;
    }
    this.nextMission();
    for (const socket of this.sockets.values()) socket.emit('game-start', this.getInitData(socket.id));
  }

  generateSpawnChunks() {
    for (let cx = -1; cx <= 2; cx++) this.getOrCreateChunk(cx);
  }

  getOrCreateChunk(cx) {
    if (!this.chunks.has(cx)) this.chunks.set(cx, new Chunk(this, cx));
    return this.chunks.get(cx);
  }

  globalTile(gx, gy) {
    const cx = Math.floor(gx / CHUNK_W);
    const chunk = this.chunks.get(cx);
    if (!chunk) return T.AIR;
    const tx = gx - cx * CHUNK_W;
    return chunk.getTile(tx, gy);
  }

  setGlobalTile(gx, gy, t) {
    const cx = Math.floor(gx / CHUNK_W);
    const chunk = this.getOrCreateChunk(cx);
    const tx = gx - cx * CHUNK_W;
    chunk.setTile(tx, gy, t);
  }

  findGroundY(gx) {
    const cx = Math.floor(gx / CHUNK_W);
    const chunk = this.getOrCreateChunk(cx);
    const tx = gx - cx * CHUNK_W;
    return chunk.findGroundY(tx);
  }

  getChunksAround(px, py, radiusChunks = 2) {
    const tcx = Math.floor(px / CHUNK_W / TILE_SIZE);
    const tcy = Math.floor(py / CHUNK_H / TILE_SIZE);
    const needed = [];
    for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        needed.push(tcx + dx);
      }
    }
    return [...new Set(needed)];
  }

  ensureChunksForPlayers() {
    const needed = new Set();
    for (const p of this.players.values()) {
      for (const cx of this.getChunksAround(p.x, p.y, 2)) needed.add(cx);
    }
    for (const cx of needed) this.getOrCreateChunk(cx);
    return needed;
  }

  nextMission() {
    this.missionCount++;
    const types = ['coins', 'kills', 'distance', 'score'];
    const type = types[this.missionCount % types.length];
    const mul = 1 + Math.floor(this.missionCount / 4) * 0.5;
    let target = 10;
    if (type === 'coins') target = Math.floor(10 * mul);
    if (type === 'kills') target = Math.floor(3 * mul);
    if (type === 'distance') target = Math.floor(500 * mul);
    if (type === 'score') target = Math.floor(200 * mul);
    this.mission = { type, target, current: 0, reward: Math.floor(50 * mul), level: this.missionCount };
    this.broadcast('mission', this.mission);
  }

  updateMission() {
    const m = this.mission;
    let maxCur = 0;
    let completer = null;
    for (const p of this.players.values()) {
      let cur = 0;
      if (m.type === 'coins') cur = p.coins;
      if (m.type === 'kills') cur = p.kills;
      if (m.type === 'distance') cur = Math.floor(p.distance / 100);
      if (m.type === 'score') cur = p.score;
      if (cur >= m.target) { completer = p; break; }
      if (cur > maxCur) maxCur = cur;
    }
    if (completer) {
      for (const p of this.players.values()) p.score += m.reward;
      this.events.push({ type: 'mission-complete', player: completer.name, reward: m.reward });
      this.nextMission();
      return true;
    }
    this.mission.current = maxCur;
    return false;
  }

  update() {
    if (!this.started) return;
    this.ensureChunksForPlayers();

    // update chunks state (gate toggles, etc)
    for (const chunk of this.chunks.values()) {
      // nothing dynamic per tick for tiles
    }

    // update players
    for (const p of this.players.values()) this.updatePlayer(p);
    // update entities
    this.updateEntities();
    // check mission progress (room-wide)
    this.updateMission();

    // send states and chunks
    const now = Date.now();
    for (const p of this.players.values()) {
      this.sendState(p, now);
    }
    this.events = [];
  }

  broadcast(event, data) {
    for (const socket of this.sockets.values()) socket.emit(event, data);
  }

  getInitData(playerId) {
    const p = this.players.get(playerId);
    const initChunks = [];
    for (let cx = -2; cx <= 3; cx++) {
      const c = this.getOrCreateChunk(cx);
      p.loadedChunks.add(cx);
      initChunks.push(c.serialize());
    }
    return {
      id: playerId,
      room: this.publicInfo(),
      tileSize: TILE_SIZE,
      chunkW: CHUNK_W,
      chunkH: CHUNK_H,
      chunks: initChunks,
      x: p.x, y: p.y,
      mission: this.mission,
      players: this.playersArray(),
      entities: this.entitiesArray()
    };
  }

  playersArray() {
    return Array.from(this.players.values()).map(p => ({
      id: p.id, name: p.name, color: p.color,
      x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      score: p.score, health: p.health, maxHealth: p.maxHealth,
      invincible: p.invincible, facing: p.vx >= 0 ? 1 : -1,
      distance: p.distance
    }));
  }

  entitiesArray() {
    const arr = [];
    for (const chunk of this.chunks.values()) {
      for (const e of chunk.entities) {
        if (e.collected || e.dead) continue;
        arr.push({
          id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, h: e.h,
          dir: e.dir, sawAngle: e.sawAngle
        });
      }
    }
    return arr;
  }

  visibleEntitiesFor(p) {
    const arr = [];
    const px = p.x, py = p.y;
    const r2 = (CHUNK_W * TILE_SIZE * 2.5) ** 2;
    for (const chunk of this.chunks.values()) {
      for (const e of chunk.entities) {
        if (e.collected || e.dead) continue;
        if (dist2(e.x + e.w / 2, e.y + e.h / 2, px + p.w / 2, py + p.h / 2) < r2) {
          arr.push({
            id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, h: e.h,
            dir: e.dir, sawAngle: e.sawAngle
          });
        }
      }
    }
    return arr;
  }

  sendState(p, now) {
    const socket = p.socket;
    const tcx = Math.floor(p.x / CHUNK_W / TILE_SIZE);
    // send new nearby chunks
    const newChunks = [];
    for (let cx = tcx - 2; cx <= tcx + 2; cx++) {
      if (!p.loadedChunks.has(cx)) {
        const c = this.getOrCreateChunk(cx);
        p.loadedChunks.add(cx);
        newChunks.push(c.serialize());
      }
    }
    const events = this.events.slice();

    const nearbyPlayers = [];
    for (const other of this.players.values()) {
      if (other.id === p.id) continue;
      if (Math.abs(other.x - p.x) < CHUNK_W * TILE_SIZE * 2.5) nearbyPlayers.push({
        id: other.id, name: other.name, color: other.color,
        x: other.x, y: other.y, vx: other.vx, vy: other.vy,
        w: other.w, h: other.h,
        score: other.score, health: other.health, maxHealth: other.maxHealth,
        invincible: other.invincible, starTimer: other.starTimer, wingTimer: other.wingTimer, grounded: other.grounded, facing: other.vx >= 0 ? 1 : -1
      });
    }

    socket.emit('state', {
      me: p.id,
      players: [this.selfState(p), ...nearbyPlayers],
      entities: this.visibleEntitiesFor(p),
      chunks: newChunks,
      mission: this.mission,
      events,
      time: now
    });
  }

  selfState(p) {
    return {
      id: p.id, name: p.name, color: p.color,
      x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      w: p.w, h: p.h,
      score: p.score, health: p.health, maxHealth: p.maxHealth,
      invincible: p.invincible, starTimer: p.starTimer, wingTimer: p.wingTimer, grounded: p.grounded, facing: p.vx >= 0 ? 1 : -1,
      distance: p.distance, self: true
    };
  }

  updatePlayer(p) {
    const input = p.input || {};
    const biome = this.biomeAt(p.x);
    const accel = 0.8;
    const maxSpeed = p.starTimer > 0 ? 10 : 6;
    const jump = p.starTimer > 0 ? -17 : -14;
    const gravity = 0.65, friction = biome === 'snow' ? 0.965 : 0.88;
    if (p.starTimer > 0) { p.starTimer--; p.invincible = Math.max(p.invincible, 1); }
    if (p.wingTimer > 0) p.wingTimer--;
    if (input.left) p.vx -= accel;
    if (input.right) p.vx += accel;
    p.vx *= friction;
    p.vx = clamp(p.vx, -maxSpeed, maxSpeed);
    if (p.grounded && input.jump) { p.vy = jump; p.grounded = false; p.airJumps = p.wingTimer > 0 ? 1 : 0; }
    else if (!p.grounded && input.jump && p.vy > 0 && p.wingTimer > 0 && p.airJumps > 0) { p.vy = jump; p.airJumps--; }
    p.vy += gravity;

    p.prevY = p.y;
    p.y += p.vy;
    this.resolveY(p, p.h);
    p.x += p.vx;
    this.resolveX(p, p.w, p.h);

    p.x = Math.max(0, p.x);
    if (p.y > CHUNK_H * TILE_SIZE * 2) this.respawn(p);
    if (p.y < 0) { p.y = 0; p.vy = 0; }

    p.distance = Math.max(p.distance, p.x);
    if (p.invincible > 0) p.invincible--;

    this.checkCollectibles(p);
    this.checkHazards(p);
    this.checkEnemies(p);
    this.checkSwitches(p);
    this.checkFlags(p);
  }

  resolveX(p, w, h) {
    const left = Math.floor(p.x / TILE_SIZE);
    const right = Math.floor((p.x + w) / TILE_SIZE);
    const top = Math.floor(p.y / TILE_SIZE);
    const bottom = Math.floor((p.y + h) / TILE_SIZE);
    if (p.vx > 0) {
      for (let ty = top; ty <= bottom; ty++) {
        if (this.isSolid(right, ty)) {
          p.x = right * TILE_SIZE - w - 0.001;
          p.vx = 0;
          return;
        }
      }
    } else if (p.vx < 0) {
      for (let ty = top; ty <= bottom; ty++) {
        if (this.isSolid(left, ty)) {
          p.x = (left + 1) * TILE_SIZE + 0.001;
          p.vx = 0;
          return;
        }
      }
    }
  }

  resolveY(p, h) {
    const prevBottom = p.prevY + h;
    const left = Math.floor(p.x / TILE_SIZE);
    const right = Math.floor((p.x + p.w) / TILE_SIZE);
    const top = Math.floor(p.y / TILE_SIZE);
    const bottom = Math.floor((p.y + h) / TILE_SIZE);
    p.grounded = false;
    if (p.vy > 0) {
      for (let tx = left; tx <= right; tx++) {
        const t = this.globalTile(tx, bottom);
        if (SOLID[t] || (ONE_WAY[t] && prevBottom <= bottom * TILE_SIZE + 0.1)) {
          p.y = bottom * TILE_SIZE - h - 0.001;
          p.vy = 0;
          p.grounded = true;
          return;
        }
      }
    } else if (p.vy < 0) {
      for (let tx = left; tx <= right; tx++) {
        if (this.isSolid(tx, top)) {
          p.y = (top + 1) * TILE_SIZE + 0.001;
          p.vy = 0;
          return;
        }
      }
    }
  }

  isSolid(gx, gy) {
    const t = this.globalTile(gx, gy);
    return SOLID[t] || false;
  }

  biomeAt(x) {
    const cx = Math.floor(x / CHUNK_W / TILE_SIZE);
    const chunk = this.chunks.get(cx);
    return chunk ? chunk.biome : 'grass';
  }

  checkCollectibles(p) {
    for (const chunk of this.chunks.values()) {
      for (const c of chunk.entities) {
        if (c.collected) continue;
        const w = c.w || 16, h = c.h || 16;
        if (!rectIntersect(p.x, p.y, p.w, p.h, c.x - w / 2, c.y - h / 2, w, h)) continue;
        if (c.type === 'coin') {
          c.collected = true;
          p.coins++; p.score += 10;
          this.events.push({ type: 'coin', x: c.x, y: c.y });
        } else if (c.type === 'heart') {
          c.collected = true;
          p.health = Math.min(p.health + 1, p.maxHealth);
          this.events.push({ type: 'heart', x: c.x, y: c.y });
        } else if (c.type === 'star') {
          c.collected = true;
          p.starTimer = 360; // 6 seconds
          p.score += 50;
          this.events.push({ type: 'star', x: c.x, y: c.y });
        } else if (c.type === 'wing') {
          c.collected = true;
          p.wingTimer = 420; // 7 seconds
          p.airJumps = 1;
          p.score += 50;
          this.events.push({ type: 'wing', x: c.x, y: c.y });
        }
      }
    }
  }

  checkHazards(p) {
    const left = Math.floor(p.x / TILE_SIZE);
    const right = Math.floor((p.x + p.w) / TILE_SIZE);
    const bottom = Math.floor((p.y + p.h) / TILE_SIZE);
    for (let tx = left; tx <= right; tx++) {
      const t = this.globalTile(tx, bottom);
      if (HAZARD[t]) this.damage(p, 1, 'spike');
    }
  }

  checkSwitches(p) {
    const cx = Math.floor(p.x / CHUNK_W / TILE_SIZE);
    const chunk = this.chunks.get(cx);
    if (!chunk) return;
    const left = Math.floor(p.x / TILE_SIZE) - cx * CHUNK_W;
    const right = Math.floor((p.x + p.w) / TILE_SIZE) - cx * CHUNK_W;
    const top = Math.floor(p.y / TILE_SIZE);
    const bottom = Math.floor((p.y + p.h) / TILE_SIZE);
    for (let tx = Math.max(0, left); tx <= Math.min(CHUNK_W - 1, right); tx++) {
      for (let ty = top; ty <= bottom; ty++) {
        const tile = chunk.getTile(tx, ty);
        if (tile === T.SWITCH && p.vy < 0) {
          this.toggleGates();
          chunk.setTile(tx, ty, T.AIR);
          this.events.push({ type: 'switch', x: (cx * CHUNK_W + tx) * TILE_SIZE, y: ty * TILE_SIZE });
        } else if (tile === T.QUESTION && p.vy < 0) {
          chunk.setTile(tx, ty, T.BRICK);
          const roll = Math.random();
          const px = (cx * CHUNK_W + tx) * TILE_SIZE + TILE_SIZE / 2;
          const py = (ty - 1) * TILE_SIZE + TILE_SIZE / 2;
          if (roll < 0.25) chunk.addPowerUp('heart', px, py);
          else if (roll < 0.5) chunk.addPowerUp('star', px, py);
          else if (roll < 0.75) chunk.addPowerUp('wing', px, py);
          else {
            for (let i = 0; i < 3; i++) chunk.addCoin(px + (i - 1) * 10, py);
          }
          this.events.push({ type: 'switch', x: px, y: ty * TILE_SIZE }); // reuse sound event
        }
      }
    }
  }

  checkFlags(p) {
    const cx = Math.floor(p.x / CHUNK_W / TILE_SIZE);
    const chunk = this.chunks.get(cx);
    if (!chunk) return;
    const left = Math.floor(p.x / TILE_SIZE) - cx * CHUNK_W;
    const right = Math.floor((p.x + p.w) / TILE_SIZE) - cx * CHUNK_W;
    const top = Math.floor(p.y / TILE_SIZE);
    const bottom = Math.floor((p.y + p.h) / TILE_SIZE);
    for (let tx = Math.max(0, left); tx <= Math.min(CHUNK_W - 1, right); tx++) {
      for (let ty = top; ty <= bottom; ty++) {
        if (chunk.getTile(tx, ty) === T.FLAG && !chunk.flagsCollected.has(p.id)) {
          chunk.flagsCollected.add(p.id);
          p.score += 100;
          p.checkpointChunk = cx;
          p.checkpointTx = tx;
          this.events.push({ type: 'flag', x: (cx * CHUNK_W + tx) * TILE_SIZE, y: ty * TILE_SIZE, biome: chunk.biome });
        }
      }
    }
  }

  toggleGates() {
    for (const chunk of this.chunks.values()) {
      for (let i = 0; i < chunk.tiles.length; i++) {
        if (chunk.tiles[i] === T.GATE) chunk.tiles[i] = T.AIR;
      }
    }
    this.broadcast('gates-open');
  }

  checkEnemies(p) {
    for (const chunk of this.chunks.values()) {
      for (const e of chunk.entities) {
        if (e.dead || e.collected || e.type === 'coin' || e.type === 'heart' || e.type === 'star' || e.type === 'wing') continue;
        if (!rectIntersect(p.x, p.y, p.w, p.h, e.x, e.y, e.w, e.h)) continue;
        if (p.starTimer > 0) {
          e.dead = true;
          p.score += 20; p.kills++;
          this.events.push({ type: 'stomp', x: e.x + e.w / 2, y: e.y + e.h / 2 });
          continue;
        }
        const playerBottom = p.y + p.h;
        const prevPlayerBottom = p.prevY + p.h;
        if (p.vy > 0 && playerBottom > e.y + 4 && prevPlayerBottom <= e.y + e.h * 0.6) {
          e.dead = true;
          p.vy = -10;
          p.score += 20; p.kills++;
          this.events.push({ type: 'stomp', x: e.x + e.w / 2, y: e.y + e.h / 2 });
        } else {
          this.damage(p, 1, e.type);
        }
      }
    }
  }

  damage(p, amount, source) {
    if (p.invincible > 0 || p.starTimer > 0) return;
    p.health -= amount;
    p.invincible = 60; // ~1s
    p.vy = -6;
    if (source && source.x !== undefined) {
      p.vx = (p.x + p.w / 2) > source.x ? 4 : -4;
    } else {
      p.vx = -p.vx || -2;
    }
    if (p.health <= 0) this.respawn(p);
  }

  respawn(p) {
    p.health = p.maxHealth;
    p.starTimer = 0;
    p.wingTimer = 0;
    p.airJumps = 0;
    p.score = Math.max(0, p.score - 50);
    const gx = p.checkpointChunk * CHUNK_W + p.checkpointTx;
    p.x = gx * TILE_SIZE;
    const ground = this.findGroundY(gx);
    p.y = (Math.max(2, ground) - 3) * TILE_SIZE;
    p.vx = 0; p.vy = 0;
    p.invincible = 120;
    p.socket.emit('die', { score: p.score });
  }

  updateEntities() {
    for (const chunk of this.chunks.values()) {
      for (const e of chunk.entities) {
        if (e.dead || e.collected) continue;
        if (e.type === 'coin') continue;
        if (e.type === 'walker') this.updateWalker(e);
        else if (e.type === 'jumper') this.updateJumper(e);
        else if (e.type === 'flyer') this.updateFlyer(e);
        else if (e.type === 'spikebug') this.updateSpikebug(e);
        else if (e.type === 'saw') this.updateSaw(e);
      }
    }
  }

  updateWalker(e) {
    e.prevY = e.y;
    e.vy += 0.65;
    e.y += e.vy;
    this.resolveEntityY(e);
    const nextX = e.x + e.vx * e.dir;
    const front = e.dir > 0 ? Math.floor((nextX + e.w) / TILE_SIZE) : Math.floor(nextX / TILE_SIZE);
    const bodyY = Math.floor((e.y + e.h / 2) / TILE_SIZE);
    const footY = Math.floor((e.y + e.h) / TILE_SIZE) + 1;
    const frontFootX = e.dir > 0 ? Math.floor((nextX + e.w) / TILE_SIZE) + 1 : Math.floor(nextX / TILE_SIZE) - 1;
    if (this.isSolid(front, bodyY) || !this.isGround(frontFootX, footY)) {
      e.dir *= -1;
    } else {
      e.x = nextX;
    }
  }

  updateJumper(e) {
    e.jumpTimer--;
    if (e.grounded && e.jumpTimer <= 0) { e.vy = -12; e.grounded = false; e.jumpTimer = 90 + Math.random() * 90; }
    this.updateWalker(e);
  }

  updateFlyer(e) {
    const nextX = e.x + e.vx * e.dir;
    const front = e.dir > 0 ? Math.floor((nextX + e.w) / TILE_SIZE) : Math.floor(nextX / TILE_SIZE);
    const midY = Math.floor((e.y + e.h / 2) / TILE_SIZE);
    if (this.isSolid(front, midY)) e.dir *= -1; else e.x = nextX;
    e.y += Math.sin(Date.now() / 300 + e.id) * 0.4;
  }

  updateSpikebug(e) {
    this.updateWalker(e);
  }

  updateSaw(e) {
    const nextX = e.x + e.vx * e.dir;
    const front = e.dir > 0 ? Math.floor((nextX + e.w) / TILE_SIZE) : Math.floor(nextX / TILE_SIZE);
    const midY = Math.floor((e.y + e.h / 2) / TILE_SIZE);
    const belowY = Math.floor((e.y + e.h) / TILE_SIZE) + 1;
    if (this.isSolid(front, midY) || this.isSolid(front, midY + 1) || !this.isGround(front, belowY)) e.dir *= -1; else e.x = nextX;
    e.sawAngle += 0.2;
  }

  resolveEntityY(e) {
    const left = Math.floor(e.x / TILE_SIZE);
    const right = Math.floor((e.x + e.w) / TILE_SIZE);
    const bottom = Math.floor((e.y + e.h) / TILE_SIZE);
    e.grounded = false;
    if (e.vy > 0) {
      for (let tx = left; tx <= right; tx++) {
        const t = this.globalTile(tx, bottom);
        if (SOLID[t] || ONE_WAY[t]) {
          e.y = bottom * TILE_SIZE - e.h - 0.001;
          e.vy = 0;
          e.grounded = true;
          return;
        }
      }
    }
    e.y += e.vy; // no ceiling collision for enemies
  }

  isGround(gx, gy) {
    const t = this.globalTile(gx, gy);
    return SOLID[t] || ONE_WAY[t] || false;
  }
}

const rooms = new Map();
const socketRoom = new Map();

function getRooms() {
  return Array.from(rooms.values()).map(r => r.publicInfo());
}

function findRoomBySocket(socketId) {
  const roomId = socketRoom.get(socketId);
  return roomId ? rooms.get(roomId) : null;
}

io.on('connection', (socket) => {
  socket.emit('rooms', getRooms());

  socket.on('list-rooms', () => socket.emit('rooms', getRooms()));

  socket.on('create-room', (data) => {
    if (socketRoom.has(socket.id)) return socket.emit('error', 'Already in a room');
    const room = new Room(socket.id, data?.name);
    rooms.set(room.id, room);
    const p = room.addPlayer(socket);
    if (data?.playerName) p.name = String(data.playerName).slice(0, 20);
    socketRoom.set(socket.id, room.id);
    socket.join(room.id);
    socket.emit('joined-room', { roomId: room.id, role: 'host', playerId: socket.id });
    io.emit('rooms', getRooms());
  });

  socket.on('join-room', (data) => {
    const roomId = (typeof data === 'string' ? data : data?.roomId) || '';
    if (socketRoom.has(socket.id)) return socket.emit('error', 'Already in a room');
    const room = rooms.get(roomId.toUpperCase());
    if (!room) return socket.emit('error', 'Room not found');
    if (room.players.size >= room.maxPlayers) return socket.emit('error', 'Room full');
    const p = room.addPlayer(socket);
    if (data?.playerName) p.name = String(data.playerName).slice(0, 20);
    socketRoom.set(socket.id, room.id);
    socket.join(room.id);
    socket.emit('joined-room', { roomId: room.id, role: 'join', playerId: socket.id });
    io.to(room.id).emit('room-update', room.publicInfo());
    io.emit('rooms', getRooms());
  });

  socket.on('start-game', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.start();
  });

  socket.on('input', (data) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) p.input = data || {};
  });

  socket.on('set-name', (name) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p && typeof name === 'string' && name.length <= 20) {
      p.name = name.trim() || p.name;
      io.to(room.id).emit('room-update', room.publicInfo());
      io.emit('rooms', getRooms());
    }
  });

  socket.on('disconnect', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const empty = room.removePlayer(socket.id);
    socketRoom.delete(socket.id);
    if (empty) {
      rooms.delete(roomId);
    } else {
      io.to(roomId).emit('room-update', room.publicInfo());
    }
    io.emit('rooms', getRooms());
  });
});

setInterval(() => {
  for (const room of rooms.values()) room.update();
}, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mario-like endless server listening on http://localhost:${PORT}`);
});

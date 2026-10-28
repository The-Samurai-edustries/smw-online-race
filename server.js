// Super Mario World Online Race — relay server.
// Serves the browser client and relays tiny position/progress packets between racers.
// The server never sees or stores any game data: every player loads their own ROM locally.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT || "8080", 10);
const PUBLIC = path.join(__dirname, "public");
const TICK_MS = 66;            // ~15 broadcasts per second
const COUNTDOWN_MS = 5000;
const MAX_PLAYERS = 8;
const COLORS = ["#ff4d4d", "#4da6ff", "#4dff88", "#ffd24d", "#c44dff", "#ff8c1a", "#1affd5", "#ff66c4"];

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm", ".data": "application/octet-stream", ".png": "image/png",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
};

// ---------- static files ----------
const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch { res.writeHead(400); return res.end("bad request"); }
  if (urlPath === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end("forbidden"); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("not found"); }
    const ext = path.extname(file).toLowerCase();
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": st.size };
    headers["Cache-Control"] = file.includes(path.sep + "ejs" + path.sep) ? "public, max-age=86400" : "no-cache";
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
});

// ---------- rooms ----------
/** room: { code, players: Map<id, player>, phase: 'lobby'|'countdown'|'racing'|'done', goAt, hostId, finishOrder } */
const rooms = new Map();
let nextId = 1;

function cleanName(s) {
  return String(s || "").replace(/[^\w \-!?.'#]/g, "").trim().slice(0, 16) || "Player";
}
function cleanRoom(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}
function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = { code, players: new Map(), phase: "lobby", goAt: 0, hostId: null, finishOrder: [] };
    rooms.set(code, r);
  }
  return r;
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, ready: p.ready, romOk: p.romOk, romCrc: p.romCrc || null,
           finished: p.finished, time: p.time, place: p.place, forfeit: p.forfeit, host: false };
}
function roster(room) {
  return [...room.players.values()].map(p => ({ ...publicPlayer(p), host: p.id === room.hostId }));
}
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { const s = JSON.stringify(msg); for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
function pushRoster(room) { broadcast(room, { t: "room", phase: room.phase, hostId: room.hostId, goAt: room.goAt, now: Date.now(), players: roster(room) }); }

function pickColor(room) {
  const used = new Set([...room.players.values()].map(p => p.color));
  return COLORS.find(c => !used.has(c)) || COLORS[room.players.size % COLORS.length];
}

function maybeFinishRace(room) {
  if (room.phase !== "racing") return;
  const active = [...room.players.values()];
  if (active.length && active.every(p => p.finished || p.forfeit)) {
    room.phase = "done";
    broadcast(room, { t: "chat", system: true, text: "Race over! Host can start a new race." });
    pushRoster(room);
  }
}

function markFinished(room, p, source) {
  if (room.phase !== "racing" || p.finished || p.forfeit) return;
  p.finished = true;
  p.time = Date.now() - room.goAt;
  room.finishOrder.push(p.id);
  p.place = room.finishOrder.length;
  broadcast(room, { t: "chat", system: true,
    text: `${p.name} beat Bowser! #${p.place} in ${fmtTime(p.time)}${source === "host" ? " (marked by host)" : ""}` });
  pushRoster(room);
  maybeFinishRace(room);
}

function fmtTime(ms) {
  const t = Math.max(0, Math.floor(ms / 10));
  const cs = t % 100, s = Math.floor(t / 100) % 60, m = Math.floor(t / 6000) % 60, h = Math.floor(t / 360000);
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  return (h ? h + ":" + pad(m) : m) + ":" + pad(s) + "." + pad(cs);
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16384 });

wss.on("connection", (ws) => {
  let room = null, me = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (buf) => {
    let m;
    try { m = JSON.parse(buf); } catch { return; }
    if (!m || typeof m.t !== "string") return;

    if (m.t === "join") {
      if (room) return;
      const code = cleanRoom(m.room);
      if (!code) return send(ws, { t: "error", text: "Room code needs letters or numbers." });
      const r = getRoom(code);
      if (r.players.size >= MAX_PLAYERS) return send(ws, { t: "error", text: "That room is full (8 racers max)." });
      room = r;
      me = { id: nextId++, ws, name: cleanName(m.name), color: pickColor(r), ready: false, romOk: false,
             finished: false, forfeit: false, time: null, place: null, state: null, stateFresh: false,
             // Late joiners during a race spectate until the next one.
             spectator: r.phase === "racing" || r.phase === "countdown" };
      if (me.spectator) me.forfeit = true;
      r.players.set(me.id, me);
      if (!r.hostId) r.hostId = me.id;
      send(ws, { t: "welcome", id: me.id, room: code, color: me.color, now: Date.now() });
      broadcast(r, { t: "chat", system: true, text: `${me.name} joined${me.spectator ? " (spectating this race)" : ""}.` });
      pushRoster(r);
      return;
    }
    if (!room || !me) return;

    switch (m.t) {
      case "ping":
        send(ws, { t: "pong", c: m.c, now: Date.now() });
        break;
      case "rom":
        me.romOk = !!m.ok;
        me.romCrc = /^[0-9A-F]{8}$/.test(String(m.crc)) ? String(m.crc) : null;
        // ROM finished loading during the countdown? Still in the race.
        if (room.phase === "countdown" && !me.finished) { me.forfeit = !me.romOk; me.spectator = false; }
        pushRoster(room);
        break;
      case "ready":
        if (room.phase !== "lobby" && room.phase !== "done") break;
        me.ready = !!m.ready;
        pushRoster(room);
        break;
      case "start": {
        if (me.id !== room.hostId || (room.phase !== "lobby" && room.phase !== "done")) break;
        const racers = [...room.players.values()].filter(p => p.romOk);
        if (!racers.length) { send(ws, { t: "error", text: "Nobody has a ROM loaded yet." }); break; }
        room.phase = "countdown";
        room.goAt = Date.now() + COUNTDOWN_MS;
        room.finishOrder = [];
        for (const p of room.players.values()) {
          p.finished = false; p.time = null; p.place = null; p.state = null; p.spectator = false;
          p.forfeit = !p.romOk;            // no ROM = spectate
          p.ready = false;
        }
        pushRoster(room);
        broadcast(room, { t: "countdown", goAt: room.goAt, now: Date.now() });
        setTimeout(() => {
          if (room.phase === "countdown") { room.phase = "racing"; pushRoster(room); maybeFinishRace(room); }
        }, COUNTDOWN_MS);
        break;
      }
      case "state":
        // Small object of numbers read from game RAM. Validate & clamp.
        if (room.phase !== "racing" || me.forfeit || typeof m.s !== "object" || !m.s) break;
        me.state = sanitizeState(m.s);
        me.stateFresh = true;
        break;
      case "sprite": {
        // A racer's own Mario frame (PNG made from their game), relayed so others can draw their ghost.
        const key = m.key | 0, url = String(m.url || "");
        if (!(key >= 0 && key <= 0xFFFFFF) || !url.startsWith("data:image/png;base64,") || url.length > 12000) break;
        if (!me.sprites) me.sprites = new Map();
        if (!me.sprites.has(key)) {
          if (me.sprites.size >= 600) me.sprites.delete(me.sprites.keys().next().value);
          me.sprites.set(key, url);
        }
        broadcast(room, { t: "sprite", id: me.id, key, url });
        break;
      }
      case "getSprite": {
        const owner = room.players.get(m.id | 0);
        const url = owner && owner.sprites && owner.sprites.get(m.key | 0);
        if (url) send(ws, { t: "sprite", id: owner.id, key: m.key | 0, url });
        break;
      }
      case "finish":
        if (me.forfeit) break;
        markFinished(room, me, "self");
        break;
      case "forfeit":
        if (room.phase !== "racing" || me.finished || me.forfeit) break;
        me.forfeit = true;
        broadcast(room, { t: "chat", system: true, text: `${me.name} forfeited.` });
        pushRoster(room);
        maybeFinishRace(room);
        break;
      case "hostFinish": {
        if (me.id !== room.hostId) break;
        const target = room.players.get(m.id | 0);
        if (target) markFinished(room, target, "host");
        break;
      }
      case "reset":
        if (me.id !== room.hostId) break;
        room.phase = "lobby"; room.goAt = 0; room.finishOrder = [];
        for (const p of room.players.values()) { p.finished = false; p.time = null; p.place = null; p.forfeit = false; p.ready = false; p.state = null; p.spectator = false; }
        broadcast(room, { t: "reset" });
        pushRoster(room);
        break;
      case "chat": {
        const text = String(m.text || "").slice(0, 200).trim();
        if (text) broadcast(room, { t: "chat", from: me.name, color: me.color, text });
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!room || !me) return;
    room.players.delete(me.id);
    if (room.players.size === 0) { rooms.delete(room.code); return; }
    if (room.hostId === me.id) room.hostId = room.players.keys().next().value;
    broadcast(room, { t: "chat", system: true, text: `${me.name} left.` });
    pushRoster(room);
    maybeFinishRace(room);
  });
});

const STATE_KEYS = ["mode", "x", "y", "cx", "cy", "room", "lvl", "pow", "dir", "yoshi", "lives", "coins", "exits", "sub", "ox", "oy", "spr", "sox", "soy"];
function sanitizeState(s) {
  const o = {};
  for (const k of STATE_KEYS) {
    const v = Number(s[k]);
    o[k] = Number.isFinite(v) ? Math.max(-0x8000, Math.min(0xFFFFFF, Math.round(v))) : 0;
  }
  return o;
}

// Relay tick: send everyone the latest state of all racers.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase !== "racing" && room.phase !== "done") continue;
    let any = false;
    const list = [];
    for (const p of room.players.values()) {
      if (p.state) { list.push([p.id, p.state]); if (p.stateFresh) any = true; p.stateFresh = false; }
    }
    if (any) broadcast(room, { t: "states", list, now: Date.now() });
  }
}, TICK_MS);

// Drop dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 20000);

server.listen(PORT, () => console.log(`SMW Online Race listening on http://localhost:${PORT}`));
module.exports = { server, fmtTime };

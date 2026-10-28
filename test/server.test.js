// Server race-logic test: two clients join, host starts, both send states, both finish in order.
const assert = require("assert");
const WebSocket = require("ws");
process.env.PORT = "8123";
const { server } = require("../server.js");

function client(name) {
  const ws = new WebSocket("ws://localhost:8123/ws");
  const msgs = [];
  ws.on("message", d => msgs.push(JSON.parse(d)));
  const wait = (pred, ms = 9000) => new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() { const m = msgs.find(pred); if (m) return res(m); if (Date.now() - t0 > ms) return rej(new Error(name + " timed out; last: " + JSON.stringify(msgs.slice(-3)))); setTimeout(poll, 20); })();
  });
  return new Promise(r => ws.on("open", () => { ws.send(JSON.stringify({ t: "join", room: "unit", name })); r({ ws, msgs, wait, send: m => ws.send(JSON.stringify(m)) }); }));
}

(async () => {
  const a = await client("Alice"), b = await client("Bob");
  await a.wait(m => m.t === "welcome"); await b.wait(m => m.t === "welcome");
  a.send({ t: "rom", ok: true, crc: "B19ED489" }); b.send({ t: "rom", ok: true, crc: "B19ED489" });
  b.send({ t: "start" }); // not host: ignored
  a.send({ t: "start" });
  const cd = await b.wait(m => m.t === "countdown");
  assert(cd.goAt > Date.now(), "go time in future");
  await a.wait(m => m.t === "room" && m.phase === "racing");
  b.send({ t: "state", s: { mode: 20, x: 300, y: 352, room: 5, lvl: 1, evil: "<script>" } });
  const st = await a.wait(m => m.t === "states");
  assert.strictEqual(st.list[0][1].x, 300);
  assert.strictEqual(st.list[0][1].evil, undefined, "unknown fields dropped");
  b.send({ t: "finish" });
  await a.wait(m => m.t === "chat" && /Bob beat Bowser! #1/.test(m.text));
  a.send({ t: "finish" });
  const done = await b.wait(m => m.t === "room" && m.phase === "done");
  const places = Object.fromEntries(done.players.map(p => [p.name, p.place]));
  assert.deepStrictEqual(places, { Alice: 2, Bob: 1 });
  assert(done.players.every(p => p.time > 0));
  console.log("server tests passed");
  a.ws.close(); b.ws.close(); server.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

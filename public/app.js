// SMW Online Race — browser client.
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const SMW_US_CRC = "B19ED489";
  const TEST_TITLE = "SMW RACE TEST ROM";
  const SEND_EVERY_MS = 66;
  const FINISH_FRAMES = 30;                 // $13C6 must read 8 this many frames in a row
  const MODE_LEVEL = 0x14, MODE_OVERWORLD = 0x0E;

  // ---------------- state ----------------
  const S = {
    ws: null, myId: null, room: null, phase: "offline", hostId: null, goAt: 0,
    players: [], states: new Map(), smooth: new Map(), clockOffset: 0, bestRtt: Infinity,
    rom: null, romCrc: null, romKind: null, emu: null, ram: null, emuReady: false,
    ready: false, lastSend: 0, finishStreak: 0, sentFinish: false, raceStartedLocally: false,
    my: null,
  };
  window.__race = S; // handy for debugging in the console

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  // ---------------- helpers ----------------
  const serverNow = () => Date.now() + S.clockOffset;
  function fmtTime(ms) {
    if (ms == null) return "--:--.--";
    const t = Math.max(0, Math.floor(ms / 10));
    const cs = t % 100, s = Math.floor(t / 100) % 60, m = Math.floor(t / 6000) % 60, h = Math.floor(t / 360000);
    const p = (n) => String(n).padStart(2, "0");
    return (h ? h + ":" + p(m) : m) + ":" + p(s) + "." + p(cs);
  }
  function hex(n, w = 2) { return n.toString(16).toUpperCase().padStart(w, "0"); }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).toUpperCase().padStart(8, "0"); }

  // ---------------- ROM loading ----------------
  $("romInput").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (S.emu) { // EmulatorJS can't swap games cleanly; reload keeps room/name via URL+storage
      if (!confirm("Loading a different ROM reloads the page. Continue?")) return;
      location.reload(); return;
    }
    let bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes.length % 1024 === 512) bytes = bytes.subarray(512); // strip copier header
    if (bytes.length < 0x8000 || bytes.length > 0x600000) { setRomStatus("That doesn't look like a SNES ROM.", "bad"); return; }
    const title = String.fromCharCode(...bytes.subarray(0x7FC0, 0x7FC0 + 21)).replace(/\0/g, " ").trim();
    const crc = crc32(bytes);
    S.romCrc = crc;
    if (crc === SMW_US_CRC) { S.romKind = "smw"; setRomStatus("✔ Super Mario World (USA)", "good"); }
    else if (title === TEST_TITLE) { S.romKind = "test"; setRomStatus("Test cartridge (for development)", "warn"); }
    else if (/MARIO ?WORLD/i.test(title)) { S.romKind = "hack"; setRomStatus(`⚠ "${title}" isn't the clean USA ROM (CRC ${crc}). Hacks may not track correctly.`, "warn"); }
    else { setRomStatus(`⚠ "${title || "Unknown"}" doesn't look like Super Mario World. Tracking won't work.`, "bad"); S.romKind = "other"; }
    S.rom = bytes;
    startEmulator(bytes);
    sendRom();
  });
  function setRomStatus(text, cls) { const el = $("romStatus"); el.textContent = text; el.className = "rom-status " + (cls || ""); }

  function startEmulator(bytes) {
    $("placeholder").hidden = true;
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    Object.assign(window, {
      EJS_player: "#game", EJS_core: "snes", EJS_pathtodata: "ejs/", EJS_gameUrl: url,
      EJS_startOnLoaded: true, EJS_DEBUG_XX: true, EJS_backgroundColor: "#000",
      EJS_color: "#e4002b", EJS_disableDatabases: true, EJS_threads: false,
      EJS_Buttons: { saveState: false, loadState: false, quickSave: false, quickLoad: false, cheat: false,
        netplay: false, cacheManager: false, saveSavFiles: false, loadSavFiles: false, screenRecord: false,
        exitEmulation: false, diskButton: false },
      EJS_onGameStart: onEmuStart,
    });
    const s = document.createElement("script");
    s.src = "ejs/loader.js";
    document.body.appendChild(s);
    setRamStatus("starting emulator…", "");
  }

  function onEmuStart() {
    S.emu = window.EJS_emulator;
    S.ram = new RamReader(S.emu);
    S.emuReady = true;
    guardRaceFeatures();
    // locate WRAM after the game has run a little
    let tries = 0;
    const attempt = () => {
      if (S.ram.locate()) setRamStatus("● tracking", "good");
      else if (++tries < 20) { setRamStatus("looking for game memory…", ""); setTimeout(attempt, 750); }
      else setRamStatus("✖ can't read game memory: " + S.ram.lastError, "bad");
    };
    setTimeout(attempt, 1200);
    if (S.phase === "countdown") S.emu.pause();
    if (S.phase === "racing" && !S.raceStartedLocally && amRacing()) beginRaceLocally();
  }
  function setRamStatus(text, cls) { const el = $("ramStatus"); el.textContent = text; el.className = "ram-status " + (cls || ""); }

  // During a race, block save states / rewind / fast-forward / slow-mo (hotkeys included).
  function guardRaceFeatures() {
    const gm = S.emu.gameManager;
    for (const fn of ["quickSave", "quickLoad", "loadState", "toggleFastForward", "toggleSlowMotion", "toggleRewind"]) {
      if (typeof gm[fn] !== "function") continue;
      const orig = gm[fn].bind(gm);
      gm[fn] = (...a) => {
        if (S.phase === "racing" || S.phase === "countdown") {
          if (fn.startsWith("toggle") && !a[0]) return orig(0); // allow turning things OFF
          S.emu.displayMessage && S.emu.displayMessage("Disabled during the race");
          return fn.startsWith("toggle") ? orig(0) : false;
        }
        return orig(...a);
      };
    }
  }

  // ---------------- networking ----------------
  $("joinBtn").addEventListener("click", join);
  $("roomInput").addEventListener("keydown", e => { if (e.key === "Enter") join(); });
  const params = new URLSearchParams(location.search);
  $("nameInput").value = store.get("smwrace.name") || "";
  $("roomInput").value = (params.get("room") || "").toUpperCase();
  if (!$("roomInput").value) $("roomInput").value = Math.random().toString(36).slice(2, 7).toUpperCase();

  function join() {
    const name = $("nameInput").value.trim() || "Player";
    const room = $("roomInput").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!room) { $("roomInput").focus(); return; }
    store.set("smwrace.name", name);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    S.ws = ws;
    $("joinBtn").disabled = true;
    ws.onopen = () => { ws.send(JSON.stringify({ t: "join", name, room })); };
    ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      S.phase = "offline";
      addChat({ system: true, text: "Disconnected from the race server. Refresh to rejoin." });
      $("joinBtn").disabled = false;
      render();
    };
  }
  const send = (m) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); };
  function sendRom() { if (S.myId) send({ t: "rom", ok: S.romKind === "smw" || S.romKind === "hack" || S.romKind === "test", crc: S.romCrc }); }

  function syncClock() {
    let n = 0;
    const tick = () => { send({ t: "ping", c: Date.now() }); if (++n < 6) setTimeout(tick, 300); };
    tick();
    setInterval(() => send({ t: "ping", c: Date.now() }), 15000);
  }

  function onMessage(m) {
    switch (m.t) {
      case "welcome":
        S.myId = m.id; S.room = m.room;
        S.clockOffset = m.now - Date.now();
        history.replaceState(null, "", `?room=${m.room}`);
        $("joinPanel").hidden = true; $("lobbyPanel").hidden = false; $("chatPanel").hidden = false;
        $("roomTag").textContent = "Room " + m.room;
        sendRom(); syncClock();
        break;
      case "pong": {
        const now = Date.now(), rtt = now - m.c;
        if (rtt < S.bestRtt) { S.bestRtt = rtt; S.clockOffset = m.now - (m.c + rtt / 2); }
        break;
      }
      case "room": {
        const prev = S.phase;
        S.phase = m.phase; S.hostId = m.hostId; S.goAt = m.goAt; S.players = m.players;
        S.my = m.players.find(p => p.id === S.myId) || null;
        if (prev !== "racing" && m.phase === "racing" && !S.raceStartedLocally && amRacing()) beginRaceLocally();
        if (m.phase === "lobby") { S.raceStartedLocally = false; S.sentFinish = false; }
        render();
        break;
      }
      case "countdown":
        S.goAt = m.goAt;
        S.clockOffset = S.bestRtt < Infinity ? S.clockOffset : m.now - Date.now();
        startCountdown();
        break;
      case "reset":
        S.states.clear(); S.smooth.clear(); S.raceStartedLocally = false; S.sentFinish = false; S.finishStreak = 0;
        S.ready = false;
        break;
      case "states":
        for (const [id, st] of m.list) S.states.set(id, st);
        break;
      case "chat": addChat(m); break;
      case "error": addChat({ system: true, text: m.text }); $("joinBtn").disabled = false; if (!S.myId && S.ws) S.ws.close(); break;
    }
  }

  // ---------------- race flow ----------------
  const amRacing = () => !!(S.my && S.my.romOk && !S.my.forfeit);

  let countdownTimer = null;
  function startCountdown() {
    S.raceStartedLocally = false; S.sentFinish = false; S.finishStreak = 0;
    S.states.clear(); S.smooth.clear();
    if (S.emu && amRacing()) S.emu.pause();
    const el = $("countdown");
    el.hidden = false;
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const left = S.goAt - serverNow();
      if (left > 0) { el.textContent = Math.ceil(left / 1000); el.className = "countdown"; return; }
      clearInterval(countdownTimer);
      if (amRacing()) beginRaceLocally();
      el.textContent = "GO!"; el.className = "countdown go";
      setTimeout(() => { el.hidden = true; }, 900);
    }, 50);
  }

  function beginRaceLocally() {
    if (S.raceStartedLocally || !S.emu || !S.emuReady) return;
    S.raceStartedLocally = true;
    const gm = S.emu.gameManager;
    const wipe = S.ram ? S.ram.wipeSram() : "no-reader";
    if (wipe.startsWith("error") || wipe === "not-found") addChat({ system: true, text: "Couldn't wipe your save file automatically — pick an EMPTY file when the game starts." });
    gm.restart();
    S.emu.play();
    if (S.emu.elements && S.emu.elements.parent) S.emu.elements.parent.focus();
    // re-locate WRAM once the reset has settled (same address in practice, but cheap to confirm)
    setTimeout(() => { if (S.ram && !S.ram.locate()) setRamStatus("✖ " + S.ram.lastError, "bad"); }, 1500);
  }

  // per-frame loop: read RAM, send state, detect finish, draw ghosts, clock
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    let mine = null;
    if (S.ram && S.ram.ok() && S.emuReady) mine = S.ram.read();

    if (S.phase === "racing" && amRacing() && S.raceStartedLocally && mine) {
      if (now - S.lastSend >= SEND_EVERY_MS) {
        S.lastSend = now;
        const { cut, ...pub } = mine;
        send({ t: "state", s: pub });
      }
      if (!S.sentFinish && !(S.my && S.my.finished)) {
        S.finishStreak = mine.cut === 8 ? S.finishStreak + 1 : 0;
        if (S.finishStreak >= FINISH_FRAMES) { S.sentFinish = true; send({ t: "finish" }); }
      }
    }
    drawGhosts(mine);
    updateClock();
    if (now - (frame.lastRender || 0) > 500) { frame.lastRender = now; renderTracker(); }
  }
  requestAnimationFrame(frame);

  function updateClock() {
    const el = $("raceClock");
    if (S.phase === "racing" || S.phase === "done") {
      el.textContent = S.my && S.my.finished ? fmtTime(S.my.time) : fmtTime(serverNow() - S.goAt);
      el.classList.toggle("done", !!(S.my && S.my.finished));
    } else if (S.phase === "countdown") el.textContent = fmtTime(0);
    else el.textContent = "--:--.--";
  }

  // ---------------- ghosts ----------------
  const ghostCanvas = $("ghosts"), gctx = ghostCanvas.getContext("2d");
  function drawGhosts(mine) {
    const wrap = $("screenWrap");
    const emuCanvas = S.emu && S.emu.canvas;
    const W = wrap.clientWidth, H = wrap.clientHeight, dpr = window.devicePixelRatio || 1;
    if (ghostCanvas.width !== Math.round(W * dpr) || ghostCanvas.height !== Math.round(H * dpr)) {
      ghostCanvas.width = Math.round(W * dpr); ghostCanvas.height = Math.round(H * dpr);
      ghostCanvas.style.width = W + "px"; ghostCanvas.style.height = H + "px";
    }
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.clearRect(0, 0, ghostCanvas.width, ghostCanvas.height);
    if (!mine || !emuCanvas || mine.mode !== MODE_LEVEL || (S.phase !== "racing" && S.phase !== "done")) return;

    // Where the SNES picture sits: 4:3 letterboxed inside the emulator canvas.
    const r = emuCanvas.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    let vw = Math.min(r.width, r.height * 4 / 3), vh = vw * 3 / 4;
    const ox = r.left - wr.left + (r.width - vw) / 2, oy = r.top - wr.top + (r.height - vh) / 2;
    const sx = vw / 256, sy = vh / 224;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const [id, st] of S.states) {
      if (id === S.myId || st.mode !== MODE_LEVEL || st.room !== mine.room || st.lvl !== mine.lvl) { S.smooth.delete(id); continue; }
      const p = S.players.find(q => q.id === id);
      if (!p || p.forfeit) continue;
      // smooth toward the latest network position
      let sm = S.smooth.get(id);
      if (!sm || Math.abs(sm.x - st.x) > 96 || Math.abs(sm.y - st.y) > 96) sm = { x: st.x, y: st.y };
      sm.x += (st.x - sm.x) * 0.35; sm.y += (st.y - sm.y) * 0.35;
      S.smooth.set(id, sm);
      const big = st.pow > 0;
      const top = sm.y + (big ? 2 : 14), h = big ? 30 : 18;
      const px = ox + (sm.x - mine.cx) * sx, py = oy + (top - mine.cy) * sy;
      if (px < -40 || px > W + 40 || py < -60 || py > H + 40) continue;
      drawGhost(px, py, 16 * sx, h * sy, p.color, st.dir, p.name, st.yoshi);
    }
  }
  function drawGhost(x, y, w, h, color, dir, name, yoshi) {
    gctx.save();
    gctx.globalAlpha = 0.55;
    gctx.fillStyle = color;
    // rounded body with a wavy hem
    const r = w / 2;
    gctx.beginPath();
    gctx.moveTo(x, y + r);
    gctx.arc(x + r, y + r, r, Math.PI, 0);
    gctx.lineTo(x + w, y + h);
    const waves = 3, ww = w / waves;
    for (let i = waves; i > 0; i--) gctx.quadraticCurveTo(x + (i - 0.5) * ww, y + h - ww * 0.7, x + (i - 1) * ww, y + h);
    gctx.closePath();
    gctx.fill();
    // eyes look the way they're facing
    gctx.globalAlpha = 0.9;
    gctx.fillStyle = "#fff";
    const ex = dir ? x + w * 0.55 : x + w * 0.2, ey = y + r * 0.8, es = Math.max(2, w * 0.16);
    gctx.fillRect(ex, ey, es, es * 1.4); gctx.fillRect(ex + es * 1.6, ey, es, es * 1.4);
    if (yoshi) { gctx.fillStyle = "#3fd13f"; gctx.fillRect(x - w * 0.1, y + h - 2, w * 1.2, 4); }
    // name tag
    gctx.globalAlpha = 1;
    gctx.font = "600 11px Inter, sans-serif";
    const tw = gctx.measureText(name).width + 8;
    gctx.fillStyle = "rgba(0,0,0,.65)";
    gctx.fillRect(x + w / 2 - tw / 2, y - 17, tw, 14);
    gctx.fillStyle = color;
    gctx.fillText(name, x + w / 2 - tw / 2 + 4, y - 6);
    gctx.restore();
  }

  // ---------------- UI ----------------
  const POW = ["Small", "Super", "Cape", "Fire"];
  function statusText(st) {
    if (!st) return "waiting…";
    if (st.mode === MODE_LEVEL) return st.lvl === 0 ? "Intro" : `In level ${hex(st.lvl)}`;
    if (st.mode === MODE_OVERWORLD) return "On the map";
    if (st.mode < 0x0B) return "Title / file select";
    if (st.mode >= 0x15 && st.mode <= 0x17) return "Game over…";
    if (st.mode >= 0x18) return "Cutscene";
    return "Loading…";
  }

  function render() {
    const host = S.myId && S.myId === S.hostId;
    const titles = { lobby: "Lobby", countdown: "Get ready…", racing: "Racing!", done: "Results", offline: "Disconnected" };
    $("phaseTitle").textContent = titles[S.phase] || S.phase;
    $("hostControls").hidden = !host;
    $("startBtn").hidden = !(S.phase === "lobby" || S.phase === "done");
    $("resetBtn").hidden = !(S.phase === "racing" || S.phase === "done" || S.phase === "countdown");
    $("readyBtn").hidden = !(S.phase === "lobby" || S.phase === "done");
    $("readyBtn").textContent = S.my && S.my.ready ? "Not ready" : "I'm ready";
    $("forfeitBtn").hidden = !(S.phase === "racing" && amRacing() && !(S.my && S.my.finished));
    const crcs = new Set(S.players.filter(p => p.romOk && p.romCrc).map(p => p.romCrc));
    let hint = "";
    if (!S.rom) hint = "Load your ROM to race (you can still spectate).";
    else if (crcs.size > 1) hint = "Heads up: racers have different ROM versions.";
    else if (S.phase === "lobby") hint = host ? "Start whenever everyone's ready. Feel free to warm up until then." : "Warm up while you wait — your game resets when the race starts.";
    $("lobbyHint").textContent = hint;
    renderTracker();
  }

  function renderTracker() {
    const host = S.myId && S.myId === S.hostId;
    const list = [...S.players].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) return a.place - b.place;
      const sa = S.states.get(a.id), sb = S.states.get(b.id);
      return ((sb && sb.exits) || 0) - ((sa && sa.exits) || 0);
    });
    const racing = S.phase === "racing" || S.phase === "done";
    $("racers").innerHTML = list.map(p => {
      const st = S.states.get(p.id);
      let line;
      if (!racing) line = p.romOk ? (p.ready ? "ready" : "ROM loaded") : "no ROM yet";
      else if (p.finished) line = `🏁 #${p.place} · ${fmtTime(p.time)}`;
      else if (p.forfeit) line = "spectating";
      else line = statusText(st);
      const stats = racing && st && !p.forfeit ? `<span class="stats">${st.exits} exits · ${POW[st.pow] || "?"}${st.yoshi ? " + Yoshi" : ""} · ♥${st.lives + 1} · ⦿${st.coins}</span>` : "";
      const mark = host && S.phase === "racing" && !p.finished && !p.forfeit ? `<button class="mini" data-finish="${p.id}" title="Mark as finished (if detection missed it)">🏁</button>` : "";
      return `<li class="${p.finished ? "fin" : ""} ${p.id === S.myId ? "me" : ""}">
        <span class="dot" style="background:${esc(p.color)}"></span>
        <span class="who"><span class="nm"><b>${esc(p.name)}</b>${p.host ? ' <span class="tag">host</span>' : ""}${p.id === S.myId ? ' <span class="tag you">you</span>' : ""}</span>
        <span class="line">${esc(line)}</span>${stats}</span>${mark}</li>`;
    }).join("");
  }
  $("racers").addEventListener("click", (e) => {
    const b = e.target.closest("[data-finish]");
    if (b && confirm("Mark this racer as finished at the current time?")) send({ t: "hostFinish", id: +b.dataset.finish });
  });

  $("readyBtn").addEventListener("click", () => send({ t: "ready", ready: !(S.my && S.my.ready) }));
  $("startBtn").addEventListener("click", () => send({ t: "start" }));
  $("resetBtn").addEventListener("click", () => { if (confirm("Stop the race and go back to the lobby?")) send({ t: "reset" }); });
  $("forfeitBtn").addEventListener("click", () => { if (confirm("Forfeit this race?")) send({ t: "forfeit" }); });
  $("copyLinkBtn").addEventListener("click", async () => {
    const link = `${location.origin}${location.pathname}?room=${S.room}`;
    try { await navigator.clipboard.writeText(link); $("copyLinkBtn").textContent = "Copied!"; }
    catch { prompt("Copy this link:", link); }
    setTimeout(() => { $("copyLinkBtn").textContent = "Copy invite link"; }, 1500);
  });

  function addChat(m) {
    const li = document.createElement("li");
    if (m.system) { li.className = "sys"; li.textContent = m.text; }
    else { li.innerHTML = `<b style="color:${esc(m.color)}">${esc(m.from)}</b> ${esc(m.text)}`; }
    const log = $("chatLog");
    log.appendChild(li);
    while (log.children.length > 100) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  $("chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("chatInput").value.trim();
    if (v) send({ t: "chat", text: v });
    $("chatInput").value = "";
  });
  // keep typing in chat from steering Mario
  $("chatInput").addEventListener("keydown", e => e.stopPropagation());
  $("chatInput").addEventListener("keyup", e => e.stopPropagation());
})();

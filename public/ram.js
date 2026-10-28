// Reads Super Mario World's work RAM out of the EmulatorJS snes9x core.
//
// The core doesn't export a "read memory" function, so we find WRAM ourselves:
//   1. ask the core for a save state (it lands in the wasm heap),
//   2. pull the 128 KiB "RAM" block out of that state,
//   3. search the rest of the wasm heap for the same 128 KiB — that's the live WRAM array.
// snes9x keeps WRAM in a static array, so once found the address never moves.
"use strict";

const WRAM_SIZE = 0x20000;

// SMW (USA) RAM addresses — see README for sources.
const SMW = {
  powerup: 0x0019, camX: 0x001A, camY: 0x001C, l1ptr: 0x0065, dir: 0x0076,
  x: 0x0094, y: 0x0096, mode: 0x0100, lives: 0x0DBE, coins: 0x0DBF,
  translevel: 0x13BF, cutscene: 0x13C6, yoshi: 0x187A, submap: 0x1F11,
  owX: 0x1F17, owY: 0x1F19, exits: 0x1F2E,
};

// Parse a snes9x save state into { name: {offset, size} } blocks (offsets relative to state start).
function parseSnes9xState(bytes) {
  // RetroArch wraps core states: "RASTATE"+ver, then chunks [tag(4) size(u32 LE) data, padded to 8].
  const tag = String.fromCharCode(...bytes.subarray(0, 7));
  if (tag === "RASTATE") {
    let p = 8;
    while (p + 8 <= bytes.length) {
      const t = String.fromCharCode(...bytes.subarray(p, p + 4));
      const size = bytes[p + 4] | (bytes[p + 5] << 8) | (bytes[p + 6] << 16) | (bytes[p + 7] << 24);
      if (t === "MEM ") {
        const inner = parseSnes9xState(bytes.subarray(p + 8, p + 8 + size));
        for (const k in inner) inner[k].offset += p + 8;
        return inner;
      }
      if (t === "END ") break;
      p += 8 + ((size + 7) & ~7);
    }
    throw new Error("no MEM chunk in RetroArch state");
  }
  const blocks = {};
  const head = String.fromCharCode(...bytes.subarray(0, 9));
  if (head !== "#!s9xsnp:") throw new Error("unexpected save-state format: " + JSON.stringify(head));
  let p = bytes.indexOf(0x0A); // end of header line
  if (p < 0) throw new Error("bad state header");
  p += 1;
  while (p + 11 <= bytes.length) {
    const name = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2]);
    if (bytes[p + 3] !== 0x3A || bytes[p + 10] !== 0x3A) break; // "XXX:nnnnnn:"
    const size = parseInt(String.fromCharCode(...bytes.subarray(p + 4, p + 10)), 10);
    if (!Number.isFinite(size)) break;
    blocks[name] = { offset: p + 11, size };
    p += 11 + size;
  }
  return blocks;
}

class RamReader {
  constructor(emulator) {
    this.ejs = emulator;
    this.base = -1;
    this.lastError = null;
  }
  get gm() { return this.ejs && this.ejs.gameManager; }
  get heap() { return this.gm.Module.HEAPU8; }

  // Returns {bytes (view into heap), start, size} for a fresh save state, without copying.
  _stateView() {
    const info = this.gm.functions.saveStateInfo().split("|");
    if (info[2] !== "1") throw new Error("core could not create a state: " + info[0]);
    const size = parseInt(info[0], 10), start = parseInt(info[1], 10);
    return { bytes: this.heap.subarray(start, start + size), start, size };
  }

  // Find every place in the heap (outside `exclude`) that holds exactly `needle`.
  _findAll(needle, exclude) {
    const heap = this.heap;
    // pick a high-entropy 32-byte probe inside the needle
    let probeOff = 0, best = -1;
    for (let off = 0; off + 32 <= needle.length; off += 256) {
      const seen = new Set();
      for (let i = 0; i < 32; i++) seen.add(needle[off + i]);
      if (seen.size > best) { best = seen.size; probeOff = off; if (best >= 24) break; }
    }
    if (best < 6) return { matches: [], ambiguous: true };
    // start the probe on an uncommon byte so indexOf() skips most of the heap
    for (let k = 0; k < 16 && probeOff + 32 < needle.length; k++) {
      const v = needle[probeOff];
      if (v !== 0x00 && v !== 0xFF && v !== 0x55) break;
      probeOff++;
    }
    const first = needle[probeOff];
    const matches = [];
    let i = heap.indexOf(first);
    while (i !== -1) {
      const base = i - probeOff;
      if (base >= 0 && base + needle.length <= heap.length &&
          !(base < exclude[1] && base + needle.length > exclude[0])) {
        let ok = true;
        for (let k = 0; k < 32; k++) if (heap[i + k] !== needle[probeOff + k]) { ok = false; break; }
        if (ok) {
          for (let k = 0; k < needle.length; k += 1) if (heap[base + k] !== needle[k]) { ok = false; break; }
          if (ok) matches.push(base);
        }
      }
      i = heap.indexOf(first, i + 1);
    }
    return { matches, ambiguous: false };
  }

  locate() {
    try {
      const st = this._stateView();
      const blocks = parseSnes9xState(st.bytes);
      if (!blocks.RAM || blocks.RAM.size !== WRAM_SIZE) throw new Error("no 128K RAM block in state");
      const ram = st.bytes.slice(blocks.RAM.offset, blocks.RAM.offset + WRAM_SIZE);
      const { matches, ambiguous } = this._findAll(ram, [st.start, st.start + st.size]);
      if (ambiguous) throw new Error("WRAM is still blank — let the game run a moment");
      if (matches.length === 0) throw new Error("WRAM not found in emulator memory");
      this.base = matches[0];
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e.message;
      this.base = -1;
      return false;
    }
  }

  // Wipes the cartridge save RAM (so everybody races from a fresh file). Returns a status string.
  wipeSram() {
    try {
      const st = this._stateView();
      const blocks = parseSnes9xState(st.bytes);
      const b = blocks.SRA;
      if (!b || !b.size) return "no-sram";
      const sram = st.bytes.slice(b.offset, b.offset + b.size);
      const uniform = sram.every(v => v === sram[0]);
      if (uniform) return "already-empty";
      const { matches } = this._findAll(sram, [st.start, st.start + st.size]);
      if (matches.length !== 1) return "not-found";
      this.heap.fill(0, matches[0], matches[0] + b.size);
      return "wiped";
    } catch (e) {
      return "error: " + e.message;
    }
  }

  ok() { return this.base >= 0 && this.gm && this.gm.Module && this.base + WRAM_SIZE <= this.heap.length; }
  u8(a) { return this.heap[this.base + a]; }
  u16(a) { const h = this.heap, b = this.base + a; return h[b] | (h[b + 1] << 8); }
  s16(a) { const v = this.u16(a); return v >= 0x8000 ? v - 0x10000 : v; }

  // Snapshot of everything the race needs.
  read() {
    if (!this.ok()) return null;
    return {
      mode: this.u8(SMW.mode),
      x: this.s16(SMW.x), y: this.s16(SMW.y),
      cx: this.s16(SMW.camX), cy: this.s16(SMW.camY),
      room: this.u8(SMW.l1ptr) | (this.u8(SMW.l1ptr + 1) << 8) | (this.u8(SMW.l1ptr + 2) << 16),
      lvl: this.u8(SMW.translevel),
      pow: this.u8(SMW.powerup), dir: this.u8(SMW.dir), yoshi: this.u8(SMW.yoshi) ? 1 : 0,
      lives: this.u8(SMW.lives), coins: this.u8(SMW.coins), exits: this.u8(SMW.exits),
      sub: this.u8(SMW.submap), ox: this.u16(SMW.owX), oy: this.u16(SMW.owY),
      cut: this.u8(SMW.cutscene),
    };
  }
}

window.RamReader = RamReader;
window.parseSnes9xState = parseSnes9xState;

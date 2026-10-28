// Captures the player's own Mario exactly as the game is drawing him this frame, so it can be
// shown to other racers as their ghost. Everything comes from this player's game RAM and ROM:
//   - OAM mirror ($0200/$0420): which 8x8/16x16 tiles make up Mario this frame, where, flipped how
//   - dynamic tile pointers ($0D85-$0D99): Mario's animation-frame graphics, held in WRAM
//   - static sprite tiles (SP1 = GFX00): decompressed from the ROM
//   - palettes: Mario's colours from ROM ($0D82 pointer), everything else from the CGRAM mirror ($0703)
// References: SMWDisX disassembly (DrawMarioAndYoshi, CODE_00F636, NMI player upload, UploadGFXFile).
"use strict";

const SPR = {
  oam: 0x0200, oamSize: 0x0420, palPtr: 0x0D82, dynPtr: 0x0D85, dyn7F: 0x0D99, mainPal: 0x0703,
  behindNet: 0x13F9, scrX: 0x007E, scrY: 0x0080, hidden: 0x0078,
  gfxLow: 0xB992, gfxHigh: 0xB9C4, gfxBank: 0xB9F6,
};
const MARIO_OAM_Y = [0x10, 0xD4, 0x10, 0xE8];  // DATA_00E2B2, by PlayerBehindNet
const YOSHI_DYN_TILES = new Set([0x06, 0x08]); // Yoshi's head/body use these dynamic 16x16 slots

// LC_LZ2 decompressor (SMW's graphics compression).
function lz2(rom, off) {
  const out = [];
  for (let guard = 0; guard < 100000; guard++) {
    const b = rom[off++];
    if (b === 0xFF) break;
    let cmd = b >> 5, len;
    if (cmd === 7) { cmd = (b >> 2) & 7; len = (((b & 3) << 8) | rom[off++]) + 1; }
    else len = (b & 0x1F) + 1;
    switch (cmd) {
      case 0: for (let i = 0; i < len; i++) out.push(rom[off++]); break;
      case 1: { const v = rom[off++]; for (let i = 0; i < len; i++) out.push(v); break; }
      case 2: { const a = rom[off++], c = rom[off++]; for (let i = 0; i < len; i++) out.push(i & 1 ? c : a); break; }
      case 3: { const v = rom[off++]; for (let i = 0; i < len; i++) out.push((v + i) & 0xFF); break; }
      case 4: { const a = (rom[off] << 8) | rom[off + 1]; off += 2; for (let i = 0; i < len; i++) out.push(out[a + i]); break; }
      default: return new Uint8Array(out);
    }
  }
  return new Uint8Array(out);
}

// 3bpp (24 bytes/tile) -> 4bpp (32 bytes/tile), 4th plane empty (what SMW does for GFX00).
function bpp3to4(src) {
  const tiles = Math.floor(src.length / 24), out = new Uint8Array(tiles * 32);
  for (let t = 0; t < tiles; t++) {
    const s = t * 24, d = t * 32;
    out.set(src.subarray(s, s + 16), d);
    for (let r = 0; r < 8; r++) out[d + 16 + r * 2] = src[s + 16 + r];
  }
  return out;
}

function decode4bpp(bytes, off) {
  const px = new Uint8Array(64);
  for (let r = 0; r < 8; r++) {
    const p0 = bytes[off + r * 2], p1 = bytes[off + r * 2 + 1], p2 = bytes[off + 16 + r * 2], p3 = bytes[off + 17 + r * 2];
    for (let c = 0; c < 8; c++) {
      const bit = 7 - c;
      px[r * 8 + c] = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
    }
  }
  return px;
}

class SpriteCapture {
  constructor(ram, rom) {
    this.ram = ram; this.rom = rom;
    this.sp1 = null;
    try { this.sp1 = bpp3to4(lz2(rom, this.gfxFileOffset(0x00))); } catch (e) { console.warn("SP1 gfx", e); }
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.lastKey = null;
  }
  romOff(bank, addr) { return (bank & 0x7F) * 0x8000 + (addr & 0x7FFF); }
  romU16(addr) { const o = this.romOff(0, addr); return this.rom[o] | (this.rom[o + 1] << 8); }
  gfxFileOffset(n) {
    const r = this.rom, lo = r[this.romOff(0, SPR.gfxLow + n)], hi = r[this.romOff(0, SPR.gfxHigh + n)], bank = r[this.romOff(0, SPR.gfxBank + n)];
    return this.romOff(bank, (hi << 8) | lo);
  }

  // 64 colour indices for one 8x8 sprite tile (page 0).
  tilePixels(t) {
    const R = this.ram, row = t >> 4, col = t & 15;
    if (t === 0x7F) { const p = R.u16(SPR.dyn7F); return decode4bpp(R.heap, R.base + p); }
    if (row < 2 && col < 10) {
      const p = R.u16(SPR.dynPtr + 2 * ((col >> 1) + 5 * row));
      return decode4bpp(R.heap, R.base + p + (col & 1) * 32);
    }
    if (this.sp1 && t < 0x80 && t * 32 + 32 <= this.sp1.length) return decode4bpp(this.sp1, t * 32);
    return null;
  }

  color(pal, c) {
    const R = this.ram, idx = 0x80 + pal * 16 + c;
    let w;
    if (pal === 0 && c >= 6) w = this.romU16(R.u16(SPR.palPtr) + (c - 6) * 2); // player colours come straight from ROM
    else w = R.u16(SPR.mainPal + idx * 2);
    return [(w & 31) << 3, ((w >> 5) & 31) << 3, ((w >> 10) & 31) << 3];
  }

  entry(n) {
    const R = this.ram, b = SPR.oam + n * 4, sz = R.u8(SPR.oamSize + n);
    let x = R.u8(b) | ((sz & 1) << 8); if (x >= 256) x -= 512;
    return { n, x, y: R.u8(b + 1), tile: R.u8(b + 2), attr: R.u8(b + 3), big: !!(sz & 2) };
  }

  // Returns null, or { key, w, h, ox, oy, url } where (ox,oy) is the image's top-left relative to
  // Mario's level position ($94/$96 minus camera), so other screens can place it in world space.
  capture(st) {
    const R = this.ram;
    if (!R.ok() || st.mode !== 0x14) return null;
    const base = 0x100 + MARIO_OAM_Y[R.u8(SPR.behindNet) & 3];
    const entries = [];
    for (let off = base - 8; off <= base + 0x10; off += 4) {
      const e = this.entry(off >> 2);
      if (e.y >= 0xE0 && e.y < 0xF8) continue;          // parked off-screen
      if (e.attr & 1) continue;                          // second sprite page: not Mario
      entries.push(e);
    }
    if (!entries.length) return null;
    // Yoshi (when riding): his dynamic head/body tiles, anywhere in OAM
    if (st.yoshi) {
      for (let n = 0; n < 128; n++) {
        const e = this.entry(n);
        if (e.y >= 0xE0 && e.y < 0xF8) continue;
        if (!(e.attr & 1) && e.big && YOSHI_DYN_TILES.has(e.tile) && !entries.some(q => q.n === n)) entries.push(e);
      }
    }
    const sx = st.x - st.cx, sy = st.y - st.cy; // Mario's screen position this frame
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const e of entries) {
      const s = e.big ? 16 : 8;
      let y = e.y; if (y >= 0xF0) y -= 256;
      e.sy = y;
      minX = Math.min(minX, e.x); minY = Math.min(minY, y); maxX = Math.max(maxX, e.x + s); maxY = Math.max(maxY, y + s);
    }
    const w = maxX - minX, h = maxY - minY;
    if (w <= 0 || h <= 0 || w > 64 || h > 64) return null;
    const img = new ImageData(w, h);
    // lower OAM index = in front, so paint highest index first
    entries.sort((a, b) => b.n - a.n);
    for (const e of entries) {
      const s = e.big ? 16 : 8, pal = (e.attr >> 1) & 7, hf = e.attr & 0x40, vf = e.attr & 0x80;
      for (let ty = 0; ty < s / 8; ty++) for (let tx = 0; tx < s / 8; tx++) {
        const t = (e.tile + tx + ty * 16) & 0xFF;
        const px = this.tilePixels(t);
        if (!px) continue;
        for (let py = 0; py < 8; py++) for (let pxx = 0; pxx < 8; pxx++) {
          const c = px[py * 8 + pxx];
          if (!c) continue;
          let lx = tx * 8 + pxx, ly = ty * 8 + py;
          if (hf) lx = s - 1 - lx;
          if (vf) ly = s - 1 - ly;
          const X = e.x - minX + lx, Y = e.sy - minY + ly;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          const [r, g, b] = this.color(pal, c), i = (Y * w + X) * 4;
          img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
        }
      }
    }
    // cheap content hash -> sprite key
    let hsh = 2166136261 >>> 0;
    const d = img.data;
    for (let i = 0; i < d.length; i += 1) { hsh ^= d[i]; hsh = Math.imul(hsh, 16777619) >>> 0; }
    hsh ^= (w << 8) ^ h;
    const key = (hsh >>> 0) & 0xFFFFFF;
    const res = { key, w, h, ox: minX - sx, oy: minY - sy };
    if (key !== this.lastKey) {
      this.canvas.width = w; this.canvas.height = h;
      this.ctx.putImageData(img, 0, 0);
      res.url = this.canvas.toDataURL("image/png");
      this.lastKey = key;
      this.lastUrl = res.url;
    } else res.url = this.lastUrl;
    return res;
  }
}

window.SpriteCapture = SpriteCapture;
window.smwLz2 = lz2;

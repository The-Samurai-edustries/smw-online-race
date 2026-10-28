// Boots SMW, walks into the first level, captures Mario with SpriteCapture and saves it next to a
// crop of the real screen so they can be compared by eye. Also checks the LZ2 decompressor
// against the game's own decompressed Mario graphics in WRAM.
// usage: node test/sprite-check.js <romPath> <outDir> [baseUrl]
const { chromium } = require("playwright");
const fs = require("fs");
const [rom, outDir] = process.argv.slice(2);
const base = process.argv[4] || "http://localhost:8099";

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", e => { if (!/Wake Lock|Failed to fetch/.test(e.message)) console.log("[pageerror]", e.message); });
  await page.goto(base + "/?room=SPR1");
  await page.fill("#nameInput", "Solo"); await page.click("#joinBtn");
  await page.waitForSelector("#lobbyPanel:not([hidden])");
  await page.setInputFiles("#romInput", rom);
  await page.waitForFunction(() => /tracking/.test(document.getElementById("ramStatus").textContent), null, { timeout: 60000 });
  const tap = async (k, ms = 120) => { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); };
  await page.click("#game canvas").catch(() => {});
  await page.waitForTimeout(4000);
  for (let i = 0; i < 6; i++) { await tap("Enter"); await page.waitForTimeout(1200); }

  // LZ2 check: GFX32 (Mario's graphics) decompressed by us should appear verbatim in WRAM at $2000
  const lz = await page.evaluate(() => {
    const S = window.__race, sc = new SpriteCapture(S.ram, S.rom);
    const g32 = smwLz2(S.rom, sc.gfxFileOffset(0x32));
    const w = S.ram.heap.subarray(S.ram.base + 0x2000, S.ram.base + 0x2000 + 256);
    let same = 0; for (let i = 0; i < 256; i++) if (g32[i] === w[i]) same++;
    return { gfx32Len: g32.length, first256Match: same, sp1Len: sc.sp1 && sc.sp1.length };
  });
  console.log("lz2:", JSON.stringify(lz));

  const grab = async (label) => {
    const r = await page.evaluate(() => {
      const S = window.__race; S._sc = S._sc || new SpriteCapture(S.ram, S.rom);
      const st = S.ram.read(); const c = S._sc.capture(st);
      return c && { ...c, st };
    });
    if (!r) { console.log(label, "no capture"); return; }
    fs.writeFileSync(`${outDir}/sprite-${label}.png`, Buffer.from(r.url.split(",")[1], "base64"));
    console.log(label, "key", r.key, "size", r.w + "x" + r.h, "offset", r.ox, r.oy, "pow", r.st.pow, "yoshi", r.st.yoshi);
  };
  await grab("intro-stand");
  await page.keyboard.down("ArrowRight"); await page.waitForTimeout(500);
  await grab("intro-walk");
  await page.keyboard.up("ArrowRight");
  await page.keyboard.down("x"); await page.waitForTimeout(150); await grab("intro-jump"); await page.keyboard.up("x");
  await page.waitForTimeout(100);
  await page.locator("#screenWrap").screenshot({ path: `${outDir}/sprite-screen.png` });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

// Loads the client in headless Chromium, joins a room, loads a ROM and checks we can read game RAM.
// usage: node test/browser-smoke.js <romPath> [baseUrl]
const { chromium } = require("playwright");
const rom = process.argv[2];
const base = process.argv[3] || "http://localhost:8099";

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", m => { const t = m.text(); if (!/Download|core report|GL_|WebGL|AudioContext/i.test(t)) console.log("[page]", t.slice(0, 200)); });
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  await page.goto(base + "/?room=TEST1");
  await page.fill("#nameInput", "Tester");
  await page.click("#joinBtn");
  await page.waitForSelector("#lobbyPanel:not([hidden])");
  await page.setInputFiles("#romInput", rom);
  console.log("rom status:", await page.textContent("#romStatus"));
  await page.waitForFunction(() => /tracking|can't/.test(document.getElementById("ramStatus").textContent), null, { timeout: 60000 });
  console.log("ram status:", await page.textContent("#ramStatus"));
  for (let i = 0; i < 4; i++) {
    const r = await page.evaluate(() => { const s = window.__race; return s.ram && s.ram.read(); });
    console.log("ram read:", JSON.stringify(r));
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: process.env.SHOT || "/tmp/claude-0/shot.png" });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

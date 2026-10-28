// Boots real SMW, presses through title + file select, and logs what the race client reads.
// usage: node test/smw-play.js <romPath> [baseUrl]
const { chromium } = require("playwright");
const rom = process.argv[2];
const base = process.argv[3] || "http://localhost:8099";
const shotDir = process.env.SHOTDIR || "/tmp";

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", e => { if (!/Wake Lock|Failed to fetch/.test(e.message)) console.log("[pageerror]", e.message); });
  await page.goto(base + "/?room=SMW1");
  await page.fill("#nameInput", "Solo");
  await page.click("#joinBtn");
  await page.waitForSelector("#lobbyPanel:not([hidden])");
  await page.setInputFiles("#romInput", rom);
  console.log("rom:", await page.textContent("#romStatus"));
  await page.waitForFunction(() => /tracking|can't/.test(document.getElementById("ramStatus").textContent), null, { timeout: 60000 });
  console.log("ram:", await page.textContent("#ramStatus"));
  const read = () => page.evaluate(() => window.__race.ram.read());
  const tap = async (key, hold = 120) => { await page.keyboard.down(key); await page.waitForTimeout(hold); await page.keyboard.up(key); };
  await page.click("#game canvas").catch(() => {});
  const log = async (label) => { const r = await read(); console.log(label.padEnd(18), "mode=0x" + r.mode.toString(16), "x", r.x, "y", r.y, "cam", r.cx, r.cy, "lvl", r.lvl, "pow", r.pow, "lives", r.lives + 1, "exits", r.exits, "sub", r.sub); };
  await page.waitForTimeout(4000); await log("after boot");
  // title -> file select -> file A -> 1 player -> overworld
  for (let i = 0; i < 6; i++) { await tap("Enter"); await page.waitForTimeout(1200); await log("pressed start " + i); }
  for (let i = 0; i < 6; i++) { await tap("x"); await page.waitForTimeout(1500); await log("pressed B " + i); }
  await page.screenshot({ path: shotDir + "/smw-1.png" });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

// Two racers in one room: host starts, both games reset at GO, racer B runs right,
// and we check racer A sees B as a ghost + both trackers update.
// usage: node test/race-two.js <romPath> [baseUrl]
const { chromium } = require("playwright");
const rom = process.argv[2];
const base = process.argv[3] || "http://localhost:8099";
const shotDir = process.env.SHOTDIR || "/tmp";

const browsers = [];
async function racer(_b, name) {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  browsers.push(browser);
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", e => { if (!/Wake Lock|Failed to fetch/.test(e.message)) console.log(`[${name} pageerror]`, e.message); });
  page.on("console", m => { if (/Couldn't|wipe/i.test(m.text())) console.log(`[${name}]`, m.text()); });
  await page.goto(base + "/?room=RACE2");
  await page.fill("#nameInput", name);
  await page.click("#joinBtn");
  await page.waitForSelector("#lobbyPanel:not([hidden])");
  await page.setInputFiles("#romInput", rom);
  await page.waitForFunction(() => /tracking/.test(document.getElementById("ramStatus").textContent), null, { timeout: 60000 });
  return page;
}
const tap = async (page, key, hold = 120) => { await page.keyboard.down(key); await page.waitForTimeout(hold); await page.keyboard.up(key); };
const read = (page) => page.evaluate(() => window.__race.ram.read());

(async () => {
  const browser = null;
  const A = await racer(browser, "Alice");
  const B = await racer(browser, "Bob");
  console.log("both tracking");
  // Give Bob a fake non-empty save file, then check the race start wipes it.
  console.log("Bob sram before:", await B.evaluate(() => {
    const gm = window.__race.emu.gameManager, path = gm.getSaveFilePath();
    const d = new Uint8Array(2048); for (let i = 0; i < d.length; i++) d[i] = (i * 37 + 11) & 255;
    gm.FS.writeFile(path, d); gm.loadSaveFiles();
    const st = window.__race.ram._stateView(); const b = parseSnes9xState(st.bytes).SRA;
    return path + " SRA size " + b.size + " first bytes " + [...st.bytes.subarray(b.offset, b.offset + 6)].join(",");
  }));

  await A.click("#startBtn");
  await A.waitForFunction(() => window.__race.phase === "racing", null, { timeout: 15000 });
  await A.waitForTimeout(800);
  console.log("racing. modes after reset:", (await read(A)).mode, (await read(B)).mode, "phase", await B.evaluate(() => window.__race.phase));
  console.log("focus:", await A.evaluate(() => document.activeElement.className + "/" + document.activeElement.id), await B.evaluate(() => document.activeElement.className + "/" + document.activeElement.id));
  console.log("Bob sram after:", await B.evaluate(() => {
    const st = window.__race.ram._stateView(); const b = parseSnes9xState(st.bytes).SRA;
    return [...st.bytes.subarray(b.offset, b.offset + 6)].join(",") + " nonzero=" + st.bytes.subarray(b.offset, b.offset + b.size).some(v => v);
  }));
  const chat = await A.evaluate(() => [...document.querySelectorAll("#chatLog li")].map(l => l.textContent));
  console.log("chat:", chat.join(" | "));

  // Both mash through title into the first scene (page focus alternates; keyboard goes to the page we press on).
  await A.waitForTimeout(4000);
  for (let i = 0; i < 7; i++) {
    await Promise.all([tap(A, "Enter"), tap(B, "Enter")]);
    await A.waitForTimeout(1000);
  }
  console.log("A", JSON.stringify(await read(A)));
  console.log("B", JSON.stringify(await read(B)));
  // Bob walks right for a bit
  await B.bringToFront();
  await B.keyboard.down("ArrowRight"); await B.waitForTimeout(1200); await B.keyboard.up("ArrowRight");
  await A.bringToFront();
  await A.waitForTimeout(800);
  const seen = await A.evaluate(() => { const s = window.__race; return [...s.states.entries()].map(([id, st]) => ({ id, mode: st.mode, x: st.x, room: st.room })); });
  console.log("A sees states:", JSON.stringify(seen), "B x now", (await read(B)).x);
  const tracker = await A.evaluate(() => document.getElementById("racers").innerText.replace(/\n+/g, " / "));
  console.log("A tracker:", tracker);
  console.log("A clock:", await A.textContent("#raceClock"));
  await A.screenshot({ path: shotDir + "/race-A.png" });
  for (const b of browsers) await b.close();
})().catch(e => { console.error(e); process.exit(1); });

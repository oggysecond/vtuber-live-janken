// 跨裝置驗證：開兩個互相隔離的瀏覽器，證明控場和舞台不必在同一台機器上。
// 同時扮演一個知道房號和 PIN 的竊聽者，檢查揭曉前通道上有沒有洩漏手勢。
//
//   BASE=http://127.0.0.1:4173/ CHROME=/path/to/chrome node scripts/verify-crossdevice.mjs
//
// 加 relay=ws://… 測主線，不加則測 ntfy 備援線。
import puppeteer from "puppeteer-core";
import { channelKey } from "../src/sync.js";

const BASE = process.env.BASE || "http://127.0.0.1:4173/";
const RELAY = process.env.RELAY || "";
const CHROME = process.env.CHROME || "/Applications/Comet.app/Contents/MacOS/Comet";
const MODE = RELAY ? "relay" : "ntfy";
const q = RELAY ? `?relay=${RELAY}` : "?relay=off";

const ROOM = "V" + Math.random().toString(36).slice(2, 5).toUpperCase();
const PIN = String(1000 + Math.floor(Math.random() * 8999));
const KEY = channelKey(ROOM, PIN);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (name, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) fails.push(name);
};

async function device(tag, hash) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=/tmp/vtjanken-${tag}-${Date.now()}`],
  });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1100, height: 800 });
  if (RELAY) {
    // 擋掉備援線，確保通的真的是主線。
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("ntfy.sh") ? r.abort() : r.continue()));
  }
  await page.goto(`${BASE}${q}#/${hash}/${ROOM}-${PIN}`, { waitUntil: "load" });
  return { browser, page };
}
const text = (p) => p.evaluate(() => document.body.innerText);

console.log(`\n=== ${MODE} 通道 / 房間 ${ROOM}-${PIN} ===`);

// 知道房號和 PIN 的第三者，用跟 app 完全相同的方式訂閱通道。
const wire = [];
let spy;
if (RELAY) {
  spy = new WebSocket(`${RELAY}/room/${KEY}?role=control`);
  spy.onmessage = (e) => {
    if (!String(e.data).includes("presence")) wire.push(e.data);
  };
} else {
  const res = await fetch(`https://ntfy.sh/vtjanken2026-${KEY}/sse`);
  const reader = res.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split("\n")) {
        if (line.startsWith("data:") && !line.includes('"open"') && !line.includes('"keepalive"')) {
          wire.push(line.slice(5).trim());
        }
      }
    }
  })().catch(() => {});
  spy = { close: () => reader.cancel().catch(() => {}) };
}
await wait(800);

const ctl = await device("control", "c");
const stg = await device("stage", "s");

let linked = false;
for (let i = 0; i < 40; i += 1) {
  if ((await text(ctl.page)).includes("舞台有回應")) {
    linked = true;
    break;
  }
  await wait(500);
}
check("控場偵測到另一台裝置上的舞台", linked);

await ctl.page.bringToFront();
await ctl.page.keyboard.press("1");
await wait(2500);
check("控場自己看得到石頭", (await text(ctl.page)).includes("石頭"));
const ready = await text(stg.page);
check("舞台顯示準備好了", ready.includes("準備好了"));
check("揭曉前舞台畫面沒有手勢", !ready.includes("石頭"));
check("竊聽者確實攔到流量（測試本身有效）", wire.length > 0);
check("揭曉前通道上沒有手勢", !JSON.stringify(wire).includes("rock"));

await ctl.page.click("[data-act=reveal]");
await wait(1200);
const counting = await text(stg.page);
check("舞台正在倒數且仍未洩漏", /[321]/.test(counting) && !counting.includes("石頭"));

await wait(3000);
check("舞台翻出石頭", (await text(stg.page)).includes("石頭"));

// PIN 不對的人連不進來。
const bad = await device("wrongpin", "s");
await bad.page.goto(`${BASE}${q}#/s/${ROOM}-0000`, { waitUntil: "load" });
await wait(3000);
await ctl.page.bringToFront();
await ctl.page.keyboard.press("2");
await wait(2500);
check("PIN 不對的舞台收不到任何東西", !(await text(bad.page)).includes("準備好了"));

try {
  spy.close();
} catch {
  /* ignore */
}
for (const d of [ctl, stg, bad]) await d.browser.close();

console.log(fails.length ? `\n${MODE}: ${fails.length} 項失敗 -> ${fails.join(", ")}` : `\n${MODE}: 全部通過`);
process.exit(fails.length ? 1 : 0);

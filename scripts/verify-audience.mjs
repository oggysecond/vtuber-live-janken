// 觀眾模式端對端驗證：1 台控場、1 台投影機、N 支各自獨立的觀眾手機（預設 30）。
// 檢查全部同步、揭曉前沒人看得到手勢、觀眾怎麼改網址或送假封包都碰不到投影機，
// 以及投影機待機畫面不放任何操作提示字、按 Q 不會跳出任何東西。
//
//   npm run build && npx vite preview --port 4180 &          # 或任何靜態伺服器
//   cd worker && npx wrangler dev &                          # 本機 relay
//   CHROME=/path/to/chrome node scripts/verify-audience.mjs
//
// 環境變數：BASE、RELAY、N（手機數）、CHROME。
// KILL_RELAY="要執行的指令" 會在最後把主線關掉，檢查投影機只變黃燈、不跳文字，並照樣翻牌。
import puppeteer from "puppeteer-core";
import { pbkdf2Sync, createHash } from "node:crypto";
import { execSync } from "node:child_process";

const BASE = process.env.BASE || "http://127.0.0.1:4180/";
const RELAY = process.env.RELAY || "ws://127.0.0.1:8787";
const Q = process.env.NOQUERY ? "" : `?relay=${RELAY}`;
const N = Number(process.env.N || 30);
const KILL = process.env.KILL_RELAY || "";
const ROOM = "E" + Math.random().toString(36).slice(2, 5).toUpperCase();
const PIN = String(1000 + Math.floor(Math.random() * 8999));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) fails.push(name);
};
const text = (p) => p.evaluate(() => document.body.innerText).catch(() => "");

// 每個頁面各自記下「某個字第一次出現在畫面上」的時間，不用輪詢 30 個頁面。
const PROBE = () => {
  window.__marks = {};
  const probe = () => {
    const t = document.body ? document.body.innerText : "";
    for (const k of ["準備好了", "石頭", "剪刀", "布"]) if (!window.__marks[k] && t.includes(k)) window.__marks[k] = Date.now();
  };
  new MutationObserver(probe).observe(document, { subtree: true, childList: true, characterData: true });
};

const CHROME = process.env.CHROME || "/Applications/Comet.app/Contents/MacOS/Comet";
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
async function phone(hash, { mobile = true } = {}) {
  const ctx = await browser.createBrowserContext();       // 各自獨立＝各自一支手機
  const p = await ctx.newPage();
  await p.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1280, height: 720 });
  await p.evaluateOnNewDocument(PROBE);
  await p.goto(`${BASE}${Q}#${hash}`, { waitUntil: "load" });
  return p;
}

console.log(`\n=== 房間 ${ROOM}-${PIN}：1 控場 + 1 投影機 + ${N} 支觀眾手機 ===`);
const ctl = await phone(`/c/${ROOM}-${PIN}`);
const stg = await phone(`/s/${ROOM}-${PIN}`, { mobile: false });

let linked = false;
for (let i = 0; i < 40 && !linked; i++) { linked = (await text(ctl)).includes("舞台有回應"); if (!linked) await wait(300); }
check("控場看到投影機上線", linked);

// ---- 觀眾位址：瀏覽器算的要跟 Node 獨立算的一模一樣（Worker 驗證用的也是同一套） ----
let addr = null;
for (let i = 0; i < 40 && !addr; i++) {
  const code = await ctl.evaluate(() => document.querySelector(".share-viewer code")?.textContent || "");
  addr = code.match(/#\/w\/([0-9a-f]{32})/)?.[1] || null;
  if (!addr) await wait(250);
}
const P = pbkdf2Sync(`${ROOM}:${PIN}`, "vtjanken-viewer-v1", 300000, 32, "sha256");
const expected = createHash("sha256").update(P).digest("hex").slice(0, 32);
check("瀏覽器算出的觀眾位址 = Node 獨立算的", addr === expected, addr ? "" : "(控場沒產生位址)");

const viewers = await Promise.all(Array.from({ length: N }, () => phone(`/w/${addr}`)));
await wait(3000);
const countText = (await text(ctl)).match(/現在 (\d+) 人在看/)?.[1];
check(`控場顯示觀眾人數 = ${N}`, Number(countText) === N, `（顯示 ${countText ?? "無"}）`);
check("觀眾不佔投影機的位子：控場仍然是「舞台有回應」", (await text(ctl)).includes("舞台有回應"));

// 以觀眾身分監聽觀眾房間的原始封包——懂技術的觀眾看得到的就是這些
const frames = [];
const spy = new WebSocket(`${RELAY}/view/${addr}`);
spy.onmessage = (e) => frames.push(JSON.parse(e.data));
await wait(500);

// ---- 第一局 ----
await ctl.bringToFront();
await ctl.keyboard.press("1");
await wait(2500);
const readyCount = (await Promise.all(viewers.map(text))).filter((t) => t.includes("準備好了")).length;
check(`${N} 支手機都顯示「準備好了」`, readyCount === N, `（${readyCount}/${N}）`);
check("投影機顯示「準備好了」", (await text(stg)).includes("準備好了"));
const leakedEarly = (await Promise.all(viewers.map(text))).filter((t) => t.includes("石頭")).length;
check("揭曉前沒有任何一支手機看得到手勢", leakedEarly === 0);

const t0 = Date.now();
await ctl.click("[data-act=reveal]");
await wait(5500);
const marks = await Promise.all(viewers.map((p) => p.evaluate(() => window.__marks["石頭"] || null)));
const got = marks.filter(Boolean).map((t) => t - t0);
const stgMark = await stg.evaluate(() => window.__marks["石頭"] || null);
check(`${N} 支手機都翻出「石頭」`, got.length === N, `（${got.length}/${N}）`);
check("投影機翻出「石頭」", !!stgMark);
if (got.length) {
  got.sort((a, b) => a - b);
  console.log(`     手機翻牌時間（按下揭曉後）：最快 ${got[0]} ms、最慢 ${got.at(-1)} ms、差距 ${got.at(-1) - got[0]} ms`);
  console.log(`     投影機翻牌時間：${stgMark - t0} ms`);
  check("30 支手機彼此的翻牌時間差在 0.5 秒內", got.at(-1) - got[0] < 500);
}
const cd = frames.find((f) => f.phase === "countdown");
const sel = frames.find((f) => f.phase === "selected");
const rv = frames.find((f) => f.phase === "reveal");
check("封包：選拳時不帶手勢", sel && sel.choice === null);
check("封包：倒數時也不帶手勢（觀眾端）", cd && cd.choice === null);
check("封包：揭曉時才帶手勢", rv && rv.choice === "rock");
check("封包：不含房號", !frames.some((f) => "room" in f));

// ---- 搗亂的觀眾 ----
console.log("\n--- 懂技術的觀眾試著搗亂 ---");
const rogueC = await phone(`/c/${addr}`);           // 把網址的 w 改成 c
await wait(1500);
await rogueC.keyboard.press("2");
await wait(300);
await rogueC.click("[data-act=reveal]").catch(() => {});
const rogueS = await phone(`/s/${addr}`, { mobile: false });  // 把 w 改成 s
const fake = new WebSocket(`${RELAY}/view/${addr}`);          // 直接對觀眾房間送假揭曉
await new Promise((r) => { fake.onopen = r; setTimeout(r, 3000); });
fake.send(JSON.stringify({ type: "state", phase: "reveal", round: 9, choice: "paper", id: "fake-1", ts: Date.now() }));
const forged = await new Promise((res) => {
  const ws = new WebSocket(`${RELAY}/view/${addr}?pub=${"ab".repeat(32)}`);
  ws.onopen = () => res("accepted"); ws.onerror = () => res("rejected"); setTimeout(() => res("timeout"), 4000);
});
await wait(5000);
const hit = async (w) => { const t = await text(w); return t.includes("剪刀") || t.includes("布"); };
check("網址改成 /c/ 也操控不了投影機", !(await hit(stg)));
check("網址改成 /c/ 也操控不了其他觀眾", !(await Promise.all(viewers.map(hit))).some(Boolean));
check("直接送假封包，其他觀眾不受影響", !(await Promise.all(viewers.map((v) => text(v).then((t) => t.includes("布"))))).some(Boolean));
check("自己編一把發訊鑰匙會被拒絕", forged === "rejected", `（${forged}）`);

// ---- 第二局：舞台上沒有提示字、沒有 QR 畫面、沒有任何技術字眼 ----
console.log("\n--- 投影機畫面 ---");
await ctl.bringToFront();
await ctl.click("[data-act=next]");
await wait(1500);
await rogueS.close().catch(() => {});
await stg.bringToFront();
// 待機畫面只該有「猜拳」（左上角那顆幾乎隱形的音效鈕不算）。
const idleWords = async () => (await text(stg)).replace(/音效[開關]/g, "").replace(/\s+/g, " ").trim();
check("投影機待機畫面只有「猜拳」，沒有操作提示字", (await idleWords()) === "猜拳", `「${await idleWords()}」`);
// 舞台原本按 Q 會秀出觀眾 QR，企劃組怕現場誤觸，已經拿掉：按了不該有任何反應。
await stg.keyboard.press("q");
await wait(1500);
const afterQ = await stg.evaluate(() => ({ imgs: document.querySelectorAll(".stage img").length, overlay: !!document.querySelector(".viewer-qr") }));
check("舞台按 Q 不會跳出任何東西", afterQ.imgs === 0 && !afterQ.overlay && (await idleWords()) === "猜拳", `「${await idleWords()}」`);
await ctl.bringToFront();
await ctl.keyboard.press("3");
await wait(2000);
check("藝人選拳後投影機顯示「準備好了」", (await text(stg)).includes("準備好了"));
// 只拿掉舞台端的；控場上的綠框觀眾 QR 要原樣留著當備用。
const kept = await ctl.evaluate(() => ({
  qr: (document.querySelector("#qr-viewer")?.getAttribute("src") || "").startsWith("data:image"),
  copy: !!document.querySelector("[data-act=copy-viewer]"),
  mentionsQ: /按\s*Q/.test(document.querySelector(".share-viewer")?.textContent || ""),
}));
check("控場仍保留綠框觀眾 QR 與複製網址", kept.qr && kept.copy);
check("控場的說明不再提到按 Q", !kept.mentionsQ);

await stg.click(".stage-board");                       // 點一下＝進全螢幕
await wait(800);
const fsOn = await stg.evaluate(() => !!document.fullscreenElement);
await ctl.bringToFront();
await ctl.click("[data-act=reveal]");
await wait(4500);
await ctl.click("[data-act=next]");
await wait(1500);
check("沒有提示字，點一下仍然會進全螢幕", fsOn);
check("全螢幕下待機畫面一樣只有「猜拳」", (await idleWords()) === "猜拳", `「${await idleWords()}」`);
await stg.evaluate(() => document.exitFullscreen?.());
await wait(800);

if (KILL) {
  console.log("\n--- 主線掛掉時投影機長什麼樣子 ---");
  execSync(KILL, { stdio: "ignore" });
  await wait(12000);
  const stageText = await text(stg);
  const dot = await stg.evaluate(() => { const d = document.querySelector(".stage-dot"); return { cls: d?.className, label: d?.dataset.label }; });
  check("投影機燈號變黃", dot.cls?.includes("tone-yellow"), `（${dot.cls}）`);
  check("投影機畫面上沒有任何文字警告", !/relay|ntfy|通道|斷線|備用|備援/.test(stageText), stageText ? `「${stageText.replace(/\s+/g, " ").trim()}」` : "");
  console.log(`     滑鼠移到燈上的說明：「${dot.label}」`);
  const note = await ctl.evaluate(() => document.querySelector(".link-note")?.textContent || "");
  const chip = await ctl.evaluate(() => document.querySelector(".status-chip")?.textContent || "");
  check("控場手機上有白話說明", note.length > 0 && !/relay|ntfy/.test(note), `「${chip.trim()}」${note}`);
  await ctl.bringToFront();
  await ctl.keyboard.press("2");
  await wait(2500);
  await ctl.click("[data-act=reveal]");
  await wait(6000);
  check("主線掛了，投影機照樣翻牌（走備用線路）", (await text(stg)).includes("剪刀"));
}

try { spy.close(); fake.close(); } catch {}
await browser.close();
console.log(fails.length ? `\n${fails.length} 項失敗 -> ${fails.join("、")}` : `\n全部通過`);
process.exit(fails.length ? 1 : 0);

// 觀眾房間（/view/<位址>）驗證：發訊鑰匙、觀眾只能收、晚到補狀態、人數回報、上限、房間隔離。
// 只用 Node，不需要瀏覽器。預設打本機 relay；上限測試需要把上限調小：
//
//   cd worker && npx wrangler dev --var MAX_VIEWERS:5      # 另開一個終端機
//   node scripts/verify-viewers.mjs
//
// 對正式環境跑（上限是 1000，跳過上限測試）：
//   RHOST=wss://vtjanken-relay.vtuber-live-janken.workers.dev CAP=0 node scripts/verify-viewers.mjs
import { pbkdf2Sync, createHash } from "node:crypto";
const HOST = process.env.RHOST || "ws://127.0.0.1:8787";
const CAP = Number(process.env.CAP ?? 5);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (n, ok) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fails.push(n); };

const room = "V" + Math.random().toString(36).slice(2, 5).toUpperCase(), pin = "2468";
const P = pbkdf2Sync(`${room}:${pin}`, "vtjanken-viewer-v1", 300000, 32, "sha256");
const pub = P.toString("hex");
const addr = createHash("sha256").update(P).digest("hex").slice(0, 32);

function conn(query = "") {
  return new Promise((res) => {
    const ws = new WebSocket(`${HOST}/view/${addr}${query}`);
    ws.got = [];
    ws.onmessage = (e) => ws.got.push(String(e.data));
    ws.onopen = () => res(ws);
    ws.onerror = () => res(null);
    setTimeout(() => res(null), 6000);
  });
}
const msg = (phase, extra = {}) => JSON.stringify({ type: "state", phase, round: 1, id: `${phase}-${Math.random()}`, ...extra });

const v1 = await conn();
const control = await conn(`?pub=${pub}`);
check("觀眾可以連上", !!v1);
check("正確的發訊鑰匙可以連上", !!control);
await wait(300);

control.send(msg("selected", { choice: null }));
await wait(400);
check("觀眾收到控場的訊息", v1.got.some((m) => m.includes('"selected"')));

const v2 = await conn();
await wait(300);
v2.send(msg("reveal", { choice: "rock" }));   // 觀眾試圖假冒揭曉
await wait(500);
check("觀眾送的假訊息不會傳給其他觀眾", !v1.got.some((m) => m.includes('"rock"')));
check("晚到的觀眾一連上就拿到目前的狀態", v2.got.some((m) => m.includes('"selected"')));

const wrong = pbkdf2Sync(`${room}:9999`, "vtjanken-viewer-v1", 300000, 32, "sha256").toString("hex");
check("錯的發訊鑰匙（PIN 不對）被拒絕", (await conn(`?pub=${wrong}`)) === null);
check("格式不對的鑰匙被拒絕", (await conn(`?pub=abc`)) === null);
check("拿觀眾位址本身當鑰匙也沒用", (await conn(`?pub=${addr}${addr}`)) === null);

const counts = control.got.filter((m) => m.includes('"viewers"')).map((m) => JSON.parse(m).count);
check(`控場收到觀眾人數更新（最後 = ${counts.at(-1)}）`, counts.at(-1) === 2);

const extra = [];
if (CAP > 0) {
  for (let i = 0; i < CAP; i++) extra.push(await conn());
  const accepted = extra.filter(Boolean).length;
  check(`觀眾上限 ${CAP} 生效（已有 2 人，再開 ${CAP} 條只收 ${CAP - 2}）`, accepted === CAP - 2);
}

const bad = await new Promise((res) => {
  const ws = new WebSocket(`${HOST}/view/nothex`);
  ws.onopen = () => res("open"); ws.onerror = () => res("rejected"); setTimeout(() => res("timeout"), 5000);
});
check("位址格式不對直接拒絕", bad === "rejected");

// 觀眾房間跟控場／舞台房間完全隔離
const k = await new Promise((res) => { const ws = new WebSocket(`${HOST}/room/${addr}`); ws.got = []; ws.onmessage = (e) => ws.got.push(String(e.data)); ws.onopen = () => res(ws); ws.onerror = () => res(null); });
await wait(300);
control.send(msg("countdown"));
await wait(400);
check("觀眾房間的訊息不會流進同名的控場房間", !k.got.some((m) => m.includes('"countdown"')));

for (const w of [v1, v2, control, k, ...extra]) { try { w?.close(); } catch {} }
console.log(fails.length ? `\n${fails.length} 項失敗 -> ${fails.join(", ")}` : `\n全部通過`);
process.exit(fails.length ? 1 : 0);

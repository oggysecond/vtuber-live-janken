// Relay 防護驗證：連線數上限與單一連線的發訊頻率上限。
// 需要一個跑著的 relay，預設打本機的 wrangler dev：
//
//   cd worker && npx wrangler dev          # 另開一個終端機
//   node scripts/verify-relay-limits.mjs
//
// 要測正式環境就給 RHOST：
//   RHOST=wss://vtjanken-relay.vtuber-live-janken.workers.dev node scripts/verify-relay-limits.mjs
const HOST = process.env.RHOST || "ws://127.0.0.1:8787";
const KEY = "ratetest" + Math.random().toString(36).slice(2, 8);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (n, ok) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fails.push(n); };

function conn(role) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${HOST}/room/${KEY}?role=${role}`);
    ws.received = [];
    ws.onmessage = (e) => { if (!String(e.data).includes("presence")) ws.received.push(e.data); };
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error("connect failed"));
    setTimeout(() => rej(new Error("timeout")), 8000);
  });
}

const victim = await conn("stage");
const flooder = await conn("control");
await wait(400);

// 1) 正常節奏的一局（4 則）必須完全不受影響
for (let i = 0; i < 4; i++) { flooder.send(JSON.stringify({ type: "state", n: i, id: `ok${i}`, from: "c", room: "R" })); await wait(120); }
await wait(600);
check("正常一局 4 則訊息全部送達", victim.received.filter((m) => m.includes('"ok')).length === 4);

victim.received.length = 0;
// 2) 灌量 200 則，應該被擋在上限附近
for (let i = 0; i < 200; i++) flooder.send(JSON.stringify({ type: "state", n: i, id: `flood${i}`, from: "c", room: "R" }));
await wait(2500);
const got = victim.received.filter((m) => m.includes("flood")).length;
console.log(`     灌 200 則，舞台實際收到 ${got} 則`);
check("灌量被擋下（收到 < 40 則）", got < 40);
check("但沒有整條連線斷掉", flooder.readyState === 1);

victim.received.length = 0;
// 3) 視窗過後要能恢復，不能把人永久封死
await wait(10500);
flooder.send(JSON.stringify({ type: "state", id: "after", from: "c", room: "R" }));
await wait(800);
check("限流視窗過後恢復正常", victim.received.some((m) => m.includes("after")));

for (const w of [victim, flooder]) { try { w.close(); } catch {} }
console.log(fails.length ? `\n${fails.length} 項失敗 -> ${fails.join(", ")}` : `\n全部通過`);
process.exit(fails.length ? 1 : 0);

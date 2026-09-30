// 現場猜拳 relay：房間內的訊息原樣轉發給其他人，並回報誰在線上。
// 伺服器不知道房間代碼也不知道 PIN——網址上的 key 是前端雜湊過的。
//
// 兩種房間：
//   /room/<key>  控場＋投影機。知道 key 的人都能發訊，所以 key 不能公開。
//   /view/<位址> 觀眾。位址可以公開，觀眾只能收；要發訊得出示 P，
//                而 SHA-256(P) 的前 32 碼才等於位址，觀眾反推不出 P。

const MAX_SOCKETS = 8;
const MAX_BYTES = 4096;

// 單一連線的發訊上限。正常一局只會送 4 則，按鍵按得再快也遠低於這個數字，
// 所以不會誤擋現場操作。它擋的是灌量（燒請求配額、拖垮房間），
// 不是擋「拿到房號和 PIN 的人送一則假訊息」——那只能靠保密。
const RATE_WINDOW_MS = 10000;
const RATE_MAX = 30;

function allowRate(rates, ws) {
  const id = ws.deserializeAttachment()?.id;
  if (!id) return true;
  const now = Date.now();
  const slot = rates.get(id);
  if (!slot || now - slot.start >= RATE_WINDOW_MS) {
    rates.set(id, { start: now, count: 1 });
    return true;
  }
  slot.count += 1;
  return slot.count <= RATE_MAX;
}

const ALLOWED = [
  "https://oggysecond.github.io",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:4173",
];

function originOk(origin) {
  if (!origin) return true; // 非瀏覽器客戶端（測試腳本）沒有 Origin。
  if (ALLOWED.includes(origin)) return true;
  // 現場備援：同網段的筆電用 Network 網址開（http://192.168.x.x:4173）。
  return /^https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(origin);
}

export class JankenRoom {
  constructor(ctx) {
    this.ctx = ctx;
    // 只放在記憶體。DO 休眠會清空，但休眠代表那段時間根本沒有訊息，
    // 也就沒有人在灌量，所以歸零是安全的。
    this.rates = new Map();
  }

  allow(ws) {
    return allowRate(this.rates, ws);
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const role =
      new URL(request.url).searchParams.get("role") === "stage" ? "stage" : "control";

    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response("room full", { status: 503 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    // Hibernation API：沒有訊息時 DO 可以休眠，連線不會斷，才待得住免費額度。
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, id: crypto.randomUUID() });
    this.sendPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_BYTES) return;
    // 超量就直接丟棄，不回報——回報等於給攻擊者一個放大管道。
    if (!this.allow(ws)) return;
    if (raw === "ping") {
      ws.send("pong");
      return;
    }
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      try {
        peer.send(raw);
      } catch {
        /* 下一輪 close 事件會清掉 */
      }
    }
  }

  webSocketClose(ws) {
    this.rates.delete(ws.deserializeAttachment()?.id);
    try {
      ws.close();
    } catch {
      /* 已經關了 */
    }
    // 這個 handler 還在跑的時候，關閉中的 socket 仍然留在 getWebSockets()
    // 裡，不排掉的話舞台掉線後控場會繼續看到綠燈。
    this.sendPresence(ws);
  }

  webSocketError(ws) {
    this.sendPresence(ws);
  }

  sendPresence(closing) {
    const sockets = this.ctx.getWebSockets().filter((peer) => peer !== closing);
    let stage = 0;
    let control = 0;
    for (const peer of sockets) {
      const tag = peer.deserializeAttachment();
      if (tag?.role === "stage") stage += 1;
      else control += 1;
    }
    const frame = JSON.stringify({ type: "presence", stage, control });
    for (const peer of sockets) {
      try {
        peer.send(frame);
      } catch {
        /* 忽略 */
      }
    }
  }
}

// 觀眾房間。跟 JankenRoom 分開，觀眾再多、再怎麼亂連，
// 都碰不到控場和投影機所在的那個房間。
const MAX_PUBLISHERS = 4;
const DEFAULT_MAX_VIEWERS = 1000;
// 最後一則狀態存在發訊端 socket 的 attachment 裡（上限 2 KB），DO 休眠也不會丟，
// 晚到的觀眾一連上就看得到現在是哪個階段。
const MAX_CACHE = 1500;

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/.test(hex || "")) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class ViewerRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.maxViewers = Number(env?.MAX_VIEWERS) || DEFAULT_MAX_VIEWERS;
    this.rates = new Map();
  }

  allow(ws) {
    return allowRate(this.rates, ws);
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const address = url.pathname.split("/").pop();
    const pub = url.searchParams.get("pub");

    let role = "viewer";
    if (pub !== null) {
      const bytes = hexToBytes(pub);
      if (!bytes || !(await sha256Hex(bytes)).startsWith(address)) {
        return new Response("bad publisher key", { status: 403 });
      }
      role = "pub";
    }

    const limit = role === "pub" ? MAX_PUBLISHERS : this.maxViewers;
    if (this.ctx.getWebSockets(role).length >= limit) {
      return new Response("room full", { status: 503 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, id: crypto.randomUUID() });

    if (role === "viewer") {
      const last = this.latest();
      if (last) server.send(last);
    }
    this.sendCount();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    const tag = ws.deserializeAttachment();
    // 觀眾送來的任何東西都直接丟掉，連頻率都不用算。
    if (tag?.role !== "pub") return;
    if (typeof raw !== "string" || raw.length > MAX_BYTES) return;
    if (!this.allow(ws)) return;
    if (raw.length <= MAX_CACHE) ws.serializeAttachment({ ...tag, last: raw, lastAt: Date.now() });
    for (const viewer of this.ctx.getWebSockets("viewer")) {
      try {
        viewer.send(raw);
      } catch {
        /* 下一輪 close 事件會清掉 */
      }
    }
  }

  webSocketClose(ws) {
    this.rates.delete(ws.deserializeAttachment()?.id);
    try {
      ws.close();
    } catch {
      /* 已經關了 */
    }
    this.sendCount(ws);
  }

  webSocketError(ws) {
    this.sendCount(ws);
  }

  latest() {
    let best = null;
    for (const pub of this.ctx.getWebSockets("pub")) {
      const tag = pub.deserializeAttachment();
      if (tag?.last && (!best || tag.lastAt > best.lastAt)) best = tag;
    }
    return best?.last || null;
  }

  // 觀眾人數只告訴控場，不廣播給觀眾——幾百人進出時才不會變成 N² 的訊息量。
  sendCount(closing) {
    const count = this.ctx.getWebSockets("viewer").filter((s) => s !== closing).length;
    const frame = JSON.stringify({ type: "viewers", count });
    for (const pub of this.ctx.getWebSockets("pub")) {
      if (pub === closing) continue;
      try {
        pub.send(frame);
      } catch {
        /* 忽略 */
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const view = url.pathname.match(/^\/view\/([0-9a-f]{32})$/);
    if (view) {
      if (!originOk(request.headers.get("Origin"))) {
        return new Response("forbidden origin", { status: 403 });
      }
      return env.VIEW.get(env.VIEW.idFromName(view[1])).fetch(request);
    }

    const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{4,64})$/);
    if (!match) return new Response("not found", { status: 404 });

    if (!originOk(request.headers.get("Origin"))) {
      return new Response("forbidden origin", { status: 403 });
    }

    const id = env.ROOM.idFromName(match[1]);
    return env.ROOM.get(id).fetch(request);
  },
};

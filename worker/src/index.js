// 現場猜拳 relay：房間內的訊息原樣轉發給其他人，並回報誰在線上。
// 伺服器不知道房間代碼也不知道 PIN——網址上的 key 是前端雜湊過的。

const MAX_SOCKETS = 8;
const MAX_BYTES = 4096;

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
    server.serializeAttachment({ role });
    this.sendPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_BYTES) return;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
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

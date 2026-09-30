import { RELAY_URL } from "./config.js";

// 觀眾連結。控場和投影機走的通道（sync.js）知道 key 的人都能發訊，
// 所以那條線的網址絕對不能給觀眾；觀眾走的是 relay 上另一個獨立的房間，
// 只能收、不能發，人再多也碰不到投影機。
//
// 位址怎麼來：
//   P    = PBKDF2(房號:PIN, 30 萬輪)   —— 只有知道房號和 PIN 的人算得出來
//   位址 = SHA-256(P) 的前 32 碼       —— 放進觀眾網址，可以公開
// relay 只在發訊端出示的 P 雜湊後對得上位址時才讓它廣播。
// 30 萬輪是故意的：觀眾連結會公開，有人拿著位址暴力猜房號＋PIN（約一百億種組合），
// 每猜一次都得跑 30 萬輪，一張顯示卡也要好幾天，演出早就結束了。

const SALT = "vtjanken-viewer-v1";
const ITERATIONS = 300000;
const keyCache = new Map();

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

let seq = 0;
const nextId = () => `v${Date.now()}-${(seq += 1)}-${Math.random().toString(16).slice(2, 8)}`;

// crypto.subtle 只存在於 HTTPS／localhost。現場斷網備援用 http://192.168.x.x 開的時候
// 沒有觀眾模式——那時也沒有網路可以讓觀眾連，所以直接回 null。
export function viewerKeys(room, pin) {
  const secret = `${String(room || "").toUpperCase()}:${String(pin || "")}`;
  if (!keyCache.has(secret)) {
    const job = (async () => {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) return null;
      const enc = new TextEncoder();
      const base = await subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
      const bits = await subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(SALT), iterations: ITERATIONS },
        base,
        256
      );
      return { pub: toHex(bits), address: toHex(await subtle.digest("SHA-256", bits)).slice(0, 32) };
    })().catch(() => null);
    keyCache.set(secret, job);
  }
  return keyCache.get(secret);
}

export function viewerUrl(address) {
  return `${location.origin}${location.pathname}#/w/${address}`;
}

// 給觀眾的訊息只挑必要欄位：不帶房號，而且倒數時不帶手勢。
// 投影機在倒數時需要知道手勢，才能在自己的 0 秒準時翻牌；但觀眾手機上的資料
// 懂技術的人讀得到，如果現場是「倒數到 0 大家一起出」，提前 3 秒知道就能作弊。
function forViewers(payload) {
  return {
    type: "state",
    phase: payload.phase,
    round: payload.round,
    choice: payload.phase === "reveal" ? payload.choice ?? null : null,
    id: nextId(),
    ts: Date.now(),
  };
}

function reconnectDelay(tries) {
  return Math.min(800 * 2 ** (tries - 1), 15000);
}

// 控場端：把每一步同步推給觀眾，並回報有幾個人在看。
export function createViewerFeed({ room, pin, onCount }) {
  let alive = true;
  let ws = null;
  let timer;
  let tries = 0;
  let keys = null;
  let latest = null;

  function connect() {
    if (!alive || !RELAY_URL || !keys) return;
    let socket;
    try {
      socket = new WebSocket(`${RELAY_URL}/view/${keys.address}?pub=${keys.pub}`);
    } catch {
      schedule();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      if (ws !== socket) return;
      tries = 0;
      // 重連之後補送最後一則，relay 才有東西給晚到的觀眾。同一個 id，已經看過的人會略過。
      if (latest) socket.send(latest);
    };
    socket.onmessage = (event) => {
      if (ws !== socket) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame?.type === "viewers") onCount?.(frame.count | 0);
      } catch {
        /* ignore */
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      onCount?.(null);
      schedule();
    };
    socket.onerror = () => {
      /* onclose 會跟著來 */
    };
  }

  function schedule() {
    if (!alive) return;
    clearTimeout(timer);
    tries += 1;
    timer = setTimeout(connect, reconnectDelay(tries));
  }

  viewerKeys(room, pin).then((k) => {
    keys = k;
    connect();
  });

  return {
    send(payload) {
      latest = JSON.stringify(forViewers(payload));
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(latest);
        } catch {
          /* 重連時會補送 */
        }
      }
    },
    destroy() {
      alive = false;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
  };
}

// 觀眾端：只收不發。
export function createViewerLink({ address, onMessage, onStatus }) {
  let alive = true;
  let ws = null;
  let timer;
  let tries = 0;
  let everOpen = false;
  const seen = new Set();

  const degraded = () => everOpen || tries >= 3;

  function connect() {
    if (!alive) return;
    if (!RELAY_URL) {
      onStatus?.("down");
      return;
    }
    let socket;
    try {
      socket = new WebSocket(`${RELAY_URL}/view/${address}`);
    } catch {
      onStatus?.(degraded() ? "down" : "connecting");
      schedule();
      return;
    }
    ws = socket;
    onStatus?.(degraded() ? "down" : "connecting");
    socket.onopen = () => {
      if (ws !== socket) return;
      everOpen = true;
      tries = 0;
      onStatus?.("open");
    };
    socket.onmessage = (event) => {
      if (ws !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message?.id || seen.has(message.id)) return;
      seen.add(message.id);
      if (seen.size > 200) seen.delete(seen.values().next().value);
      onMessage(message);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      onStatus?.(degraded() ? "down" : "connecting");
      schedule();
    };
    socket.onerror = () => {
      /* onclose 會跟著來 */
    };
  }

  function schedule() {
    if (!alive) return;
    clearTimeout(timer);
    tries += 1;
    timer = setTimeout(connect, reconnectDelay(tries));
  }

  connect();

  return {
    destroy() {
      alive = false;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
  };
}

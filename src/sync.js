import { RELAY_URL } from "./config.js";

const NTFY_PREFIX = "vtjanken2026";

// ntfy.sh 每 5 秒才回補 1 則發送額度（burst 約 60）。心跳一定要比它慢，
// 否則開場幾分鐘後就會開始收到 429，而且是無聲無息地斷掉。
export const HELLO_MS = 12000;
export const STALE_MS = 30000;

function messageId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clientId() {
  const key = "vtjanken-client";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const created = messageId();
  sessionStorage.setItem(key, created);
  return created;
}

// 房間代碼 + PIN 推導出實際的通道名稱，房號被看到也訂閱不到。
// 這裡刻意不用 crypto.subtle：它只在 HTTPS／localhost 底下才存在，
// 現場斷網備援是用 http://192.168.x.x 開的，那裡它是 undefined，
// 兩台裝置就會算出不同的 key 而永遠對不上。
export function channelKey(room, pin) {
  const text = `${String(room || "").trim().toUpperCase()}:${String(pin || "").trim()}`;
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds
    .map((seed) => {
      let h = seed >>> 0;
      for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      h ^= h >>> 16;
      h = Math.imul(h, 0x2246029b) >>> 0;
      h ^= h >>> 15;
      return (h >>> 0).toString(36).padStart(7, "0").slice(-7);
    })
    .join("");
}

async function postText(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  if (!res.ok && res.status !== 204) {
    const err = new Error(`publish ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

export function createSync({ room, pin, role, onMessage, onStatus }) {
  const key = channelKey(room, pin);
  const self = clientId();
  const seen = new Set();
  const lastTsByPeer = new Map();

  let alive = true;
  let ws = null;
  let wsTimer;
  let wsTries = 0;
  let everOpen = false;
  let localEs;
  let localTimer;
  let localTries = 0;
  let localOk = false;
  let ntfyEs;

  const status = {
    relay: RELAY_URL ? "connecting" : "off",
    ntfy: "connecting",
    limited: false,
    stage: 0,
    control: 0,
  };

  const setStatus = (patch) => {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (status[k] !== v) {
        status[k] = v;
        changed = true;
      }
    }
    if (changed) onStatus?.({ ...status });
  };

  // ntfy 的 SSE 不是直接丟回 payload，而是包一層信封：
  //   {"id":"…","topic":"…","event":"message","message":"<payload 的 JSON 字串>"}
  // 少解這一層，所有跨裝置的訊息都會在底下的欄位檢查被丟掉——
  // 這就是先前「一定要同一台裝置」的真正原因。
  function unwrap(raw) {
    let data = raw;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return null;
      }
    }
    if (!data || typeof data !== "object") return null;
    if (data.event && data.event !== "message") return null;
    if (typeof data.message === "string" && typeof data.topic === "string") {
      try {
        data = JSON.parse(data.message);
      } catch {
        return null;
      }
    }
    return data;
  }

  function ingest(raw) {
    if (!alive) return;
    const data = unwrap(raw);
    if (!data || data.room !== room || !data.id || !data.from) return;
    if (data.from === self) return;
    if (seen.has(data.id)) return;
    seen.add(data.id);
    if (seen.size > 200) seen.delete(seen.values().next().value);
    // 時間戳只跟同一個來源比：兩台裝置的時鐘不會一致，
    // 拿全域的 lastTs 去比會把時鐘較慢那台的訊息整批丟掉。
    if (typeof data.ts === "number") {
      const prev = lastTsByPeer.get(data.from) || 0;
      if (data.ts < prev) return;
      lastTsByPeer.set(data.from, data.ts);
    }
    onMessage(data);
  }

  const channel = new BroadcastChannel(`vtjanken-${key}`);
  channel.onmessage = (event) => ingest(event.data);

  // 連過一次之後就不再回報「連線中」：重連期間必須維持 down，
  // 否則每 800ms 的重試會把警告洗掉，現場只看得到畫面不動、沒有任何提示。
  // 從頭到尾都連不上（網址打錯、場地擋 WebSocket）時，重試三次後也轉成 down。
  const relayDegraded = () => everOpen || wsTries >= 3;

  function connectRelay() {
    if (!alive || !RELAY_URL) return;
    let socket;
    try {
      socket = new WebSocket(`${RELAY_URL}/room/${key}?role=${role}`);
    } catch {
      setStatus({ relay: relayDegraded() ? "down" : "connecting" });
      scheduleRelay();
      return;
    }
    ws = socket;
    setStatus({ relay: relayDegraded() ? "down" : "connecting" });

    socket.onopen = () => {
      if (ws !== socket) return;
      everOpen = true;
      wsTries = 0;
      setStatus({ relay: "open" });
    };
    socket.onmessage = (event) => {
      if (ws !== socket || event.data === "pong") return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      // presence 只信任 relay 這條線，不經過 ingest，才不會被 ntfy 上的人偽造。
      if (frame?.type === "presence") {
        setStatus({ stage: frame.stage | 0, control: frame.control | 0 });
        return;
      }
      ingest(frame);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      setStatus({ relay: relayDegraded() ? "down" : "connecting", stage: 0, control: 0 });
      scheduleRelay();
    };
    socket.onerror = () => {
      /* onclose 一定會跟著來，在那裡重連就好 */
    };
  }

  function scheduleRelay() {
    if (!alive || !RELAY_URL) return;
    clearTimeout(wsTimer);
    wsTries += 1;
    wsTimer = setTimeout(connectRelay, Math.min(800 * 2 ** (wsTries - 1), 10000));
  }

  // 本機開發／現場斷網備援時，vite 外掛提供的 relay。
  // 正式站（GitHub Pages）上根本沒有 /api，所以試幾次就放棄：
  // 否則整場演出會每 2 秒對著 404 重試一次，每則訊息也白打一次。
  function connectLocal() {
    if (!alive || localTries >= 3) return;
    localTries += 1;
    try {
      localEs?.close();
      const base = location.pathname.replace(/[^/]*$/, "");
      localEs = new EventSource(`${base}api/sub?room=${encodeURIComponent(key)}`);
      localEs.onopen = () => {
        localOk = true;
        localTries = 0;
      };
      localEs.onmessage = (event) => ingest(event.data);
      localEs.onerror = () => {
        localEs?.close();
        localEs = null;
        if (!alive) return;
        clearTimeout(localTimer);
        localTimer = setTimeout(connectLocal, 2000);
      };
    } catch {
      localEs = null;
    }
  }

  function connectNtfy() {
    if (!alive) return;
    try {
      ntfyEs?.close();
      ntfyEs = new EventSource(`https://ntfy.sh/${NTFY_PREFIX}-${key}/sse`);
      ntfyEs.onopen = () => setStatus({ ntfy: "open" });
      ntfyEs.onmessage = (event) => ingest(event.data);
      // EventSource 會自己重連，這裡只負責讓畫面知道現在是斷的。
      ntfyEs.onerror = () => setStatus({ ntfy: "down" });
    } catch {
      ntfyEs = null;
      setStatus({ ntfy: "down" });
    }
  }

  connectRelay();
  connectLocal();
  connectNtfy();

  async function send(payload) {
    const message = {
      ...payload,
      v: 1,
      id: messageId(),
      from: self,
      ts: Date.now(),
      room,
    };
    const text = JSON.stringify(message);

    channel.postMessage(message);

    let relayOk = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(text);
        relayOk = true;
      } catch {
        relayOk = false;
      }
    }

    const jobs = [];
    if (localOk) {
      const base = location.pathname.replace(/[^/]*$/, "");
      jobs.push(postText(`${base}api/pub?room=${encodeURIComponent(key)}`, text).catch(() => {}));
    }

    // 出拳／揭曉這種關鍵訊息一律兩條線都送，多一層保險。
    // 心跳只在 relay 斷線時才走 ntfy——它才是會燒光免費額度的那個。
    if (payload.type !== "hello" || !relayOk) {
      jobs.push(
        postText(`https://ntfy.sh/${NTFY_PREFIX}-${key}`, text)
          .then(() => setStatus({ limited: false }))
          .catch((err) => {
            if (err.status === 429) setStatus({ limited: true });
          })
      );
    }

    await Promise.all(jobs);
    return message;
  }

  function destroy() {
    alive = false;
    clearTimeout(wsTimer);
    clearTimeout(localTimer);
    channel.close();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
    localEs?.close();
    ntfyEs?.close();
  }

  return { send, destroy, key, status: () => ({ ...status }) };
}

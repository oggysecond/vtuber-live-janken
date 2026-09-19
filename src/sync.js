const NTFY_PREFIX = "vtjanken2026";

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

async function postJson(url, data) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(data),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`publish failed ${res.status}`);
  }
}

export function createSync(room, onMessage) {
  const seen = new Set();
  const self = clientId();
  let alive = true;
  let localEs;
  let ntfyEs;
  let reconnectTimer;
  let lastTs = 0;

  const channel = new BroadcastChannel(`vtjanken-${room}`);

  const ingest = (raw) => {
    if (!alive || raw == null) return;
    let data = raw;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
    }
    if (!data || data.room !== room || !data.id) return;
    if (data.from === self) return;
    if (seen.has(data.id)) return;
    seen.add(data.id);
    if (seen.size > 80) {
      const first = seen.values().next().value;
      seen.delete(first);
    }
    if (typeof data.ts === "number" && data.ts < lastTs) return;
    if (typeof data.ts === "number") lastTs = data.ts;
    onMessage(data);
  };

  channel.onmessage = (event) => ingest(event.data);

  const connectLocal = () => {
    if (!alive) return;
    try {
      localEs?.close();
      localEs = new EventSource(`/api/sub?room=${encodeURIComponent(room)}`);
      localEs.onmessage = (event) => ingest(event.data);
      localEs.onerror = () => {
        localEs?.close();
        localEs = null;
        if (alive) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectLocal, 1500);
        }
      };
    } catch {
      localEs = null;
    }
  };

  const connectNtfy = () => {
    if (!alive) return;
    try {
      ntfyEs?.close();
      ntfyEs = new EventSource(
        `https://ntfy.sh/${NTFY_PREFIX}-${room}/sse`
      );
      ntfyEs.onmessage = (event) => ingest(event.data);
    } catch {
      ntfyEs = null;
    }
  };

  connectLocal();
  connectNtfy();

  const send = async (payload) => {
    const message = {
      ...payload,
      v: 1,
      id: messageId(),
      from: self,
      ts: Date.now(),
      room,
    };
    channel.postMessage(message);
    const jobs = [
      postJson(`/api/pub?room=${encodeURIComponent(room)}`, message).catch(
        () => {}
      ),
      postJson(`https://ntfy.sh/${NTFY_PREFIX}-${room}`, message).catch(
        () => {}
      ),
    ];
    await Promise.all(jobs);
    return message;
  };

  const destroy = () => {
    alive = false;
    clearTimeout(reconnectTimer);
    channel.close();
    localEs?.close();
    ntfyEs?.close();
  };

  return { send, destroy };
}

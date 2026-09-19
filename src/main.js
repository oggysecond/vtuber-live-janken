import "./style.css";
import QRCode from "qrcode";
import { HANDS, HAND_ORDER, handByKey, handMarkup } from "./hands.js";
import { createSync, HELLO_MS, STALE_MS } from "./sync.js";
import { tickSound, revealSound, unlockAudio } from "./audio.js";
import { helpView } from "./help.js";

const app = document.getElementById("app");
const COUNT_FROM = 3;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const state = {
  route: parseRoute(),
  choice: null,
  phase: "idle",
  count: COUNT_FROM,
  round: 1,
  connectedAt: 0,
  mute: false,
  pendingChoice: null,
  link: { relay: "connecting", ntfy: "connecting", limited: false, stage: 0, control: 0 },
};

let sync;
let countTimer;
let helloTimer;
let wakeLock;
let qrUrl = "";
let qrFor = "";
let linkTimer;
let lastLinkKey = "";

// 網址上的房號長這樣：ABCD-1234（房間代碼 - PIN）。舊的純房號連結仍然可用，
// 只是沒有 PIN 保護。
function parseTag(raw) {
  const [room = "", pin = ""] = String(raw || "").toUpperCase().split("-");
  return {
    room: room.replace(/[^A-Z0-9]/g, "").slice(0, 6),
    pin: pin.replace(/[^0-9]/g, "").slice(0, 6),
  };
}

function roomTag(room, pin) {
  return pin ? `${room}-${pin}` : room;
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "help") {
    return { role: "help", room: parts[1] || "", pin: "" };
  }
  if ((parts[0] === "c" || parts[0] === "s") && parts[1]) {
    const { room, pin } = parseTag(parts[1]);
    return { role: parts[0] === "c" ? "control" : "stage", room, pin };
  }
  return { role: "home", room: "", pin: "" };
}

function makeRoom() {
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    out += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return out;
}

// PIN 決定實際的通道名稱。房號被投影機閃到也沒用，沒有 PIN 就訂閱不到。
function makePin() {
  const n = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(n);
  else n[0] = Math.floor(Math.random() * 0xffffffff);
  return String(n[0] % 10000).padStart(4, "0");
}

function go(hash) {
  location.hash = hash;
}

function stageUrl(room, pin) {
  return `${location.origin}${location.pathname}#/s/${roomTag(room, pin)}`;
}

function nowConnected() {
  // relay 直接告訴我們對面在不在；ntfy 那條線只能靠心跳推斷。
  const { role } = state.route;
  if (role === "control" && state.link.stage > 0) return true;
  if (role === "stage" && state.link.control > 0) return true;
  return Date.now() - state.connectedAt < STALE_MS;
}

// 通道出問題時要講出來。舊版把錯誤全部吞掉，現場只會看到畫面莫名不動。
function linkNote() {
  const { relay, ntfy, limited } = state.link;
  if (relay === "down" && ntfy === "down") return "兩條通道都斷了，請檢查網路";
  if (limited) return "ntfy 被限流，目前靠 relay 傳送";
  if (relay === "down") return "relay 斷線，備援通道接手中";
  return "";
}

function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* ignore */
  }
}

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    /* ignore */
  }
}

function clearCount() {
  clearInterval(countTimer);
  countTimer = null;
}

function applyRemote(message) {
  if (message.type === "hello") {
    if (state.route.role === "control") {
      state.connectedAt = Date.now();
      render();
    }
    return;
  }
  if (message.type !== "state") return;
  state.connectedAt = Date.now();
  state.round = message.round || 1;
  if (state.route.role === "control") {
    if (message.phase === "countdown" && state.phase === "countdown") return;
    if (message.phase === "reveal" && state.phase === "reveal") return;
    // selected 訊息刻意不帶 choice（見 pick()），別拿 null 去洗掉自己的選擇。
    if (message.choice != null || message.phase === "idle") state.choice = message.choice;
  } else {
    state.pendingChoice = message.choice ?? state.pendingChoice;
    if (message.phase !== "reveal") state.choice = null;
  }
  if (message.phase === "countdown") {
    startLocalCountdown(message.choice, false);
    return;
  }
  if (message.phase === "reveal") {
    finishReveal(message.choice, false);
    return;
  }
  if (message.phase === "idle" || message.phase === "selected") {
    state.phase = message.phase;
    clearCount();
    render();
  }
}

function publish(phase, extra = {}) {
  const choice = extra.choice !== undefined ? extra.choice : state.choice;
  return sync?.send({
    type: "state",
    phase,
    choice,
    round: state.round,
    ...extra,
  });
}

function startLocalCountdown(choice, isOrigin) {
  clearCount();
  state.phase = "countdown";
  state.count = COUNT_FROM;
  if (state.route.role === "stage") state.pendingChoice = choice;
  else state.choice = choice;
  render();
  if (!state.mute) tickSound(state.count);
  vibrate(40);
  let left = COUNT_FROM - 1;
  countTimer = setInterval(() => {
    if (left <= 0) {
      clearCount();
      finishReveal(choice, isOrigin);
      return;
    }
    state.count = left;
    render();
    if (!state.mute) tickSound(left);
    vibrate(40);
    left -= 1;
  }, 1000);
}

function finishReveal(choice, isOrigin) {
  clearCount();
  state.phase = "reveal";
  if (state.route.role === "stage") state.choice = choice;
  else state.choice = choice;
  render();
  if (!state.mute) revealSound();
  vibrate([80, 40, 120]);
  if (isOrigin) publish("reveal", { choice });
}

function pick(id) {
  if (state.phase === "countdown" || state.phase === "reveal") return;
  state.choice = id;
  state.phase = "selected";
  vibrate(20);
  // 舞台在揭曉前只會顯示「準備好了」，根本不需要知道是哪個拳。
  // 選拳當下就送出 choice，等於在通道上提前公布答案——這裡把它拿掉，
  // 洩漏窗口就從結構上消失，不必倚賴通道保密。
  publish("selected", { choice: null });
  render();
}

function reveal() {
  if (!state.choice || state.phase === "countdown" || state.phase === "reveal") return;
  unlockAudio();
  startLocalCountdown(state.choice, true);
  publish("countdown", { choice: state.choice });
}

function nextRound() {
  state.round += 1;
  state.choice = null;
  state.pendingChoice = null;
  state.phase = "idle";
  state.count = COUNT_FROM;
  clearCount();
  publish("idle", { choice: null });
  render();
}

function bindKeys() {
  window.onkeydown = (event) => {
    if (state.route.role === "home" || state.route.role === "help") return;
    if (event.target.closest?.("input")) return;
    const hand = handByKey(event.key);
    if (hand && state.route.role === "control") {
      event.preventDefault();
      pick(hand.id);
    }
    if (state.route.role === "control" && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      if (state.phase === "reveal") nextRound();
      else reveal();
    }
    if (state.route.role === "stage" && event.key.toLowerCase() === "f") {
      document.documentElement.requestFullscreen?.();
    }
  };
}

function homeView() {
  return `
    <main class="page home">
      <section class="home-card">
        <div class="kicker">LIVE JANKEN</div>
        <h1>現場猜拳</h1>
        <p class="lead">藝人先用 1 2 3 密選手勢，觀眾在大螢幕上看不到。按下揭曉後倒數 3 秒，舞台才翻出超大手勢。</p>
        <div class="steps">
          <div><span class="num">1</span><span>手機打開「控場」，按 1 石頭／2 剪刀／3 布。這個畫面只有藝人看。</span></div>
          <div><span class="num">2</span><span>投影電腦打開「舞台」網址，全螢幕。揭曉前不會出現手勢。</span></div>
          <div><span class="num">3</span><span>觀眾出拳後，控場按「揭曉」。大螢幕 3、2、1，然後翻牌。</span></div>
        </div>
        <button class="primary" data-act="create">建立房間</button>
        <div class="join-row two">
          <input id="room-input" maxlength="6" placeholder="房間代碼" autocomplete="off" />
          <input id="pin-input" maxlength="4" placeholder="PIN" inputmode="numeric" autocomplete="off" />
        </div>
        <div class="link-row">
          <button class="ghost" data-act="join-control">進控場</button>
          <button class="ghost" data-act="join-stage">進舞台畫面</button>
        </div>
        <div class="link-row">
          <button class="ghost" data-act="help">使用說明</button>
          <button class="ghost" data-act="staff">工作人員說明</button>
        </div>
        <p class="tiny">房間代碼和 PIN 兩個都要一樣才連得上。建議手機當控場、筆電接投影當舞台。鍵盤 1 / 2 / 3 出拳，Enter 揭曉。</p>
      </section>
    </main>
  `;
}

function controlView(room) {
  const note = linkNote();
  const hand = state.choice ? HANDS[state.choice] : null;
  const canReveal = Boolean(hand) && state.phase !== "countdown" && state.phase !== "reveal";
  const secretClass = hand ? "secret is-picked" : "secret";
  const secretStyle = hand ? `--hand:${hand.color};--glow:${hand.glow}` : "";
  const secretInner = hand
    ? handMarkup(hand.id)
    : `<div class="secret-empty">按 1、2、3 先出拳</div>`;
  const revealLabel =
    state.phase === "countdown"
      ? `倒數 ${state.count}`
      : state.phase === "reveal"
        ? "已揭曉"
        : "揭曉：倒數 3 秒";

  return `
    <main class="page control">
      <header class="topbar">
        <div>
          <div class="brand">控場</div>
          <div class="room-chip">房間 ${room}${state.route.pin ? ` · PIN ${state.route.pin}` : ""}</div>
        </div>
        <div class="status-chip ${nowConnected() ? "is-on" : ""}">${nowConnected() ? "舞台有回應" : "等待舞台"}</div>
      </header>
      ${note ? `<p class="link-note">${note}</p>` : ""}
      <section class="${secretClass}" style="${secretStyle}">${secretInner}</section>
      <section class="choices">
        ${HAND_ORDER.map((id) => {
          const item = HANDS[id];
          const on = state.choice === id ? "is-on" : "";
          return `<button class="choice ${on}" data-pick="${id}" style="--hand:${item.color};--glow:${item.glow}" ${state.phase === "countdown" ? "disabled" : ""}>
            <span class="key">${item.key}</span>
            <span class="lbl">${item.label}</span>
          </button>`;
        }).join("")}
      </section>
      <section class="actions">
        <button class="reveal" data-act="reveal" ${canReveal ? "" : "disabled"}>${revealLabel}</button>
        <button class="next" data-act="next" ${state.phase === "reveal" ? "" : "disabled"}>下一局</button>
      </section>
      <section class="share">
        <img id="qr" width="120" height="120" alt="舞台網址 QR" />
        <div>
          <p>投影電腦請打開舞台網址。大螢幕在揭曉前看不到你選的拳。</p>
          <code>${stageUrl(room, state.route.pin)}</code>
          <button class="ghost linkish" data-act="copy">複製舞台網址</button>
        </div>
      </section>
    </main>
  `;
}

function stageView() {
  let board = `
    <div>
      <div class="idle-mark">猜拳</div>
      <div class="idle-sub">點一下進入全螢幕</div>
    </div>
  `;
  if (state.phase === "selected") {
    board = `
      <div>
        <div class="ready-ring"><b>準備好了</b></div>
        <div class="ready-sub">READY</div>
      </div>
    `;
  }
  if (state.phase === "countdown") {
    board = `<div class="count">${state.count}</div>`;
  }
  if (state.phase === "reveal" && state.choice) {
    board = `${handMarkup(state.choice, { giant: true })}<div class="flash"></div>`;
  }
  return `
    <main class="page stage">
      <button class="stage-mute" data-act="mute">${state.mute ? "音效關" : "音效開"}</button>
      <div class="stage-dot ${nowConnected() ? "is-on" : ""}"></div>
      ${linkNote() ? `<p class="stage-note">${linkNote()}</p>` : ""}
      <section class="stage-board">${board}</section>
    </main>
  `;
}

async function afterRender() {
  const img = document.getElementById("qr");
  const room = state.route.room;
  if (!img || !room) return;
  const tag = roomTag(room, state.route.pin);
  if (qrFor !== tag || !qrUrl) {
    qrFor = tag;
    qrUrl = await QRCode.toDataURL(stageUrl(room, state.route.pin), {
      width: 240,
      margin: 1,
      color: { dark: "#07070c", light: "#ffffff" },
    });
  }
  img.src = qrUrl;
}

function scrollHelp() {
  if (state.route.role !== "help") return;
  const target = state.route.room === "staff" ? document.getElementById("staff") : null;
  (target || app.querySelector(".help"))?.scrollIntoView({ block: "start" });
}

function wire() {
  app.onclick = async (event) => {
    const btn = event.target.closest("button");
    if (!btn) {
      if (state.route.role === "stage") {
        unlockAudio();
        document.documentElement.requestFullscreen?.().catch(() => {});
      }
      return;
    }
    const act = btn.dataset.act;
    const pickId = btn.dataset.pick;
    if (pickId) pick(pickId);
    if (act === "help") go("#/help");
    if (act === "staff") go("#/help/staff");
    if (act === "create") go(`#/c/${roomTag(makeRoom(), makePin())}`);
    if (act === "join-control" || act === "join-stage") {
      const { room } = parseTag(document.getElementById("room-input")?.value || "");
      const pin = (document.getElementById("pin-input")?.value || "").replace(/[^0-9]/g, "");
      if (!room) return;
      go(`#/${act === "join-control" ? "c" : "s"}/${roomTag(room, pin)}`);
    }
    if (act === "reveal") reveal();
    if (act === "next") nextRound();
    if (act === "copy") {
      const room = state.route.room;
      if (!room) return;
      try {
        // clipboard API 在非 HTTPS（現場備援的 http://192.168.x.x）會直接丟錯，
        // 不接住的話按鈕會整個沒反應。
        await navigator.clipboard.writeText(stageUrl(room, state.route.pin));
        btn.textContent = "已複製";
      } catch {
        btn.textContent = "請手動複製下方網址";
      }
    }
    if (act === "mute") {
      state.mute = !state.mute;
      render();
    }
  };
}

function render() {
  const { role, room } = state.route;
  if (role === "home") app.innerHTML = homeView();
  else if (role === "help") app.innerHTML = helpView();
  else if (role === "control") app.innerHTML = controlView(room);
  else app.innerHTML = stageView();
  afterRender();
  scrollHelp();
}

function connectRoute() {
  sync?.destroy();
  sync = null;
  clearCount();
  clearInterval(helloTimer);
  state.choice = null;
  state.pendingChoice = null;
  state.phase = "idle";
  state.count = COUNT_FROM;
  qrUrl = "";
  qrFor = "";
  if (state.route.role === "home" || state.route.role === "help") {
    render();
    return;
  }
  state.link = { relay: "connecting", ntfy: "connecting", limited: false, stage: 0, control: 0 };
  sync = createSync({
    room: state.route.room,
    pin: state.route.pin,
    role: state.route.role === "stage" ? "stage" : "control",
    onMessage: applyRemote,
    onStatus: (next) => {
      state.link = next;
      render();
    },
  });
  if (state.route.role === "stage") {
    sync.send({ type: "hello" });
    // 這個心跳只是 ntfy 備援用的存在證明；relay 那條線有 presence，不靠它。
    // 間隔必須比 ntfy 的補額速度（5 秒 1 則）慢，否則會被限流。
    helloTimer = setInterval(() => {
      if (state.route.role !== "stage") return;
      sync?.send({ type: "hello" });
    }, HELLO_MS);
  }
  keepAwake();
  render();
}

// 狀態燈必須會自己變暗：不能等到下一則訊息進來才發現對面早就掉線了。
function watchLink() {
  clearInterval(linkTimer);
  linkTimer = setInterval(() => {
    const { role } = state.route;
    if (role !== "control" && role !== "stage") return;
    const now = `${nowConnected()}|${linkNote()}`;
    if (now === lastLinkKey) return;
    lastLinkKey = now;
    render();
  }, 2000);
}

window.addEventListener("hashchange", () => {
  state.route = parseRoute();
  connectRoute();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepAwake();
});

wire();
bindKeys();
watchLink();
connectRoute();

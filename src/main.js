import "./style.css";
import QRCode from "qrcode";
import { HANDS, HAND_ORDER, handByKey, handMarkup } from "./hands.js";
import { createSync, HELLO_MS, STALE_MS } from "./sync.js";
import { viewerKeys, viewerUrl, createViewerFeed, createViewerLink } from "./viewer.js";
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
  viewerLink: "connecting",
  viewers: null,
  viewerAddress: null,
  showViewerQr: false,
  viewerQr: "",
};

let sync;
let viewerFeed;
let viewerLink;
let countTimer;
let helloTimer;
let wakeLock;
let linkTimer;
let lastLinkKey = "";
const qrCache = new Map();

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
  // 觀眾網址只有一串位址，沒有房號也沒有 PIN。把 w 改成 c 或 s 只會解出一個不存在的房間。
  if (parts[0] === "w" && /^[0-9a-f]{32}$/i.test(parts[1] || "")) {
    return { role: "viewer", room: "", pin: "", address: parts[1].toLowerCase() };
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

// 投影機和觀眾手機都是「顯示端」：只收訊號、照著畫。
function isDisplay() {
  return state.route.role === "stage" || state.route.role === "viewer";
}

// 連線狀況只用右上角的小燈表示，舞台上不放任何文字——那是給全場看的畫面。
// 滑鼠移到燈上才會出現白話說明；控場手機上才有完整的一句話。
//   綠：一切正常　黃：改走備用線路，還能用　紅：斷線　灰：連線中／等對方連上
function dotState() {
  const { role } = state.route;
  if (role === "viewer") {
    if (state.viewerLink === "open") return { tone: "green", label: "連線正常" };
    if (state.viewerLink === "down") return { tone: "red", label: "連不上，正在重試…" };
    return { tone: "gray", label: "連線中…" };
  }
  const { relay, ntfy, limited } = state.link;
  // 主線斷了的時候，備用線路要嘛也斷了、要嘛（控場這邊）送出去被擋——兩種都等於指令到不了。
  if (relay === "down" && (ntfy === "down" || (role === "control" && limited))) {
    return { tone: "red", label: role === "control" ? "斷線了：舞台收不到指令" : "斷線了：收不到控場的訊號" };
  }
  if (relay === "down") return { tone: "yellow", label: "改走備用線路：還能用，可能慢一點" };
  if (!nowConnected()) {
    if (relay === "connecting" && ntfy !== "open") return { tone: "gray", label: "連線中…" };
    return { tone: "gray", label: role === "control" ? "等投影電腦連上" : "等控場連上" };
  }
  return { tone: "green", label: "一切正常" };
}

// 控場手機上的白話說明。燈是綠的就不囉嗦。
function controlNote() {
  const { tone, label } = dotState();
  if (tone === "red" && state.link.ntfy !== "down") {
    return "網路太擠，指令暫時送不出去。先不要連按，等 10 秒再試一次。";
  }
  if (tone === "red") return "網路斷了，舞台收不到你的指令。請換個網路（例如手機熱點），或改用單機備用。";
  if (tone === "yellow") return "主要線路斷了，已經自動改走備用線路。可以繼續用，只是反應可能慢一點。";
  if (label === "等投影電腦連上") return "投影電腦還沒連上。請用投影電腦掃下面「投影電腦用」的 QR。";
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
    // 藝人一選拳，觀眾 QR 就自動收起來，免得擋住「準備好了」和翻牌。
    if (message.phase !== "idle") state.showViewerQr = false;
    // 投影機自己倒數到 0 就先翻牌了，控場的 reveal 晚一點才到。
    // 同一張牌已經翻過就不要再翻一次，否則揭曉音效會響兩次。
    if (message.phase === "reveal" && state.phase === "reveal" && state.choice === message.choice) {
      render();
      return;
    }
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
  const payload = { type: "state", phase, choice, round: state.round, ...extra };
  viewerFeed?.send(payload);
  return sync?.send(payload);
}

function startLocalCountdown(choice, isOrigin) {
  clearCount();
  state.phase = "countdown";
  state.count = COUNT_FROM;
  if (isDisplay()) state.pendingChoice = choice;
  else state.choice = choice;
  render();
  if (!state.mute) tickSound(state.count);
  vibrate(40);
  let left = COUNT_FROM - 1;
  countTimer = setInterval(() => {
    if (left <= 0) {
      clearCount();
      // 觀眾收到的倒數訊息不帶手勢（見 viewer.js）：停在最後一格，等控場的 reveal 到了再翻。
      if (!choice) return;
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
    if (isDisplay() && event.key.toLowerCase() === "f") {
      document.documentElement.requestFullscreen?.();
    }
    if (state.route.role === "stage" && event.key.toLowerCase() === "q") {
      event.preventDefault();
      toggleViewerQr();
    }
  };
}

// 投影機上按 Q：全螢幕秀出觀眾 QR，讓台下掃了用手機看。再按一次收起來；
// 藝人一選拳也會自動收起。第一次按才開始算位址（要跑 PBKDF2，大約零點幾秒）。
async function toggleViewerQr() {
  state.showViewerQr = !state.showViewerQr;
  render();
  if (!state.showViewerQr || state.viewerQr) return;
  const { room, pin } = state.route;
  const keys = await viewerKeys(room, pin);
  if (state.route.room !== room || state.route.pin !== pin) return;
  state.viewerQr = keys ? await qrData(viewerUrl(keys.address), 480) : "unsupported";
  render();
}

async function qrData(url, width = 240) {
  const key = `${width}|${url}`;
  if (!qrCache.has(key)) {
    qrCache.set(
      key,
      QRCode.toDataURL(url, { width, margin: 1, color: { dark: "#07070c", light: "#ffffff" } })
    );
  }
  return qrCache.get(key);
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

const CHIP_TEXT = { green: "舞台有回應", yellow: "用備用線路", red: "斷線了" };

function controlView(room) {
  const note = controlNote();
  const dot = dotState();
  const chipText = CHIP_TEXT[dot.tone] || (dot.label === "連線中…" ? "連線中…" : "等待舞台");
  const address = state.viewerAddress;
  const watchers =
    typeof state.viewers === "number" ? `現在 <b>${state.viewers}</b> 人在看。` : "";
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
        <div class="status-chip tone-${dot.tone}"><i></i>${chipText}</div>
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
      <section class="share share-stage">
        <img id="qr" width="120" height="120" alt="投影電腦用 QR" />
        <div>
          <p class="share-title">投影電腦用 · 不要給觀眾</p>
          <p>用投影電腦掃這個。這個網址等於遙控器，拿到的人可以操控大螢幕。</p>
          <code>${stageUrl(room, state.route.pin)}</code>
          <button class="ghost linkish" data-act="copy">複製投影電腦網址</button>
        </div>
      </section>
      <section class="share share-viewer">
        <img id="qr-viewer" width="120" height="120" alt="觀眾用 QR" />
        <div>
          <p class="share-title">觀眾用手機看 · 可以公開</p>
          <p>只能看、不能操作。投影電腦上按 <b>Q</b> 也能把這個 QR 秀在大螢幕上。${watchers}</p>
          ${
            address === "unsupported"
              ? `<code>這個網址開不了觀眾畫面（需要 https）</code>`
              : address
                ? `<code>${viewerUrl(address)}</code><button class="ghost linkish" data-act="copy-viewer">複製觀眾網址</button>`
                : `<code>產生中…</code>`
          }
        </div>
      </section>
    </main>
  `;
}

function viewerQrOverlay() {
  const body =
    state.viewerQr === "unsupported"
      ? `<p class="viewer-qr-note">這個網址開不了觀眾畫面（需要 https）</p>`
      : state.viewerQr
        ? `<img src="${state.viewerQr}" alt="觀眾 QR" />`
        : `<p class="viewer-qr-note">產生中…</p>`;
  return `<div class="viewer-qr">${body}<p class="viewer-qr-title">手機掃這裡，一起看猜拳</p></div>`;
}

function stageView() {
  const viewer = state.route.role === "viewer";
  // 投影機的待機畫面只有「猜拳」兩個字，不放操作提示：這是給全場看的畫面，
  // 而且手機瀏覽器沒有網頁全螢幕，提示字會一直掛著。點一下／F／Q 怎麼用寫在說明頁。
  const hint = viewer ? "等待開始" : "";
  let board = `
    <div>
      <div class="idle-mark">猜拳</div>
      ${hint ? `<div class="idle-sub">${hint}</div>` : ""}
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
  const dot = dotState();
  return `
    <main class="page stage${viewer ? " is-viewer" : ""}">
      ${viewer ? "" : `<button class="stage-mute" data-act="mute">${state.mute ? "音效關" : "音效開"}</button>`}
      <div class="stage-dot tone-${dot.tone}" data-label="${dot.label}" title="${dot.label}"></div>
      <section class="stage-board">${board}</section>
      ${!viewer && state.showViewerQr ? viewerQrOverlay() : ""}
    </main>
  `;
}

async function paintQr(id, url) {
  if (!document.getElementById(id) || !url) return;
  const data = await qrData(url);
  const img = document.getElementById(id);
  if (img) img.src = data;
}

async function afterRender() {
  if (state.route.role !== "control" || !state.route.room) return;
  await paintQr("qr", stageUrl(state.route.room, state.route.pin));
  const address = state.viewerAddress;
  if (address && address !== "unsupported") await paintQr("qr-viewer", viewerUrl(address));
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
      if (isDisplay()) {
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
    if (act === "copy-viewer" && state.viewerAddress) {
      try {
        await navigator.clipboard.writeText(viewerUrl(state.viewerAddress));
        btn.textContent = "已複製";
      } catch {
        btn.textContent = "請手動複製上方網址";
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
  viewerFeed?.destroy();
  viewerFeed = null;
  viewerLink?.destroy();
  viewerLink = null;
  clearCount();
  clearInterval(helloTimer);
  state.choice = null;
  state.pendingChoice = null;
  state.phase = "idle";
  state.count = COUNT_FROM;
  state.showViewerQr = false;
  state.viewerQr = "";
  state.viewers = null;
  state.viewerAddress = null;
  // 觀眾手機預設靜音：場內幾十支手機一起響只會吵。
  state.mute = state.route.role === "viewer";
  if (state.route.role === "home" || state.route.role === "help") {
    render();
    return;
  }
  // 觀眾只連 relay 上的觀眾房間；控場和投影機那條線，觀眾手上根本沒有鑰匙。
  if (state.route.role === "viewer") {
    state.viewerLink = "connecting";
    viewerLink = createViewerLink({
      address: state.route.address,
      onMessage: applyRemote,
      onStatus: (next) => {
        state.viewerLink = next;
        render();
      },
    });
    keepAwake();
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
  if (state.route.role === "control") {
    const { room, pin } = state.route;
    viewerFeed = createViewerFeed({
      room,
      pin,
      onCount: (count) => {
        state.viewers = count;
        render();
      },
    });
    viewerKeys(room, pin).then((keys) => {
      if (state.route.role !== "control" || state.route.room !== room || state.route.pin !== pin) return;
      state.viewerAddress = keys ? keys.address : "unsupported";
      render();
    });
  }
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
    if (role !== "control" && !isDisplay()) return;
    const dot = dotState();
    const now = `${dot.tone}|${dot.label}`;
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

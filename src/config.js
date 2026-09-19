// 部署 worker/ 之後（cd worker && npx wrangler deploy），wrangler 會印出你的
// Worker 網址。把它填在這裡，並且把開頭的 https:// 換成 wss://，例如：
//
//   const DEFAULT_RELAY = "wss://vtjanken-relay.你的子網域.workers.dev";
//
// 留空字串＝不使用 relay，全部走 ntfy 備援線（功能完整，只是延遲高一點、
// 而且沒有即時的「舞台在不在線上」偵測）。這裡刻意不預填猜測的網址：
// 填錯的話畫面會一直掛著「relay 斷線」的警告。
const DEFAULT_RELAY = "wss://vtjanken-relay.vtuber-live-janken.workers.dev";

// 測試用：網址加 ?relay=ws://127.0.0.1:8787 指到本機，?relay=off 則完全停用。
function override() {
  try {
    const q = new URLSearchParams(location.search).get("relay");
    if (q === "off") return "";
    if (q) return q.replace(/\/+$/, "");
  } catch {
    /* ignore */
  }
  return null;
}

export const RELAY_URL = override() ?? DEFAULT_RELAY;

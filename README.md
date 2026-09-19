# 現場猜拳

線上測試：[https://oggysecond.github.io/vtuber-live-janken/](https://oggysecond.github.io/vtuber-live-janken/)

給 VTuber 舞台用的密選猜拳網站。藝人用手機按 1／2／3 先出拳，觀眾在投影幕上看不到；按下揭曉後倒數 3 秒，大螢幕才翻出超大手勢。

## 現場怎麼用

1. 電腦執行 `npm install` 然後 `npm run start`（或 `npm run dev`）
2. 手機打開控場網址，按 **建立房間**
3. 投影電腦掃 QR 或打開舞台網址，點一下進全螢幕
4. 藝人按 `1` 石頭、`2` 剪刀、`3` 布（只有控場看得到）
5. 觀眾出拳後，控場按 **揭曉：倒數 3 秒**

同一 Wi-Fi 時，手機請打開電腦終端機顯示的 Network 網址，不要用 `localhost`。

鍵盤：`1` `2` `3` 出拳，`Enter` 揭曉，揭曉後再按一次進入下一局。

## 指令

```bash
npm install
npm run dev      # 開發，預設 http://localhost:5173
npm run start    # 建置後在 http://localhost:4173 給現場用
```

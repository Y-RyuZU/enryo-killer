# 遠慮の塊 解消マシン (SPAJAM MVP)

大皿の「最後の1個の唐揚げ」を、スマホの縄をこっそり引っ張って自分の方へ寄せる引っ張り合いゲーム。

```
server/   Hono on Cloudflare Workers + Durable Object (1部屋=1 RoomDO, SQLite backend, WS Hibernation)
  src/shared.ts  型定義 (web からも import)
  src/logic.ts   純関数 step() = 張力/皿の移動/勝敗判定, deviceCmd() = モード別アダプタ
  src/room.ts    RoomDO (席, 0.5s alarm tick, WS broadcast, device poll, estop)
web/      React + Vite (スマホ画面 / PC シミュレーター+ホスト)。Tauri Mobile は後で web/ を包むだけ
scripts/  fake-players.mjs (E2E), screenshots.mjs (headless Chromium)
```

## 動かし方 (ローカル)

Node 22+ が必要 (wrangler 4 の要件)。

```bash
pnpm install
pnpm dev:server   # wrangler dev → http://127.0.0.1:8787  (Cloudflare ログイン不要)
pnpm dev:web      # vite → http://localhost:5173  (/api は 8787 にプロキシ)
```

- PC: `http://<PCのIP>:5173/sim` → 「部屋をつくる」→ 4文字コードが出る
- スマホ: `http://<PCのIP>:5173/?room=XXXX` → 名前と席 (東西南北) をタップ → 縄画面
- PCで「開始」。縄を下にドラッグした量 = 引く力。一番引いてる人の席へ皿がじわじわ動き、決着距離に入ったら勝ち

テスト:

```bash
pnpm test:e2e                       # 偽プレイヤー4人で引っ張り、皿移動/ESP32 API/estop/決着を検証
PLAYWRIGHT_BROWSERS_PATH=.playwright npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=.playwright pnpm screenshots   # screenshots/*.png
```

デプロイ (要 Cloudflare アカウント/API トークン): `pnpm --filter web build && cd server && CLOUDFLARE_API_TOKEN=... npx wrangler deploy`
(web/dist も同じ Worker から静的配信される)

## ゲームロジック (0.5秒ごと)

```
tension[席] = tension*decay + power*(1-decay)      // power = 縄のドラッグ量 0..1 (1.5s 来なければ 0)
leader = 最大 tension の席 (2位との差 < tieMargin なら拮抗 = 動かない)
speed  = clamp((1位-2位) * gain, 0, 1)
皿は leader の席へ speed * maxSpeed (卓半径/秒) で移動 → 席から winRadius 以内で決着
```
係数は PC シミュレーター画面のスライダーでリアルタイム調整可。

## 出力モード (部屋ごとに切替 `mode: 'A' | 'B' | 'C'`)

| mode | 出力 | 動き |
|---|---|---|
| A | ESP32 タイヤロボ | HTTP ポーリングで方向+速度を取得 |
| B | 磁石 XY 装置 | HTTP ポーリングで目標座標を取得 |
| C | バーチャル皿 | シミュレーター画面だけ (WebSocket) |

シミュレーターはどのモードでも観戦用に常に動く。サーバーは共通の皿状態を計算し、モード別アダプタ (`deviceCmd()`) で各デバイス用の値に変換。

## ESP32 / デバイス API (矢野さん向け)

```
GET /api/rooms/{ROOM}/device?type=A     # タイヤロボ
GET /api/rooms/{ROOM}/device?type=B     # 磁石XY
POST /api/rooms/{ROOM}/estop            # 緊急停止 (誰でも叩ける)
```
- **500ms ごと**にポーリング (HTTP keep-alive 推奨)。本番は `https://<worker>.workers.dev`、ローカルは `http://<PCのIP>:8787`
- ポーリングが来ている間、PC 画面に「デバイス オンライン」と出る

レスポンス (共通):

```jsonc
{
  "type": "A",          // 要求した type
  "seq": 123,           // 単調増加。古い seq は捨てる
  "ttlMs": 600,         // 受信からこの時間を過ぎたら自力で停止
  "active": true,       // false なら即停止 (対戦中でない / estop / モード違い / 拮抗)
  "estop": false,       // true なら停止し、解除されるまで動かない
  "phase": "playing",   // lobby | playing | finished
  "leaderSeat": "E",    // N | E | S | W | null

  // type=A (タイヤ)
  "dirDeg": 90,         // 進みたい絶対方位 0=北 90=東 180=南 270=西 (時計回り)
  "speed": 0.73,        // 0..1
  "turn": 0.0,          // -1..1 正=右旋回 (サーバーがオープンループで推定した向きとの差)
  "fwd": 0.73,          // 0..1 前進量 (向きが30°以上ズレてる間は 0 = その場旋回)

  // type=B (XY)
  "x_mm": 60, "y_mm": 0,            // 今いてほしい座標 (卓中心原点, +x=東, +y=南, 卓半径200mm)
  "goal_x_mm": 160, "goal_y_mm": 0, // 最終目標 (リーダーの席方向)
  "feed_mm_s": 19                   // 移動速度
}
```

差動2輪の例: `L = fwd - turn`, `R = fwd + turn` → PWM。

**フェイルセーフ (ファーム側で必ず実装)**
1. 最後の成功ポーリングから `ttlMs` (600ms) 経過 → モーター停止
2. 通信エラー / Wi-Fi 切断中 → 停止
3. `active:false` または `estop:true` → 即停止
4. `seq` が前回以下 → 破棄
5. ファーム側でも PWM 上限をハードコード (サーバーが 1.0 を送っても全開にしない)

向きは IMU なし前提のオープンループ推定。ズレたら手で北向きに置き直して「リセット」。

## メモ

- 無料枠: DO は `new_sqlite_classes` マイグレーション必須 (設定済み)。WS は Hibernation API。ESP32 の 500ms ポーリングは1台1時間 7,200 リクエスト (無料枠 10万/日) なので開発中つなぎっぱなしにしない
- Tauri Mobile: `web/` をそのまま包む。API の向き先は `VITE_API_BASE=https://xxx.workers.dev` でビルド

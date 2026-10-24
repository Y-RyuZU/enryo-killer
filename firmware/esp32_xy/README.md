# Plan B: 磁石 XY ガントリー (ESP32 + ステッピング 2 軸)

テーブルの下で磁石を XY に動かし、上の皿 (底に磁石/鉄板) を引っ張る方式。
サーバーは Plan A と同じ皿の座標 (x, y) を計算しているので、それを **そのまま目標座標として** `device/ws` に流すだけ。
ハードが間に合わなくても、人が磁石を手で動かす **人間磁石画面** (`/magnet`) で同じゲームが遊べる。

設計案 (Claude Code): [DESIGN.md](DESIGN.md)

## 1. モード切替 (サーバー)

部屋ごとの `deviceMode` = 既存の出力モードの別名:

| deviceMode | mode | device/ws に流れるもの |
|---|---|---|
| `wheels` | A | `{"payload":"forward"}` など (Plan A タイヤロボ) |
| `xy` | B | `{"t":"xy", "x":..., "y":...}` (この README) |
| `none` | C | `{"payload":"stop"}` のみ (バーチャル皿) |

切替方法 (どれでも同じ):
- PC 画面 `/sim?room=XXXX` の「出力モード」→ **B 磁石XY**
- `PUT /api/rooms/XXXX/device/mode` `{"deviceMode":"xy"}` (Swagger: `/api/docs`)

```bash
H=https://ek.ryuzu.dev; R=ABCD
curl -X PUT $H/api/rooms/$R/device/mode -H 'content-type: application/json' -d '{"deviceMode":"xy"}'
curl $H/api/rooms/$R/device/mode
# 手動ジョグ (xy モード時のみ): 5 秒間 東寄り (0.5, 0) へ → その後は皿の位置に戻る
curl -X POST $H/api/rooms/$R/device/xy -H 'content-type: application/json' -d '{"x":0.5,"y":0,"durationMs":5000}'
npx wscat -c wss://ek.ryuzu.dev/api/rooms/$R/device/ws   # 何か打つ (ping) と最新 xy が返る
```

## 2. プロトコル (`wss://<host>/api/rooms/<code>/device/ws`)

```jsonc
{ "t": "xy", "seq": 12, "active": true, "estop": false, "ttlMs": 1500,
  "x": 0.31, "y": -0.05,      // 目標 -1..1 (卓中心原点、1.0 = 席の位置、+x=東 +y=南)。単位円にクランプ済み
  "x_mm": 62, "y_mm": -10,    // 参考 (サーバーの TABLE_RADIUS_MM=200 換算。ファーム側は PLAY_RADIUS_MM を使う)
  "manual": true }            // POST /device/xy のジョグ中のみ
```
- 対戦中は 0.5 秒ごと。モード切替 / 開始・停止・リセット / estop 時にも送信
- **デバイスが何かテキストを送ると (例 `ping`) その場で最新 xy を返す** → ロビー中も `PING_MS` ごとに ping して TTL 切れを防ぐ
- 目標は「皿の現在位置」。ロビー/決着後も active (= その位置で保持)。リセットで (0,0) に戻る
- `active:false` (xy 以外のモード) → その場で減速停止、`estop:true` → 即停止 + ドライバ無効
- タイヤ用 `{"payload":...}` も同じソケットに流れ続けるので XY 機は `"t":"xy"` 以外は無視。タイヤ機 (Plan A) は xy を無視する

## 3. ファームウェア (`esp32_xy.ino`)

```bash
cp config.example.h config.h   # WiFi / 部屋コード / ピン / steps/mm を埋める (config.h は git 管理外)
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/esp32_xy
arduino-cli upload  --fqbn esp32:esp32:esp32 -p /dev/ttyUSB0 firmware/esp32_xy
arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=115200
```
ライブラリは Plan A と同じ "WebSockets" (Markus Sattler) だけ。ステッピング制御は自前 (AccelStepper 不要)。

- **ドライバ**: `DRIVER_TYPE` = `DRIVER_STEPDIR` (A4988 / DRV8825 / TMC2208: STEP+DIR+共通EN) or `DRIVER_ULN2003` (28BYJ-48 をハーフステップ)
- **座標**: `x * PLAY_RADIUS_MM` mm → `* STEPS_PER_MM_X` steps。電源投入位置 (またはホーミング後) = 卓中央 = 0。`±TRAVEL_X_MM/2` でクランプ
- **動き**: 台形加速 (`MAX_SPEED_MM_S`, `ACCEL_MM_S2`)、2 軸の速度を按分して直線移動。loop() はブロックしない。WebSocket は core0 の別タスク
- **ホーミング (任意)**: `USE_HOMING 1` で起動時に -X/-Y 端のリミットスイッチ (INPUT_PULLUP、押すと LOW) へ → バックオフ → 原点
- **フェイルセーフ**: `FAILSAFE_MS` (1.5s) xy が来ない / WS 切断 / `active:false` → 減速停止して保持。`estop:true` → 即停止 + EN=HIGH (A4988 無効)
- 28BYJ の発熱が気になるなら `DISABLE_WHEN_IDLE 1` (停止中コイル OFF)
- シリアル 115200 に 1 秒ごと `[xy] tgt=(x,y)mm pos=(x,y)mm act= estop= fresh=` を出す

### 目安 (要調整)
| 構成 | STEPS_PER_MM | MAX_SPEED_MM_S |
|---|---|---|
| NEMA17 + A4988 1/16 + GT2 20T | 80 | 60〜150 |
| 28BYJ-48 + ULN2003 (ハーフ) + GT2 20T | 102.4 | 10〜15 |

ゲームの皿速度は既定 `maxSpeed 0.08` (卓半径/秒) = PLAY_RADIUS 150mm なら 12mm/s 程度なので 28BYJ でも追従できる。

### キャリブレーション手順
1. `PUT device/mode xy` → `POST device/xy` で `(0,0)`, `(1,0)`, `(0,1)`, `(-1,0)`, `(0,-1)` を順に送る
2. 中央→東端の実距離が `PLAY_RADIUS_MM` になるよう `STEPS_PER_MM_*` を調整、向きが逆なら `X_INVERT`/`Y_INVERT`
3. 天板越しに皿が付いてくる最大速度を探して `MAX_SPEED_MM_S` を決める (天板の厚み・磁石の強さ次第)

## 4. 人間磁石画面 (フォールバック)

`https://ek.ryuzu.dev/magnet?room=XXXX` (PC 画面の「人間磁石画面」リンクからも開ける)

- テーブルの下の人がスマホを見上げて、赤い ● (= 皿の目標位置) の真下に磁石を持っていく。対戦中は黄色の矢印 + 「東へ」等の大きな文字で進む方向を表示
- 下から見上げると東西が逆になるので **左右反転 (既定 ON)** と **回転** ボタンあり (設定は端末に保存)
- 動き出し/方向転換でバイブ、緊急停止で画面が赤く、Wake Lock で画面スリープ防止
- どのモードでも動く (サーバーの皿位置を見ているだけ)。A/C モードのままでも使える

## 5. テスト

```bash
node scripts/device-xy.mjs --base http://127.0.0.1:8787   # モード切替 / xy 配信 / ping 応答 / ジョグ / estop
node scripts/device-ws.mjs --base http://127.0.0.1:8787   # Plan A の回帰
```

## 設計からの変更点
- `deviceMode` は独立フィールドにせず **既存の `mode` の別名** にした (A=wheels / B=xy / C=none)。PC 画面のモードボタンがそのまま切替スイッチになり、永続化データも増えない
- REST は `PUT|GET /device/mode` と `POST /device/xy`。人間磁石画面のパスは `/magnet`
- ロビー中の TTL 切れ対策として「デバイスの ping に最新 xy を返す」を追加 (DO を起こしっぱなしにしない)
- ステッピングは AccelStepper ではなく自前 (ULN2003/STEP-DIR 両対応・依存ライブラリなし)

# ESP32 疎通 handoff（8noさん向け）

ESP32 は **自分からサーバーに WebSocket で繋ぎに行く** 側。ローカル WiFi で ESP にアクセスする必要はなく、
ネットに出られる WiFi（自宅 / スマホのテザリング）さえあれば OK。

## 0. 前提（RyuZU 側）
- `ek.ryuzu.dev` の Cloudflare Access を外す or `/api/*` に Bypass(Everyone)。**これがないと ESP は弾かれる**
- RyuZU が https://ek.ryuzu.dev/sim で部屋を作り、4文字の **部屋コード** を共有（以下 `ABCD`）

## 1. まず PC で経路確認（ハード不要・1分）
```
npx wscat -c wss://ek.ryuzu.dev/api/rooms/ABCD/device/ws
```
繋がるとすぐ `{"payload":"stop"}` が届く。届けば経路は OK。
（`302` / ログイン画面系のエラーなら Access がまだ有効）

## 2. ファーム書き込み（Arduino IDE）
1. repo: https://github.com/Y-RyuZU/enryo-killer （`firmware/esp32_device/`）
2. ボードマネージャ: **esp32 by Espressif** / ライブラリマネージャ: **WebSockets (Markus Sattler)**
3. `config.example.h` を `config.h` にコピーして埋める
   - `WIFI_SSID` / `WIFI_PASS`（**2.4GHz** のみ。5GHz は ESP32 非対応）
   - `ROOM_CODE` = 部屋コード
   - モーターのピン（`L_IN1/L_IN2/L_EN`, `R_IN1/R_IN2/R_EN`, `STBY`）。未配線ならデフォルトのままで可
4. ボード「ESP32 Dev Module」（実機に合わせて）→ 書き込み → シリアルモニタ **115200**

arduino-cli 派なら:
```
arduino-cli core install esp32:esp32
arduino-cli lib install WebSockets
arduino-cli compile -b esp32:esp32:esp32 firmware/esp32_device
arduino-cli upload  -b esp32:esp32:esp32 -p <COMポート> firmware/esp32_device
```

## 3. 動作確認
1. シリアルに `[ws] connected` が出る
2. Swagger https://ek.ryuzu.dev/api/docs → `POST /api/rooms/{code}/device/cmd` → Try it out
   ```json
   {"payload":"forward","durationMs":1000}
   ```
   レスポンスの `devices` が 1 以上なら ESP が繋がっている
3. シリアルに `[cmd] forward` → モーターが1秒回って止まれば成功
4. `backward` / `turn_right` / `turn_left` / `stop` も同様に

## 仕様メモ
- サーバー → ESP: `{"payload":"forward|backward|turn_right|turn_left|stop"}`（任意で `"speed":0..1`）。ESP からの送信は IMU ビルドのみ（`hello` / `imu` / `calib`）
- 通信が `FAILSAFE_MS`(1秒) 途切れたら自動 stop、切断時は2秒ごとに自動再接続
- 速度は `SPEED` / `TURN_SPEED`（0-255）、向きが逆なら該当モーターの `IN1`/`IN2` を入れ替え
- `{"payload":"forward","speed":0.6}` のように `speed`（0..1）が付くと `SPEED`/`TURN_SPEED` × speed で回す（下限 `MIN_DUTY`/`TURN_MIN_DUTY`）。付かなければ従来どおり
- 古い `config.h` のままでもビルドできる（新しい項目は既定値）。IMU を使うときだけ `config.example.h` の IMU 節をコピー

## 4. 速度指定のテスト
Swagger の `POST /device/cmd` に `speed` を足すだけ:
```json
{"payload":"forward","durationMs":1000,"speed":0.5}
```
シリアルに `[cmd] forward @0.50`。遅すぎて回らないなら `config.h` の `MIN_DUTY` / `TURN_MIN_DUTY` を上げる。
試合中も速度を変えたいなら /sim の config で `speedOut: 1`（皿の勢いに応じて forward の speed が変わる。下限 `minSpeedOut`=0.35）。

## 5. 旋回キャリブレーション（IMU 無しでも必須・**皿を載せた状態で**）
サーバーは「1秒に何度回るか」(`turnRateDegPerSec`, 既定 90) で向きを推定しているので、実機の値を入れる。
1. ロボを床に置き、向きが分かるように床にテープで印（分度器を下に敷くと楽）
2. Swagger `POST /api/rooms/{code}/device/calibrate`
   ```json
   {"dir":"right","durationMs":2000}
   ```
   → 2秒その場で右旋回して止まる（lobby 中のみ。プレイ中 / estop 中は 409）
3. **IMU なし**: 回った角度を測って `POST /api/rooms/{code}/device/calibrate/result`
   ```json
   {"measuredDeg":183}
   ```
   → `turnRateDegPerSec` = 183 / 2 = 91.5 に更新（state の `params.turnRateDegPerSec` で確認）
4. **IMU あり**: 何もしなくて OK。ESP32 が自分で測って自動更新（シリアルに `[calib] 214.6 deg in 2000ms -> 107.3 deg/s`）
5. 2〜3 回やってバラつきが小さいか見る。左旋回 (`"dir":"left"`) もほぼ同じならOK
- 直接入れるなら `{"turnRateDegPerSec":110}` を result に POST

## 6. IMU（任意・MPU6050 などで向きのズレを解消）
IMU 無しだとサーバーは「旋回コマンドを出した時間」から向きを推測するだけなので、滑ったりぶつかったりするとズレる。
IMU を載せると実測の向きをサーバーへ送り、サーバーの推定を上書きする。

### 配線（MPU6050 / GY-521）
| MPU6050 | ESP32 |
|---|---|
| VCC | 3V3 |
| GND | GND |
| SDA | GPIO21 (`IMU_SDA`) |
| SCL | GPIO22 (`IMU_SCL`) |
| AD0 | GND（→ アドレス 0x68。HIGH なら `IMU_ADDR 0x69`） |

- 基板は**水平に**、ロボの回転中心付近に固定（両面テープ OK）。振動でグラグラしないように
- MPU6500 / MPU9250 もそのまま動く（追加ライブラリ不要）

### 設定
`config.h` に（`config.example.h` の IMU 節をコピー）:
```c
#define USE_IMU 1
```
`USE_IMU 0`（既定）なら従来と完全に同じ動作・同じ通信。

### 起動〜確認
1. 電源 ON 直後 **2 秒は触らない**（ジャイロのバイアス計測）。シリアル:
   `[imu] ok WHO_AM_I=0x68` → `[imu] bias=-1.23 dps spread=0.8 dps`
   （`動いてる?` と出たら置き直して再起動。`not found` なら配線 / アドレス）
2. `[ws] connected` の後、サーバーへ `{"t":"hello",...,"imu":1}` と `{"t":"imu","yaw":...}` を送る
3. **向きの符号チェック（重要）**: https://ek.ryuzu.dev/api/rooms/ABCD/state の `deviceImu.headingDeg` を見ながら
   ロボを**上から見て時計回り（右）**に手で 90° 回す → `headingDeg` が **約 +90 増えれば OK**。
   減るなら `config.h` の `IMU_YAW_SIGN` を `1` にして書き込み直し（逆だと勝ってる人から逃げていく）
4. 向きの基準: **/sim でリセットした時に皿（ロボの前）が N 席を向いている**とみなす。
   試合前は「ロボを N 向きに置く → リセット」。ズレたら stop → N 向きに置き直す → リセット
5. state の `headingSource` がプレイ中 `imu` なら IMU で補正中。報告が 1.5 秒途絶えると自動で `dr`（従来の推定）に戻る
6. 旋回キャリブは上の 5. を IMU ありでやる（自動で値が入る）

### IMU の注意
- ジャイロは長時間でじわじわズレる（モーターの熱など）。ラウンドごとに N 向きに置いてリセットすれば OK
- ESP32 が再起動したらサーバーが自動で基準を取り直す（その時の向き = N または現在の推定方位）
- キャリブ旋回中に estop / stop が来たら即中断する

## 困ったとき
| 症状 | 見るところ |
|---|---|
| WiFi に繋がらない | SSID/パス、2.4GHz か |
| `[ws] disconnected` を繰り返す | Access が外れているか、部屋コード |
| `[cmd]` は出るがモーターが回らない | ピン配置、ドライバ電源、TB6612 なら `STBY` |
| 書き込めない | USBドライバ(CP210x/CH340)、BOOT ボタン押しながら書き込み |
| `[imu] not found` | SDA/SCL 逆、3V3 給電、`IMU_ADDR`（AD0） |
| IMU ありで勝ってる人から逃げる | `IMU_YAW_SIGN` の符号が逆（6-3 参照） |
| 旋回しすぎて左右に首振り | 旋回キャリブ未実施。`turnRateDegPerSec` を実測値に |

ボード / ドライバ型番 / ピン配置を教えてくれれば `config.h` の値はこちらで用意します。

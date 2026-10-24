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
- サーバー → ESP: `{"payload":"forward|backward|turn_right|turn_left|stop"}`（ESP からの送信は不要・無視される）
- 通信が `FAILSAFE_MS`(1秒) 途切れたら自動 stop、切断時は2秒ごとに自動再接続
- 速度は `SPEED` / `TURN_SPEED`（0-255）、向きが逆なら該当モーターの `IN1`/`IN2` を入れ替え

## 困ったとき
| 症状 | 見るところ |
|---|---|
| WiFi に繋がらない | SSID/パス、2.4GHz か |
| `[ws] disconnected` を繰り返す | Access が外れているか、部屋コード |
| `[cmd]` は出るがモーターが回らない | ピン配置、ドライバ電源、TB6612 なら `STBY` |
| 書き込めない | USBドライバ(CP210x/CH340)、BOOT ボタン押しながら書き込み |

ボード / ドライバ型番 / ピン配置を教えてくれれば `config.h` の値はこちらで用意します。

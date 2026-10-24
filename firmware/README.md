# ESP32 device firmware

`wss://ek.ryuzu.dev/api/rooms/{code}/device/ws` に自分から接続し、サーバーから push される
`{"payload":"forward|backward|turn_right|turn_left|stop"}` で2輪差動のモーターを動かす。

## 書き込み (Arduino IDE)
1. ボードマネージャで **esp32 by Espressif** を入れる、ライブラリマネージャで **WebSockets (Markus Sattler)** を入れる
2. `esp32_device/config.example.h` を `config.h` にコピーして WiFi / 部屋コード / ピン を埋める
3. ボード「ESP32 Dev Module」等を選んで書き込み → シリアルモニタ 115200

## 確認
- シリアルに `[ws] connected` → https://ek.ryuzu.dev/api/docs の `POST /api/rooms/{code}/device/cmd` で `forward` → `[cmd] forward` が出てモーターが回ればOK
- 通信が 1 秒途切れると自動で stop (FAILSAFE_MS)
- ピン・速度は `config.h` だけ直せばよい。モーターがない状態でもシリアルで受信確認できる

疎通手順の全体は [HANDOFF.md](HANDOFF.md)

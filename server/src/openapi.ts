// 手書きの OpenAPI 定義 + Swagger UI (/api/docs)。WebSocket は OpenAPI で表現できないので description に記載
const room = { name: "code", in: "path", required: true, schema: { type: "string", example: "ABCD" }, description: "部屋コード (PC の /sim で作成)" };
const payloadEnum = ["forward", "backward", "turn_right", "turn_left", "stop"];

export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "遠慮の塊 解消マシン API",
    version: "0.4.0",
    description: [
      "## ESP32 (タイヤロボ) WebSocket",
      "`wss://<host>/api/rooms/{code}/device/ws` に接続すると、サーバーから次の JSON が push されます:",
      "```json",
      '{ "payload": "forward" }                 // forward | backward | turn_right | turn_left | stop',
      '{ "payload": "forward", "speed": 0.6 }   // speed (任意, 0..1) = ファームの SPEED/TURN_SPEED に対する倍率。省略 = 1',
      "```",
      "- `payload` は常に先頭キー。`speed` が付くのは `POST /device/cmd` で speed 指定したとき、または params.speedOut=1 のときだけ (既定は従来どおり `{payload}` のみ)",
      "- 接続直後に現在のコマンド (通常 `stop`) を 1 回送信",
      "- 対戦中 (mode=A) は 0.5 秒ごとに送信。勝っている席の方向へ向くまで turn_*、向いたら forward",
      "- 停止/リセット/緊急停止/決着時は `stop`",
      "- **安全のため、ESP32 側で約 1.5 秒メッセージが来なければ停止、切断時も停止してください**",
      "- 疎通テストは下の `POST /device/cmd` (Try it out) で任意のコマンドを流せます",
      "- `payload` の無いフレーム `{\"cmd\":\"calib\",\"id\":4,\"dir\":\"right\",\"ms\":2000,\"speed\":1}` は IMU ビルド向けの旋回キャリブ指示 (旧ファームは無視)",
      "",
      "## ESP32 → サーバー (任意: firmware の USE_IMU=1 ビルドのみ)",
      "IMU (MPU6050 等) 付きなら実測方位を送ると、サーバーの方位推定 (dead reckoning) を上書き補正します。送らなければ従来どおり。",
      "```json",
      '{ "t": "hello", "fw": "1.1.0", "imu": 1, "boot": 2914837461 }   // 接続時。boot が変わったら方位基準を取り直す',
      '{ "t": "imu", "yaw": 187.3, "gz": -12.4, "ms": 48213 }          // 5-7Hz。yaw=起動時基準の相対方位 (時計回り+)',
      '{ "t": "calib", "id": 4, "dir": "right", "ms": 2000, "deg": 214.6, "dps": 107.3, "ok": 1 }',
      "```",
      "- 方位基準: リセット時に皿は N 向きに置かれているとみなし、次の imu 報告で offset を決める (config WS の `zeroImu: true` でも取り直し)",
      "- `imuMaxAgeMs` (既定 1500ms) 報告が途絶えたら dead reckoning に戻る",
      "- JSON でないメッセージ (ping 等) は無視",
      "",
      "## params (config WS `{t:'config', params:{...}}` で変更)",
      "`maxSpeed, gain, decay, tieMargin, winRadius` に加え: `turnRateDegPerSec` (既定 90, キャリブで更新), `imuMaxAgeMs` (1500), `imuBlend` (0..1, 既定 1), `speedOut` (0/1, 既定 0), `minSpeedOut` (既定 0.35)",
      "",
      "## スマホ / PC 用 WebSocket",
      "`/api/rooms/{code}/ws?role=player&playerId=...` / `?role=viewer`。メッセージ型は server/src/shared.ts の C2S / S2C を参照",
    ].join("\n"),
  },
  paths: {
    "/api/health": { get: { summary: "ヘルスチェック", responses: { 200: { description: "ok" } } } },
    "/api/rooms": {
      post: {
        summary: "部屋を作成 (4 文字コードを返す)",
        responses: { 200: { description: "作成", content: { "application/json": { schema: { type: "object", properties: { code: { type: "string" } } } } } } },
      },
    },
    "/api/rooms/{code}/state": {
      get: { summary: "部屋の状態スナップショット", parameters: [room], responses: { 200: { description: "Snapshot (shared.ts)" } } },
    },
    "/api/rooms/{code}/device/cmd": {
      post: {
        summary: "ESP32 へ手動コマンドを送る (疎通テスト用)",
        description: "接続中の device/ws 全部に payload を durationMs の間 250ms ごとに再送し、その後 stop を送る。手動中は自動制御を抑制。",
        parameters: [room],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["payload"],
                properties: {
                  payload: { type: "string", enum: payloadEnum, example: "forward" },
                  durationMs: { type: "integer", minimum: 100, maximum: 5000, default: 1000 },
                  speed: { type: "number", minimum: 0, maximum: 1, example: 0.6, description: "任意。ファームの SPEED/TURN_SPEED に対する倍率。省略時は従来どおり (=1)" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "送信した。devices = 接続中の ESP32 数", content: { "application/json": { example: { ok: true, payload: "forward", durationMs: 1000, speed: 0.6, devices: 1 } } } },
          400: { description: "payload / speed 不正" },
          409: { description: "緊急停止中" },
        },
      },
    },
    "/api/rooms/{code}/device/calibrate": {
      post: {
        summary: "旋回キャリブレーション開始 (その場で durationMs 回す)",
        description: [
          "lobby 中のみ (プレイ中 / estop 中 / device 未接続は 409)。**皿は載せた状態で** 計測推奨。",
          "- `via=imu` (IMU ビルド): ESP32 が自分で回って実測 deg/s を返し、`params.turnRateDegPerSec` を自動更新",
          "- `via=manual` (IMU なし): サーバーが turn_* を durationMs 流して止める → 回った角度を測って `POST /device/calibrate/result`",
          "- `via` 省略時は IMU 報告があれば imu、無ければ manual。結果は state の `calib` / `params.turnRateDegPerSec`",
        ].join("\n"),
        parameters: [room],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  dir: { type: "string", enum: ["right", "left"], default: "right" },
                  durationMs: { type: "integer", minimum: 300, maximum: 5000, default: 2000 },
                  speed: { type: "number", minimum: 0.2, maximum: 1, default: 1, description: "試合中の旋回と同じ 1 推奨" },
                  via: { type: "string", enum: ["auto", "imu", "manual"], default: "auto" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "開始", content: { "application/json": { example: { ok: true, calibId: 1, via: "manual", dir: "right", durationMs: 2000, speed: 1 } } } },
          409: { description: "estop / プレイ中 / device 未接続 / IMU 無しで via=imu" },
        },
      },
    },
    "/api/rooms/{code}/device/calibrate/result": {
      post: {
        summary: "旋回キャリブ結果 (実測角度 or 旋回速度を直接) を登録",
        description: "`measuredDeg` = 直前の calibrate で回った角度 (度)。turnRateDegPerSec = |deg| / (durationMs/1000)。`turnRateDegPerSec` を直接指定しても OK",
        parameters: [room],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  measuredDeg: { type: "number", example: 183 },
                  durationMs: { type: "integer", description: "省略時は直前の calibrate の durationMs" },
                  turnRateDegPerSec: { type: "number", example: 91.5 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "更新", content: { "application/json": { example: { ok: true, turnRateDegPerSec: 91.5 } } } },
          400: { description: "measuredDeg / turnRateDegPerSec が無い" },
        },
      },
    },
    "/api/rooms/{code}/device/ws": {
      get: {
        summary: "ESP32 用 WebSocket (Upgrade: websocket)",
        description: '接続すると `{"payload":"forward"}` 形式のコマンドが push される。Swagger からは試せないので wscat 等で: `npx wscat -c wss://<host>/api/rooms/ABCD/device/ws`',
        parameters: [room],
        responses: { 101: { description: "Switching Protocols" }, 426: { description: "WebSocket 以外" } },
      },
    },
    "/api/rooms/{code}/device": {
      get: {
        summary: "(旧) HTTP ポーリング版デバイス API",
        parameters: [room, { name: "type", in: "query", schema: { type: "string", enum: ["A", "B"], default: "A" } }],
        responses: { 200: { description: "DeviceCmd (shared.ts)" } },
      },
    },
    "/api/rooms/{code}/estop": {
      post: { summary: "緊急停止 (全デバイスに stop)", parameters: [room], responses: { 200: { description: "ok" } } },
    },
  },
};

// ===== ゲームルール + params REST (追記) =====
openapi.info.description += "\n\n" + [
  "## ゲームルール (params。/host の「ゲームルール」カード / `PUT /api/rooms/{code}/params` / config WS で変更)",
  "- **ひも切れ** `snapEnabled` (0/1, 既定 1): 引く力 >= `snapPower` (既定 0.9) を `snapHoldMs` (既定 800ms) 続けると切れる。`snapLeadMargin` > 0 なら「他の席の最大より margin 以上強い」(1 人だけ突出) ときだけ。切れたら `snapRecoverMs` (既定 3000ms) の間その席の力は 0、張力も即 0",
  "- **旋回ロック** `turnLockEnabled` (0/1, 既定 1): mode A の対戦中、ESP32 へ turn_right/turn_left を出し始めたら `turnLockMs` の間 全員の引っ張りを無視し張力を凍結 (旋回をやり切る)。`turnLockMs`=0 (既定) は自動 = 必要な旋回角 ÷ `turnRateDegPerSec` (300..5000ms)",
  "- **引っ張りクールタイム** `pullCooldownEnabled` (0/1, 既定 1): 1 回引いて離して (power <= 0.05) から `pullCooldownMs` (既定 300ms) の間、次の引っ張りは 0 扱い",
  "- 状態は snapshot の `mech`: `seats[席] = {snapped, snapRemainMs, cooldownRemainMs, overMs}`, `turnLock = {remainMs, durationMs, dir} | null`, `events` (viewer のみ: snap / restore / turnlock_start / turnlock_end)",
].join("\n");
const paramProps = {
  maxSpeed: { type: "number", default: 0.08 }, gain: { type: "number", default: 2 }, decay: { type: "number", default: 0.8 },
  tieMargin: { type: "number", default: 0.05 }, winRadius: { type: "number", default: 0.35 },
  turnRateDegPerSec: { type: "number", default: 90 }, imuMaxAgeMs: { type: "number", default: 1500 }, imuBlend: { type: "number", default: 1 },
  speedOut: { type: "number", enum: [0, 1], default: 0 }, minSpeedOut: { type: "number", default: 0.35 },
  snapEnabled: { type: "number", enum: [0, 1], default: 1, description: "ひも切れ ON/OFF (true/false も可)" },
  snapPower: { type: "number", minimum: 0.05, maximum: 1, default: 0.9, description: "この強さ以上で引き続けると切れる" },
  snapHoldMs: { type: "number", minimum: 0, maximum: 10000, default: 800, description: "snapPower 以上をこの時間続けたら切れる (0=即)" },
  snapLeadMargin: { type: "number", minimum: 0, maximum: 1, default: 0, description: ">0 なら他の席の最大よりこれ以上強いときだけ切れる" },
  snapRecoverMs: { type: "number", minimum: 0, maximum: 60000, default: 3000, description: "切れてから復活まで" },
  turnLockEnabled: { type: "number", enum: [0, 1], default: 1, description: "旋回ロック ON/OFF" },
  turnLockMs: { type: "number", minimum: 0, maximum: 10000, default: 0, description: "旋回ロックの長さ。0=自動 (旋回角 ÷ turnRateDegPerSec)" },
  pullCooldownEnabled: { type: "number", enum: [0, 1], default: 1, description: "引っ張りクールタイム ON/OFF" },
  pullCooldownMs: { type: "number", minimum: 0, maximum: 10000, default: 300, description: "離してから次の引っ張りが効くまで" },
};
const paramsRes = { description: "現在の params / 既定値 / 許容範囲", content: { "application/json": { example: { ok: true, params: { snapEnabled: 1, snapPower: 0.9, snapHoldMs: 800, snapLeadMargin: 0, snapRecoverMs: 3000, turnLockEnabled: 1, turnLockMs: 0, pullCooldownEnabled: 1, pullCooldownMs: 300 }, defaults: {}, ranges: {} } } } };
Object.assign(openapi.paths, {
  "/api/rooms/{code}/params": {
    get: { summary: "params (係数 + ゲームルール) を取得", parameters: [room], responses: { 200: paramsRes } },
    put: {
      summary: "params を部分更新 (ゲームルールの調整など)",
      description: "送ったキーだけ更新 (範囲外は clamp)。`{\"params\": {...}}` でも直接 `{...}` でも OK。`{\"reset\": true}` で既定値に戻す (turnRateDegPerSec は保持)。未知キー / 数値でない値は 400。永続化され、全画面に即反映",
      parameters: [room],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: paramProps }, example: { snapPower: 0.85, snapRecoverMs: 4000, turnLockMs: 1500, pullCooldownMs: 250 } } } },
      responses: { 200: paramsRes, 400: { description: "未知キー / 数値でない" } },
    },
  },
});

// ===== Plan B: 磁石 XY (追記) =====
openapi.info.description += "\n\n" + [
  "## 磁石 XY (Plan B) — deviceMode = xy",
  "`PUT /api/rooms/{code}/device/mode` で `xy` にすると (= mode B)、同じ `device/ws` に次の JSON が push されます:",
  "```json",
  '{ "t": "xy", "seq": 12, "active": true, "estop": false, "ttlMs": 1500, "x": 0.31, "y": -0.05, "x_mm": 62, "y_mm": -10 }',
  "```",
  "- `x,y` = 皿の目標座標 (-1..1、卓中心原点、卓半径=1、+x=東 +y=南)。対戦中は 0.5 秒ごと",
  "- デバイスが何かメッセージ (ping 等) を送ると、その都度最新の xy を返す → ロビー中も 500ms ごとに ping すれば TTL 切れしない",
  "- `active:false` = その場で停止、`estop:true` = 停止してドライバ無効化。`ttlMs` 何も来なければ停止",
  "- `{\"payload\":...}` (タイヤ用) も従来通り流れるので XY 機は `\"t\":\"xy\"` 以外を無視すること。タイヤ機は xy を無視する",
  "- 手動テスト: `POST /device/xy` で任意座標へジョグ。人間磁石画面: `/magnet?room={code}`",
].join("\n");
const deviceModeEnum = ["wheels", "xy", "none"];
const modeRes = { description: "現在のモード", content: { "application/json": { example: { ok: true, deviceMode: "xy", mode: "B", devices: 1, xy: { t: "xy", seq: 3, active: true, estop: false, ttlMs: 1500, x: 0, y: 0, x_mm: 0, y_mm: 0 } } } } };
Object.assign(openapi.paths, {
  "/api/rooms/{code}/device/mode": {
    get: { summary: "デバイスモード取得 (wheels=A タイヤ / xy=B 磁石XY / none=C バーチャル)", parameters: [room], responses: { 200: modeRes } },
    put: {
      summary: "デバイスモード切替 (PC 画面の出力モードと同じ)",
      parameters: [room],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["deviceMode"], properties: { deviceMode: { type: "string", enum: deviceModeEnum, example: "xy" } } } } } },
      responses: { 200: modeRes, 400: { description: "deviceMode 不正" } },
    },
  },
  "/api/rooms/{code}/device/xy": {
    post: {
      summary: "XY 機を手動で任意座標へ (疎通/キャリブレーション用)",
      description: "deviceMode=xy の時のみ。durationMs の間この座標を 250ms ごとに送り、その後は皿の位置に戻る。(0,0)=中央、(1,0)=東端、(0,-1)=北端",
      parameters: [room],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["x", "y"], properties: {
        x: { type: "number", minimum: -1, maximum: 1, example: 0.5 },
        y: { type: "number", minimum: -1, maximum: 1, example: 0 },
        durationMs: { type: "integer", minimum: 500, maximum: 30000, default: 5000 },
      } } } } },
      responses: { 200: { description: "送信した" }, 400: { description: "座標不正" }, 409: { description: "xy モードでない / 緊急停止中" } },
    },
  },
});

export const swaggerHtml = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>遠慮の塊 API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: "/api/openapi.json", dom_id: "#ui" });</script>
</body></html>`;

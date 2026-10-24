// 手書きの OpenAPI 定義 + Swagger UI (/api/docs)。WebSocket は OpenAPI で表現できないので description に記載
const room = { name: "code", in: "path", required: true, schema: { type: "string", example: "ABCD" }, description: "部屋コード (PC の /sim で作成)" };
const payloadEnum = ["forward", "backward", "turn_right", "turn_left", "stop"];

export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "遠慮の塊 解消マシン API",
    version: "0.2.0",
    description: [
      "## ESP32 (タイヤロボ) WebSocket",
      "`wss://<host>/api/rooms/{code}/device/ws` に接続すると、サーバーから次の JSON が push されます:",
      "```json",
      '{ "payload": "forward" }   // forward | backward | turn_right | turn_left | stop',
      "```",
      "- 接続直後に現在のコマンド (通常 `stop`) を 1 回送信",
      "- 対戦中 (mode=A) は 0.5 秒ごとに送信。勝っている席の方向へ向くまで turn_*、向いたら forward",
      "- 停止/リセット/緊急停止/決着時は `stop`",
      "- **安全のため、ESP32 側で約 1.5 秒メッセージが来なければ停止、切断時も停止してください**",
      "- 疎通テストは下の `POST /device/cmd` (Try it out) で任意のコマンドを流せます",
      "- デバイスから送ったメッセージは無視されます (keep-alive の ping に使って OK)",
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
                },
              },
            },
          },
        },
        responses: {
          200: { description: "送信した。devices = 接続中の ESP32 数", content: { "application/json": { example: { ok: true, payload: "forward", durationMs: 1000, devices: 1 } } } },
          400: { description: "payload 不正" },
          409: { description: "緊急停止中" },
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

export const swaggerHtml = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>遠慮の塊 API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: "/api/openapi.json", dom_id: "#ui" });</script>
</body></html>`;

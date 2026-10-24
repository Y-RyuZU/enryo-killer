import { Hono } from "hono";
import { cors } from "hono/cors";
import { RoomDO, Env } from "./room";
export { RoomDO };
import { openapi, swaggerHtml } from "./openapi";

const app = new Hono<{ Bindings: Env }>();
app.use("/api/*", cors());

const norm = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
const stub = (env: Env, code: string) => env.ROOM.get(env.ROOM.idFromName(code));

app.get("/api/health", (c) => c.json({ ok: true }));

// 部屋作成: ランダム4文字コードを返すだけ (DO は idFromName で自動生成)
app.post("/api/rooms", (c) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return c.json({ code });
});

// ESP32 WebSocket / 手動コマンド / 旋回キャリブ
app.all("/api/rooms/:code/device/:action{ws|cmd|calibrate|calibrate/result}", async (c) => {
  const code = norm(c.req.param("code"));
  if (!code) return c.text("bad code", 400);
  const url = new URL(c.req.url);
  url.searchParams.set("code", code);
  return stub(c.env, code).fetch(new Request(url.toString(), c.req.raw));
});

// Plan B: デバイスモード切替 (wheels|xy|none) / XY 手動ジョグ
app.all("/api/rooms/:code/device/:action{mode|xy}", async (c) => {
  const code = norm(c.req.param("code"));
  if (!code) return c.text("bad code", 400);
  const url = new URL(c.req.url);
  url.searchParams.set("code", code);
  return stub(c.env, code).fetch(new Request(url.toString(), c.req.raw));
});

app.get("/api/openapi.json", (c) => c.json(openapi));
app.get("/api/docs", (c) => c.html(swaggerHtml));

// WS / device poll / estop / state は全部 RoomDO へ転送
app.all("/api/rooms/:code/:action{ws|device|estop|state}", async (c) => {
  const code = norm(c.req.param("code"));
  if (!code) return c.text("bad code", 400);
  const url = new URL(c.req.url);
  url.searchParams.set("code", code);
  return stub(c.env, code).fetch(new Request(url.toString(), c.req.raw));
});

export default app;

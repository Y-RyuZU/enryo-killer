// ローカル dev サーバーの UI を headless Chromium でスクショ (偽プレイヤー付き)
// usage: PLAYWRIGHT_BROWSERS_PATH=.playwright node scripts/screenshots.mjs [--web http://127.0.0.1:5173] [--api http://127.0.0.1:8787]
import { chromium } from "playwright";
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const WEB = opt("--web", "http://127.0.0.1:5173");
const API = opt("--api", "http://127.0.0.1:8787");
const OUT = new URL("../screenshots/", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const code = (await (await fetch(`${API}/api/rooms`, { method: "POST" })).json()).code;
console.log("room", code);
const conn = (role, id) => new Promise((res) => {
  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/api/rooms/${code}/ws?role=${role}${id ? `&playerId=${id}` : ""}`);
  const c = { ws, last: null, send: (m) => ws.send(JSON.stringify(m)) };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "state") c.last = m.snapshot; };
  ws.onopen = () => res(c);
});
const viewer = await conn("viewer");
viewer.send({ t: "config", mode: "C", params: { maxSpeed: 0.12 } });
const fakes = [
  { id: "f-n", name: "あつき", seat: "N", power: 0.45 },
  { id: "f-w", name: "矢野", seat: "W", power: 0.3 },
];
for (const f of fakes) { f.c = await conn("player", f.id); f.c.send({ t: "join", playerId: f.id, name: f.name, seat: f.seat }); }
const pulling = setInterval(() => fakes.forEach((f) => f.c.send({ t: "pull", power: f.power + (Math.random() - 0.5) * 0.08 })), 150);

const browser = await chromium.launch();
const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: false, locale: "ja-JP" });
await mobileCtx.addInitScript(() => localStorage.setItem("enryo.name", "kohey"));
const mobile = await mobileCtx.newPage();
await mobile.goto(`${WEB}/?room=${code}`);
await mobile.waitForSelector(".seat-btn.taken");
await sleep(400);
await mobile.screenshot({ path: `${OUT}01-mobile-join-seat.png` });
console.log("01 done");

// 南に着席 → ゲーム開始 → 縄を引っ張る
await mobile.click(".seat-S");
await mobile.waitForSelector(".rope-svg");
viewer.send({ t: "host", cmd: "start" });
await sleep(1500);
const box = await mobile.locator(".rope-svg").boundingBox();
const sx = box.x + box.width / 2, sy = box.y + box.height * 0.5;
await mobile.mouse.move(sx, sy);
await mobile.mouse.down();
for (let i = 1; i <= 10; i++) { await mobile.mouse.move(sx, sy + i * 20); await sleep(30); }
await sleep(3500); // 張力が溜まって「勝ってる」になるのを待つ
await mobile.screenshot({ path: `${OUT}02-mobile-rope-pulling.png` });
console.log("02 done", viewer.last.leaderSeat, JSON.stringify(viewer.last.plate));

// PC シミュレーター (モバイルは引き続けたまま)
const pc = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "ja-JP" });
await pc.goto(`${WEB}/sim?room=${code}`);
await pc.waitForSelector(".table-svg");
// 4人目を足して賑やかに
const f3 = { id: "f-e", name: "アム", seat: "E", power: 0.5 };
f3.c = await conn("player", f3.id); f3.c.send({ t: "join", playerId: f3.id, name: f3.name, seat: f3.seat }); fakes.push(f3);
await sleep(6000);
await pc.screenshot({ path: `${OUT}03-pc-simulator-host.png` });
console.log("03 done", JSON.stringify(viewer.last.plate));

// 負けてる表示: 離して他の人が引く
await mobile.mouse.up();
fakes[0].power = 0.9;
await sleep(3000);
await mobile.screenshot({ path: `${OUT}04-mobile-rope-losing.png` });
console.log("04 done", viewer.last.leaderSeat);

// 決着: 南(自分)が本気で引く
fakes.forEach((f) => (f.power = 0.1));
viewer.send({ t: "config", params: { maxSpeed: 0.4 } });
await mobile.mouse.move(sx, sy); await mobile.mouse.down();
for (let i = 1; i <= 14; i++) { await mobile.mouse.move(sx, sy + i * 25); await sleep(20); }
for (let i = 0; i < 60 && viewer.last.phase !== "finished"; i++) await sleep(250);
await mobile.mouse.up();
await sleep(800);
await mobile.screenshot({ path: `${OUT}05-mobile-result.png` });
await pc.screenshot({ path: `${OUT}06-pc-result.png` });
console.log("05/06 done", viewer.last.phase, viewer.last.winnerSeat);

clearInterval(pulling);
await browser.close();
fakes.forEach((f) => f.c.ws.close()); viewer.ws.close();
process.exit(0);

// E2E: 偽プレイヤー(WebSocket)で引っ張り、皿が動くこと & ESP32 ポーリングAPIを検証
// usage: node scripts/fake-players.mjs [--base http://127.0.0.1:8787] [--room CODE] [--keep]
//   --keep : 検証後もプレイヤーが引き続けて終了しない (スクショ用)
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt("--base", "http://127.0.0.1:8787");
const KEEP = args.includes("--keep");
const WS_BASE = BASE.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (cond, label, extra = "") => { console.log(`${cond ? "✅" : "❌"} ${label} ${extra}`); if (!cond) fails++; };

const code = opt("--room", null) ?? (await (await fetch(`${BASE}/api/rooms`, { method: "POST" })).json()).code;
console.log("room:", code);

function connect(role, playerId) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws?role=${role}${playerId ? `&playerId=${playerId}` : ""}`);
    const c = { ws, last: null, errors: [] };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "state") c.last = m.snapshot; else c.errors.push(m.message); };
    ws.onopen = () => res(c);
    ws.onerror = rej;
  });
}
const send = (c, m) => c.ws.send(JSON.stringify(m));
const poll = async (type) => (await fetch(`${BASE}/api/rooms/${code}/device?type=${type}`)).json();

const viewer = await connect("viewer");
const players = [
  { id: "fake-n", name: "あつき", seat: "N", power: 0.35 },
  { id: "fake-e", name: "kohey", seat: "E", power: 0.95 },
  { id: "fake-s", name: "アム", seat: "S", power: 0.2 },
  { id: "fake-w", name: "矢野", seat: "W", power: 0.5 },
];
for (const p of players) {
  p.c = await connect("player", p.id);
  send(p.c, { t: "join", playerId: p.id, name: p.name, seat: p.seat });
}
await sleep(400);
check(Object.keys(viewer.last.seats).length === 4, "4人が着席", JSON.stringify(Object.keys(viewer.last.seats)));

// 席の取り合い: 埋まってる席には座れない
const intruder = await connect("player", "fake-x");
send(intruder, { t: "join", playerId: "fake-x", name: "乱入", seat: "E" });
await sleep(300);
check(intruder.errors.length > 0 && viewer.last.seats.E.playerId === "fake-e", "埋まってる席はブロック", intruder.errors[0] ?? "");
intruder.ws.close();

send(viewer, { t: "config", mode: "A", params: { maxSpeed: 0.12 } });
send(viewer, { t: "host", cmd: "reset" });
send(viewer, { t: "host", cmd: "start" });
const pullTimer = setInterval(() => {
  for (const p of players) send(p.c, { t: "pull", power: Math.max(0, Math.min(1, p.power + (Math.random() - 0.5) * 0.1)) });
}, 150);

await sleep(4000);
let s = viewer.last;
console.log("plate:", JSON.stringify(s.plate), "leader:", s.leaderSeat, "tensions:", Object.values(s.seats).map((p) => `${p.seat}=${p.tension}`).join(" "));
check(s.phase === "playing", "phase=playing");
check(s.leaderSeat === "E", "一番引いてる E がリーダー");
check(s.plate.x > 0.05 && Math.abs(s.plate.y) < 0.05, "皿が E(+x) 方向へ移動", `x=${s.plate.x.toFixed(3)}`);
const kohey = players[1].c.last, atsuki = players[0].c.last;
check(kohey.me?.status === "winning" && atsuki.me?.status === "losing", "プレイヤー状態 勝ってる/負けてる");
check(kohey.seats.N.tension === undefined, "プレイヤーには他人の張力を見せない");

const a = await poll("A");
console.log("poll A:", JSON.stringify(a));
check(a.active && a.ttlMs > 0 && Math.abs(a.dirDeg - 90) < 15, "ESP32(A) active, dirDeg≈90(E)");
check(a.fwd > 0 && a.fwd <= 1 && Math.abs(a.turn) <= 1, "ESP32(A) fwd/turn 範囲OK", `fwd=${a.fwd} turn=${a.turn}`);
const bWrong = await poll("B");
check(!bWrong.active, "mode=A のとき XY(B) は停止指示");

send(viewer, { t: "config", mode: "B" });
await sleep(700);
const b = await poll("B");
console.log("poll B:", JSON.stringify(b));
check(b.active && b.x_mm > 0 && b.goal_x_mm > 0 && b.feed_mm_s > 0, "XY(B) 目標座標が +x 側");
check(!(await poll("A")).active, "mode=B のときタイヤ(A) は停止指示");
await sleep(600);
check(viewer.last.deviceOnline === true, "deviceOnline=true (ポーリング検知)");

// 逆転: W が本気出す
players[3].power = 1.0; players[1].power = 0.3;
const x0 = viewer.last.plate.x;
await sleep(4000);
check(viewer.last.leaderSeat === "W" && viewer.last.plate.x < x0, "逆転: W がリーダー & 皿が -x へ", `x ${x0.toFixed(3)} -> ${viewer.last.plate.x.toFixed(3)}`);

// 緊急停止
const e = await (await fetch(`${BASE}/api/rooms/${code}/estop`, { method: "POST" })).json();
await sleep(300);
const pe = await poll("B");
check(e.ok && pe.estop && !pe.active && pe.feed_mm_s === 0, "POST /estop → デバイス停止");
const xe = viewer.last.plate.x;
await sleep(1200);
check(viewer.last.plate.x === xe, "estop 中は皿が動かない");
send(viewer, { t: "host", cmd: "release_estop" });

// 決着まで: E 一人勝ち
players.forEach((p) => (p.power = 0.05)); players[1].power = 1;
send(viewer, { t: "config", mode: "C", params: { maxSpeed: 0.5 } });
send(viewer, { t: "host", cmd: "start" });
for (let i = 0; i < 40 && viewer.last.phase !== "finished"; i++) await sleep(250);
check(viewer.last.phase === "finished" && viewer.last.winnerSeat === "E", "決着: E の勝ち", `phase=${viewer.last.phase}`);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
if (!KEEP) {
  clearInterval(pullTimer);
  for (const p of players) p.c.ws.close();
  viewer.ws.close();
  process.exit(fails ? 1 : 0);
} else {
  // スクショ用: リセットして引き続ける
  send(viewer, { t: "config", mode: "C", params: { maxSpeed: 0.08 } });
  send(viewer, { t: "host", cmd: "reset" });
  players[0].power = 0.4; players[1].power = 0.85; players[2].power = 0.15; players[3].power = 0.55;
  send(viewer, { t: "host", cmd: "start" });
  console.log("KEEP: pulling forever in room", code);
}

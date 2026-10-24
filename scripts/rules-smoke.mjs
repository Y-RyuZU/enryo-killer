// ゲームルール (ひも切れ / 旋回ロック / クールタイム) の結合テスト
// usage: node scripts/rules-smoke.mjs [--base http://127.0.0.1:8787]   (Node 22+: グローバル WebSocket)
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt("--base", "http://127.0.0.1:8787");
const WS = BASE.replace(/^http/, "ws");
const ROOM = `RS${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, l, x = "") => { console.log(`${c ? "✅" : "❌"} ${l} ${x}`); if (!c) fails++; };
const api = (path, body, method = "PUT") => fetch(`${BASE}/api/rooms/${ROOM}/${path}`, body ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const open = (q) => new Promise((res) => { const ws = new WebSocket(`${WS}/api/rooms/${ROOM}/${q}`); ws.onopen = () => res(ws); });
console.log("room:", ROOM);

const viewer = await open("ws?role=viewer");
let snap = null;
viewer.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "state") snap = m.snapshot; };
const players = {};
const power = { N: 0, E: 0, S: 0, W: 0 };
for (const s of ["N", "E", "S", "W"]) {
  players[s] = await open(`ws?role=player&playerId=p${s}`);
  players[s].send(JSON.stringify({ t: "join", playerId: `p${s}`, name: s, seat: s }));
}
const iv = setInterval(() => { for (const s in players) players[s].send(JSON.stringify({ t: "pull", power: power[s] })); }, 125);
const host = (cmd) => viewer.send(JSON.stringify({ t: "host", cmd }));

// --- 1. ひも切れ (mode C で旋回ロックの影響を排除)
viewer.send(JSON.stringify({ t: "config", mode: "C" }));
await api("params", { snapHoldMs: 400, snapRecoverMs: 1500, pullCooldownMs: 300, maxSpeed: 0.001 });
host("start");
await sleep(300);
power.N = 1;
await sleep(900);
check(snap.mech.seats.N.snapped, "N snapped after pulling at 100%", JSON.stringify(snap.mech.seats.N));
check(snap.mech.events.some((e) => e.kind === "snap" && e.seat === "N"), "snap event logged");
await sleep(600);
check((snap.seats.N.tension ?? 1) < 0.05, "snapped seat tension is ~0", snap.seats.N.tension);
power.N = 0;
await sleep(1500);
check(!snap.mech.seats.N.snapped, "N restored after snapRecoverMs");
check(snap.mech.events.some((e) => e.kind === "restore" && e.seat === "N"), "restore event logged");
power.E = 0.6;
await sleep(800);
check(!snap.mech.seats.E.snapped && snap.seats.E.tension > 0.1, "60% pull does not snap", snap.seats.E.tension);

// --- 2. クールタイム: 離した直後
power.E = 0;
await sleep(130);
const st = await api("state", null, "GET");
check(st.mech.seats.E.cooldownRemainMs > 0, "cooldown after release", st.mech.seats.E.cooldownRemainMs);

// --- 3. 旋回ロック (mode A, 偽 ESP32)
host("stop");
await api("params", { turnLockMs: 1500, snapEnabled: 0, maxSpeed: 0.001 });
const dev = await open("device/ws");
const got = [];
dev.onmessage = (e) => got.push(JSON.parse(e.data).payload);
await sleep(200);
viewer.send(JSON.stringify({ t: "config", mode: "A" }));
host("reset");
await sleep(200);
host("start");
power.E = 0.8; // 東 (90°) へ → 向きは N なので turn_right
await sleep(1500);
check(got.includes("turn_right"), "device got turn_right", got.slice(-5).join(","));
check(!!snap.mech.turnLock, "turn lock active", JSON.stringify(snap.mech.turnLock));
check(snap.mech.events.some((e) => e.kind === "turnlock_start"), "turnlock_start event");
const tE = snap.seats.E.tension;
power.E = 0; power.W = 1; // ロック中の引っ張りは無視される
await sleep(700);
if (snap.mech.turnLock) check(Math.abs(snap.seats.E.tension - tE) < 0.02 && (snap.seats.W.tension ?? 0) < 0.02, "pulls ignored during lock (tensions frozen)", `${tE} -> ${snap.seats.E.tension}, W=${snap.seats.W.tension}`);
await sleep(1500);
check(snap.mech.events.some((e) => e.kind === "turnlock_end"), "turnlock_end event");

// --- 4. 無効化
await api("params", { turnLockEnabled: 0, snapEnabled: 0, pullCooldownEnabled: 0 });
const p = await api("params", null, "GET");
check(p.params.turnLockEnabled === 0 && p.params.pullCooldownEnabled === 0, "toggles persisted via API");
host("stop");
clearInterval(iv);
for (const s in players) players[s].close();
viewer.close(); dev.close();
console.log(fails ? `FAILED ${fails}` : "ALL OK");
process.exit(fails ? 1 : 0);

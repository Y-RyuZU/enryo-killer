// Plan B (磁石XY) の疎通テスト: deviceMode 切替 / device/ws に {t:"xy"} が届くか / 手動ジョグ / ping 応答 / estop
// usage: node scripts/device-xy.mjs [--base http://127.0.0.1:8787]
const args = process.argv.slice(2);
const BASE = (args.indexOf("--base") >= 0 ? args[args.indexOf("--base") + 1] : "http://127.0.0.1:8787");
const WS = BASE.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, l, x = "") => { console.log(`${c ? "✅" : "❌"} ${l} ${x}`); if (!c) fails++; };
const json = (r) => r.json();
const api = (p, method = "GET", body) => fetch(`${BASE}/api/rooms/${code}${p}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
const code = (await (await fetch(`${BASE}/api/rooms`, { method: "POST" })).json()).code;

const m0 = await api("/device/mode").then(json);
check(m0.deviceMode === "none", "初期 deviceMode=none (mode C)", JSON.stringify(m0));
check((await api("/device/mode", "PUT", { deviceMode: "bogus" })).status === 400, "不正 deviceMode は 400");
check((await api("/device/xy", "POST", { x: 0.5, y: 0 })).status === 409, "xy モード以外でジョグは 409");

const xs = [], pays = [];
const dev = new WebSocket(`${WS}/api/rooms/${code}/device/ws`);
dev.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "xy") xs.push(m); else pays.push(m.payload); };
await new Promise((r) => (dev.onopen = r));
await sleep(200);
check(xs.length === 0 && pays[0] === "stop", "mode C では xy は来ない (stop のみ)", JSON.stringify(pays));

const m1 = await api("/device/mode", "PUT", { deviceMode: "xy" }).then(json);
check(m1.deviceMode === "xy" && m1.mode === "B", "PUT deviceMode=xy → mode B", JSON.stringify(m1));
await sleep(200);
check(xs.at(-1)?.active === true && xs.at(-1)?.x === 0 && xs.at(-1)?.y === 0, "切替直後に xy(0,0) active", JSON.stringify(xs.at(-1)));

// ping 応答
const n = xs.length;
dev.send("ping");
await sleep(200);
check(xs.length === n + 1, "ping すると最新 xy が返る", `${n}→${xs.length}`);

// 手動ジョグ
const j = await api("/device/xy", "POST", { x: 0.5, y: -2, durationMs: 800 }).then(json);
check(j.ok === false, "範囲外 (|y|>1.5) は拒否", JSON.stringify(j));
const j2 = await api("/device/xy", "POST", { x: 0.6, y: -0.8, durationMs: 800 }).then(json);
check(j2.ok && j2.devices === 1 && j2.xy.manual === true, "手動ジョグ受付", JSON.stringify(j2));
await sleep(400);
check(xs.at(-1).x === 0.6 && xs.at(-1).y === -0.8 && xs.at(-1).x_mm === 120, "ジョグ座標が 250ms ごとに届く", JSON.stringify(xs.at(-1)));
await sleep(800);
check(xs.at(-1).x === 0 && !xs.at(-1).manual, "ジョグ終了後は皿位置 (0,0) に戻る", JSON.stringify(xs.at(-1)));

// ゲーム: 東の人が引く → x が増える
const ctl = new WebSocket(`${WS}/api/rooms/${code}/ws?role=viewer`);
let snap = null;
ctl.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "state") snap = m.snapshot; };
await new Promise((r) => (ctl.onopen = r));
const p = new WebSocket(`${WS}/api/rooms/${code}/ws?role=player&playerId=xy-e`);
await new Promise((r) => (p.onopen = r));
p.send(JSON.stringify({ t: "join", playerId: "xy-e", name: "E", seat: "E" }));
ctl.send(JSON.stringify({ t: "config", params: { maxSpeed: 0.3 } }));
await sleep(200);
ctl.send(JSON.stringify({ t: "host", cmd: "start" }));
const iv = setInterval(() => p.send(JSON.stringify({ t: "pull", power: 1 })), 200);
const before = xs.length;
await sleep(2600);
const tick = xs.slice(before);
check(tick.length >= 4, "対戦中 0.5s ごとに xy", `${tick.length} msgs`);
check(tick.at(-1).x > 0.05 && Math.abs(tick.at(-1).y) < 0.01, "東へ引くと x が増える", JSON.stringify(tick.at(-1)));
check(snap?.deviceMode === "xy" && snap?.xy?.t === "xy", "Snapshot に deviceMode/xy", JSON.stringify({ dm: snap?.deviceMode, xy: snap?.xy?.x }));
check(!tick.some((m) => "payload" in m), "xy フレームに payload は含まれない (タイヤ機は無視)");

ctl.send(JSON.stringify({ t: "host", cmd: "estop" }));
await sleep(300);
check(xs.at(-1).estop === true && xs.at(-1).active === false, "緊急停止で estop:true active:false", JSON.stringify(xs.at(-1)));
clearInterval(iv);
ctl.send(JSON.stringify({ t: "host", cmd: "release_estop" }));
ctl.send(JSON.stringify({ t: "config", mode: "A" }));
await sleep(300);
const m2 = await api("/device/mode").then(json);
check(m2.deviceMode === "wheels", "PC 画面で mode A → deviceMode=wheels", m2.deviceMode);
const after = xs.length;
dev.send("ping");
await sleep(200);
check(xs.length === after, "wheels モードでは ping に xy を返さない");
for (const w of [dev, ctl, p]) w.close();
console.log(fails ? `FAILED ${fails}` : "ALL OK");
process.exit(fails ? 1 : 0);

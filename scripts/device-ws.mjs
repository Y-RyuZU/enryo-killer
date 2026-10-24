// ESP32 WebSocket の疎通テスト: device/ws に繋いで、手動コマンド・自動制御・estop で payload が届くか検証
// usage: node scripts/device-ws.mjs [--base http://127.0.0.1:8787]
const args = process.argv.slice(2);
const BASE = (args.indexOf("--base") >= 0 ? args[args.indexOf("--base") + 1] : "http://127.0.0.1:8787");
const WS = BASE.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, l, x = "") => { console.log(`${c ? "✅" : "❌"} ${l} ${x}`); if (!c) fails++; };
const code = (await (await fetch(`${BASE}/api/rooms`, { method: "POST" })).json()).code;
const got = [];
const raw = []; // 生フレーム (後方互換チェック用)
const dev = new WebSocket(`${WS}/api/rooms/${code}/device/ws`);
dev.onmessage = (e) => { raw.push(e.data); const m = JSON.parse(e.data); if (m.payload) got.push(m.payload); };
await new Promise((r) => (dev.onopen = r));
await sleep(300);
check(got[0] === "stop", "接続直後に stop", JSON.stringify(got));
const cmd = (b) => fetch(`${BASE}/api/rooms/${code}/device/cmd`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
got.length = 0;
const r = await cmd({ payload: "forward", durationMs: 800 });
check(r.ok && r.devices === 1, "手動 forward 受付", JSON.stringify(r));
await sleep(1300);
check(got.includes("forward") && got.at(-1) === "stop", "forward を再送→最後に stop", JSON.stringify(got));
check((await cmd({ payload: "jump" })).ok === false, "不正 payload は 400");
// 自動制御: mode A で E 席の人だけ引く → turn_right (初期 heading=北) → そのうち forward
const ctl = new WebSocket(`${WS}/api/rooms/${code}/ws?role=viewer`);
await new Promise((r) => (ctl.onopen = r));
ctl.send(JSON.stringify({ t: "config", mode: "A" }));
const p = new WebSocket(`${WS}/api/rooms/${code}/ws?role=player&playerId=dev-e`);
await new Promise((r) => (p.onopen = r));
p.send(JSON.stringify({ t: "join", playerId: "dev-e", name: "E", seat: "E" }));
await sleep(200);
got.length = 0;
ctl.send(JSON.stringify({ t: "host", cmd: "start" }));
const iv = setInterval(() => p.send(JSON.stringify({ t: "pull", power: 0.9 })), 200);
await sleep(3500);
check(got.includes("turn_right"), "東へ向くため turn_right", JSON.stringify(got));
check(got.includes("forward"), "向いたら forward", "");
ctl.send(JSON.stringify({ t: "host", cmd: "estop" }));
await sleep(400);
check(got.at(-1) === "stop", "緊急停止で stop", got.at(-1));
clearInterval(iv);
check(raw.every((r) => !r.includes("speed")), "speed 未指定なら従来どおり {payload} のみ", raw.find((r) => r.includes("speed")) ?? "");

// ===== speed パラメータ =====
ctl.send(JSON.stringify({ t: "host", cmd: "release_estop" }));
ctl.send(JSON.stringify({ t: "host", cmd: "reset" }));
await sleep(300);
raw.length = 0;
const rs = await cmd({ payload: "forward", durationMs: 600, speed: 0.5 });
check(rs.ok && rs.speed === 0.5, "手動 forward + speed 受付", JSON.stringify(rs));
await sleep(1000);
check(raw.includes('{"payload":"forward","speed":0.5}'), "speed 付きフレーム", JSON.stringify(raw.slice(0, 2)));
check(raw.at(-1) === '{"payload":"stop"}', "最後は speed 無しの stop", raw.at(-1));
check((await cmd({ payload: "forward", speed: 2 })).ok === false, "speed>1 は 400");
// tick 駆動: speedOut=1 で forward に speed (>= minSpeedOut)
ctl.send(JSON.stringify({ t: "config", params: { speedOut: 1, minSpeedOut: 0.4, turnRateDegPerSec: 360 } }));
raw.length = 0;
ctl.send(JSON.stringify({ t: "host", cmd: "start" }));
const iv2 = setInterval(() => p.send(JSON.stringify({ t: "pull", power: 0.9 })), 200);
await sleep(2500);
const fw = raw.map((r) => JSON.parse(r)).filter((m) => m.payload === "forward");
check(fw.length > 0 && fw.every((m) => m.speed >= 0.4 && m.speed <= 1), "speedOut=1 で forward に speed", JSON.stringify(fw.slice(0, 2)));
ctl.send(JSON.stringify({ t: "host", cmd: "stop" }));
clearInterval(iv2);
await sleep(300);
ctl.send(JSON.stringify({ t: "config", params: { speedOut: 0, turnRateDegPerSec: 90 } }));

// ===== 旋回キャリブ (IMU なし = manual) =====
const st = () => fetch(`${BASE}/api/rooms/${code}/state`).then((r) => r.json());
const cal = (b) => fetch(`${BASE}/api/rooms/${code}/device/calibrate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const calRes = (b) => fetch(`${BASE}/api/rooms/${code}/device/calibrate/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
got.length = 0;
const c1 = await cal({ dir: "right", durationMs: 600 });
check(c1.ok && c1.via === "manual", "IMU なしなら manual キャリブ", JSON.stringify(c1));
await sleep(1100);
check(got.includes("turn_right") && got.at(-1) === "stop", "manual キャリブで turn_right → stop", JSON.stringify(got));
check((await st()).calib?.state === "awaiting_measure", "calib.state=awaiting_measure");
const r1 = await calRes({ measuredDeg: 108 });
check(r1.ok && r1.turnRateDegPerSec === 180, "108°/0.6s → 180 deg/s", JSON.stringify(r1));
check((await st()).params.turnRateDegPerSec === 180, "params.turnRateDegPerSec 反映");
check((await cal({ via: "imu" })).status === 409, "IMU 無しで via=imu は 409");

// ===== IMU 付きデバイス (fake) =====
const imu = new WebSocket(`${WS}/api/rooms/${code}/device/ws`);
const imuGot = [];
imu.onmessage = (e) => imuGot.push(JSON.parse(e.data));
await new Promise((r) => (imu.onopen = r));
let yaw = 37, ms = 1000; // 端末の相対 yaw (起動時の向き = 37 とする)
imu.send(JSON.stringify({ t: "hello", fw: "test", imu: 1, boot: 12345 }));
imu.send("ping"); // 非 JSON は無視される
ctl.send(JSON.stringify({ t: "host", cmd: "reset" })); // reset で「今 N 向き」= yaw 37 が heading 0
await sleep(200);
const sendImu = () => imu.send(JSON.stringify({ t: "imu", yaw, gz: 0, ms: (ms += 150) }));
sendImu();
await sleep(200);
let s1 = await st();
check(s1.deviceHasImu && s1.deviceImu?.fresh && Math.abs(s1.deviceImu.headingDeg) < 0.5, "IMU 基準取り (reset 時 = N)", JSON.stringify(s1.deviceImu));
// 実機が物理的に 90° 右を向いた (=東) → E 席の人が引いても旋回せずに forward になるはず
yaw = 37 + 90;
const imuTimer = setInterval(sendImu, 150);
await sleep(300);
imuGot.length = 0;
ctl.send(JSON.stringify({ t: "host", cmd: "start" }));
const iv3 = setInterval(() => p.send(JSON.stringify({ t: "pull", power: 0.9 })), 200);
await sleep(1600);
s1 = await st();
check(s1.headingSource === "imu" && Math.abs(s1.plate.headingDeg - 90) < 1, "プレイ中の方位は IMU 実測", `${s1.headingSource} ${s1.plate.headingDeg}`);
const pays = imuGot.filter((m) => m.payload).map((m) => m.payload);
check(pays.includes("forward") && !pays.includes("turn_right") && !pays.includes("turn_left"), "実測で東向きなので旋回せず forward", JSON.stringify(pays));
// 報告が途絶えたら dead reckoning に戻る
clearInterval(imuTimer);
ctl.send(JSON.stringify({ t: "config", params: { imuMaxAgeMs: 300 } }));
await sleep(1200);
check((await st()).headingSource === "dr", "IMU 報告途絶 → dead reckoning");
ctl.send(JSON.stringify({ t: "host", cmd: "stop" }));
clearInterval(iv3);
await sleep(300);
// IMU キャリブ: サーバー → {"cmd":"calib"}、デバイス → {"t":"calib"} で turnRate 更新
imu.send(JSON.stringify({ t: "imu", yaw, gz: 0, ms: (ms += 150) }));
imuGot.length = 0;
const c2 = await cal({ dir: "left", durationMs: 1000 });
check(c2.ok && c2.via === "imu", "IMU ありなら imu キャリブ", JSON.stringify(c2));
await sleep(200);
const cc = imuGot.find((m) => m.cmd === "calib");
check(cc && cc.dir === "left" && cc.ms === 1000 && cc.payload === undefined, "calib 指示フレーム (payload 無し)", JSON.stringify(cc));
imu.send(JSON.stringify({ t: "calib", id: cc?.id, dir: "left", ms: 1000, deg: -123.4, dps: 123.4, ok: 1 }));
await sleep(200);
s1 = await st();
check(s1.params.turnRateDegPerSec === 123.4 && s1.calib?.state === "done", "IMU キャリブ結果で turnRate 更新", `${s1.params.turnRateDegPerSec} ${s1.calib?.state}`);
imu.close();
for (const w of [dev, ctl, p]) w.close();
console.log(fails ? `FAILED ${fails}` : "ALL OK");
process.exit(fails ? 1 : 0);

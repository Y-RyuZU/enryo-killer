// /host ダッシュボード + /a〜/d 席画面のスモークテスト (headless Chromium)
// usage: PLAYWRIGHT_BROWSERS_PATH=.playwright node scripts/gui-smoke.mjs [--base http://127.0.0.1:8787] [--room ABCD] [--no-device]
//   --room を省略すると使い捨ての部屋 (GUITEST + 乱数) を使う (本番の ABCD を汚さない)
import { chromium } from "playwright";
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt("--base", "http://127.0.0.1:8787");
const ROOM = opt("--room", `GT${Math.random().toString(36).slice(2, 6).toUpperCase()}`);
const q = `?room=${ROOM}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, l, x = "") => { console.log(`${c ? "✅" : "❌"} ${l} ${x}`); if (!c) fails++; };
const state = async () => (await fetch(`${BASE}/api/rooms/${ROOM}/state`)).json();
console.log("room:", ROOM);

// 偽 ESP32
const got = [];
let dev = null;
if (!args.includes("--no-device")) {
  dev = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/rooms/${ROOM}/device/ws`);
  dev.onmessage = (e) => got.push(JSON.parse(e.data).payload);
  await new Promise((r) => (dev.onopen = r));
}

const browser = await chromium.launch();
const host = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
host.on("pageerror", (e) => errs.push(String(e)));
await host.goto(`${BASE}/host${q}`);
await host.waitForSelector(".hd-seat");
check((await host.locator(".hd-seat").count()) === 4, "ホスト: 席カード 4 枚");
if (dev) check(/ESP32 1台/.test(await host.locator(".hd-head").innerText()), "ホスト: ESP32 1台 表示");

// A, B はスマホ画面から
const phones = [];
for (const l of ["a", "b"]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(`${l}: ${e}`));
  await p.goto(`${BASE}/${l}${q}`);
  phones.push(p);
}
await phones[0].waitForSelector(".rope-screen", { timeout: 8000 });
await phones[1].waitForSelector(".rope-screen", { timeout: 8000 });
check(true, "/a /b: 自動着席して縄画面");
// C, D はホストの BOT
const seats = host.locator(".hd-seat");
await seats.nth(2).locator(".hd-bot input").check();
await seats.nth(3).locator(".hd-bot input").check();
await sleep(1200);
let s = await state();
check(Object.keys(s.seats).length === 4, "4 席埋まる (A,B=スマホ C,D=BOT)", JSON.stringify(Object.fromEntries(Object.entries(s.seats).map(([k, v]) => [k, v.name]))));

// 開始 → C の BOT を強く引かせる
await host.getByRole("button", { name: "▶ 開始" }).click();
await seats.nth(2).locator(".hd-bot-power").fill("1");
await sleep(3500);
s = await state();
check(s.phase === "playing", "開始で playing");
check(s.plate.y > 0.02, "皿が C (南) へ動く", `y=${s.plate.y.toFixed(3)}`);
const logText = await host.locator(".hd-log").innerText();
check(/フェーズ: 待機中 → 対戦中/.test(logText) && /着席/.test(logText), "イベントログに開始/着席が出る");
await host.screenshot({ path: "screenshots/host.png" });
await phones[0].screenshot({ path: "screenshots/seat-a.png" });

// 手動コマンド
if (dev) {
  await host.getByRole("button", { name: "⏸ 停止" }).click();
  await sleep(300);
  got.length = 0;
  await host.locator(".hd-pad-btn", { hasText: "前進" }).click();
  await sleep(700);
  check(got.includes("forward"), "手動 前進 → ESP32 に forward", JSON.stringify(got.slice(0, 6)));
  check(/手動: 前進/.test(await host.locator(".hd-log").innerText()), "ログに手動コマンド");
}
// 緊急停止 (Space)
await host.keyboard.press(" ");
await sleep(600);
s = await state();
check(s.estop === true, "Space で緊急停止");
check(await phones[0].locator(".overlay.estop").count() === 1, "スマホに緊急停止表示");
await host.getByRole("button", { name: "緊急停止を解除" }).click({ force: true });
await host.getByRole("button", { name: "↺ リセット" }).click();
await sleep(500);
// 旋回キャリブ (IMU なしの偽 ESP32 → manual: 回して止める → 角度入力)
if (dev) {
  await host.locator("summary", { hasText: "旋回キャリブレーション" }).click();
  got.length = 0;
  await host.getByRole("button", { name: "ワンクリック計測" }).click();
  await sleep(1000);
  await host.locator(".hd-calib-row select").nth(1).selectOption("1000").catch(() => {});
  await sleep(1800);
  s = await state();
  check(got.includes("turn_right") && s.calib?.state === "awaiting_measure", "キャリブ: 右旋回→角度待ち", `${s.calib?.state} ${JSON.stringify([...new Set(got)])}`);
  await host.locator(".hd-calib-row input").fill("180");
  await host.getByRole("button", { name: "登録" }).click();
  await sleep(600);
  s = await state();
  check(s.calib?.state === "done" && Math.abs(s.params.turnRateDegPerSec - 90) < 1, "キャリブ: 180°/2s → 90 deg/s", `${s.params.turnRateDegPerSec}`);
  // WASD
  got.length = 0;
  await host.keyboard.press("d");
  await sleep(500);
  check(got.includes("turn_right"), "D キーで右旋回", JSON.stringify(got.slice(0, 3)));
  await host.keyboard.press("x");
}
// BOT OFF → 席が空く / 空けるボタン
await seats.nth(3).locator(".hd-bot input").uncheck();
await sleep(800);
s = await state();
check(!s.seats.W, "BOT OFF で D 席が空く");
await seats.nth(1).getByRole("button", { name: "空ける" }).click();
await sleep(1500);
s = await state();
check(s.seats.E?.playerId === "seat-B", "B を空けても /b が自動で座り直す");
check(errs.length === 0, "ページエラーなし", errs.join(" | "));
await host.screenshot({ path: "screenshots/host-after.png" });

// 入口
const land = await browser.newPage({ viewport: { width: 390, height: 844 } });
await land.goto(`${BASE}/`);
check((await land.locator(".landing-seat").count()) === 4, "/ 入口に A〜D リンク");
await land.screenshot({ path: "screenshots/landing.png" });

await seats.nth(2).locator(".hd-bot input").uncheck();
await sleep(300);
await browser.close();
dev?.close();
console.log(fails ? `\n${fails} 件失敗` : "\nALL OK");
process.exit(fails ? 1 : 0);

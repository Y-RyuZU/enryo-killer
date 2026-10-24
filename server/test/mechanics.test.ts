import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, PARAM_RANGES, Params } from "../src/shared";
import { applyPull, freshMech, restoreIfDue, turnLockDuration, turnLockStarts, mergeParams, SeatMech } from "../src/mechanics";

const P = (o: Partial<Params> = {}): Params => ({ ...DEFAULT_PARAMS, ...o });
/** 8Hz で power を送り続けたときの最終状態 */
function feed(m: SeatMech, power: number, from: number, ms: number, p: Params, othersMax = 0) {
  let last = { mech: m, effective: 0, snapped: false, restored: false };
  const events: string[] = [];
  for (let t = from; t <= from + ms; t += 125) {
    last = applyPull(last.mech, power, t, p, othersMax);
    if (last.snapped) events.push(`snap@${t - from}`);
    if (last.restored) events.push(`restore@${t - from}`);
  }
  return { ...last, events };
}

test("defaults are sane", () => {
  assert.equal(DEFAULT_PARAMS.snapEnabled, 1);
  assert.equal(DEFAULT_PARAMS.snapPower, 0.9);
  assert.equal(DEFAULT_PARAMS.snapRecoverMs, 3000);
  assert.equal(DEFAULT_PARAMS.turnLockMs, 0);
  assert.equal(DEFAULT_PARAMS.pullCooldownMs, 300);
});

test("normal pull is passed through", () => {
  const r = feed(freshMech(), 0.6, 0, 2000, P());
  assert.equal(r.effective, 0.6);
  assert.deepEqual(r.events, []);
});

test("pulling too hard for snapHoldMs snaps the rope, then restores", () => {
  const p = P({ snapHoldMs: 500, snapRecoverMs: 2000 });
  const r = feed(freshMech(), 1, 0, 600, p);
  assert.deepEqual(r.events, ["snap@500"]);
  assert.equal(r.effective, 0);
  assert.ok(r.mech.snappedUntil === 2500);
  // 切れてる間は 0
  const during = applyPull(r.mech, 0.5, 1500, p);
  assert.equal(during.effective, 0);
  // 復活
  const after = applyPull(r.mech, 0.5, 2600, p);
  assert.equal(after.restored, true);
  assert.equal(after.effective, 0.5);
  assert.equal(restoreIfDue(r.mech, 2500).restored, true);
  assert.equal(restoreIfDue(r.mech, 2499).restored, false);
});

test("dipping below snapPower resets the hold timer", () => {
  const p = P({ snapHoldMs: 500 });
  let m = feed(freshMech(), 1, 0, 375, p).mech;
  m = applyPull(m, 0.5, 500, p).mech;
  const r = feed(m, 1, 625, 375, p);
  assert.deepEqual(r.events, []);
});

test("snap disabled / lead margin", () => {
  assert.deepEqual(feed(freshMech(), 1, 0, 3000, P({ snapEnabled: 0 })).events, []);
  // 他の人も同じくらい引いていれば切れない
  assert.deepEqual(feed(freshMech(), 1, 0, 3000, P({ snapLeadMargin: 0.3 }), 0.8).events, []);
  assert.equal(feed(freshMech(), 1, 0, 3000, P({ snapLeadMargin: 0.3, snapHoldMs: 0 }), 0.2).events[0], "snap@0");
});

test("pull cooldown: after releasing, the next stroke is ignored for pullCooldownMs", () => {
  const p = P({ pullCooldownMs: 400, snapEnabled: 0 });
  let r = applyPull(freshMech(), 0.7, 0, p);
  assert.equal(r.effective, 0.7);
  r = applyPull(r.mech, 0, 100, p); // 離す
  assert.equal(r.mech.cooldownUntil, 500);
  assert.equal(applyPull(r.mech, 0.7, 300, p).effective, 0); // まだクールタイム
  assert.equal(applyPull(r.mech, 0.7, 500, p).effective, 0.7);
  // disabled
  const q = P({ pullCooldownEnabled: 0, snapEnabled: 0 });
  const r2 = applyPull(applyPull(freshMech(), 0.7, 0, q).mech, 0, 100, q);
  assert.equal(applyPull(r2.mech, 0.7, 150, q).effective, 0.7);
});

test("turn lock duration and trigger", () => {
  assert.equal(turnLockDuration(P({ turnLockMs: 1200 }), 10), 1200);
  assert.equal(turnLockDuration(P({ turnLockMs: 0, turnRateDegPerSec: 90 }), 90), 1000);
  assert.equal(turnLockDuration(P({ turnLockMs: 0, turnRateDegPerSec: 90 }), -180), 2000);
  assert.equal(turnLockDuration(P({ turnLockMs: 0, turnRateDegPerSec: 90 }), 5), 300);
  assert.equal(turnLockStarts("forward", "turn_right"), "right");
  assert.equal(turnLockStarts("turn_right", "turn_left"), "left");
  assert.equal(turnLockStarts("turn_left", "turn_left"), null);
  assert.equal(turnLockStarts("turn_left", "forward"), null);
});

test("mergeParams validates and clamps", () => {
  const { params, errors } = mergeParams(P(), { snapPower: 5, turnLockEnabled: false, nope: 1, gain: "x" }, DEFAULT_PARAMS, PARAM_RANGES);
  assert.equal(params.snapPower, 1);
  assert.equal(params.turnLockEnabled, 0);
  assert.deepEqual(errors, ["unknown param: nope", "gain must be a number"]);
});

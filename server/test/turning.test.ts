import test from "node:test";
import assert from "node:assert/strict";
import { step, deviceCmd, movePayload } from "../src/logic";
import { DEFAULT_PARAMS } from "../src/shared";

// N 席が引いてる (目標 0°)、皿は 40° 向き
const run = (turning: "right" | "left" | null | undefined) => {
  const params = { ...DEFAULT_PARAMS, turnRateDegPerSec: 180 };
  const out = step({ powers: { N: 1 }, tensions: { N: 1 }, plate: { x: 0, y: 0, headingDeg: 40, speed: 0 }, params, dt: 0.25, turning });
  const cmd = deviceCmd({ type: "A", mode: "A", phase: "playing", estop: false, seq: 1, plate: out.plate, leaderSeat: out.leaderSeat, params, targetDirDeg: out.targetDirDeg });
  return { heading: out.plate.headingDeg, payload: movePayload(cmd, params) };
};

test("heading estimate does not rotate unless the device was actually turning", () => {
  const r = run(null); // 直進中だった
  assert.equal(r.heading, 40);
  assert.equal(r.payload, "turn_left"); // 旧挙動だと「回ったこと」にされて forward のままだった
});

test("heading estimate rotates while turning, without overshoot", () => {
  assert.equal(run("left").heading, 0); // 180°/s * 0.25s = 45° > 40° -> 目標で止める
  assert.equal(run("left").payload, "forward");
});

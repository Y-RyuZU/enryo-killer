import test from "node:test";
import assert from "node:assert/strict";
import { deviceCmd, movePayload, driveFrame } from "../src/logic";
import { DEFAULT_PARAMS } from "../src/shared";

const cmdFor = (headingDeg: number, backwardEnabled: number) => {
  const params = { ...DEFAULT_PARAMS, backwardEnabled };
  const cmd = deviceCmd({ type: "A", mode: "A", phase: "playing", estop: false, seq: 1, plate: { x: 0, y: 0, headingDeg, speed: 0.5 }, leaderSeat: "N", params, targetDirDeg: 0 });
  return movePayload(cmd, params);
};

test("backward: target behind -> backward instead of 180° turn", () => {
  assert.equal(cmdFor(180, 1), "backward");
  assert.equal(cmdFor(180, 0), "turn_left");
  assert.equal(cmdFor(0, 1), "forward");
  assert.deepEqual(driveFrame(0, 150, { backwardEnabled: 1 }), { dh: 30, back: true });
  assert.equal(cmdFor(150, 1), "turn_right"); // tail 330° -> 0° は右旋回 30°
});

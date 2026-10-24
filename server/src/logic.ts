import { DEFAULT_PARAMS, Params, Plate, SEATS, Seat, DeviceCmd, Mode, Phase, MovePayload, XyMsg } from "./shared";

export const SEAT_POS: Record<Seat, { x: number; y: number }> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};
export const SEAT_DIR_DEG: Record<Seat, number> = { N: 0, E: 90, S: 180, W: 270 };
export const TABLE_RADIUS_MM = 200;
export const DEVICE_TTL_MS = 600;
export const PULL_STALE_MS = 1500;

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export type StepInput = {
  powers: Partial<Record<Seat, number>>; // 0..1 現在の引っ張り
  tensions: Partial<Record<Seat, number>>;
  plate: Plate;
  params: Params;
  dt: number; // sec
};
export type StepOutput = {
  tensions: Partial<Record<Seat, number>>;
  plate: Plate;
  leaderSeat: Seat | null;
  winnerSeat: Seat | null;
  targetDirDeg: number | null;
};

/** 純関数: 1 tick 分の物理/判定 */
export function step({ powers, tensions, plate, params, dt }: StepInput): StepOutput {
  const p = { ...DEFAULT_PARAMS, ...params };
  const k = Math.pow(p.decay, dt / 0.5); // decay は 0.5s あたりの値
  const nt: Partial<Record<Seat, number>> = {};
  for (const s of SEATS) {
    if (powers[s] === undefined && tensions[s] === undefined) continue;
    nt[s] = (tensions[s] ?? 0) * k + clamp(powers[s] ?? 0, 0, 1) * (1 - k);
  }
  // 合力方式: 各席の tension をその席方向の単位ベクトルとして足し合わせ、合力の向き・大きさで皿を動かす
  // (向かい合う 2 人が同じ力なら打ち消し合って止まる)
  let fx = 0, fy = 0;
  for (const [s, t] of Object.entries(nt) as [Seat, number][]) {
    fx += SEAT_POS[s].x * t;
    fy += SEAT_POS[s].y * t;
  }
  const mag = Math.hypot(fx, fy);
  // leaderSeat = 合力の向きに一番近い席 (UI の勝ち/負け表示・デバイス B の目標用)
  let leaderSeat: Seat | null = null;
  if (mag >= p.tieMargin && mag > 0.02) {
    let best = -Infinity;
    for (const s of Object.keys(nt) as Seat[]) {
      const d = (SEAT_POS[s].x * fx + SEAT_POS[s].y * fy) / mag;
      if (d > best) { best = d; leaderSeat = s; }
    }
  }

  const np = { ...plate };
  let targetDirDeg: number | null = null;
  if (leaderSeat) {
    np.speed = clamp(mag * p.gain, 0, 1);
    const stepLen = np.speed * p.maxSpeed * dt;
    np.x += (fx / mag) * stepLen;
    np.y += (fy / mag) * stepLen;
    // 卓の外へは出さない (席位置 = 半径 1)
    const r = Math.hypot(np.x, np.y);
    if (r > 1) { np.x /= r; np.y /= r; }
    targetDirDeg = ((Math.atan2(fx, -fy) * 180) / Math.PI + 360) % 360; // 0=N 時計回り
    // オープンループの向き推定: 最大 90°/s で目標方向へ回す
    const dh = wrap180(targetDirDeg - plate.headingDeg);
    np.headingDeg = (plate.headingDeg + clamp(dh, -90 * dt, 90 * dt) + 360) % 360;
  } else {
    np.speed = 0;
  }
  let winnerSeat: Seat | null = null;
  for (const s of SEATS) {
    const sp = SEAT_POS[s];
    if (Math.hypot(sp.x - np.x, sp.y - np.y) < p.winRadius && nt[s] !== undefined) winnerSeat = s;
  }
  return { tensions: nt, plate: np, leaderSeat, winnerSeat, targetDirDeg };
}

/** モード別アダプタ: 共通の皿状態 -> デバイスコマンド */
export function deviceCmd(opts: {
  type: "A" | "B";
  mode: Mode;
  phase: Phase;
  estop: boolean;
  seq: number;
  plate: Plate;
  leaderSeat: Seat | null;
  params: Params;
  targetDirDeg?: number | null; // 合力の向き (あればこちらを優先)
}): DeviceCmd {
  const { type, mode, phase, estop, seq, plate, leaderSeat, params, targetDirDeg } = opts;
  const active = !estop && phase === "playing" && mode === type && leaderSeat !== null;
  const base: DeviceCmd = { type, seq, ttlMs: DEVICE_TTL_MS, active, estop, phase, leaderSeat };
  if (type === "A") {
    if (!active || !leaderSeat) return { ...base, dirDeg: plate.headingDeg, speed: 0, turn: 0, fwd: 0 };
    const tgt = SEAT_POS[leaderSeat];
    const dirDeg = targetDirDeg ?? ((Math.atan2(tgt.x - plate.x, -(tgt.y - plate.y)) * 180) / Math.PI + 360) % 360;
    const dh = wrap180(dirDeg - plate.headingDeg);
    const turn = clamp(dh / 90, -1, 1);
    const fwd = Math.abs(dh) < 30 ? plate.speed : 0;
    const r = (n: number) => Math.round(n * 1000) / 1000;
    return { ...base, dirDeg: r(dirDeg), speed: r(plate.speed), turn: r(turn), fwd: r(fwd) };
  }
  const R = TABLE_RADIUS_MM;
  const goal = leaderSeat ? SEAT_POS[leaderSeat] : { x: plate.x, y: plate.y };
  return {
    ...base,
    x_mm: Math.round(plate.x * R),
    y_mm: Math.round(plate.y * R),
    goal_x_mm: Math.round(goal.x * R * 0.8),
    goal_y_mm: Math.round(goal.y * R * 0.8),
    feed_mm_s: active ? Math.round(plate.speed * params.maxSpeed * R) : 0,
  };
}

/** mode A のコマンドを ESP32 WS 用の単純コマンドに変換 (方位はサーバー側のオープンループ推定) */
export const TURN_THRESHOLD = 0.33; // |turn| がこれ以上なら旋回 (≒30°ずれ)
export function movePayload(cmd: DeviceCmd): MovePayload {
  if (!cmd.active || cmd.estop) return "stop";
  const turn = cmd.turn ?? 0;
  if (turn >= TURN_THRESHOLD) return "turn_right";
  if (turn <= -TURN_THRESHOLD) return "turn_left";
  return (cmd.fwd ?? 0) > 0 ? "forward" : "stop";
}

/** mode B (磁石XY): 皿の現在位置をそのまま目標座標として送る。単位円にクランプ */
export const XY_TTL_MS = 1500;
export function xyMsg(opts: { mode: Mode; estop: boolean; seq: number; x: number; y: number; manual?: boolean }): XyMsg {
  let { x, y } = opts;
  if (!isFinite(x)) x = 0;
  if (!isFinite(y)) y = 0;
  const r = Math.hypot(x, y);
  if (r > 1) { x /= r; y /= r; }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    t: "xy",
    seq: opts.seq,
    // ロビー/決着中も「今の皿位置でホールド」= active。リセットで中央へ戻る
    active: !opts.estop && opts.mode === "B",
    estop: opts.estop,
    ttlMs: XY_TTL_MS,
    x: r3(x),
    y: r3(y),
    x_mm: Math.round(x * TABLE_RADIUS_MM),
    y_mm: Math.round(y * TABLE_RADIUS_MM),
    ...(opts.manual ? { manual: true } : {}),
  };
}

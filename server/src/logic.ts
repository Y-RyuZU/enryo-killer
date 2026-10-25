import { DEFAULT_PARAMS, Params, Plate, SEATS, Seat, DeviceCmd, Mode, Phase, MovePayload, XyMsg, DeviceWsMsg } from "./shared";

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
export const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
/** 目標方位と現在の向きから「どっちを前にして進むか」を決める。
 *  backwardEnabled で ずれが 90° を超えるなら、お尻を前にして backward (旋回は最大 90° で済む)。
 *  dh = 「前にする側」から目標までのずれ (正 = 右旋回) */
export function driveFrame(dirDeg: number, headingDeg: number, p?: Partial<Params>): { dh: number; back: boolean } {
  const dh = wrap180(dirDeg - headingDeg);
  if (Number(p?.backwardEnabled ?? 0) >= 0.5 && Math.abs(dh) > 90) return { dh: wrap180(dh - 180), back: true };
  return { dh, back: false };
}
export const wrap360 = (d: number) => ((d % 360) + 360) % 360;
/** 方位誤差の正規化 (turn = dh / これ)。turnRateDegPerSec とは別物なので固定 */
export const TURN_ERR_NORM_DEG = 90;

// ===== IMU 方位補正 =====
/** 端末相対 yaw + offset -> 卓基準の絶対方位 */
export const imuHeading = (yawDeg: number, offsetDeg: number) => wrap360(yawDeg + offsetDeg);
/** 「今の yaw は卓方位 target」とみなす offset */
export const imuOffsetFor = (targetHeadingDeg: number, yawDeg: number) => wrap360(targetHeadingDeg - yawDeg);
/** 角度の折返しに強い相補フィルタ (blend=1 で IMU 値そのまま) */
export const fuseHeading = (drDeg: number, imuDeg: number, blend: number) =>
  wrap360(drDeg + clamp(blend, 0, 1) * wrap180(imuDeg - drDeg));
/** 旋回キャリブ: 回った角度と時間から deg/s */
export const turnRateFrom = (measuredDeg: number, durationMs: number) =>
  clamp(Math.abs(measuredDeg) / (Math.max(100, durationMs) / 1000), 5, 720);

export type StepInput = {
  powers: Partial<Record<Seat, number>>; // 0..1 現在の引っ張り
  tensions: Partial<Record<Seat, number>>;
  plate: Plate;
  params: Params;
  dt: number; // sec
  headingOverrideDeg?: number | null; // IMU 由来の実測方位 (新鮮なときだけ)。null = dead reckoning
};
export type StepOutput = {
  tensions: Partial<Record<Seat, number>>;
  plate: Plate;
  leaderSeat: Seat | null;
  winnerSeat: Seat | null;
  targetDirDeg: number | null;
  headingSource: "imu" | "dr";
};

/** 純関数: 1 tick 分の物理/判定 */
export function step({ powers, tensions, plate, params, dt, headingOverrideDeg = null }: StepInput): StepOutput {
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

  const headingSource = headingOverrideDeg == null ? "dr" : "imu";
  const h0 = headingOverrideDeg ?? plate.headingDeg; // 実測があればそこを起点に推定
  const np = { ...plate, headingDeg: h0 };
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
    // 向き推定: 最大 turnRateDegPerSec (既定 90°/s, キャリブで実測値) で目標方向へ回す。IMU 実測があればそこが起点
    const rate = p.turnRateDegPerSec > 0 ? p.turnRateDegPerSec : 90;
    const { dh } = driveFrame(targetDirDeg, h0, p); // バック走行時はお尻を目標へ向ける
    np.headingDeg = (h0 + clamp(dh, -rate * dt, rate * dt) + 360) % 360;
  } else {
    np.speed = 0;
  }
  let winnerSeat: Seat | null = null;
  for (const s of SEATS) {
    const sp = SEAT_POS[s];
    if (Math.hypot(sp.x - np.x, sp.y - np.y) < p.winRadius && nt[s] !== undefined) winnerSeat = s;
  }
  return { tensions: nt, plate: np, leaderSeat, winnerSeat, targetDirDeg, headingSource };
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
    const { dh, back } = driveFrame(dirDeg, plate.headingDeg, params);
    const turn = clamp(dh / TURN_ERR_NORM_DEG, -1, 1);
    const fwd = Math.abs(dh) < turnStartDeg(params) ? plate.speed : 0;
    const r = (n: number) => Math.round(n * 1000) / 1000;
    return { ...base, dirDeg: r(dirDeg), speed: r(plate.speed), turn: r(turn), fwd: r(fwd), ...(back ? { back: true } : {}) };
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
export const TURN_THRESHOLD = 0.33; // 旧既定 (≒30°ずれ)。今は params.turnStartDeg / TURN_ERR_NORM_DEG
export const turnStartDeg = (p?: Partial<Params>) => clamp(Number(p?.turnStartDeg) > 0 ? Number(p!.turnStartDeg) : 15, 5, 90);
export function movePayload(cmd: DeviceCmd, params?: Partial<Params>): MovePayload {
  if (!cmd.active || cmd.estop) return "stop";
  const turn = cmd.turn ?? 0;
  const th = turnStartDeg(params) / TURN_ERR_NORM_DEG - 1e-6;
  if (turn >= th) return "turn_right";
  if (turn <= -th) return "turn_left";
  if ((cmd.fwd ?? 0) <= 0) return "stop";
  return cmd.back ? "backward" : "forward";
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

/** movePayload + 任意の speed。speedOut=0 なら {payload} だけ (従来と同一バイト列) */
export function moveCommand(cmd: DeviceCmd, params: Params): DeviceWsMsg {
  const payload = movePayload(cmd, params);
  if ((params.speedOut ?? 0) < 0.5 || payload === "stop") return { payload };
  // 前後進は皿の速度 (margin 由来) に追従、下限 minSpeedOut。旋回はフル (遅い旋回は止まりやすい)
  const base = payload === "forward" || payload === "backward" ? cmd.fwd ?? cmd.speed ?? 0 : 1;
  const min = clamp(params.minSpeedOut ?? 0.35, 0, 1);
  return { payload, speed: Math.round(clamp(Math.max(base, min), 0, 1) * 100) / 100 };
}

/** 0..1 の speed を検証。省略 = undefined、範囲外 = null */
export function parseSpeed(v: unknown): number | undefined | null {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 1000) / 1000;
}

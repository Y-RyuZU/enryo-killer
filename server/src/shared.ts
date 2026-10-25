// Shared types between server and web (web imports this file via relative path).
export type Seat = "N" | "E" | "S" | "W";
export const SEATS: Seat[] = ["N", "E", "S", "W"];
export type Mode = "A" | "B" | "C"; // A=ESP32タイヤ, B=磁石XY, C=バーチャル皿のみ
export type Phase = "lobby" | "playing" | "finished";
export type Status = "waiting" | "winning" | "losing";

export type Params = {
  maxSpeed: number; // 皿の最大速度 (卓半径=1 の正規化単位 / 秒)
  gain: number; // margin -> 速度係数
  decay: number; // tension の減衰 (0..1, 大きいほど粘る)
  tieMargin: number; // これ未満の差は拮抗 = 動かない
  winRadius: number; // 席からこの距離に入ったら決着
  // --- Plan A 方位補正 (全部 number: config WS の既存バリデータでそのまま変更可) ---
  turnRateDegPerSec: number; // 実機の旋回速度 (deg/s)。dead reckoning の回転上限。キャリブで更新。90 = 従来どおり
  imuMaxAgeMs: number; // これより古い IMU 報告は無視して dead reckoning に戻す
  imuBlend: number; // 0..1  0=IMU 無視, 1=IMU で上書き
  speedOut: number; // 0/1  1 なら tick 駆動の push に speed を付ける (0=従来と同一バイト列)
  minSpeedOut: number; // speedOut=1 時の forward/backward の下限 (0..1, モーターが止まらない値)
  // --- ゲームルール (enable は 0/1。全部 number なので config WS / PUT /params でそのまま変更可) ---
  snapEnabled: number; // 0/1 ひも切れ
  snapPower: number; // 0..1 これ以上の強さで引き続けると切れる
  snapHoldMs: number; // snapPower 以上をこの時間続けたら切れる (0 = 即)
  snapLeadMargin: number; // 0..1  >0 なら「他の席の最大より これ以上強い」(1 人だけ突出) ときだけ切れる。0 = 無条件
  snapRecoverMs: number; // 切れてから復活までの時間
  turnLockEnabled: number; // 0/1 旋回中は誰も引けない (mode A)
  turnLockMs: number; // 旋回ロックの長さ。0 = 自動 (必要な旋回角 ÷ turnRateDegPerSec, 300..5000ms)
  pullCooldownEnabled: number; // 0/1 引っ張りクールタイム
  pullCooldownMs: number; // 1 回引いて離してから、次の引っ張りが効くまでの時間
  // --- Plan A 旋回のキビキビ度 ---
  turnStartDeg: number; // 目標方向とのずれがこれ以上なら旋回 (未満なら直進)。小さいほどすぐ曲がる (旧 30)
  turnPauseMs: number; // 直進→旋回に切り替わるとき、いったん止まる時間 (0 = 止まらない)
  backwardEnabled: number; // 0/1 行きたい方向が後ろ寄り (ずれ 90°超) なら、180°回らずにお尻を向けて backward で進む
};
export const DEFAULT_PARAMS: Params = {
  maxSpeed: 0.08, gain: 2, decay: 0.8, tieMargin: 0.05, winRadius: 0.35,
  turnRateDegPerSec: 90, imuMaxAgeMs: 1500, imuBlend: 1, speedOut: 0, minSpeedOut: 0.35,
  snapEnabled: 1, snapPower: 0.9, snapHoldMs: 800, snapLeadMargin: 0, snapRecoverMs: 3000,
  turnLockEnabled: 1, turnLockMs: 0,
  pullCooldownEnabled: 1, pullCooldownMs: 300,
  turnStartDeg: 15, turnPauseMs: 250,
  backwardEnabled: 1,
};
/** params の許容範囲 (PUT /params と config WS で clamp) */
export const PARAM_RANGES: Partial<Record<keyof Params, [number, number]>> = {
  snapEnabled: [0, 1], snapPower: [0.05, 1], snapHoldMs: [0, 10000], snapLeadMargin: [0, 1], snapRecoverMs: [0, 60000],
  turnLockEnabled: [0, 1], turnLockMs: [0, 10000], pullCooldownEnabled: [0, 1], pullCooldownMs: [0, 10000],
  turnStartDeg: [5, 90], turnPauseMs: [0, 2000], backwardEnabled: [0, 1],
};

/** 席ごとのルール状態 (残り時間は snapshot 生成時点からの ms) */
export type SeatMechView = { snapped: boolean; snapRemainMs: number; cooldownRemainMs: number; overMs: number };
export type TurnLockView = { remainMs: number; durationMs: number; dir: TurnDir };
export type MechEventView = { id: number; at: number; kind: "snap" | "restore" | "turnlock_start" | "turnlock_end"; seat?: Seat; durationMs?: number; dir?: TurnDir };
export type MechView = {
  seats: Partial<Record<Seat, SeatMechView>>;
  turnLock: TurnLockView | null;
  events?: MechEventView[]; // viewer のみ: 直近のルールイベント (id 昇順)
};

export type PlayerView = {
  playerId: string;
  name: string;
  seat: Seat;
  online: boolean;
  tension?: number; // viewer にだけ公開 (プレイヤーには自分の分のみ)
};

export type Plate = { x: number; y: number; headingDeg: number; speed: number };

export type Snapshot = {
  code: string;
  tick: number;
  phase: Phase;
  mode: Mode;
  estop: boolean;
  params: Params;
  seats: Partial<Record<Seat, PlayerView>>;
  plate: Plate;
  leaderSeat: Seat | null;
  winnerSeat: Seat | null;
  deviceOnline: boolean;
  lastDevice?: DeviceCmd | null;
  devicePayload?: MovePayload | null; // ESP32 (WS) に最後に送ったコマンド
  deviceWsCount?: number;
  deviceMode?: DeviceMode; // mode から導出 (A=wheels, B=xy, C=none)
  xy?: XyMsg | null; // mode B で device/ws に最後に送った目標座標
  deviceSpeed?: number | null; // 最後に送った speed (付けてなければ null)
  deviceHasImu?: boolean;
  deviceImu?: ImuView | null;
  headingSource?: "imu" | "dr"; // 直近 tick の方位の出どころ
  calib?: CalibState | null;
  mech?: MechView; // ひも切れ / 旋回ロック / クールタイム
  me?: { playerId: string; seat: Seat | null; tension: number; status: Status };
};

// ===== WebSocket messages =====
export type C2S =
  | { t: "join"; playerId: string; name: string; seat: Seat }
  | { t: "leave" }
  | { t: "pull"; power: number } // 0..1 (ドラッグ量)
  | { t: "host"; cmd: "start" | "stop" | "estop" | "reset" | "release_estop" }
  | { t: "config"; mode?: Mode; params?: Partial<Params>; zeroImu?: boolean }; // zeroImu: 次の IMU 報告で方位の基準を取り直す

export type S2C =
  | { t: "state"; snapshot: Snapshot }
  | { t: "error"; message: string };

// ===== Device poll response (mode A / B) =====
export type DeviceCmd = {
  type: "A" | "B";
  seq: number;
  ttlMs: number; // この時間を過ぎたら自力停止
  active: boolean; // false = 止まれ
  estop: boolean;
  phase: Phase;
  leaderSeat: Seat | null;
  // --- mode A (タイヤロボ) ---
  dirDeg?: number; // 進みたい絶対方位 (0=N, 90=E, 時計回り)
  speed?: number; // 0..1
  turn?: number; // -1..1 (正=右旋回) 推定headingとの差から計算
  fwd?: number; // 0..1
  back?: boolean; // true = お尻側を進行方向にして backward で進む (backwardEnabled 時)
  // --- mode B (磁石XY) ---
  x_mm?: number; // 今いてほしい座標 (卓中心原点, +x=E, +y=S)
  y_mm?: number;
  goal_x_mm?: number;
  goal_y_mm?: number;
  feed_mm_s?: number;
};

// ===== ESP32 WebSocket (device/ws) =====
export type MovePayload = "forward" | "backward" | "turn_right" | "turn_left" | "stop";
export const MOVE_PAYLOADS: MovePayload[] = ["forward", "backward", "turn_right", "turn_left", "stop"];

// ===== Plan B: 磁石 XY (device/ws に {t:"xy",...} を push) =====
// deviceMode は room.mode の別名: wheels=A, xy=B, none=C (C=バーチャルのみ、デバイスは停止)
export type DeviceMode = "wheels" | "xy" | "none";
export const DEVICE_MODES: DeviceMode[] = ["wheels", "xy", "none"];
export const DEVICE_MODE_TO_MODE: Record<DeviceMode, Mode> = { wheels: "A", xy: "B", none: "C" };
export const MODE_TO_DEVICE_MODE: Record<Mode, DeviceMode> = { A: "wheels", B: "xy", C: "none" };
export type XyMsg = {
  t: "xy";
  seq: number;
  active: boolean; // false = その場で停止 (ホールド)
  estop: boolean; // true = 停止してドライバ無効化
  ttlMs: number; // この時間メッセージが来なければ停止
  x: number; // 目標座標 -1..1 (卓中心原点, 卓半径=1, +x=東, +y=南)
  y: number;
  x_mm: number; // 参考: TABLE_RADIUS_MM 換算
  y_mm: number;
  manual?: boolean; // POST /device/xy の手動ジョグ中
};
export type TurnDir = "right" | "left";
/** サーバー -> ESP32。payload が先頭キー。speed は 0..1 (ファームの SPEED/TURN_SPEED に対する倍率)、省略 = 1 */
export type DeviceWsMsg = { payload: MovePayload; speed?: number };
/** payload の無いフレームは旧ファームが無視する (IMU ビルドのみ解釈) */
export type DeviceWsCalib = { cmd: "calib"; id: number; dir: TurnDir; ms: number; speed: number };
export type DeviceWsOut = DeviceWsMsg | DeviceWsCalib;

// ESP32 -> サーバー (USE_IMU ビルドのみ送信。パースできないもの / 未知の t は無視)
export type DeviceHello = { t: "hello"; fw: string; imu: 0 | 1; boot: number; speedMax?: number; turnMax?: number };
export type DeviceImu = { t: "imu"; yaw: number; gz: number; ms: number }; // yaw: 起動時基準の相対方位 (時計回り+, 0..360)
export type DeviceCalibResult = { t: "calib"; id: number; dir: TurnDir; ms: number; deg: number; dps: number; ok: 0 | 1; err?: string };
export type D2S = DeviceHello | DeviceImu | DeviceCalibResult;

export type ImuView = {
  yawDeg: number; // 端末の相対 yaw
  offsetDeg: number; // 卓方位 = yaw + offset
  headingDeg: number; // 卓基準の絶対方位 (0=N 時計回り)
  rateDps: number;
  ageMs: number;
  fresh: boolean;
};
export type CalibState = {
  id: number;
  dir: TurnDir;
  durationMs: number;
  speed: number;
  via: "imu" | "manual";
  startedAt: number;
  state: "spinning" | "awaiting_measure" | "done" | "failed";
  measuredDeg?: number;
  turnRateDegPerSec?: number;
  err?: string;
};

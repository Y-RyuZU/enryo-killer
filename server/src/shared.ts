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
};
export const DEFAULT_PARAMS: Params = { maxSpeed: 0.08, gain: 2, decay: 0.8, tieMargin: 0.05, winRadius: 0.35 };

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
  me?: { playerId: string; seat: Seat | null; tension: number; status: Status };
};

// ===== WebSocket messages =====
export type C2S =
  | { t: "join"; playerId: string; name: string; seat: Seat }
  | { t: "leave" }
  | { t: "pull"; power: number } // 0..1 (ドラッグ量)
  | { t: "host"; cmd: "start" | "stop" | "estop" | "reset" | "release_estop" }
  | { t: "config"; mode?: Mode; params?: Partial<Params> };

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
export type DeviceWsMsg = { payload: MovePayload };

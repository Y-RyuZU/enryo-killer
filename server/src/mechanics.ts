// ===== ゲームルール (純関数): ひも切れ / 旋回ロック / 引っ張りクールタイム =====
// room.ts から呼ぶ。Date.now() は引数で受け取る (テストしやすいように副作用なし)
import type { MechEventView, Params, TurnDir } from "./shared";

/** これを超えたら「引いている」とみなす (ストロークの開始/終了判定) */
export const PULL_ON = 0.05;

export type SeatMech = {
  overSince: number | null; // snapPower 以上で引き続けている開始時刻
  snappedUntil: number; // > now なら ひもが切れている
  pulling: boolean; // いまストローク中か
  cooldownUntil: number; // > now なら 次の引っ張りはまだ無効
};
export const freshMech = (): SeatMech => ({ overSince: null, snappedUntil: 0, pulling: false, cooldownUntil: 0 });

export type PullResult = {
  mech: SeatMech;
  effective: number; // 実際に効く引く力 (切れてる/クールタイム中は 0)
  snapped: boolean; // この引っ張りで切れた
  restored: boolean; // この呼び出しで復活した
};

/** ひもの復活チェックだけ (tick から呼ぶ) */
export function restoreIfDue(m: SeatMech, now: number): { mech: SeatMech; restored: boolean } {
  if (m.snappedUntil > 0 && now >= m.snappedUntil) return { mech: { ...m, snappedUntil: 0, overSince: null, pulling: false }, restored: true };
  return { mech: m, restored: false };
}

/**
 * 1 回の pull 報告 (~8Hz) を処理。
 * - pull cooldown: ストローク (power > PULL_ON) を離した瞬間から pullCooldownMs の間は次のストロークが効かない
 * - snap: power >= snapPower を snapHoldMs 続けたら切れる。snapLeadMargin > 0 なら「他の席の最大より margin 以上強い」(1 人だけ突出) も条件
 *         切れたら snapRecoverMs の間その席は 0
 */
export function applyPull(m0: SeatMech, power: number, now: number, p: Params, othersMax = 0): PullResult {
  const r0 = restoreIfDue(m0, now);
  let m = r0.mech;
  const restored = r0.restored;
  power = Math.max(0, Math.min(1, Number(power) || 0));

  if (m.snappedUntil > now) return { mech: m, effective: 0, snapped: false, restored };

  const cdOn = (p.pullCooldownEnabled ?? 0) >= 0.5 && (p.pullCooldownMs ?? 0) > 0;
  if (power > PULL_ON) {
    if (!m.pulling) {
      if (cdOn && now < m.cooldownUntil) return { mech: m, effective: 0, snapped: false, restored }; // クールタイム中
      m = { ...m, pulling: true };
    }
  } else {
    if (m.pulling) m = { ...m, pulling: false, overSince: null, cooldownUntil: cdOn ? now + p.pullCooldownMs : 0 };
    return { mech: m, effective: power, snapped: false, restored };
  }

  if ((p.snapEnabled ?? 0) >= 0.5) {
    const tooHard = power >= p.snapPower && (!(p.snapLeadMargin > 0) || power - othersMax >= p.snapLeadMargin);
    if (tooHard) {
      const since = m.overSince ?? now;
      if (now - since >= Math.max(0, p.snapHoldMs)) {
        return {
          mech: { overSince: null, snappedUntil: now + Math.max(0, p.snapRecoverMs), pulling: false, cooldownUntil: 0 },
          effective: 0, snapped: true, restored,
        };
      }
      m = { ...m, overSince: since };
    } else if (m.overSince !== null) m = { ...m, overSince: null };
  }
  return { mech: m, effective: power, snapped: false, restored };
}

/** 旋回ロックの長さ。turnLockMs > 0 ならその値、0 なら自動 = 必要な旋回角 / turnRateDegPerSec (300..5000ms) */
export function turnLockDuration(p: Params, dhDeg: number): number {
  if ((p.turnLockMs ?? 0) > 0) return Math.round(p.turnLockMs);
  const rate = p.turnRateDegPerSec > 0 ? p.turnRateDegPerSec : 90;
  return Math.round(Math.max(300, Math.min(5000, (Math.abs(dhDeg) / rate) * 1000)));
}

/** 直前の payload から turn_* に「入った」ときだけロック開始 (回り続けている間は延長しない) */
export function turnLockStarts(prev: string | null, next: string): TurnDir | null {
  if (next !== "turn_right" && next !== "turn_left") return null;
  if (prev === next) return null;
  return next === "turn_right" ? "right" : "left";
}

export type MechEvent = MechEventView;

/** params の部分更新を検証して適用した新しい params を返す。未知キー / 数値でないものは errors へ */
export function mergeParams(cur: Params, patch: Record<string, unknown>, defaults: Params, ranges: Partial<Record<keyof Params, [number, number]>>): { params: Params; errors: string[] } {
  const out = { ...cur };
  const errors: string[] = [];
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!(k in defaults)) { errors.push(`unknown param: ${k}`); continue; }
    const n = typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : NaN;
    if (!isFinite(n)) { errors.push(`${k} must be a number`); continue; }
    const rg = ranges[k as keyof Params];
    (out as any)[k] = rg ? Math.max(rg[0], Math.min(rg[1], n)) : n;
  }
  return { params: out, errors };
}

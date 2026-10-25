import { useEffect, useRef, useState } from "react";
import { Phase, Plate, SEATS, SEAT_LABEL, Seat, Snapshot, roomFromUrl, useRoom } from "./api";
import "./stage.css";

// /stage — プレゼン用 プロジェクター/観戦画面 (読み取り専用・操作なし・16:9 全画面)
//   部屋は固定 ABCD (?room= で上書き)。/host や /sim と同じ viewer WS を購読するだけ。
//   ひも切れ / 旋回ロック / クールタイム (snap.mech) がサーバーにあれば表示 (無ければ無視)

const SEAT_XY: Record<Seat, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const SEAT_COLOR: Record<Seat, string> = { N: "#ff5a4e", E: "#ffd23f", S: "#4fd1ff", W: "#7dff8a" };

// 他ジョブ (ひも切れ等) の型が main に無くても壊れないよう、必要な形だけダックタイピングで読む
type MechSeat = { snapped?: boolean; snapRemainMs?: number; cooldownRemainMs?: number };
type Mech = { seats?: Partial<Record<Seat, MechSeat>>; turnLock?: { remainMs: number; durationMs: number; dir?: string } | null };
const mechOf = (snap: Snapshot): Mech | null => ((snap as any).mech as Mech | undefined) ?? null;

function resultant(snap: Snapshot) {
  let fx = 0, fy = 0;
  for (const s of SEATS) {
    const t = snap.seats[s]?.tension ?? 0;
    fx += SEAT_XY[s][0] * t;
    fy += SEAT_XY[s][1] * t;
  }
  const mag = Math.hypot(fx, fy);
  return { fx, fy, mag, moving: mag >= snap.params.tieMargin && mag > 0.02 };
}

function useSmoothPlate(target: Plate): Plate {
  const [p, setP] = useState(target);
  const tgt = useRef(target);
  tgt.current = target;
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setP((c) => {
        const t = tgt.current;
        const dh = ((((t.headingDeg - c.headingDeg) + 540) % 360) - 180);
        const k = 0.12;
        return { ...t, x: c.x + (t.x - c.x) * k, y: c.y + (t.y - c.y) * k, headingDeg: c.headingDeg + dh * k };
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return p;
}

/** 対戦経過時間 (サーバーに開始時刻が無いのでクライアントで playing への遷移を計測) + START 演出 */
function usePhaseClock(phase: Phase | undefined) {
  const [startAt, setStartAt] = useState<number | null>(null);
  const [endAt, setEndAt] = useState<number | null>(null);
  const [flashUntil, setFlashUntil] = useState(0);
  const prev = useRef<Phase | undefined>(undefined);
  const [, force] = useState(0);
  useEffect(() => {
    if (phase === prev.current) return;
    const now = Date.now();
    if (phase === "playing") {
      setStartAt(now); setEndAt(null);
      if (prev.current !== undefined) setFlashUntil(now + 1600);
    } else if (phase === "finished") {
      setEndAt(now);
    } else {
      setStartAt(null); setEndAt(null);
    }
    prev.current = phase;
  }, [phase]);
  useEffect(() => {
    const iv = window.setInterval(() => force((n) => n + 1), 200);
    return () => clearInterval(iv);
  }, []);
  const now = Date.now();
  const elapsed = startAt ? ((endAt ?? now) - startAt) / 1000 : null;
  return { elapsed, flashing: now < flashUntil };
}

const fmtTime = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

export function Stage() {
  const code = roomFromUrl();
  const { snap } = useRoom(code, "viewer");
  const clock = usePhaseClock(snap?.phase);
  useEffect(() => { document.title = `STAGE ${code} — 遠慮キラー`; }, [code]);

  return (
    <div className={`stg ${snap?.estop ? "stg-estop" : ""}`}>
      {snap ? <StageView snap={snap} elapsed={clock.elapsed} /> : <div className="stg-loading">接続中…</div>}
      {snap && clock.flashing && <div className="stg-overlay stg-start"><div>START!</div></div>}
      {snap && snap.phase === "finished" && <ResultOverlay snap={snap} elapsed={clock.elapsed} />}
      {snap?.estop && <div className="stg-estop-banner">緊急停止中</div>}
    </div>
  );
}

function ResultOverlay({ snap }: { snap: Snapshot; elapsed: number | null }) {
  const w = snap.winnerSeat;
  const p = w ? snap.seats[w] : undefined;
  return (
    <div className="stg-overlay stg-result">
      {w ? (
        <div className="stg-result-box" style={{ borderColor: SEAT_COLOR[w] }}>
          <div className="stg-result-sub">WINNER</div>
          <div className="stg-result-name" style={{ color: SEAT_COLOR[w] }}>{p?.name ?? SEAT_LABEL[w]}</div>
        </div>
      ) : (
        <div className="stg-result-box"><div className="stg-result-name">終了</div></div>
      )}
    </div>
  );
}

function StageView({ snap, elapsed }: { snap: Snapshot; elapsed: number | null }) {
  const [trail, setTrail] = useState<[number, number][]>([]);
  const lastTick = useRef(-1);
  useEffect(() => {
    if (snap.tick === 0) { setTrail([]); lastTick.current = 0; return; }
    if (snap.tick !== lastTick.current) {
      lastTick.current = snap.tick;
      setTrail((t) => [...t.slice(-200), [snap.plate.x, snap.plate.y]]);
    }
  }, [snap.tick, snap.plate.x, snap.plate.y]);

  const plate = useSmoothPlate(snap.plate);
  const r = resultant(snap);
  const mech = mechOf(snap);
  const arrowLen = Math.min(0.9, r.mag * 0.7);
  const ax = r.mag > 0 ? plate.x + (r.fx / r.mag) * arrowLen : plate.x;
  const ay = r.mag > 0 ? plate.y + (r.fy / r.mag) * arrowLen : plate.y;

  return (
    // 16:9 の viewBox。卓半径 = 1。どの画面サイズでも全体が収まる (meet)
    <svg className="stg-svg" viewBox="-3.2 -1.8 6.4 3.6" preserveAspectRatio="xMidYMid meet">
      <defs>
        <radialGradient id="stg-wood" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#9a6438" />
          <stop offset="100%" stopColor="#5b3820" />
        </radialGradient>
        <marker id="stg-arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="#ffffff" />
        </marker>
      </defs>

      {/* 左上: タイマーのみ */}
      <g transform="translate(-3.05 -1.52)">
        <text className="stg-timer" x="0" y="0.2">{elapsed != null ? fmtTime(elapsed) : ""}</text>
      </g>

      {/* 卓 */}
      <circle r="1.05" fill="url(#stg-wood)" stroke="#000" strokeWidth="0.04" />
      {[0.35, 0.7].map((rr) => <circle key={rr} r={rr} fill="none" stroke="#ffffff1c" strokeWidth="0.01" />)}
      {SEATS.map((s) => snap.seats[s] && (
        <circle key={s} cx={SEAT_XY[s][0]} cy={SEAT_XY[s][1]} r={snap.params.winRadius}
          fill={snap.winnerSeat === s ? `${SEAT_COLOR[s]}66` : `${SEAT_COLOR[s]}14`} stroke={`${SEAT_COLOR[s]}66`} strokeWidth="0.012" strokeDasharray="0.04 0.04" />
      ))}
      {trail.length > 1 && <polyline points={trail.map((p) => p.join(",")).join(" ")} fill="none" stroke="#ffe36e" strokeOpacity="0.7" strokeWidth="0.022" strokeLinecap="round" strokeLinejoin="round" />}

      {/* ひも (張力で太さ) */}
      {SEATS.map((s) => {
        const p = snap.seats[s];
        if (!p) return null;
        const t = p.tension ?? 0;
        const snapped = !!mech?.seats?.[s]?.snapped;
        const [x, y] = SEAT_XY[s];
        return <line key={s} x1={x * 1.05} y1={y * 1.05} x2={plate.x} y2={plate.y}
          stroke={snapped ? "#ff3b30" : SEAT_COLOR[s]} strokeWidth={0.008 + t * 0.05} strokeOpacity={snapped ? 0.5 : 0.35 + t * 0.6}
          strokeDasharray={snapped ? "0.05 0.05" : undefined} />;
      })}

      {/* 皿 */}
      <g transform={`translate(${plate.x} ${plate.y})`}>
        <g transform={`rotate(${plate.headingDeg})`}>
          <circle r="0.2" fill="#f6f1e7" stroke="#c9bfae" strokeWidth="0.015" />
          <circle r="0.155" fill="none" stroke="#2f5f8a" strokeWidth="0.01" strokeDasharray="0.02 0.025" />
          <path d="M-0.09 -0.03 C-0.1 -0.1 -0.02 -0.12 0.03 -0.1 C0.09 -0.11 0.12 -0.04 0.09 0.01 C0.12 0.07 0.05 0.11 0 0.1 C-0.06 0.12 -0.11 0.06 -0.09 -0.03 Z" fill="#c8731f" stroke="#8a4a12" strokeWidth="0.012" />
          {snap.mode === "A" && <path d="M0 -0.21 l0.07 -0.1 l-0.14 0 z" fill="#4fd1ff" stroke="#000" strokeWidth="0.008" />}
        </g>
      </g>
      {/* 合力の矢印 */}
      {r.moving && snap.phase === "playing" && (
        <line x1={plate.x} y1={plate.y} x2={ax} y2={ay} stroke="#ffffff" strokeWidth="0.05" strokeLinecap="round" markerEnd="url(#stg-arr)" />
      )}

      {/* 席パネル */}
      {SEATS.map((s) => <SeatPanel key={s} seat={s} snap={snap} mech={mech} />)}

      {snap.phase === "lobby" && (
        <g>
          <rect x="-0.85" y="-0.15" width="1.7" height="0.3" rx="0.06" fill="#000000aa" />
          <text className="stg-banner" y="0.07" textAnchor="middle">まもなく開始</text>
        </g>
      )}
    </svg>
  );
}

// 席の位置: 北/南は卓の上下の帯、東/西は左右の大きな枠
const PANEL: Record<Seat, { x: number; y: number; w: number; h: number }> = {
  N: { x: -1.0, y: -1.78, w: 2.0, h: 0.66 },
  S: { x: -1.0, y: 1.12, w: 2.0, h: 0.66 },
  E: { x: 1.3, y: -0.62, w: 1.8, h: 1.24 },
  W: { x: -3.1, y: -0.62, w: 1.8, h: 1.24 },
};

function SeatPanel({ seat, snap, mech }: { seat: Seat; snap: Snapshot; mech: Mech | null }) {
  const p = snap.seats[seat];
  const b = PANEL[seat];
  const t = Math.min(1, Math.max(0, p?.tension ?? 0));
  const col = SEAT_COLOR[seat];
  const lead = snap.phase === "playing" && snap.leaderSeat === seat;
  const win = snap.winnerSeat === seat;
  const m = mech?.seats?.[seat];
  const snapped = !!m?.snapped;
  const big = seat === "E" || seat === "W";
  const pad = 0.06;
  const barH = big ? 0.22 : 0.13;
  const barY = b.y + b.h - pad - barH;
  return (
    <g opacity={p ? 1 : 0.45}>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="0.06"
        fill={lead || win ? `${col}33` : "#120d0a"} stroke={lead || win ? col : "#4a3a2e"} strokeWidth={lead || win ? 0.03 : 0.015} />
      <text className="stg-seat-dir" x={b.x + pad} y={b.y + (big ? 0.22 : 0.19)} fill={col}>{SEAT_LABEL[seat]}</text>
      <text className={`stg-seat-name ${big ? "big" : ""}`} x={b.x + pad} y={b.y + (big ? 0.6 : 0.39)}>{p ? clip(p.name, big ? 9 : 12) : ""}</text>
      {p && <>
        <rect x={b.x + pad} y={barY} width={b.w - pad * 2 - (big ? 0 : 0.42)} height={barH} rx={barH / 2} fill="#ffffff1a" />
        <rect x={b.x + pad} y={barY} width={(b.w - pad * 2) * t} height={barH} rx={barH / 2} fill={snapped ? "#ff3b30" : col} />
      </>}
    </g>
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

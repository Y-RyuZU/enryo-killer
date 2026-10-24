// Plan B フォールバック「人間磁石」画面: /magnet?room=XXXX
// テーブルの下の人がスマホを見ながら磁石を手で動かす。皿の目標位置 (サーバーの plate x,y) と進む方向を大きく表示。
import { useEffect, useRef, useState } from "react";
import { SEATS, SEAT_LABEL, Seat, Snapshot, useRoom } from "./api";
import "./magnet.css";

const SEAT_XY: Record<Seat, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
type View = { mirror: boolean; rot: 0 | 90 | 180 | 270 };

/** 卓座標 -> 画面座標 (回転 + 左右反転)。文字は回さず位置だけ変換するので読める */
function tf(v: View, x: number, y: number): [number, number] {
  let [a, b] = [x, y];
  for (let i = 0; i < v.rot / 90; i++) [a, b] = [-b, a]; // 90° 時計回り
  if (v.mirror) a = -a;
  return [a, b];
}

function loadView(): View {
  try { return { mirror: true, rot: 0, ...JSON.parse(localStorage.getItem("enryo.magnetView") ?? "{}") }; } catch { return { mirror: true, rot: 0 }; }
}

export function Magnet() {
  const qs = new URLSearchParams(location.search);
  const [code, setCode] = useState<string | null>(qs.get("room")?.toUpperCase() ?? null);
  const [input, setInput] = useState("");
  const { snap, connected } = useRoom(code, "viewer");
  const [view, setView] = useState<View>(loadView);
  useEffect(() => { localStorage.setItem("enryo.magnetView", JSON.stringify(view)); }, [view]);

  // 画面スリープ防止
  useEffect(() => {
    let lock: any = null;
    const req = async () => { try { lock = await (navigator as any).wakeLock?.request("screen"); } catch {} };
    req();
    const onVis = () => document.visibilityState === "visible" && req();
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); lock?.release?.(); };
  }, []);

  if (!code) {
    return (
      <div className="mg-join">
        <h1>人間磁石モード</h1>
        <p>テーブルの下で磁石を動かす人用の画面</p>
        <input value={input} onChange={(e) => setInput(e.target.value.toUpperCase())} placeholder="部屋コード" maxLength={8} />
        <button className="btn primary big" disabled={!input} onClick={() => { history.replaceState(null, "", `/magnet?room=${input}`); setCode(input); }}>はじめる</button>
      </div>
    );
  }
  return (
    <div className={`mg ${snap?.estop ? "estop" : ""}`}>
      <div className="mg-top">
        <span className={`dot ${connected ? "on" : ""}`} />
        <b>{code}</b>
        <button className={view.mirror ? "on" : ""} onClick={() => setView({ ...view, mirror: !view.mirror })}>左右反転 {view.mirror ? "ON" : "OFF"}</button>
        <button onClick={() => setView({ ...view, rot: (((view.rot + 90) % 360) as View["rot"]) })}>回転 {view.rot}°</button>
      </div>
      {snap ? <Board snap={snap} view={view} /> : <div className="mg-msg">接続中…</div>}
    </div>
  );
}

function Board({ snap, view }: { snap: Snapshot; view: View }) {
  const { plate, leaderSeat, phase, estop } = snap;
  const moving = phase === "playing" && !!leaderSeat && !estop && plate.speed > 0;
  const [px, py] = tf(view, plate.x, plate.y);
  let arrow: [number, number] | null = null;
  if (moving && leaderSeat) {
    const [sx, sy] = tf(view, ...SEAT_XY[leaderSeat]);
    const d = Math.hypot(sx - px, sy - py) || 1;
    arrow = [(sx - px) / d, (sy - py) / d];
  }
  // 動き出し / 方向転換でバイブ
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const key = moving ? leaderSeat : null;
    if (key !== prev.current) {
      try { navigator.vibrate?.(key ? [120] : [60, 60, 60]); } catch {}
      prev.current = key;
    }
  }, [moving, leaderSeat]);

  const angle = arrow ? (Math.atan2(arrow[0], -arrow[1]) * 180) / Math.PI : 0;
  let headline = "そのまま";
  let sub = "磁石を ● の位置にキープ";
  if (estop) { headline = "緊急停止"; sub = "手を止めて"; }
  else if (phase === "lobby") { headline = "待機中"; sub = "● (中央) に磁石を置いて待つ"; }
  else if (phase === "finished") { headline = "決着！"; sub = snap.winnerSeat ? `${SEAT_LABEL[snap.winnerSeat]} の勝ち` : ""; }
  else if (moving && leaderSeat) { headline = `${SEAT_LABEL[leaderSeat]}へ`; sub = `速さ ${Math.round(plate.speed * 100)}%`; }

  return (
    <div className="mg-body">
      <div className="mg-head">
        <div className="mg-arrow" style={{ opacity: arrow ? 1 : 0.15, transform: `rotate(${angle}deg)` }}>{arrow ? "⬆" : "●"}</div>
        <div>
          <div className="mg-headline">{headline}</div>
          <div className="mg-sub">{sub}</div>
        </div>
      </div>
      <svg className="mg-board" viewBox="-1.45 -1.45 2.9 2.9">
        <circle r="1" fill="#5b3820" stroke="#2c1a0e" strokeWidth="0.04" />
        {[0.25, 0.5, 0.75].map((r) => <circle key={r} r={r} fill="none" stroke="#ffffff22" strokeWidth="0.008" />)}
        {SEATS.map((s) => {
          const [x, y] = tf(view, ...SEAT_XY[s]);
          const p = snap.seats[s];
          const lead = leaderSeat === s && moving;
          return (
            <g key={s} transform={`translate(${x * 1.22} ${y * 1.22})`}>
              <circle r="0.19" fill={lead ? "#e8443a" : p ? "#3a2a1d" : "#1a1512"} stroke={lead ? "#ffb3ad" : "#a0703f"} strokeWidth="0.02" />
              <text y="0.07" textAnchor="middle" fontSize="0.2" fontWeight="800" fill="#f3e9da">{SEAT_LABEL[s]}</text>
            </g>
          );
        })}
        {arrow && (
          <line x1={px} y1={py} x2={px + arrow[0] * 0.55} y2={py + arrow[1] * 0.55} stroke="#f2d649" strokeWidth="0.09" strokeLinecap="round" markerEnd="url(#mgarr)" />
        )}
        <defs>
          <marker id="mgarr" viewBox="0 0 10 10" refX="3" refY="5" markerWidth="2.2" markerHeight="2.2" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" fill="#f2d649" />
          </marker>
        </defs>
        <circle cx={px} cy={py} r="0.13" fill="#e8443a" stroke="#fff" strokeWidth="0.03" className={moving ? "mg-pulse" : ""} />
      </svg>
      <div className="mg-foot">目標 x={plate.x.toFixed(2)} y={plate.y.toFixed(2)} · {snap.deviceMode ?? snap.mode}{view.mirror ? " · 下から見上げ用に左右反転中" : ""}</div>
    </div>
  );
}

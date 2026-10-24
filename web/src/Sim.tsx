import { useEffect, useRef, useState } from "react";
import { Mode, Params, Plate, SEATS, SEAT_LABEL, Seat, Snapshot, createRoom, useRoom } from "./api";

const SEAT_XY: Record<Seat, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const MODES: { m: Mode; label: string; desc: string }[] = [
  { m: "A", label: "A タイヤロボ", desc: "ESP32が方向+速度をポーリング" },
  { m: "B", label: "B 磁石XY", desc: "XY装置が目標座標をポーリング" },
  { m: "C", label: "C バーチャル皿", desc: "この画面の皿だけ動く" },
];
const SLIDERS: { k: keyof Params; label: string; min: number; max: number; step: number }[] = [
  { k: "maxSpeed", label: "最大速度 (卓半径/秒)", min: 0.01, max: 0.5, step: 0.01 },
  { k: "gain", label: "差→速度ゲイン", min: 0.2, max: 6, step: 0.1 },
  { k: "decay", label: "張力の粘り (減衰)", min: 0.3, max: 0.98, step: 0.01 },
  { k: "tieMargin", label: "拮抗とみなす差", min: 0, max: 0.3, step: 0.01 },
  { k: "winRadius", label: "決着距離", min: 0.1, max: 0.7, step: 0.01 },
];

export function Sim() {
  const qs = new URLSearchParams(location.search);
  const [code, setCode] = useState<string | null>(qs.get("room")?.toUpperCase() ?? null);
  const { snap, connected, send } = useRoom(code, "viewer");

  const newRoom = async () => {
    const c = await createRoom();
    history.replaceState(null, "", `/sim?room=${c}`);
    setCode(c);
  };

  if (!code) {
    return (
      <div className="sim-empty">
        <h1>遠慮の塊 解消マシン — シミュレーター</h1>
        <button className="btn primary big" onClick={newRoom}>部屋をつくる</button>
      </div>
    );
  }
  const joinUrl = `${location.origin}/?room=${code}`;
  return (
    <div className="sim">
      <main className="sim-main">
        <div className="sim-head">
          <h1>遠慮の塊 解消マシン <span>シミュレーター / 観戦</span></h1>
          <div className={`conn ${connected ? "on" : ""}`}>{connected ? "接続中" : "未接続"}</div>
        </div>
        {snap ? <Table snap={snap} /> : <div className="loading">読み込み中…</div>}
      </main>
      <aside className="sim-side">
        <section className="card room">
          <div className="label">部屋コード</div>
          <div className="code">{code}</div>
          <div className="url">{joinUrl}</div>
        </section>
        {snap && <Host snap={snap} send={send} />}
      </aside>
    </div>
  );
}

function Table({ snap }: { snap: Snapshot }) {
  // 軌跡 (クライアント側だけで保持)
  const [trail, setTrail] = useState<[number, number][]>([]);
  const lastTick = useRef(-1);
  useEffect(() => {
    if (snap.tick === 0) { setTrail([]); lastTick.current = 0; return; }
    if (snap.tick !== lastTick.current) {
      lastTick.current = snap.tick;
      setTrail((t) => [...t.slice(-80), [snap.plate.x, snap.plate.y]]);
    }
  }, [snap.tick, snap.plate.x, snap.plate.y]);

  const { leaderSeat, winnerSeat } = snap;
  const plate = useSmooth(snap.plate); // 2Hz の状態を 60fps で補間
  const leaderXY = leaderSeat ? SEAT_XY[leaderSeat] : null;
  return (
    <svg className="table-svg" viewBox="-1.55 -1.55 3.1 3.1">
      <defs>
        <radialGradient id="wood" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#8a5a34" />
          <stop offset="100%" stopColor="#5b3820" />
        </radialGradient>
        <marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="#e8443a" />
        </marker>
      </defs>
      <circle r="1.05" fill="url(#wood)" stroke="#2c1a0e" strokeWidth="0.04" />
      {[0.35, 0.7].map((r) => <circle key={r} r={r} fill="none" stroke="#ffffff14" strokeWidth="0.01" />)}
      <line x1="-1.05" y1="0" x2="1.05" y2="0" stroke="#ffffff10" strokeWidth="0.01" />
      <line x1="0" y1="-1.05" x2="0" y2="1.05" stroke="#ffffff10" strokeWidth="0.01" />
      {/* 決着ゾーン */}
      {SEATS.map((s) => snap.seats[s] && (
        <circle key={s} cx={SEAT_XY[s][0]} cy={SEAT_XY[s][1]} r={snap.params.winRadius}
          fill={winnerSeat === s ? "#e8443a55" : "#ffffff0a"} stroke="#ffffff22" strokeWidth="0.008" strokeDasharray="0.03 0.03" />
      ))}
      {trail.length > 1 && <polyline points={trail.map((p) => p.join(",")).join(" ")} fill="none" stroke="#f2d64988" strokeWidth="0.015" strokeLinecap="round" />}
      {leaderXY && (
        <line x1={plate.x} y1={plate.y} x2={plate.x + (leaderXY[0] - plate.x) * 0.45} y2={plate.y + (leaderXY[1] - plate.y) * 0.45}
          stroke="#e8443a" strokeWidth="0.03" markerEnd="url(#arr)" />
      )}
      {/* 席 + 張力バー */}
      {SEATS.map((s) => {
        const p = snap.seats[s];
        const [x, y] = SEAT_XY[s];
        const lx = x * 1.3, ly = y * 1.3;
        const t = p?.tension ?? 0;
        const isLead = leaderSeat === s;
        return (
          <g key={s}>
            {p && <line x1={x * 1.05} y1={y * 1.05} x2={plate.x} y2={plate.y} stroke="#c9a36a" strokeWidth={0.005 + t * 0.035} strokeOpacity={0.25 + t * 0.6} />}
            <g transform={`translate(${lx} ${ly})`}>
              <rect x="-0.27" y="-0.15" width="0.54" height="0.3" rx="0.05"
                fill={p ? (isLead ? "#e8443a" : "#2a211b") : "#1a1512"} stroke={isLead ? "#ffb3ad" : "#5a4a3c"} strokeWidth="0.012" />
              <text y="-0.04" textAnchor="middle" className="seat-dir">{SEAT_LABEL[s]}</text>
              <text y="0.06" textAnchor="middle" className="seat-name">{p ? p.name : "空席"}</text>
              {p && <rect x="-0.22" y="0.09" width="0.44" height="0.03" rx="0.015" fill="#00000066" />}
              {p && <rect x="-0.22" y="0.09" width={0.44 * Math.min(1, t)} height="0.03" rx="0.015" fill="#f2d649" />}
            </g>
          </g>
        );
      })}
      {/* 皿 */}
      <g transform={`translate(${plate.x} ${plate.y})`}>
        <g transform={`rotate(${plate.headingDeg})`}>
          <circle r="0.2" fill="#f6f1e7" stroke="#c9bfae" strokeWidth="0.015" />
          <circle r="0.155" fill="none" stroke="#2f5f8a" strokeWidth="0.01" strokeDasharray="0.02 0.025" />
          <path d="M-0.09 -0.03 C-0.1 -0.1 -0.02 -0.12 0.03 -0.1 C0.09 -0.11 0.12 -0.04 0.09 0.01 C0.12 0.07 0.05 0.11 0 0.1 C-0.06 0.12 -0.11 0.06 -0.09 -0.03 Z" fill="#c8731f" stroke="#8a4a12" strokeWidth="0.012" />
          {snap.mode === "A" && <path d="M0 -0.2 l0.04 -0.06 l-0.08 0 z" fill="#2f5f8a" />}
        </g>
      </g>
      {snap.phase === "finished" && winnerSeat && (
        <g>
          <rect x="-0.9" y="-0.2" width="1.8" height="0.4" rx="0.08" fill="#000000cc" />
          <text y="0.06" textAnchor="middle" className="win-text">{SEAT_LABEL[winnerSeat]}・{snap.seats[winnerSeat]?.name} の勝ち！</text>
        </g>
      )}
      {snap.estop && <text y="-1.4" textAnchor="middle" className="estop-text">緊急停止中</text>}
    </svg>
  );
}

function useSmooth(target: Plate): Plate {
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

function Host({ snap, send }: { snap: Snapshot; send: (m: any) => void }) {
  const host = (cmd: string) => send({ t: "host", cmd });
  const phaseLabel = { lobby: "待機中", playing: "対戦中", finished: "決着" }[snap.phase];
  return (
    <>
      <section className="card">
        <div className="row between">
          <div className="label">ゲーム</div>
          <div className={`phase ${snap.phase}`}>{phaseLabel} · tick {snap.tick}</div>
        </div>
        <div className="btns">
          <button className="btn primary" disabled={snap.estop || snap.phase === "playing"} onClick={() => host("start")}>開始</button>
          <button className="btn" disabled={snap.phase !== "playing"} onClick={() => host("stop")}>停止</button>
          <button className="btn" onClick={() => host("reset")}>リセット</button>
        </div>
        {snap.estop
          ? <button className="btn estop-btn released" onClick={() => host("release_estop")}>緊急停止を解除</button>
          : <button className="btn estop-btn" onClick={() => host("estop")}>緊急停止</button>}
      </section>
      <section className="card">
        <div className="label">出力モード</div>
        <div className="modes">
          {MODES.map(({ m, label, desc }) => (
            <button key={m} className={`mode ${snap.mode === m ? "sel" : ""}`} onClick={() => send({ t: "config", mode: m })}>
              <b>{label}</b><small>{desc}</small>
            </button>
          ))}
        </div>
        <div className="device">
          <span className={`dot ${snap.deviceOnline ? "on" : ""}`} /> デバイス {snap.deviceOnline ? "オンライン" : "未接続"}
          {!!snap.deviceWsCount && <> (ESP32 WS×{snap.deviceWsCount}) </>}
          {snap.devicePayload && <code>{JSON.stringify({ payload: snap.devicePayload })}</code>}
          {snap.lastDevice && <code>{JSON.stringify(snap.lastDevice)}</code>}
          <a href="/api/docs" target="_blank" rel="noreferrer">API (Swagger)</a>
        </div>
      </section>
      <section className="card">
        <div className="label">係数チューニング</div>
        {SLIDERS.map(({ k, label, min, max, step }) => (
          <label key={k} className="slider">
            <span>{label}<b>{snap.params[k]}</b></span>
            <input type="range" min={min} max={max} step={step} value={snap.params[k]}
              onChange={(e) => send({ t: "config", params: { [k]: Number(e.target.value) } })} />
          </label>
        ))}
      </section>
    </>
  );
}

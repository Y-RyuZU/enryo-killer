import { useEffect, useRef, useState } from "react";
import { SEATS, SEAT_LABEL, Seat, Snapshot, getPlayerId, sanitizeCode, secs, useNowSince, useRoom } from "./api";
import { Karaage } from "./Karaage";

const NAMES = ["からあげ太郎", "遠慮さん", "最後の一個", "レモン派", "マヨ派", "渋い人"];

export function Mobile() {
  // QR (?room=XXXX) から来たらそれを最優先。保存済みの部屋より勝つ
  const [code, setCode] = useState(() => {
    const urlRoom = sanitizeCode(new URLSearchParams(location.search).get("room"));
    return urlRoom || sanitizeCode(localStorage.getItem("enryo.room"));
  });
  const [name, setName] = useState(localStorage.getItem("enryo.name") ?? NAMES[Math.floor(Math.random() * NAMES.length)]);
  const playerId = useState(getPlayerId)[0];
  const active = code.length >= 4 ? code : null;
  const { snap, connected, error, send } = useRoom(active, "player", playerId);
  const mySeat = snap?.me?.seat ?? null;

  useEffect(() => { if (active) localStorage.setItem("enryo.room", active); }, [active]);
  useEffect(() => { localStorage.setItem("enryo.name", name); }, [name]);
  // ?room は一度読んだら URL から消す (リロードで古いコードに戻らないように)
  useEffect(() => {
    const qs = new URLSearchParams(location.search);
    if (!qs.has("room")) return;
    qs.delete("room");
    const rest = qs.toString();
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
  }, []);

  if (snap && mySeat) return <Rope snap={snap} seat={mySeat} send={send} connected={connected} />;

  const pick = (seat: Seat) => send({ t: "join", playerId, name, seat });
  return (
    <div className="m-screen join">
      <header className="brand">
        <div className="brand-sub">関西の「遠慮の塊」を解消する</div>
        <h1>遠慮の塊<br />解消マシン</h1>
      </header>
      <label className="field">
        <span>部屋コード</span>
        <input value={code} maxLength={8} inputMode="text" autoCapitalize="characters" placeholder="ABCD"
          onChange={(e) => setCode(sanitizeCode(e.target.value))} />
      </label>
      <label className="field">
        <span>なまえ</span>
        <input value={name} maxLength={16} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="seat-title">
        席をえらぶ {active && <span className={`dot ${connected ? "on" : ""}`} />}
      </div>
      <div className="seat-picker">
        <div className="mini-table"><Karaage size={56} /></div>
        {SEATS.map((s) => {
          const taken = snap?.seats[s];
          return (
            <button key={s} className={`seat-btn seat-${s} ${taken ? "taken" : ""}`} disabled={!snap || !!taken} onClick={() => pick(s)}>
              <b>{SEAT_LABEL[s]}</b>
              <small>{taken ? taken.name : "空いてる"}</small>
            </button>
          );
        })}
      </div>
      <p className="hint">{!active ? "PC画面のQRを読むか、4文字のコードを入れてね" : !snap ? "接続中…" : "テーブルで自分が座ってる方角をタップ"}</p>
      {error && <div className="toast">{error}</div>}
    </div>
  );
}

const MAX_DRAG = 260; // viewBox単位: これだけ引いたら power=1

export function Rope({ snap, seat, send, connected, title, onTitleClick }: { snap: Snapshot; seat: Seat; send: (m: any) => void; connected: boolean; title?: string; onTitleClick?: () => void }) {
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const power = Math.min(1, drag / MAX_DRAG);
  const powerRef = useRef(0);
  powerRef.current = power;

  // 引っ張り値を ~8Hz で送信 (離したら 0)
  useEffect(() => {
    const id = setInterval(() => send({ t: "pull", power: powerRef.current }), 125);
    return () => clearInterval(id);
  }, [send]);

  const svgRef = useRef<SVGSVGElement>(null);
  const unit = () => { // px -> viewBox 単位
    const r = svgRef.current!.getBoundingClientRect();
    return Math.min(r.width / 200, r.height / 640) || 1;
  };
  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    start.current = e.clientY - drag * unit();
  };
  const onMove = (e: React.PointerEvent) => {
    if (start.current === null) return;
    setDrag(Math.max(0, Math.min(MAX_DRAG, (e.clientY - start.current) / unit())));
  };
  const onUp = () => { start.current = null; setDrag(0); };

  const me = snap.me!;
  const status = snap.phase !== "playing" ? "waiting" : me.status;
  const statusText = { waiting: snap.phase === "lobby" ? "待機中…" : snap.phase === "playing" ? "拮抗中…" : "決着", winning: "勝ってる！", losing: "負けてる…" }[status];
  const handleY = 300 + drag;
  const shake = power > 0.6 ? (Math.random() - 0.5) * power * 6 : 0;
  // ゲームルール: ひも切れ / 旋回ロック / クールタイム
  const left = useNowSince(snap);
  const mm = snap.phase === "playing" ? snap.mech?.seats[seat] : undefined;
  const snapLeft = mm?.snapped ? left(mm.snapRemainMs) : 0;
  const snapped = snapLeft > 0;
  const turnLeft = snap.phase === "playing" ? left(snap.mech?.turnLock?.remainMs) : 0;
  const turning = turnLeft > 0;
  const cdLeft = left(mm?.cooldownRemainMs);
  const cooling = !snapped && !turning && cdLeft > 0;

  return (
    <div className={`m-screen rope-screen st-${status} ${snapped ? "is-snapped" : ""} ${turning ? "is-turning" : ""}`}>
      {/* 上部のチップ・ミニマップ・状態ピルは非表示 (デザイン指示) / クールタイム表記・引きすぎ警告もスマホでは出さない */}
      {snapped ? (
        <div className="mech-banner snapped">✂ ひもが切れた！<b>復活まで {secs(snapLeft)}s</b></div>
      ) : turning ? (
        <div className="mech-banner turning">↻ 旋回中… <b>いまは引けない</b></div>
      ) : null}

      <svg ref={svgRef} className="rope-svg" viewBox="0 0 200 640" preserveAspectRatio="xMidYMin meet"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <defs>
          <pattern id="twist" width="10" height="14" patternUnits="userSpaceOnUse" patternTransform={`translate(0 ${drag}) rotate(-35)`}>
            <rect width="10" height="14" fill="#b88a4a" />
            <rect width="10" height="5" fill="#8a5f2c" />
          </pattern>
        </defs>
        {/* 上端の留め具は無し: 画面の外 (上) から紐が垂れてくる見せ方 */}
        {snapped ? (
          <>
            <path d="M100 -40 L 96 150 L 104 165" stroke="url(#twist)" strokeWidth="12" fill="none" strokeLinecap="round" />
            <path d={`M104 210 L 98 222 L ${100 + shake / 2} ${handleY}`} stroke="url(#twist)" strokeWidth="12" fill="none" strokeLinecap="round" opacity="0.55" />
            <text x="100" y="196" textAnchor="middle" fontSize="34">✂</text>
          </>
        ) : (
          <path d={`M100 -40 Q ${100 + shake} ${(-40 + handleY) / 2} ${100 + shake / 2} ${handleY}`} stroke="url(#twist)" strokeWidth="12" fill="none" strokeLinecap="round" />
        )}
        {/* 紐の先端: 輪っかは無し、茶色の結び目だけ */}
        <g transform={`translate(${100 + shake / 2} ${handleY})`} style={{ cursor: "grab" }} opacity={snapped ? 0.55 : 1}>
          <g transform="translate(0 4)">
            <rect x="-9" y="-9" width="18" height="18" rx="5" fill="#8a5f2c" transform="rotate(45)" />
            <path d="M-7 -5 L 7 3 M-7 1 L 7 9" stroke="#5c3d1b" strokeWidth="2.5" strokeLinecap="round" />
          </g>
          <circle cy="4" r="44" fill="transparent" />
        </g>
        {/* 「こっそり引っ張る」ヒントは非表示 (デザイン指示) */}
      </svg>

      <div className={`gauge ${snapped || turning || cooling ? "off" : ""}`}><div className="gauge-fill" style={{ width: `${power * 100}%` }} /><span>引く力 {Math.round(power * 100)}%{snapped ? "（切れてる）" : turning ? "（旋回中）" : ""}</span></div>

      {/* 負けた側の「取られた…」画面は無し (ゲームの趣旨と違うのでデザイン指示で削除)。勝った人だけ結果を出す */}
      {snap.phase === "finished" && snap.winnerSeat === seat && (
        <div className="overlay">
          <div className="result-card">
            {/* ゲット画面: 唐揚げイラストと見出しは無し、「今なら食べれそう！」だけ (デザイン指示) */}
            <h2>今なら<br />食べれそう！</h2>
            <small>ホストが次のゲームを始めるのを待ってね</small>
          </div>
        </div>
      )}
      {snap.estop && <div className="overlay estop"><h2>緊急停止中</h2></div>}
    </div>
  );
}

// 自分の席を下にした小さな卓マップ (皿の位置は物理的に見えるので見せてOK)
function MiniMap({ snap, seat }: { snap: Snapshot; seat: Seat }) {
  const rot = { S: 0, W: -90, N: 180, E: 90 }[seat];
  return (
    <svg viewBox="-1.3 -1.3 2.6 2.6" className="minimap">
      <g transform={`rotate(${rot})`}>
        <circle r="1.05" fill="#6b4426" stroke="#3b2414" strokeWidth="0.08" />
        {SEATS.map((s) => {
          const p = { N: [0, -1.18], E: [1.18, 0], S: [0, 1.18], W: [-1.18, 0] }[s];
          return <circle key={s} cx={p[0]} cy={p[1]} r="0.12" fill={s === seat ? "#e8443a" : snap.seats[s] ? "#d9c7a3" : "#555"} />;
        })}
        <circle cx={snap.plate.x} cy={snap.plate.y} r="0.22" fill="#f4efe6" style={{ transition: "all 0.5s linear" }} />
        <circle cx={snap.plate.x} cy={snap.plate.y} r="0.11" fill="#c8731f" style={{ transition: "all 0.5s linear" }} />
      </g>
    </svg>
  );
}

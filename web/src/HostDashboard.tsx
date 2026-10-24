import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEMO_ROOM, MovePayload, Mode, Params, SEATS, SEAT_LABEL, SEAT_LETTER, Seat, Snapshot,
  hostUrl, kickSeat, roomApi, roomFromUrl, seatTitle, seatUrl, useBot, useRoom, useNowSince, secs, DEFAULT_PARAMS,
} from "./api";
import { Table } from "./Sim";
import { JoinQR, JoinQROverlay } from "./JoinQR";

// ===== デモ用 ホスト/管理ダッシュボード (/host) =====
// 目的: ハッカソンのデモ中に「いま何が起きているか」を人間が一目で分かる + その場で操作/テスト/デバッグできる
// サーバーは既存 API だけ使う (WS: host/config, REST: device/cmd, device/xy, estop)。イベントログはスナップショットの差分から作る

const SEAT_VEC: Record<Seat, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const MODES: { m: Mode; label: string; desc: string }[] = [
  { m: "A", label: "A タイヤロボ", desc: "ESP32 に forward/turn を送る" },
  { m: "B", label: "B 磁石XY", desc: "ESP32 に目標座標 {x,y}" },
  { m: "C", label: "C バーチャル", desc: "画面だけ (デバイス停止)" },
];
const SLIDERS: { k: keyof Params; label: string; min: number; max: number; step: number }[] = [
  { k: "maxSpeed", label: "最大速度", min: 0.01, max: 0.5, step: 0.01 },
  { k: "gain", label: "合力→速度ゲイン", min: 0.2, max: 6, step: 0.1 },
  { k: "decay", label: "張力の粘り", min: 0.3, max: 0.98, step: 0.01 },
  { k: "tieMargin", label: "拮抗しきい値", min: 0, max: 0.3, step: 0.01 },
  { k: "winRadius", label: "決着距離", min: 0.1, max: 0.7, step: 0.01 },
  { k: "turnRateDegPerSec", label: "実機の旋回速度 (deg/s)", min: 10, max: 360, step: 1 },
  { k: "speedOut", label: "自動走行に speed を付ける (0/1)", min: 0, max: 1, step: 1 },
  { k: "minSpeedOut", label: "speed 下限", min: 0, max: 1, step: 0.05 },
  { k: "imuBlend", label: "IMU 方位の信頼度", min: 0, max: 1, step: 0.05 },
];
const PAYLOAD_VIEW: Record<MovePayload, { icon: string; label: string }> = {
  forward: { icon: "⬆", label: "前進" },
  backward: { icon: "⬇", label: "後退" },
  turn_right: { icon: "↻", label: "右旋回" },
  turn_left: { icon: "↺", label: "左旋回" },
  stop: { icon: "■", label: "停止" },
};
const PHASE_LABEL = { lobby: "待機中", playing: "対戦中", finished: "決着" } as const;

type LogItem = { id: number; at: number; kind: "info" | "game" | "device" | "warn" | "host" | "rule"; text: string };
const hhmmss = (t: number) => new Date(t).toLocaleTimeString("ja-JP", { hour12: false });
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** 各席の張力ベクトルの合力 (server/logic.ts step() と同じ計算) */
function resultant(snap: Snapshot) {
  let fx = 0, fy = 0;
  for (const s of SEATS) {
    const t = snap.seats[s]?.tension ?? 0;
    fx += SEAT_VEC[s][0] * t;
    fy += SEAT_VEC[s][1] * t;
  }
  const mag = Math.hypot(fx, fy);
  const dirDeg = ((Math.atan2(fx, -fy) * 180) / Math.PI + 360) % 360; // 0=北(A) 時計回り
  return { fx, fy, mag, dirDeg, moving: mag >= snap.params.tieMargin && mag > 0.02 };
}

// ---------- イベントログ (スナップショット差分 + ホスト操作) ----------
function useEventLog(snap: Snapshot | null, connected: boolean) {
  const [items, setItems] = useState<LogItem[]>([]);
  const seq = useRef(0);
  const add = useCallback((kind: LogItem["kind"], text: string) => {
    setItems((xs) => [{ id: ++seq.current, at: Date.now(), kind, text }, ...xs].slice(0, 300));
  }, []);
  const prev = useRef<Snapshot | null>(null);
  const prevConn = useRef<boolean | null>(null);
  const lastMechId = useRef<number | null>(null);

  useEffect(() => {
    // prevConn: null = まだ一度も繋がっていない
    if (prevConn.current === null) { if (connected) { add("info", "サーバーに接続"); prevConn.current = true; } return; }
    if (prevConn.current !== connected) add(connected ? "info" : "warn", connected ? "サーバーに再接続" : "サーバーとの接続が切れた (再接続中…)");
    prevConn.current = connected;
  }, [connected, add]);

  useEffect(() => {
    if (!snap) return;
    const p = prev.current;
    prev.current = snap;
    // ルールイベント (ひも切れ / 復活 / 旋回ロック) はサーバーの id 付きリストから。初回は既存分をスキップ
    const evs = snap.mech?.events ?? [];
    if (lastMechId.current === null) lastMechId.current = evs.length ? evs[evs.length - 1].id : 0;
    else {
      if (evs.length && evs[evs.length - 1].id < lastMechId.current) lastMechId.current = 0; // サーバー再起動
      for (const e of evs) {
        if (e.id <= lastMechId.current) continue;
        lastMechId.current = e.id;
        const who = e.seat ? `${seatTitle(e.seat)} ${snap.seats[e.seat]?.name ?? ""}` : "";
        if (e.kind === "snap") add("rule", `✂ ${who} のひもが切れた！ (${((e.durationMs ?? 0) / 1000).toFixed(1)}秒で復活)`);
        else if (e.kind === "restore") add("rule", `🪢 ${who} のひもが復活`);
        else if (e.kind === "turnlock_start") add("rule", `↻ 旋回ロック開始 (${e.dir === "left" ? "左" : "右"}旋回 ${e.durationMs}ms 誰も引けない)`);
        else if (e.kind === "turnlock_end") add("rule", "旋回ロック終了 (引っ張り再開)");
      }
    }
    if (!p) {
      add("info", `部屋 ${snap.code}: ${PHASE_LABEL[snap.phase]} / モード ${snap.mode} / ESP32 ${snap.deviceWsCount ?? 0}台`);
      return;
    }
    if (p.phase !== snap.phase) add("game", `フェーズ: ${PHASE_LABEL[p.phase]} → ${PHASE_LABEL[snap.phase]}`);
    if (p.mode !== snap.mode) add("game", `出力モード: ${p.mode} → ${snap.mode}`);
    if (p.estop !== snap.estop) add(snap.estop ? "warn" : "info", snap.estop ? "🛑 緊急停止 ON" : "緊急停止 解除");
    if (!p.winnerSeat && snap.winnerSeat) add("game", `🏆 ${seatTitle(snap.winnerSeat)} ${snap.seats[snap.winnerSeat]?.name ?? ""} の勝ち！`);
    for (const s of SEATS) {
      const a = p.seats[s], b = snap.seats[s];
      if (!a && b) add("game", `${seatTitle(s)} 着席: ${b.name}`);
      else if (a && !b) add("game", `${seatTitle(s)} 離席: ${a.name}`);
      else if (a && b) {
        if (a.name !== b.name) add("info", `${seatTitle(s)} 名前変更: ${a.name} → ${b.name}`);
        if (a.online !== b.online) add(b.online ? "info" : "warn", `${seatTitle(s)} ${b.name} ${b.online ? "オンライン" : "オフライン"}`);
      }
    }
    if (snap.phase === "playing" && p.leaderSeat !== snap.leaderSeat) add("game", snap.leaderSeat ? `優勢: ${seatTitle(snap.leaderSeat)} の方向へ` : "拮抗 (皿は止まる)");
    if ((p.deviceWsCount ?? 0) !== (snap.deviceWsCount ?? 0)) add((snap.deviceWsCount ?? 0) > (p.deviceWsCount ?? 0) ? "device" : "warn", `ESP32 接続数: ${p.deviceWsCount ?? 0} → ${snap.deviceWsCount ?? 0}`);
    if (p.devicePayload !== snap.devicePayload && snap.devicePayload) add("device", `ESP32 ← ${snap.devicePayload} (${PAYLOAD_VIEW[snap.devicePayload]?.label ?? ""})`);
    if (!!p.deviceHasImu !== !!snap.deviceHasImu) add("device", snap.deviceHasImu ? "ESP32: IMU あり (方位フィードバック有効)" : "ESP32: IMU なし (推定方位)");
    const c = snap.calib, pc = p.calib;
    if (c && (!pc || pc.id !== c.id || pc.state !== c.state)) {
      const st = { spinning: "回転中…", awaiting_measure: "回った角度を入力してね", done: `完了 → ${c.turnRateDegPerSec ?? "?"} deg/s`, failed: `失敗 ${c.err ?? ""}` }[c.state];
      add(c.state === "failed" ? "warn" : "device", `キャリブ #${c.id} (${c.dir === "right" ? "右" : "左"} ${c.durationMs}ms, ${c.via}): ${st}`);
    }
    if (snap.mode === "B" && snap.xy && (!p.xy || p.xy.manual !== snap.xy.manual)) add("device", snap.xy.manual ? `XY 手動ジョグ → (${snap.xy.x}, ${snap.xy.y})` : `XY 自動 (皿位置に追従)`);
  }, [snap, add]);

  return { items, add };
}

// ---------- メイン ----------
export function HostDashboard() {
  const code = roomFromUrl();
  const { snap, connected, error, send } = useRoom(code, "viewer");
  const { items, add } = useEventLog(snap, connected);
  const [qr, setQr] = useState<{ url: string; label: string } | null>(null);

  useEffect(() => { document.title = `HOST ${code} | 遠慮の塊`; }, [code]);
  useEffect(() => { if (error) add("warn", `サーバー: ${error}`); }, [error, add]);

  const host = useCallback((cmd: "start" | "stop" | "estop" | "reset" | "release_estop", label: string) => {
    send({ t: "host", cmd });
    add("host", `ホスト操作: ${label}`);
  }, [send, add]);

  const estop = useCallback(async () => {
    // WS と REST の両方で止める (片方が死んでいても止まるように)
    send({ t: "host", cmd: "estop" });
    const r = await roomApi(code, "estop");
    add("warn", `🛑 緊急停止を送信 ${r.ok ? "" : JSON.stringify(r)}`);
  }, [code, send, add]);

  const speedRef = useRef<number | null>(null); // null = ファームの既定速度
  const manual = useCallback(async (payload: MovePayload, durationMs: number) => {
    const speed = speedRef.current;
    const r = await roomApi(code, "device/cmd", { payload, durationMs, ...(speed !== null && payload !== "stop" ? { speed } : {}) });
    add(r.ok ? "host" : "warn", r.ok ? `手動: ${PAYLOAD_VIEW[payload].label} ${durationMs}ms${r.speed !== undefined ? ` speed ${r.speed}` : ""} → ESP32 ${r.devices}台` : `手動コマンド失敗: ${r.error ?? JSON.stringify(r)}`);
  }, [code, add]);

  // キーボード: Space/Esc = 緊急停止, WASD/矢印 = 手動コマンド, Enter = 開始, R = リセット
  const durRef = useRef(800);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (e.key === " " || e.key === "Escape") { e.preventDefault(); estop(); }
      else if (e.repeat) return;
      else if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") { e.preventDefault(); manual("forward", durRef.current); }
      else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") { e.preventDefault(); manual("backward", durRef.current); }
      else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") { e.preventDefault(); manual("turn_left", durRef.current); }
      else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") { e.preventDefault(); manual("turn_right", durRef.current); }
      else if (e.key === "x" || e.key === "X") manual("stop", 0);
      else if (e.key === "Enter") host("start", "開始 (Enter)");
      else if (e.key === "r" || e.key === "R") host("reset", "リセット (R)");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [estop, manual, host]);

  return (
    <div className={`hd ${snap?.estop ? "hd-estop" : ""}`}>
      <header className="hd-head">
        <div className="hd-title">遠慮の塊 解消マシン <span>HOST</span></div>
        <div className="hd-chip">ROOM <b>{code}</b>{code !== DEMO_ROOM && <em> (上書き)</em>}</div>
        {snap && <div className={`hd-phase ${snap.phase}`}>{PHASE_LABEL[snap.phase]}</div>}
        {snap && <div className="hd-chip">モード <b>{snap.mode}</b></div>}
        {snap && <div className={`hd-chip ${snap.deviceWsCount ? "ok" : "ng"}`}>ESP32 <b>{snap.deviceWsCount ?? 0}</b>台</div>}
        <div className={`hd-chip ${connected ? "ok" : "ng"}`}><span className={`dot ${connected ? "on" : ""}`} />{connected ? "サーバー接続中" : "未接続"}</div>
        <div className="hd-spacer" />
        {snap && (snap.estop
          ? <button className="hd-estop-btn released" onClick={() => host("release_estop", "緊急停止 解除")}>緊急停止を解除</button>
          : <button className="hd-estop-btn" onClick={estop} title="Space / Esc">🛑 緊急停止</button>)}
      </header>

      {!snap ? <div className="hd-loading">部屋 {code} に接続中…</div> : (
        <>
          <section className="hd-col hd-left">
            <div className="hd-card hd-table">
              <Table snap={snap} letters />
              <ResultantBadge snap={snap} />
            </div>
            <OutputCard snap={snap} />
          </section>

          <section className="hd-col hd-mid">
            <div className="hd-seats">
              {SEATS.map((s) => <SeatCard key={s} seat={s} snap={snap} code={code} add={add} onQr={() => setQr({ url: seatUrl(s, code), label: seatTitle(s) })} />)}
            </div>
            <VectorCard snap={snap} />
            <LogCard items={items} />
          </section>

          <section className="hd-col hd-right">
            <GameCard snap={snap} host={host} />
            <ModeCard snap={snap} send={send} add={add} />
            <RulesCard snap={snap} send={send} add={add} />
            <ManualCard snap={snap} code={code} manual={manual} durRef={durRef} speedRef={speedRef} add={add} />
            <CalibCard snap={snap} code={code} add={add} />
            <ParamsCard snap={snap} send={send} />
            <div className="hd-card hd-links">
              <a href={hostUrl(code)} target="_blank" rel="noreferrer">別タブでホスト</a>
              <a href={`/sim${code === DEMO_ROOM ? "" : `?room=${code}`}`} target="_blank" rel="noreferrer">旧シミュレーター</a>
              <a href={`/magnet?room=${code}`} target="_blank" rel="noreferrer">人間磁石</a>
              <a href="/api/docs" target="_blank" rel="noreferrer">API (Swagger)</a>
              <a href={`/api/rooms/${code}/state`} target="_blank" rel="noreferrer">state JSON</a>
            </div>
            <details className="hd-card hd-raw">
              <summary>デバッグ: 生スナップショット</summary>
              <pre>{JSON.stringify(snap, null, 1)}</pre>
            </details>
            <div className="hd-keys">キー: Space/Esc=緊急停止 · WASD/矢印=手動 · X=停止 · Enter=開始 · R=リセット</div>
          </section>
        </>
      )}
      {qr && <JoinQROverlay url={qr.url} code={qr.label} onClose={() => setQr(null)} />}
    </div>
  );
}

// ---------- 席カード ----------
function SeatCard({ seat, snap, code, add, onQr }: { seat: Seat; snap: Snapshot; code: string; add: (k: LogItem["kind"], t: string) => void; onQr: () => void }) {
  const p = snap.seats[seat];
  const t = p?.tension ?? 0;
  const [bot, setBot] = useState(false);
  const [botPower, setBotPower] = useState(0.5);
  useBot(code, seat, bot, botPower);
  const isBot = p?.playerId.startsWith("bot-");
  const lead = snap.leaderSeat === seat;
  const win = snap.winnerSeat === seat;
  const url = seatUrl(seat, code);
  const left = useNowSince(snap);
  const mm = snap.phase === "playing" ? snap.mech?.seats[seat] : undefined;
  const snapLeft = mm?.snapped ? left(mm.snapRemainMs) : 0;
  const cdLeft = left(mm?.cooldownRemainMs);
  return (
    <div className={`hd-card hd-seat ${p ? "taken" : "empty"} ${lead ? "lead" : ""} ${win ? "win" : ""} ${snapLeft > 0 ? "snapped" : ""}`}>
      <div className="hd-seat-top">
        <div className="hd-seat-letter">{SEAT_LETTER[seat]}</div>
        <div className="hd-seat-info">
          <div className="hd-seat-dir">{SEAT_LABEL[seat]}の席 {lead && <span className="hd-tag lead">優勢</span>}{win && <span className="hd-tag win">WIN</span>}
            {snapLeft > 0 && <span className="hd-tag snap">✂ 切れた {secs(snapLeft)}s</span>}
            {!snapLeft && cdLeft > 0 && <span className="hd-tag cool">クール {(cdLeft / 1000).toFixed(1)}s</span>}
            {!snapLeft && (mm?.overMs ?? 0) > 0 && <span className="hd-tag over">引きすぎ {(mm!.overMs / 1000).toFixed(1)}s</span>}</div>
          <div className="hd-seat-name">
            {p ? <><span className={`dot ${p.online ? "on" : ""}`} />{p.name}{!p.online && <small> (オフライン)</small>}</> : <span className="muted">空席 — QR で参加</span>}
          </div>
        </div>
        <button className="hd-qr" onClick={onQr} title={url}><JoinQR url={url} /></button>
      </div>
      <div className="hd-bar"><div className="hd-bar-fill" style={{ width: pct(Math.min(1, t)) }} /><span>引く力 {pct(t)}</span></div>
      <div className="hd-seat-actions">
        <a href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\//, "")}</a>
        <label className={`hd-bot ${bot ? "on" : ""}`}>
          <input type="checkbox" checked={bot} onChange={(e) => { setBot(e.target.checked); add("host", `テストBOT ${SEAT_LETTER[seat]} ${e.target.checked ? "ON" : "OFF"}`); }} disabled={!!p && !isBot && !bot} />
          BOT
        </label>
        {bot && <input className="hd-bot-power" type="range" min={0} max={1} step={0.05} value={botPower} onChange={(e) => setBotPower(Number(e.target.value))} title={`BOT 引く力 ${pct(botPower)}`} />}
        {p && !bot && (
          <button className="hd-mini" onClick={async () => { await kickSeat(code, p.playerId); add("host", `${seatTitle(seat)} を空けた (${p.name})`); }}>空ける</button>
        )}
      </div>
    </div>
  );
}

// ---------- 合力 ----------
function ResultantBadge({ snap }: { snap: Snapshot }) {
  const r = resultant(snap);
  return (
    <div className="hd-plate-info">
      皿 x={snap.plate.x.toFixed(2)} y={snap.plate.y.toFixed(2)} · 向き {Math.round(snap.plate.headingDeg)}° · 速度 {pct(snap.plate.speed)} · tick {snap.tick}
      {snap.phase === "playing" && <> · {r.moving ? `→ ${Math.round(r.dirDeg)}°` : "拮抗"}</>}
    </div>
  );
}

function VectorCard({ snap }: { snap: Snapshot }) {
  const r = resultant(snap);
  const k = 0.9 / Math.max(1, r.mag);
  return (
    <div className="hd-card hd-vector">
      <svg viewBox="-1.25 -1.25 2.5 2.5" className="hd-vec-svg">
        <circle r="1" fill="none" stroke="#ffffff22" strokeWidth="0.02" />
        <circle r={Math.max(0.001, snap.params.tieMargin)} fill="#ffffff10" stroke="#ffffff30" strokeWidth="0.01" strokeDasharray="0.04 0.04" />
        {SEATS.map((s) => {
          const t = snap.seats[s]?.tension ?? 0;
          const [x, y] = SEAT_VEC[s];
          return (
            <g key={s}>
              {t > 0.005 && <line x1="0" y1="0" x2={x * t * k} y2={y * t * k} stroke="#c9a36a" strokeWidth="0.05" strokeOpacity="0.6" strokeLinecap="round" />}
              <text x={x * 1.13} y={y * 1.13 + 0.06} textAnchor="middle" className="hd-vec-label">{SEAT_LETTER[s]}</text>
            </g>
          );
        })}
        {r.mag > 0.005 && <line x1="0" y1="0" x2={r.fx * k} y2={r.fy * k} stroke={r.moving ? "#e8443a" : "#888"} strokeWidth="0.09" strokeLinecap="round" />}
        <circle r="0.06" fill="#f6f1e7" />
      </svg>
      <div className="hd-vec-text">
        <div className="label">合力 (みんなの引っ張りの足し算)</div>
        <div className="hd-vec-big">{r.moving ? <>{pct(Math.min(1, r.mag))} <small>→ {Math.round(r.dirDeg)}°</small></> : <span className="muted">拮抗 / 動かない</span>}</div>
        <div className="hd-vec-sub">
          {snap.phase !== "playing" ? "※ 対戦中だけ皿が動く" : snap.leaderSeat ? `${seatTitle(snap.leaderSeat)} の方へ寄っていく` : `差が ${snap.params.tieMargin} 未満なので止まる`}
        </div>
      </div>
    </div>
  );
}

// ---------- 出力 (ESP32 に送っているもの) ----------
function OutputCard({ snap }: { snap: Snapshot }) {
  const pv = snap.devicePayload ? PAYLOAD_VIEW[snap.devicePayload] : null;
  return (
    <div className="hd-card hd-output">
      <div className="label">ESP32 に送っているコマンド {snap.mode === "C" && <span className="muted">(モード C: デバイスは停止)</span>}</div>
      <div className="hd-output-row">
        {snap.mode === "B" ? (
          <div className="hd-output-big">
            <span className="hd-output-icon">⌖</span>
            {snap.xy ? <>x {snap.xy.x.toFixed(2)} / y {snap.xy.y.toFixed(2)}{snap.xy.manual && <small> 手動</small>}{!snap.xy.active && <small> (停止)</small>}</> : "—"}
          </div>
        ) : (
          <div className={`hd-output-big p-${snap.devicePayload ?? "none"}`}>
            <span className="hd-output-icon">{pv?.icon ?? "—"}</span>{pv?.label ?? "未送信"} <code>{snap.devicePayload ?? ""}</code>
          </div>
        )}
        <div className="hd-output-dev">
          <span className={`dot ${snap.deviceWsCount ? "on" : ""}`} />
          {snap.deviceWsCount ? `ESP32 ${snap.deviceWsCount}台 接続中` : snap.deviceOnline ? "HTTP ポーリングあり" : "ESP32 未接続"}
          <div className="hd-output-sub">
            {snap.deviceSpeed != null && <>speed {snap.deviceSpeed} · </>}
            方位: {snap.headingSource === "imu" ? "IMU" : "推定"}
            {snap.deviceImu && <> · IMU {Math.round(snap.deviceImu.headingDeg)}° {snap.deviceImu.fresh ? "" : "(古い)"}</>}
            {snap.deviceHasImu === false && snap.deviceWsCount ? " · IMU なし" : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- 操作 ----------
function GameCard({ snap, host }: { snap: Snapshot; host: (c: any, l: string) => void }) {
  return (
    <div className="hd-card">
      <div className="label">ゲーム · tick {snap.tick}</div>
      <div className="hd-btns">
        <button className="hd-btn primary" disabled={snap.estop || snap.phase === "playing"} onClick={() => host("start", "開始")}>▶ 開始</button>
        <button className="hd-btn" disabled={snap.phase !== "playing"} onClick={() => host("stop", "停止")}>⏸ 停止</button>
        <button className="hd-btn" onClick={() => host("reset", "リセット")}>↺ リセット</button>
      </div>
      {snap.estop && <div className="hd-warn">緊急停止中: 解除するまで開始・手動操作できません</div>}
      <TurnLockBadge snap={snap} />
    </div>
  );
}

function TurnLockBadge({ snap }: { snap: Snapshot }) {
  const left = useNowSince(snap);
  const tl = snap.phase === "playing" ? snap.mech?.turnLock : null;
  const rem = left(tl?.remainMs);
  if (!tl || rem <= 0) return <div className="hd-turnlock idle">旋回ロック: なし{snap.params.turnLockEnabled >= 0.5 ? "" : " (無効)"}</div>;
  return <div className="hd-turnlock">↻ 旋回ロック中 ({tl.dir === "left" ? "左" : "右"}) 残り {(rem / 1000).toFixed(1)}s / {tl.durationMs}ms — 引っ張り無視</div>;
}

// ---------- ゲームルール (ひも切れ / 旋回ロック / クールタイム) ----------
type RuleSlider = { k: keyof Params; label: string; min: number; max: number; step: number; fmt?: (v: number) => string };
const ms = (v: number) => `${v}ms`;
const RULES: { en: keyof Params; title: string; desc: string; sliders: RuleSlider[] }[] = [
  {
    en: "snapEnabled", title: "✂ ひも切れ", desc: "強く引きすぎると切れて、復活まで 0",
    sliders: [
      { k: "snapPower", label: "切れる強さ (以上)", min: 0.3, max: 1, step: 0.05, fmt: pct },
      { k: "snapHoldMs", label: "この時間続けたら切れる", min: 0, max: 3000, step: 100, fmt: ms },
      { k: "snapLeadMargin", label: "他の人より これ以上強い時だけ (0=無条件)", min: 0, max: 1, step: 0.05, fmt: (v) => (v > 0 ? pct(v) : "無条件") },
      { k: "snapRecoverMs", label: "復活までの時間", min: 500, max: 15000, step: 500, fmt: ms },
    ],
  },
  {
    en: "turnLockEnabled", title: "↻ 旋回ロック", desc: "モードAで旋回コマンドを出したら、その間は誰も引けない",
    sliders: [
      { k: "turnLockMs", label: "ロック時間 (0=自動: 角度÷旋回速度)", min: 0, max: 5000, step: 100, fmt: (v) => (v > 0 ? ms(v) : "自動") },
      { k: "turnRateDegPerSec", label: "実機の旋回速度 (自動の計算に使う)", min: 10, max: 360, step: 1, fmt: (v) => `${v}°/s` },
    ],
  },
  {
    en: "pullCooldownEnabled", title: "⏱ 引っ張りクールタイム", desc: "1回引いて離したら、少しの間 次の引っ張りが効かない",
    sliders: [{ k: "pullCooldownMs", label: "クールタイム", min: 0, max: 3000, step: 50, fmt: ms }],
  },
];

function RulesCard({ snap, send, add }: { snap: Snapshot; send: (m: any) => void; add: (k: LogItem["kind"], t: string) => void }) {
  const set = (k: keyof Params, v: number) => send({ t: "config", params: { [k]: v } });
  const resetRules = () => {
    const keys: (keyof Params)[] = ["snapEnabled", "snapPower", "snapHoldMs", "snapLeadMargin", "snapRecoverMs", "turnLockEnabled", "turnLockMs", "pullCooldownEnabled", "pullCooldownMs"];
    send({ t: "config", params: Object.fromEntries(keys.map((k) => [k, DEFAULT_PARAMS[k]])) });
    add("host", "ゲームルールを既定値に戻した");
  };
  return (
    <details className="hd-card hd-rules" open>
      <summary className="label">ゲームルール (ひも切れ / 旋回ロック / クールタイム)</summary>
      {RULES.map((r) => {
        const on = (snap.params[r.en] ?? 0) >= 0.5;
        return (
          <div key={r.en} className="hd-rule">
            <div className="hd-rule-head">
              <label className="hd-toggle">
                <input type="checkbox" checked={on} onChange={(e) => { set(r.en, e.target.checked ? 1 : 0); add("host", `${r.title} ${e.target.checked ? "ON" : "OFF"}`); }} />
                {r.title}
              </label>
              <small>{r.desc}</small>
            </div>
            {on && r.sliders.map(({ k, label, min, max, step, fmt }) => (
              <label key={k} className="hd-slider">
                <span>{label} <b>{fmt ? fmt(snap.params[k]) : snap.params[k]}</b></span>
                <input type="range" min={min} max={max} step={step} value={snap.params[k]} onChange={(e) => set(k, Number(e.target.value))} />
              </label>
            ))}
          </div>
        );
      })}
      <div className="hd-btns" style={{ marginTop: 8 }}><button className="hd-mini" onClick={resetRules}>ルールを既定値に戻す</button></div>
    </details>
  );
}

function ModeCard({ snap, send, add }: { snap: Snapshot; send: (m: any) => void; add: (k: LogItem["kind"], t: string) => void }) {
  return (
    <div className="hd-card">
      <div className="label">出力モード</div>
      <div className="hd-modes">
        {MODES.map(({ m, label, desc }) => (
          <button key={m} className={`hd-mode ${snap.mode === m ? "sel" : ""}`} onClick={() => { send({ t: "config", mode: m }); add("host", `モード切替 → ${label}`); }}>
            <b>{label}</b><small>{desc}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function ManualCard({ snap, code, manual, durRef, speedRef, add }: { snap: Snapshot; code: string; manual: (p: MovePayload, d: number) => void; durRef: React.MutableRefObject<number>; speedRef: React.MutableRefObject<number | null>; add: (k: LogItem["kind"], t: string) => void }) {
  const [dur, setDur] = useState(durRef.current);
  durRef.current = dur;
  const [speed, setSpeed] = useState<number | null>(speedRef.current);
  speedRef.current = speed;
  const b = (p: MovePayload, cls = "") => (
    <button className={`hd-pad-btn ${cls}`} disabled={snap.estop && p !== "stop"} onClick={() => manual(p, dur)}>
      <span>{PAYLOAD_VIEW[p].icon}</span>{PAYLOAD_VIEW[p].label}
    </button>
  );
  const xy = async (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.round((((e.clientX - r.left) / r.width) * 2.4 - 1.2) * 100) / 100;
    const y = Math.round((((e.clientY - r.top) / r.height) * 2.4 - 1.2) * 100) / 100;
    const res = await roomApi(code, "device/xy", { x, y, durationMs: 5000 });
    add(res.ok ? "host" : "warn", res.ok ? `手動 XY → (${x}, ${y}) 5秒` : `XY 失敗: ${res.error ?? JSON.stringify(res)}`);
  };
  return (
    <div className="hd-card">
      <div className="label">手動テスト (ESP32 {snap.deviceWsCount ?? 0}台)</div>
      {snap.mode === "B" ? (
        <div className="hd-xy">
          <svg viewBox="-1.2 -1.2 2.4 2.4" onClick={xy} className="hd-xy-pad">
            <circle r="1" fill="#5b3820" stroke="#2c1a0e" strokeWidth="0.04" />
            {SEATS.map((s) => <text key={s} x={SEAT_VEC[s][0] * 0.85} y={SEAT_VEC[s][1] * 0.85 + 0.07} textAnchor="middle" className="hd-vec-label">{SEAT_LETTER[s]}</text>)}
            {snap.xy && <circle cx={snap.xy.x} cy={snap.xy.y} r="0.1" fill={snap.xy.manual ? "#f2d649" : "#f6f1e7"} />}
          </svg>
          <small className="muted">卓をクリック → 磁石をその座標へ (5秒)</small>
        </div>
      ) : (
        <>
          <div className="hd-pad">
            <div />{b("forward")}<div />
            {b("turn_left")}{b("stop", "stop")}{b("turn_right")}
            <div />{b("backward")}<div />
          </div>
          <label className="hd-slider">
            <span>1回の長さ <b>{dur}ms</b></span>
            <input type="range" min={200} max={3000} step={100} value={dur} onChange={(e) => setDur(Number(e.target.value))} />
          </label>
          <label className="hd-slider">
            <span>速度 <b>{speed === null ? "ファーム既定" : pct(speed)}</b>{speed !== null && <button className="hd-mini" onClick={(e) => { e.preventDefault(); setSpeed(null); }}>既定に戻す</button>}</span>
            <input type="range" min={0.1} max={1} step={0.05} value={speed ?? 1} onChange={(e) => setSpeed(Number(e.target.value))} />
          </label>
          {snap.mode === "C" && <small className="muted">※ モード C 中でも手動コマンドは ESP32 に届きます</small>}
        </>
      )}
    </div>
  );
}

function ParamsCard({ snap, send }: { snap: Snapshot; send: (m: any) => void }) {
  return (
    <details className="hd-card">
      <summary className="label">係数チューニング</summary>
      {SLIDERS.map(({ k, label, min, max, step }) => (
        <label key={k} className="hd-slider">
          <span>{label} <b>{snap.params[k]}</b></span>
          <input type="range" min={min} max={max} step={step} value={snap.params[k]}
            onChange={(e) => send({ t: "config", params: { [k]: Number(e.target.value) } })} />
        </label>
      ))}
    </details>
  );
}

function LogCard({ items }: { items: LogItem[] }) {
  return (
    <div className="hd-card hd-log">
      <div className="label">イベントログ (新しい順)</div>
      <ol>
        {items.length === 0 && <li className="muted">まだ何も起きていません</li>}
        {items.map((it) => (
          <li key={it.id} className={`lk-${it.kind}`}><time>{hhmmss(it.at)}</time>{it.text}</li>
        ))}
      </ol>
    </div>
  );
}

// ---------- 旋回キャリブレーション (POST /device/calibrate) ----------
function CalibCard({ snap, code, add }: { snap: Snapshot; code: string; add: (k: LogItem["kind"], t: string) => void }) {
  const [dir, setDir] = useState<"right" | "left">("right");
  const [ms, setMs] = useState(2000);
  const [deg, setDeg] = useState("");
  const c = snap.calib;
  const start = async () => {
    const r = await roomApi(code, "device/calibrate", { dir, durationMs: ms });
    add(r.ok ? "host" : "warn", r.ok ? `キャリブ開始 (${dir === "right" ? "右" : "左"} ${ms}ms, ${r.via})` : `キャリブ失敗: ${r.error ?? JSON.stringify(r)}`);
  };
  const submit = async () => {
    const measuredDeg = Number(deg);
    if (!isFinite(measuredDeg) || measuredDeg <= 0) return;
    const r = await roomApi(code, "device/calibrate/result", { measuredDeg });
    add(r.ok ? "host" : "warn", r.ok ? `キャリブ結果: ${measuredDeg}° → ${r.turnRateDegPerSec} deg/s` : `結果登録失敗: ${r.error ?? JSON.stringify(r)}`);
    if (r.ok) setDeg("");
  };
  const busy = c?.state === "spinning";
  return (
    <details className="hd-card" open={!!c && c.state !== "done"}>
      <summary className="label">旋回キャリブレーション · 今 {Math.round(snap.params.turnRateDegPerSec ?? 90)} deg/s</summary>
      <div className="hd-calib-row">
        <select value={dir} onChange={(e) => setDir(e.target.value as any)}><option value="right">右回り</option><option value="left">左回り</option></select>
        <select value={ms} onChange={(e) => setMs(Number(e.target.value))}>{[1000, 2000, 3000, 4000].map((v) => <option key={v} value={v}>{v / 1000}秒</option>)}</select>
        <button className="hd-btn" disabled={busy || snap.estop || snap.phase === "playing" || !snap.deviceWsCount} onClick={start}>{busy ? "回転中…" : "ワンクリック計測"}</button>
      </div>
      {c?.state === "awaiting_measure" && (
        <div className="hd-calib-row">
          <span>回った角度</span>
          <input type="number" value={deg} placeholder="例 180" onChange={(e) => setDeg(e.target.value)} style={{ width: 90 }} />°
          <button className="hd-btn" onClick={submit}>登録</button>
        </div>
      )}
      {c && <div className="hd-calib-st">#{c.id} {c.via} · {c.state}{c.measuredDeg != null && ` · ${c.measuredDeg}°`}{c.turnRateDegPerSec != null && ` → ${c.turnRateDegPerSec} deg/s`}{c.err && ` · ${c.err}`}</div>}
      <small className="muted">待機中 + ESP32 接続中のみ。IMU 版は自動計測、IMU なしは回った角度を目で測って入力</small>
    </details>
  );
}

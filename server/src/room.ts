import { DurableObject } from "cloudflare:workers";
import { C2S, DEFAULT_PARAMS, Mode, Params, Phase, Plate, S2C, SEATS, Seat, Snapshot, Status, DeviceCmd, MovePayload, MOVE_PAYLOADS, DeviceWsOut, CalibState, TurnDir } from "./shared";
import type { DeviceWsMsg } from "./shared";
import { PULL_STALE_MS, clamp, deviceCmd, moveCommand, step, fuseHeading, imuHeading, imuOffsetFor, wrap360, turnRateFrom, parseSpeed } from "./logic";
import { xyMsg, driveFrame } from "./logic";
import { DEVICE_MODES, DEVICE_MODE_TO_MODE, MODE_TO_DEVICE_MODE, DeviceMode, XyMsg, PARAM_RANGES, MechView } from "./shared";
import { SeatMech, MechEvent, freshMech, applyPull, restoreIfDue, turnLockDuration, turnLockStarts, mergeParams } from "./mechanics";

type Player = { playerId: string; name: string; seat: Seat };
type Persisted = {
  code: string;
  mode: Mode;
  phase: Phase;
  estop: boolean;
  params: Params;
  seats: Partial<Record<Seat, Player>>;
  plate: Plate;
  winnerSeat: Seat | null;
  imuOffsetDeg?: number; // 卓方位 = IMU yaw + offset (hibernation をまたいで保持)
  imuBoot?: number; // offset を決めたときの ESP32 boot id
};
type Attach = { role: "player" | "viewer" | "device"; playerId?: string };

export interface Env {
  ROOM: DurableObjectNamespace<RoomDO>;
}

const TICK_MS = 500;
const DEVICE_ONLINE_MS = 2000;
const freshPlate = (): Plate => ({ x: 0, y: 0, headingDeg: 0, speed: 0 });

export class RoomDO extends DurableObject<Env> {
  s: Persisted = {
    code: "",
    mode: "C",
    phase: "lobby",
    estop: false,
    params: { ...DEFAULT_PARAMS },
    seats: {},
    plate: freshPlate(),
    winnerSeat: null,
    imuOffsetDeg: 0,
    imuBoot: 0,
  };
  // volatile (メモリのみ。プレイ中は alarm で起き続けるので消えない)
  tick = 0;
  powers: Partial<Record<Seat, { power: number; at: number }>> = {};
  tensions: Partial<Record<Seat, number>> = {};
  leaderSeat: Seat | null = null;
  targetDirDeg: number | null = null;
  deviceSeq = 0;
  lastDevicePoll = 0;
  lastDevice: DeviceCmd | null = null;
  devicePayload: MovePayload | null = null;
  manualUntil = 0;
  turnPauseTimer: ReturnType<typeof setTimeout> | null = null; // 直進→旋回の「ちょっと止まる」中
  manualTimer: ReturnType<typeof setInterval> | null = null;
  // Plan B (磁石XY)
  xySeq = 0;
  lastXy: XyMsg | null = null;
  manualXy: { x: number; y: number; until: number } | null = null;
  manualXyTimer: ReturnType<typeof setInterval> | null = null;
  deviceSpeed: number | null = null;
  // IMU (USE_IMU ビルドの ESP32 からの報告)
  imuLast: { yawDeg: number; rateDps: number; devMs: number; at: number } | null = null;
  imuZeroPending = false;
  deviceHasImu = false;
  headingSource: "imu" | "dr" = "dr";
  // 旋回キャリブレーション
  calib: CalibState | null = null;
  calibSeq = 0;
  calibTimer: ReturnType<typeof setTimeout> | null = null;
  // ゲームルール (ひも切れ / 旋回ロック / クールタイム)
  mech: Partial<Record<Seat, SeatMech>> = {};
  turnLock: { until: number; durationMs: number; dir: TurnDir } | null = null;
  mechEvents: MechEvent[] = [];
  mechSeq = 0;
  mechTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Persisted>("room");
      if (saved) this.s = { ...this.s, ...saved, params: { ...DEFAULT_PARAMS, ...saved.params } };
    });
  }

  async save() {
    await this.ctx.storage.put("room", this.s);
  }

  // ---------- HTTP entry (from Worker) ----------
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = url.searchParams.get("code") ?? "";
    if (!this.s.code && code) this.s.code = code;
    const path = url.pathname;
    const xyRes = await this.fetchXy(req, path);
    if (xyRes) return xyRes;

    if (path.endsWith("/device/ws")) {
      // ESP32 用: サーバーから {"payload":"forward"} 等を push するだけ (受信は ping 用に無視)
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["device"]);
      pair[1].serializeAttachment({ role: "device" } satisfies Attach);
      // 実機が繋がったらバーチャル(C)からタイヤロボ(A)へ自動切替 (B を選んでいる場合はそのまま)
      if (this.s.mode === "C") { this.s.mode = "A"; await this.save(); }
      this.sendDevice(this.devicePayload ?? "stop", pair[1]);
      if (this.s.mode === "B") this.sendXy(pair[1]);
      this.broadcast();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path.endsWith("/device/calibrate/result") && req.method === "POST") return this.calibResult(await readJson(req));
    if (path.endsWith("/device/calibrate") && req.method === "POST") return this.startCalib(await readJson(req));
    if (path.endsWith("/device/cmd") && req.method === "POST") {
      // 疎通/手動テスト用: 指定コマンドを durationMs の間 (500ms ごとに再送) 流し、その後 stop
      let body: any = {};
      try { body = await req.json(); } catch {}
      const payload = body?.payload as MovePayload;
      if (!MOVE_PAYLOADS.includes(payload)) return Response.json({ ok: false, error: `payload must be one of ${MOVE_PAYLOADS.join(", ")}` }, { status: 400 });
      if (this.s.estop && payload !== "stop") return Response.json({ ok: false, error: "estop 中 (解除してから)" }, { status: 409 });
      const durationMs = clamp(Number(body?.durationMs ?? 1000) || 1000, 100, 5000);
      const speed = parseSpeed(body?.speed);
      if (speed === null) return Response.json({ ok: false, error: "speed は 0..1 (省略でファームの SPEED/TURN_SPEED)" }, { status: 400 });
      this.manual(speed === undefined || payload === "stop" ? { payload } : { payload, speed }, durationMs);
      return Response.json({ ok: true, payload, durationMs, ...(speed !== undefined ? { speed } : {}), devices: this.ctx.getWebSockets("device").length });
    }
    if (path.endsWith("/ws")) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      const role = url.searchParams.get("role") === "viewer" ? "viewer" : "player";
      const att: Attach = { role, playerId: url.searchParams.get("playerId") ?? undefined };
      this.ctx.acceptWebSocket(pair[1], [role]);
      pair[1].serializeAttachment(att);
      this.sendTo(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path.endsWith("/device")) {
      const type = (url.searchParams.get("type") ?? "A").toUpperCase() === "B" ? "B" : "A";
      this.lastDevicePoll = Date.now();
      const cmd = deviceCmd({
        type,
        mode: this.s.mode,
        phase: this.s.phase,
        estop: this.s.estop,
        seq: ++this.deviceSeq,
        plate: this.livePlate(),
        leaderSeat: this.leaderSeat,
        params: this.s.params,
        targetDirDeg: this.targetDirDeg,
      });
      this.lastDevice = cmd;
      return Response.json(cmd);
    }
    if (path.endsWith("/estop") && req.method === "POST") {
      this.manual("stop", 0);
      await this.host("estop");
      return Response.json({ ok: true });
    }
    if (path.endsWith("/state")) return Response.json(this.snapshot());
    if (path.endsWith("/params")) return this.paramsApi(req);
    return new Response("not found", { status: 404 });
  }

  // ---------- WebSocket (Hibernation API) ----------
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const att0 = ws.deserializeAttachment() as Attach | null;
    if (att0?.role === "device" && this.s.mode === "B") this.sendXy(ws); // XY 機は ping ごとに最新目標を返す
    if (att0?.role === "device") return this.onDeviceMessage(raw); // IMU 報告など。ping 等は無視
    let msg: C2S;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.err(ws, "bad json");
    }
    const att = (ws.deserializeAttachment() ?? { role: "player" }) as Attach;
    switch (msg.t) {
      case "join": {
        if (!SEATS.includes(msg.seat)) return this.err(ws, "bad seat");
        const cur = this.s.seats[msg.seat];
        if (cur && cur.playerId !== msg.playerId) return this.err(ws, "その席はもう埋まってるよ");
        // 既に別の席に座ってたら移動
        for (const s of SEATS) if (this.s.seats[s]?.playerId === msg.playerId) delete this.s.seats[s];
        this.s.seats[msg.seat] = { playerId: msg.playerId, name: (msg.name || "名無し").slice(0, 16), seat: msg.seat };
        ws.serializeAttachment({ role: "player", playerId: msg.playerId } satisfies Attach);
        await this.save();
        return this.broadcast();
      }
      case "leave": {
        for (const s of SEATS) if (this.s.seats[s]?.playerId === att.playerId) delete this.s.seats[s];
        await this.save();
        return this.broadcast();
      }
      case "pull": {
        const seat = this.seatOf(att.playerId);
        if (!seat) return;
        return this.onPull(seat, clamp(Number(msg.power) || 0, 0, 1));
      }
      case "host":
        await this.host(msg.cmd);
        return;
      case "config": {
        if (msg.mode && ["A", "B", "C"].includes(msg.mode)) { this.s.mode = msg.mode; this.autoDevice(); }
        if (msg.params) {
          const ok: Record<string, number> = {};
          for (const [k, v] of Object.entries(msg.params)) if (k in DEFAULT_PARAMS && typeof v === "number" && isFinite(v)) ok[k] = v;
          this.s.params = mergeParams(this.s.params, ok, DEFAULT_PARAMS, PARAM_RANGES).params;
        }
        if (msg.zeroImu) this.imuZeroPending = true;
        await this.save();
        return this.broadcast();
      }
    }
  }

  async webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch {}
    this.broadcast();
  }
  async webSocketError() {}

  async host(cmd: "start" | "stop" | "estop" | "reset" | "release_estop") {
    if (cmd === "start") {
      if (this.s.estop) return this.broadcast();
      if (this.s.phase !== "playing") {
        if (this.s.phase === "finished") this.resetGame();
        this.resetMech();
        this.s.phase = "playing";
        await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
      }
    } else if (cmd === "stop") {
      this.s.phase = "lobby";
      this.leaderSeat = null;
      this.endTurnLock();
    } else if (cmd === "estop") {
      this.endTurnLock();
      if (this.calib?.state === "spinning") { this.clearCalibTimer(); this.calib = { ...this.calib, state: "failed", err: "estop" }; }
      this.s.estop = true;
      this.s.phase = "lobby";
      this.leaderSeat = null;
      this.s.plate.speed = 0;
    } else if (cmd === "release_estop") {
      this.s.estop = false;
    } else if (cmd === "reset") {
      this.resetGame();
      this.s.phase = "lobby";
    }
    if (cmd !== "start" && cmd !== "release_estop") this.autoDevice();
    await this.save();
    this.broadcast();
  }

  resetGame() {
    this.s.plate = freshPlate();
    this.s.winnerSeat = null;
    this.tensions = {};
    this.powers = {};
    this.leaderSeat = null;
    this.tick = 0;
    this.headingSource = "dr";
    this.resetMech();
    this.imuZeroPending = true; // リセット時は「皿は N 向きに置き直した」とみなし、次の IMU 報告で基準を取り直す
  }

  async alarm() {
    if (this.s.phase !== "playing" || this.s.estop) return;
    const now = Date.now();
    this.mechTick(now);
    const locked = !!this.turnLock;
    const powers: Partial<Record<Seat, number>> = {};
    for (const s of SEATS) {
      if (!this.s.seats[s]) continue;
      const p = this.powers[s];
      // 旋回ロック中は引っ張りを無視して張力を凍結 (= 旋回を最後までやり切る)。切れている席は 0
      if (locked) powers[s] = this.tensions[s] ?? 0;
      else powers[s] = p && now - p.at < PULL_STALE_MS ? p.power : 0;
      if ((this.mech[s]?.snappedUntil ?? 0) > now) powers[s] = 0;
    }
    const out = step({
      powers, tensions: this.tensions, plate: this.s.plate, params: this.s.params, dt: TICK_MS / 1000,
      headingOverrideDeg: this.fusedHeading(),
    });
    this.headingSource = out.headingSource;
    this.tick++;
    this.tensions = out.tensions;
    this.s.plate = out.plate;
    this.leaderSeat = out.leaderSeat;
    this.targetDirDeg = out.targetDirDeg;
    const prevPayload = this.devicePayload;
    this.autoDevice();
    this.maybeStartTurnLock(prevPayload, now);
    if (out.winnerSeat) {
      this.endTurnLock();
      this.s.winnerSeat = out.winnerSeat;
      this.s.phase = "finished";
      this.leaderSeat = null;
      this.s.plate.speed = 0;
      this.autoDevice();
      await this.save();
    } else {
      await this.ctx.storage.setAlarm(now + TICK_MS);
    }
    this.broadcast();
  }

  // ---------- ゲームルール (ひも切れ / 旋回ロック / 引っ張りクールタイム) ----------
  onPull(seat: Seat, power: number) {
    const now = Date.now();
    if (this.s.phase !== "playing" || this.s.estop) { this.powers[seat] = { power, at: now }; return; }
    if (this.turnLock) {
      if (now < this.turnLock.until) return; // 旋回中は誰も引けない (無視)
      this.mechTick(now);
    }
    let othersMax = 0;
    for (const s of SEATS) if (s !== seat && this.s.seats[s]) othersMax = Math.max(othersMax, this.powers[s]?.power ?? 0);
    const r = applyPull(this.mech[seat] ?? freshMech(), power, now, this.s.params, othersMax);
    this.mech[seat] = r.mech;
    this.powers[seat] = { power: r.effective, at: now };
    if (r.restored) this.pushMech({ kind: "restore", seat });
    if (r.snapped) {
      this.tensions[seat] = 0; // ひもが切れた = その席の力はすぐ 0
      this.pushMech({ kind: "snap", seat, durationMs: this.s.params.snapRecoverMs });
      this.scheduleMechWake(this.s.params.snapRecoverMs);
    }
    if (r.restored || r.snapped) this.broadcast();
  }

  /** 復活 / ロック解除の判定 (tick と pull から) */
  mechTick(now: number) {
    let changed = false;
    for (const s of SEATS) {
      const m = this.mech[s];
      if (!m) continue;
      const r = restoreIfDue(m, now);
      if (r.restored) { this.mech[s] = r.mech; this.pushMech({ kind: "restore", seat: s }); changed = true; }
    }
    if (this.turnLock && now >= this.turnLock.until) { this.endTurnLock(); changed = true; }
    return changed;
  }

  maybeStartTurnLock(prevPayload: MovePayload | null, now: number) {
    const p = this.s.params;
    if (this.turnLock || (p.turnLockEnabled ?? 0) < 0.5 || this.s.mode !== "A" || this.s.phase !== "playing" || this.s.estop) return;
    if (Date.now() < this.manualUntil || this.calib?.state === "spinning") return;
    const dir = turnLockStarts(prevPayload, this.devicePayload ?? "stop");
    if (!dir) return;
    const dh = this.targetDirDeg == null ? 90 : driveFrame(this.targetDirDeg, this.livePlate().headingDeg, p).dh; // バック走行なら必要な旋回角も小さい
    const durationMs = turnLockDuration(p, dh);
    this.turnLock = { until: now + durationMs, durationMs, dir };
    this.pushMech({ kind: "turnlock_start", durationMs, dir });
    this.scheduleMechWake(durationMs);
  }

  endTurnLock() {
    if (!this.turnLock) return;
    this.turnLock = null;
    this.pushMech({ kind: "turnlock_end" });
  }

  resetMech() {
    this.mech = {};
    this.turnLock = null;
    if (this.mechTimer) clearTimeout(this.mechTimer);
    this.mechTimer = null;
  }

  pushMech(e: Omit<MechEvent, "id" | "at">) {
    this.mechEvents.push({ id: ++this.mechSeq, at: Date.now(), ...e });
    if (this.mechEvents.length > 30) this.mechEvents.splice(0, this.mechEvents.length - 30);
  }

  /** 復活 / ロック解除の瞬間に画面を更新 (tick を待たない) */
  scheduleMechWake(ms: number) {
    if (this.mechTimer) clearTimeout(this.mechTimer);
    const at = Math.min(...[ms, ...Object.values(this.mech).map((m) => (m!.snappedUntil > 0 ? m!.snappedUntil - Date.now() : Infinity)), this.turnLock ? this.turnLock.until - Date.now() : Infinity]);
    this.mechTimer = setTimeout(() => {
      this.mechTimer = null;
      if (this.mechTick(Date.now())) this.broadcast();
      const pending = Object.values(this.mech).some((m) => m!.snappedUntil > 0) || !!this.turnLock;
      if (pending) this.scheduleMechWake(5000);
    }, Math.max(20, at + 10));
  }

  mechView(viewer: boolean): MechView {
    const now = Date.now();
    const seats: MechView["seats"] = {};
    for (const s of SEATS) {
      if (!this.s.seats[s]) continue;
      const m = this.mech[s] ?? freshMech();
      const snapped = m.snappedUntil > now;
      seats[s] = {
        snapped,
        snapRemainMs: snapped ? m.snappedUntil - now : 0,
        cooldownRemainMs: !snapped && !m.pulling && m.cooldownUntil > now ? m.cooldownUntil - now : 0,
        overMs: m.overSince != null ? now - m.overSince : 0,
      };
    }
    const tl = this.turnLock && this.turnLock.until > now ? { remainMs: this.turnLock.until - now, durationMs: this.turnLock.durationMs, dir: this.turnLock.dir } : null;
    return { seats, turnLock: tl, ...(viewer ? { events: this.mechEvents } : {}) };
  }

  // ---------- REST: params ----------
  async paramsApi(req: Request): Promise<Response> {
    const res = (extra: object = {}, status = 200) => Response.json({ ok: status < 300, params: this.s.params, defaults: DEFAULT_PARAMS, ranges: PARAM_RANGES, ...extra }, { status });
    if (req.method === "GET") return res();
    if (req.method !== "PUT" && req.method !== "PATCH" && req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = await readJson(req);
    const patch = body && typeof body === "object" ? (body.params && typeof body.params === "object" ? body.params : body) : {};
    if (body?.reset === true) this.s.params = { ...DEFAULT_PARAMS, turnRateDegPerSec: this.s.params.turnRateDegPerSec };
    const { params, errors } = mergeParams(this.s.params, body?.reset === true ? {} : patch, DEFAULT_PARAMS, PARAM_RANGES);
    if (errors.length) return res({ errors }, 400);
    this.s.params = params;
    await this.save();
    this.broadcast();
    return res();
  }

  // ---------- helpers ----------
  seatOf(playerId?: string): Seat | null {
    if (!playerId) return null;
    for (const s of SEATS) if (this.s.seats[s]?.playerId === playerId) return s;
    return null;
  }

  onlineIds(): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets("player")) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.playerId) ids.add(a.playerId);
    }
    return ids;
  }

  snapshot(forPlayer?: string, viewer = true): Snapshot {
    const online = this.onlineIds();
    const seats: Snapshot["seats"] = {};
    for (const s of SEATS) {
      const p = this.s.seats[s];
      if (!p) continue;
      seats[s] = {
        playerId: p.playerId,
        name: p.name,
        seat: s,
        online: online.has(p.playerId),
        ...(viewer ? { tension: Math.round((this.tensions[s] ?? 0) * 1000) / 1000 } : {}),
      };
    }
    const snap: Snapshot = {
      code: this.s.code,
      tick: this.tick,
      phase: this.s.phase,
      mode: this.s.mode,
      estop: this.s.estop,
      params: this.s.params,
      seats,
      plate: this.s.plate,
      leaderSeat: this.leaderSeat,
      winnerSeat: this.s.winnerSeat,
      deviceOnline: Date.now() - this.lastDevicePoll < DEVICE_ONLINE_MS || this.ctx.getWebSockets("device").length > 0,
      devicePayload: this.devicePayload,
      deviceWsCount: this.ctx.getWebSockets("device").length,
      deviceMode: MODE_TO_DEVICE_MODE[this.s.mode],
      xy: this.lastXy,
      deviceSpeed: this.deviceSpeed,
      deviceHasImu: this.deviceHasImu,
      deviceImu: this.imuView(),
      headingSource: this.headingSource,
      calib: this.calib,
      mech: this.mechView(viewer),
      ...(viewer ? { lastDevice: this.lastDevice } : {}),
    };
    if (forPlayer !== undefined) {
      const seat = this.seatOf(forPlayer);
      let status: Status = "waiting";
      if (seat && this.s.phase === "playing" && this.leaderSeat) status = this.leaderSeat === seat ? "winning" : "losing";
      snap.me = { playerId: forPlayer, seat, tension: seat ? this.tensions[seat] ?? 0 : 0, status };
    }
    return snap;
  }

  sendTo(ws: WebSocket) {
    const a = (ws.deserializeAttachment() ?? { role: "player" }) as Attach;
    const snapshot = a.role === "viewer" ? this.snapshot() : this.snapshot(a.playerId ?? "", false);
    const m: S2C = { t: "state", snapshot };
    try { ws.send(JSON.stringify(m)); } catch {}
  }

  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.role === "device") continue;
      this.sendTo(ws);
    }
  }

  // ---------- ESP32 WebSocket ----------
  sendDevice(out: MovePayload | DeviceWsOut, only?: WebSocket) {
    const o: DeviceWsOut = typeof out === "string" ? { payload: out } : out;
    if ("payload" in o) {
      this.devicePayload = o.payload;
      this.deviceSpeed = o.speed ?? null;
    }
    const msg = JSON.stringify(o); // speed が無ければ従来と同一の {"payload":"..."}
    for (const ws of only ? [only] : this.ctx.getWebSockets("device")) {
      try { ws.send(msg); } catch {}
    }
  }

  /** tick ごとに mode A のコマンドを WS デバイスへ (手動テスト中は抑制) */
  autoDevice() {
    if (this.s.mode === "B") this.sendXy();
    if (Date.now() < this.manualUntil) return;
    if (this.calib?.state === "spinning" && !this.s.estop) return; // キャリブ中は自動制御を抑制
    const cmd = deviceCmd({
      type: "A", mode: this.s.mode, phase: this.s.phase, estop: this.s.estop, seq: this.deviceSeq,
      plate: this.livePlate(), leaderSeat: this.leaderSeat, params: this.s.params, targetDirDeg: this.targetDirDeg,
    });
    const out = moveCommand(cmd, this.s.params);
    if (this.turnPauseTimer) return; // 停止中: 終わったら旋回を送る
    const pauseMs = Math.round(this.s.params.turnPauseMs ?? 0);
    const isTurn = out.payload === "turn_right" || out.payload === "turn_left";
    const wasDriving = this.devicePayload === "forward" || this.devicePayload === "backward";
    if (isTurn && wasDriving && pauseMs > 0 && this.s.mode === "A" && this.s.phase === "playing" && !this.s.estop) {
      // 直進の勢いを一度殺してから回る (曲がりやすくする)
      this.sendDevice("stop");
      this.turnPauseTimer = setTimeout(() => {
        this.turnPauseTimer = null;
        if (this.s.phase !== "playing" || this.s.estop || this.s.mode !== "A") return;
        const prev = this.devicePayload;
        this.autoDevice();
        this.maybeStartTurnLock(prev, Date.now());
        // 旋回をまるまる 1 tick 続けられるよう次の tick を後ろへずらす (方位推定と実際の旋回時間を合わせる)
        this.ctx.storage.setAlarm(Date.now() + TICK_MS).catch(() => {});
        this.broadcast();
      }, pauseMs);
      return;
    }
    this.sendDevice(out);
  }

  manual(out: MovePayload | DeviceWsMsg, durationMs: number) {
    const msg: DeviceWsMsg = typeof out === "string" ? { payload: out } : out;
    const payload = msg.payload;
    if (this.manualTimer) clearInterval(this.manualTimer);
    this.manualTimer = null;
    this.manualUntil = 0;
    this.sendDevice(msg);
    if (payload === "stop" || durationMs <= 0) { this.broadcast(); return; }
    this.manualUntil = Date.now() + durationMs;
    this.manualTimer = setInterval(() => {
      if (Date.now() >= this.manualUntil) {
        clearInterval(this.manualTimer!);
        this.manualTimer = null;
        this.manualUntil = 0;
        this.sendDevice("stop");
        if (this.calib?.state === "spinning" && this.calib.via === "manual") this.calib = { ...this.calib, state: "awaiting_measure" };
        this.autoDevice();
        this.broadcast();
      } else this.sendDevice(msg);
    }, 250);
    this.broadcast();
  }

  // ---------- Plan B: 磁石 XY ----------
  /** 現在の目標 (手動ジョグ中はその座標、通常は皿位置) を {t:"xy"} で device/ws へ */
  sendXy(only?: WebSocket) {
    const man = this.manualXy && Date.now() < this.manualXy.until ? this.manualXy : null;
    const src = man ?? this.s.plate;
    const msg = xyMsg({ mode: this.s.mode, estop: this.s.estop, seq: ++this.xySeq, x: src.x, y: src.y, manual: !!man });
    this.lastXy = msg;
    const raw = JSON.stringify(msg);
    for (const ws of only ? [only] : this.ctx.getWebSockets("device")) {
      try { ws.send(raw); } catch {}
    }
  }

  /** /device/mode (GET|PUT) と /device/xy (POST)。該当しなければ null */
  async fetchXy(req: Request, path: string): Promise<Response | null> {
    const modeRes = () => Response.json({
      ok: true, deviceMode: MODE_TO_DEVICE_MODE[this.s.mode], mode: this.s.mode,
      devices: this.ctx.getWebSockets("device").length, xy: this.lastXy,
    });
    if (path.endsWith("/device/mode")) {
      if (req.method === "GET") return modeRes();
      if (req.method !== "PUT" && req.method !== "POST") return new Response("method not allowed", { status: 405 });
      let body: any = {};
      try { body = await req.json(); } catch {}
      const dm = body?.deviceMode as DeviceMode;
      if (!DEVICE_MODES.includes(dm)) return Response.json({ ok: false, error: `deviceMode must be one of ${DEVICE_MODES.join(", ")}` }, { status: 400 });
      this.s.mode = DEVICE_MODE_TO_MODE[dm];
      this.autoDevice();
      await this.save();
      this.broadcast();
      return modeRes();
    }
    if (path.endsWith("/device/xy") && req.method === "POST") {
      let body: any = {};
      try { body = await req.json(); } catch {}
      const x = Number(body?.x), y = Number(body?.y);
      if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 1.5 || Math.abs(y) > 1.5) return Response.json({ ok: false, error: "x, y は -1..1 の数値" }, { status: 400 });
      if (this.s.mode !== "B") return Response.json({ ok: false, error: "deviceMode が xy ではない (PUT /device/mode で切替)" }, { status: 409 });
      if (this.s.estop) return Response.json({ ok: false, error: "estop 中 (解除してから)" }, { status: 409 });
      const durationMs = clamp(Number(body?.durationMs ?? 5000) || 5000, 500, 30000);
      this.manualXy = { x, y, until: Date.now() + durationMs };
      if (this.manualXyTimer) clearInterval(this.manualXyTimer);
      this.manualXyTimer = setInterval(() => {
        this.sendXy();
        if (!this.manualXy || Date.now() >= this.manualXy.until) {
          clearInterval(this.manualXyTimer!);
          this.manualXyTimer = null;
          this.manualXy = null;
          this.broadcast();
        }
      }, 250);
      this.sendXy();
      this.broadcast();
      return Response.json({ ok: true, durationMs, devices: this.ctx.getWebSockets("device").length, xy: this.lastXy });
    }
    return null;
  }

  // ---------- IMU 方位補正 ----------
  /** 新鮮な IMU 報告があれば卓基準の方位 (dead reckoning と blend)、無ければ null */
  fusedHeading(): number | null {
    const l = this.imuLast;
    if (!l || this.imuZeroPending) return null;
    if (Date.now() - l.at > (this.s.params.imuMaxAgeMs ?? 1500)) return null;
    const blend = this.s.params.imuBlend ?? 1;
    if (blend <= 0) return null;
    return fuseHeading(this.s.plate.headingDeg, imuHeading(l.yawDeg, this.s.imuOffsetDeg ?? 0), blend);
  }

  /** tick 間でも最新の実測方位を使った皿 */
  livePlate(): Plate {
    const h = this.fusedHeading();
    return h == null ? this.s.plate : { ...this.s.plate, headingDeg: h };
  }

  imuView(): Snapshot["deviceImu"] {
    const l = this.imuLast;
    if (!l) return null;
    const r = (n: number) => Math.round(n * 10) / 10;
    const off = this.s.imuOffsetDeg ?? 0;
    return {
      yawDeg: r(l.yawDeg), offsetDeg: r(off), headingDeg: r(imuHeading(l.yawDeg, off)),
      rateDps: r(l.rateDps), ageMs: Date.now() - l.at, fresh: this.fusedHeading() != null,
    };
  }

  onDeviceMessage(raw: string | ArrayBuffer) {
    let m: any;
    try { m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (!m || typeof m !== "object") return;
    const now = Date.now();
    switch (m.t) {
      case "hello": {
        const boot = Number(m.boot) || 0;
        this.deviceHasImu = m.imu === 1 || m.imu === true;
        if (this.deviceHasImu && boot !== (this.s.imuBoot ?? 0)) {
          // 再起動 = yaw が 0 から再スタート。offset を取り直す
          this.s.imuBoot = boot;
          this.imuLast = null;
          this.imuZeroPending = true;
        }
        this.broadcast();
        return;
      }
      case "imu": {
        const yaw = Number(m.yaw), ms = Number(m.ms);
        if (!isFinite(yaw) || !isFinite(ms)) return;
        const prev = this.imuLast;
        if (prev && ms < prev.devMs) { this.imuLast = null; this.imuZeroPending = true; } // millis 巻き戻り = 無言の再起動
        else if (prev && ms === prev.devMs) return;
        this.deviceHasImu = true;
        if (this.imuZeroPending) {
          // プレイ中の取り直しは現在の推定方位に、それ以外は「皿は N 向き」= 0 に合わせる
          const target = this.s.phase === "playing" ? this.s.plate.headingDeg : 0;
          this.s.imuOffsetDeg = imuOffsetFor(target, wrap360(yaw));
          this.imuZeroPending = false;
          void this.save();
        }
        this.imuLast = { yawDeg: wrap360(yaw), rateDps: Number(m.gz) || 0, devMs: ms, at: now };
        return; // broadcast しない (次の tick で反映)
      }
      case "calib": {
        const c = this.calib;
        if (!c || c.via !== "imu" || c.state !== "spinning" || c.id !== Number(m.id)) return;
        this.clearCalibTimer();
        if (m.ok === 0 || m.ok === false) {
          this.calib = { ...c, state: "failed", err: String(m.err ?? "imu") };
        } else {
          const dps = Number(m.dps);
          const rate = isFinite(dps) && dps > 0 ? clamp(dps, 5, 720) : turnRateFrom(Number(m.deg) || 0, Number(m.ms) || c.durationMs);
          this.s.params.turnRateDegPerSec = Math.round(rate * 10) / 10;
          this.calib = { ...c, state: "done", measuredDeg: Number(m.deg), turnRateDegPerSec: this.s.params.turnRateDegPerSec };
          void this.save();
        }
        this.broadcast();
        return;
      }
    }
  }

  // ---------- 旋回キャリブレーション ----------
  clearCalibTimer() {
    if (this.calibTimer) clearTimeout(this.calibTimer);
    this.calibTimer = null;
  }

  async startCalib(body: any): Promise<Response> {
    const bad = (status: number, error: string) => Response.json({ ok: false, error }, { status });
    if (this.s.estop) return bad(409, "estop 中 (解除してから)");
    if (this.s.phase === "playing") return bad(409, "プレイ中は不可 (stop してから)");
    if (this.ctx.getWebSockets("device").length === 0) return bad(409, "device 未接続");
    const dir: TurnDir = body?.dir === "left" ? "left" : "right";
    const durationMs = clamp(Number(body?.durationMs ?? 2000) || 2000, 300, 5000);
    const sp = parseSpeed(body?.speed);
    if (sp === null) return bad(400, "speed は 0..1");
    const speed = sp === undefined ? 1 : Math.max(0.2, sp);
    const via = body?.via === "imu" ? "imu" : body?.via === "manual" ? "manual" : this.deviceHasImu ? "imu" : "manual";
    if (via === "imu" && !this.deviceHasImu) return bad(409, "IMU からの報告が無い (USE_IMU 0 のビルド?) → via=manual で");
    this.clearCalibTimer();
    const id = ++this.calibSeq;
    this.calib = { id, dir, durationMs, speed, via, startedAt: Date.now(), state: "spinning" };
    const payload: MovePayload = dir === "right" ? "turn_right" : "turn_left";
    if (via === "imu") {
      // ESP32 が自分で durationMs 回って実測 deg/s を返す。返事が無ければ failed
      this.manual("stop", 0);
      this.sendDevice({ cmd: "calib", id, dir, ms: durationMs, speed });
      this.calibTimer = setTimeout(() => {
        this.calibTimer = null;
        if (this.calib?.id === id && this.calib.state === "spinning") {
          this.calib = { ...this.calib, state: "failed", err: "timeout (ESP32 から calib 結果が来ない)" };
          this.sendDevice("stop");
          this.broadcast();
        }
      }, durationMs + 3000);
    } else {
      // サーバー駆動で durationMs 回す → 実測角度を /device/calibrate/result へ
      this.manual(speed < 1 ? { payload, speed } : { payload }, durationMs);
    }
    this.broadcast();
    return Response.json({
      ok: true, calibId: id, via, dir, durationMs, speed,
      ...(via === "manual" ? { note: "回り終わったら実測角度 (度) を POST /device/calibrate/result {\"measuredDeg\": N} で送ってね" } : {}),
    });
  }

  async calibResult(body: any): Promise<Response> {
    const direct = Number(body?.turnRateDegPerSec);
    const c = this.calib;
    if (body?.turnRateDegPerSec !== undefined && isFinite(direct) && direct > 0) {
      this.s.params.turnRateDegPerSec = Math.round(clamp(direct, 5, 720) * 10) / 10;
    } else {
      const deg = Number(body?.measuredDeg);
      if (!isFinite(deg) || Math.abs(deg) < 1) return Response.json({ ok: false, error: "measuredDeg (度) か turnRateDegPerSec が必要" }, { status: 400 });
      const ms = Number(body?.durationMs) || c?.durationMs || 2000;
      this.s.params.turnRateDegPerSec = Math.round(turnRateFrom(deg, ms) * 10) / 10;
      if (c) this.calib = { ...c, state: "done", measuredDeg: deg, turnRateDegPerSec: this.s.params.turnRateDegPerSec };
    }
    await this.save();
    this.broadcast();
    return Response.json({ ok: true, turnRateDegPerSec: this.s.params.turnRateDegPerSec, calib: this.calib });
  }

  err(ws: WebSocket, message: string) {
    const m: S2C = { t: "error", message };
    try { ws.send(JSON.stringify(m)); } catch {}
  }
}

async function readJson(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

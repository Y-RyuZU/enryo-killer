import { DurableObject } from "cloudflare:workers";
import { C2S, DEFAULT_PARAMS, Mode, Params, Phase, Plate, S2C, SEATS, Seat, Snapshot, Status, DeviceCmd } from "./shared";
import { PULL_STALE_MS, clamp, deviceCmd, step } from "./logic";

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
};
type Attach = { role: "player" | "viewer"; playerId?: string };

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
  };
  // volatile (メモリのみ。プレイ中は alarm で起き続けるので消えない)
  tick = 0;
  powers: Partial<Record<Seat, { power: number; at: number }>> = {};
  tensions: Partial<Record<Seat, number>> = {};
  leaderSeat: Seat | null = null;
  deviceSeq = 0;
  lastDevicePoll = 0;
  lastDevice: DeviceCmd | null = null;

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
        plate: this.s.plate,
        leaderSeat: this.leaderSeat,
        params: this.s.params,
      });
      this.lastDevice = cmd;
      return Response.json(cmd);
    }
    if (path.endsWith("/estop") && req.method === "POST") {
      await this.host("estop");
      return Response.json({ ok: true });
    }
    if (path.endsWith("/state")) return Response.json(this.snapshot());
    return new Response("not found", { status: 404 });
  }

  // ---------- WebSocket (Hibernation API) ----------
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
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
        this.powers[seat] = { power: clamp(Number(msg.power) || 0, 0, 1), at: Date.now() };
        return;
      }
      case "host":
        await this.host(msg.cmd);
        return;
      case "config": {
        if (msg.mode && ["A", "B", "C"].includes(msg.mode)) this.s.mode = msg.mode;
        if (msg.params) {
          for (const [k, v] of Object.entries(msg.params)) {
            if (k in DEFAULT_PARAMS && typeof v === "number" && isFinite(v)) (this.s.params as any)[k] = v;
          }
        }
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
        this.s.phase = "playing";
        await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
      }
    } else if (cmd === "stop") {
      this.s.phase = "lobby";
      this.leaderSeat = null;
    } else if (cmd === "estop") {
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
  }

  async alarm() {
    if (this.s.phase !== "playing" || this.s.estop) return;
    const now = Date.now();
    const powers: Partial<Record<Seat, number>> = {};
    for (const s of SEATS) {
      if (!this.s.seats[s]) continue;
      const p = this.powers[s];
      powers[s] = p && now - p.at < PULL_STALE_MS ? p.power : 0;
    }
    const out = step({ powers, tensions: this.tensions, plate: this.s.plate, params: this.s.params, dt: TICK_MS / 1000 });
    this.tick++;
    this.tensions = out.tensions;
    this.s.plate = out.plate;
    this.leaderSeat = out.leaderSeat;
    if (out.winnerSeat) {
      this.s.winnerSeat = out.winnerSeat;
      this.s.phase = "finished";
      this.leaderSeat = null;
      this.s.plate.speed = 0;
      await this.save();
    } else {
      await this.ctx.storage.setAlarm(now + TICK_MS);
    }
    this.broadcast();
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
      deviceOnline: Date.now() - this.lastDevicePoll < DEVICE_ONLINE_MS,
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
    for (const ws of this.ctx.getWebSockets()) this.sendTo(ws);
  }

  err(ws: WebSocket, message: string) {
    const m: S2C = { t: "error", message };
    try { ws.send(JSON.stringify(m)); } catch {}
  }
}

import { useEffect, useRef, useState, useCallback } from "react";
import type { C2S, S2C, Seat, Snapshot } from "../../server/src/shared";
export * from "../../server/src/shared";

// Tauri で包むときは VITE_API_BASE=https://xxx.workers.dev を指定 (未指定=同一オリジン)
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";
const wsBase = () => {
  if (API_BASE) return API_BASE.replace(/^http/, "ws");
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
};

// QR / 共有に載せる公開オリジン。Tauri (tauri://localhost 等) では共有できないので VITE_API_BASE か本番を使う
const FALLBACK_ORIGIN = "https://ek.ryuzu.dev";
const stripSlash = (s: string) => s.replace(/\/+$/, "");
export const isTauri = () =>
  typeof (window as any).__TAURI_INTERNALS__ !== "undefined" ||
  location.protocol === "tauri:" ||
  location.hostname === "tauri.localhost";
export function publicOrigin(): string {
  const httpish = location.protocol === "http:" || location.protocol === "https:";
  if (httpish && !isTauri()) return stripSlash(location.origin); // 本番 / LAN IP の dev
  return stripSlash(API_BASE || FALLBACK_ORIGIN);
}
export const sanitizeCode = (s: string | null | undefined) =>
  (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
export const joinUrl = (code: string) => `${publicOrigin()}/?room=${encodeURIComponent(code)}`;

export async function createRoom(): Promise<string> {
  const r = await fetch(`${API_BASE}/api/rooms`, { method: "POST" });
  return (await r.json()).code;
}

export function getPlayerId(): string {
  let id = localStorage.getItem("enryo.playerId");
  if (!id) {
    id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem("enryo.playerId", id);
  }
  return id;
}

export function useRoom(code: string | null, role: "player" | "viewer", playerId?: string) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    let timer: number | undefined;
    const open = () => {
      const q = new URLSearchParams({ role, ...(playerId ? { playerId } : {}) });
      const ws = new WebSocket(`${wsBase()}/api/rooms/${encodeURIComponent(code)}/ws?${q}`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data) as S2C;
        if (m.t === "state") setSnap(m.snapshot);
        else if (m.t === "error") { setError(m.message); setTimeout(() => setError(null), 2500); }
      };
      ws.onclose = () => {
        setConnected(false);
        if (alive) timer = window.setTimeout(open, 1000); // 自動再接続
      };
    };
    open();
    return () => { alive = false; clearTimeout(timer); wsRef.current?.close(); setSnap(null); };
  }, [code, role, playerId]);

  const send = useCallback((m: C2S) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);

  return { snap, connected, error, send };
}

export const SEAT_LABEL = { N: "北", E: "東", S: "南", W: "西" } as const;

// ===== デモ用 固定部屋 (部屋作成/コード入力はアーカイブ: /join や ?room= で旧フローも使える) =====
export const DEMO_ROOM = "ABCD"; // 8no の ESP32 もここに繋がっている
/** ?room= があればそれ、無ければ固定のデモ部屋 */
export const roomFromUrl = () => sanitizeCode(new URLSearchParams(location.search).get("room")) || DEMO_ROOM;

// プレイヤー A〜D = 席 北/東/南/西
export type Letter = "A" | "B" | "C" | "D";
export const LETTERS: Letter[] = ["A", "B", "C", "D"];
export const SEAT_LETTER: Record<Seat, Letter> = { N: "A", E: "B", S: "C", W: "D" };
export const LETTER_SEAT: Record<Letter, Seat> = { A: "N", B: "E", C: "S", D: "W" };
export const seatTitle = (s: Seat) => `${SEAT_LETTER[s]}（${SEAT_LABEL[s]}）`;
const roomQs = (code: string) => (code === DEMO_ROOM ? "" : `?room=${encodeURIComponent(code)}`);
export const seatUrl = (seat: Seat, code: string) => `${publicOrigin()}/${SEAT_LETTER[seat].toLowerCase()}${roomQs(code)}`;
export const hostUrl = (code: string) => `${publicOrigin()}/host${roomQs(code)}`;

/** REST 呼び出し (device/cmd, device/xy, device/mode, estop など)。失敗しても例外にせず JSON を返す */
export async function roomApi(code: string, path: string, body?: unknown, method = "POST"): Promise<any> {
  try {
    const r = await fetch(`${API_BASE}/api/rooms/${encodeURIComponent(code)}/${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, ok: r.ok, text }; }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 席を空ける: その席の playerId で一瞬 WS を開いて leave を送る (サーバー変更なしで追い出せる) */
export function kickSeat(code: string, playerId: string): Promise<void> {
  return new Promise((resolve) => {
    const q = new URLSearchParams({ role: "player", playerId });
    const ws = new WebSocket(`${wsBase()}/api/rooms/${encodeURIComponent(code)}/ws?${q}`);
    const done = () => { try { ws.close(); } catch {} resolve(); };
    ws.onopen = () => { ws.send(JSON.stringify({ t: "leave" } satisfies C2S)); setTimeout(done, 300); };
    ws.onerror = done;
    setTimeout(done, 3000);
  });
}

/** テスト用ボット: 指定席に座って power を 8Hz で送り続ける (ホスト画面から 4 人分シミュレート) */
export function useBot(code: string, seat: Seat, enabled: boolean, power: number) {
  const powerRef = useRef(power);
  powerRef.current = power;
  useEffect(() => {
    if (!enabled) return;
    const playerId = `bot-${SEAT_LETTER[seat]}`;
    let alive = true;
    let ws: WebSocket | null = null;
    let iv: number | undefined;
    let retry: number | undefined;
    const open = () => {
      const q = new URLSearchParams({ role: "player", playerId });
      ws = new WebSocket(`${wsBase()}/api/rooms/${encodeURIComponent(code)}/ws?${q}`);
      ws.onopen = () => {
        ws!.send(JSON.stringify({ t: "join", playerId, name: `BOT-${SEAT_LETTER[seat]}`, seat } satisfies C2S));
        iv = window.setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "pull", power: powerRef.current } satisfies C2S));
        }, 125);
      };
      ws.onclose = () => { clearInterval(iv); if (alive) retry = window.setTimeout(open, 1000); };
    };
    open();
    return () => {
      alive = false;
      clearInterval(iv);
      clearTimeout(retry);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "leave" } satisfies C2S));
      setTimeout(() => ws?.close(), 100);
    };
  }, [code, seat, enabled]);
}

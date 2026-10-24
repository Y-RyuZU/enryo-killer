import { useEffect, useRef, useState, useCallback } from "react";
import type { C2S, S2C, Snapshot } from "../../server/src/shared";
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

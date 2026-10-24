import { createRoot } from "react-dom/client";
import "./styles.css";
import { Mobile } from "./Mobile";
import { Sim } from "./Sim";
import { Magnet } from "./Magnet";
import { HostDashboard } from "./HostDashboard";
import { SeatScreen } from "./SeatScreen";
import { Landing } from "./Landing";
import type { Letter } from "./api";

// 超シンプルなルーティング
//   /host        デモ用ホスト/管理ダッシュボード (固定部屋 ABCD, ?room= で上書き)
//   /a /b /c /d  プレイヤー A〜D (北/東/南/西) 画面。コード入力なしで固定部屋に着席
//   /            入口 (ホスト + A〜D へのリンク)
//   --- アーカイブ (残してあるだけ) ---
//   /sim         旧 PC シミュレーター/ホスト (?new=1 で部屋作成)
//   /join, /?room=XXXX  旧: 部屋コード入力 + 席選択
//   /magnet      Plan B 人間磁石
const path = location.pathname.toLowerCase().replace(/\/+$/, "") || "/";
const qs = new URLSearchParams(location.search);
const seatMatch = path.match(/^\/([abcd])$/);

function route() {
  if (path.startsWith("/magnet")) return <Magnet />;
  if (path === "/host" || path === "/admin") return <HostDashboard />;
  if (path.startsWith("/sim") || qs.get("view") === "sim") return <Sim />;
  if (seatMatch) return <SeatScreen letter={seatMatch[1].toUpperCase() as Letter} />;
  const seatQ = (qs.get("seat") ?? "").toUpperCase();
  if (["A", "B", "C", "D"].includes(seatQ)) return <SeatScreen letter={seatQ as Letter} />;
  if (path === "/join" || qs.has("room")) return <Mobile />;
  return <Landing />;
}
createRoot(document.getElementById("root")!).render(route());

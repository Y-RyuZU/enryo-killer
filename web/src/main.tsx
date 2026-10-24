import { createRoot } from "react-dom/client";
import "./styles.css";
import { Mobile } from "./Mobile";
import { Sim } from "./Sim";
import { Magnet } from "./Magnet";

// 超シンプルなルーティング: /sim = PC シミュレーター/ホスト、それ以外 = スマホ
const isSim = location.pathname.startsWith("/sim") || new URLSearchParams(location.search).get("view") === "sim";
const isMagnet = location.pathname.startsWith("/magnet"); // Plan B 人間磁石
createRoot(document.getElementById("root")!).render(isMagnet ? <Magnet /> : isSim ? <Sim /> : <Mobile />);

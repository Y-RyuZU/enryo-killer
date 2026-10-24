import { createRoot } from "react-dom/client";
import "./styles.css";
import { Mobile } from "./Mobile";
import { Sim } from "./Sim";

// 超シンプルなルーティング: /sim = PC シミュレーター/ホスト、それ以外 = スマホ
const isSim = location.pathname.startsWith("/sim") || new URLSearchParams(location.search).get("view") === "sim";
createRoot(document.getElementById("root")!).render(isSim ? <Sim /> : <Mobile />);

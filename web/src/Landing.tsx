import { DEMO_ROOM, LETTERS, LETTER_SEAT, SEAT_LABEL, roomFromUrl } from "./api";
import { Karaage } from "./Karaage";

/** / : デモ用の入口。ホスト画面と A〜D 画面へのリンクだけ */
export function Landing() {
  const code = roomFromUrl();
  const q = code === DEMO_ROOM ? "" : `?room=${code}`;
  return (
    <div className="m-screen landing">
      <header className="brand">
        <div className="brand-sub">関西の「遠慮の塊」を解消する</div>
        <h1>遠慮の塊<br />解消マシン</h1>
      </header>
      <div className="landing-plate"><Karaage size={110} /></div>
      <div className="landing-label">プレイヤーとして参加</div>
      <div className="landing-seats">
        {LETTERS.map((l) => (
          <a key={l} className="landing-seat" href={`/${l.toLowerCase()}${q}`}>
            <b>{l}</b><small>{SEAT_LABEL[LETTER_SEAT[l]]}の席</small>
          </a>
        ))}
      </div>
      <a className="btn big landing-host" href={`/host${q}`}>ホスト / 管理画面</a>
      <div className="landing-foot">
        ROOM {code} · <a href={`/sim${q}`}>旧シミュレーター</a> · <a href="/join">コード入力で参加 (旧)</a> · <a href="/api/docs">API</a>
      </div>
    </div>
  );
}

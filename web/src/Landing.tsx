import { DEMO_ROOM, LETTERS, LETTER_SEAT, SEAT_LABEL, roomFromUrl } from "./api";

/** / : デモ用の入口。ホスト画面と A〜D 画面へのリンクだけ */
export function Landing() {
  const code = roomFromUrl();
  const q = code === DEMO_ROOM ? "" : `?room=${code}`;
  return (
    <div className="m-screen landing">
      <header className="brand">
        <h1 className="landing-logo"><img src="/logo.png" alt="とりしぶ" /></h1>
      </header>
      <div className="landing-seats">
        {LETTERS.map((l) => (
          <a key={l} className={`landing-seat seat-${LETTER_SEAT[l].toLowerCase()}`} href={`/${l.toLowerCase()}${q}`}>
            <img src={`/seat-${LETTER_SEAT[l].toLowerCase()}.png`} alt={`${SEAT_LABEL[LETTER_SEAT[l]]}の席`} />
          </a>
        ))}
      </div>
      <a className="landing-host" href={`/host${q}`}>ホスト / 管理画面</a>
    </div>
  );
}

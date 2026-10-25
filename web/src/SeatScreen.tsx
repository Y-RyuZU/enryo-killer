import { useEffect, useRef, useState } from "react";
import { LETTER_SEAT, Letter, SEAT_LABEL, kickSeat, roomFromUrl, seatTitle, useRoom } from "./api";
import { Rope } from "./Mobile";
import { Karaage } from "./Karaage";

/**
 * /a /b /c /d : プレイヤー A〜D 専用画面。固定のデモ部屋に自動で着席 (コード入力なし)。
 * playerId は席ごとに固定 (seat-A 等) なので、どの端末で開いても同じプレイヤーとして入れる (端末の差し替えが楽)。
 */
export function SeatScreen({ letter }: { letter: Letter }) {
  const seat = LETTER_SEAT[letter];
  const code = roomFromUrl();
  const playerId = `seat-${letter}`;
  const nameKey = `enryo.name.${letter}`;
  const [name, setName] = useState(() => new URLSearchParams(location.search).get("name") || localStorage.getItem(nameKey) || `プレイヤー${letter}`);
  const { snap, connected, error, send } = useRoom(code, "player", playerId);
  const occupant = snap?.seats[seat];
  const takenByOther = !!occupant && occupant.playerId !== playerId;
  const seated = snap?.me?.seat === seat;
  const joinSent = useRef(0);

  useEffect(() => { localStorage.setItem(nameKey, name); }, [name, nameKey]);
  useEffect(() => { document.title = `${letter} | 遠慮の塊`; }, [letter]);

  // 空いていれば自動で着席 (リセット後や再接続後も)
  useEffect(() => {
    if (!snap || !connected || seated || takenByOther) return;
    if (Date.now() - joinSent.current < 800) return;
    joinSent.current = Date.now();
    send({ t: "join", playerId, name, seat });
  }, [snap, connected, seated, takenByOther, send, playerId, name, seat]);

  const rename = () => {
    const n = prompt("なまえ", name)?.trim();
    if (!n) return;
    setName(n.slice(0, 16));
    send({ t: "join", playerId, name: n.slice(0, 16), seat });
  };

  if (snap && seated) return <Rope snap={snap} seat={seat} send={send} connected={connected} title={`${letter}（${SEAT_LABEL[seat]}）`} onTitleClick={rename} />;

  // 接続中 / 着席処理中は「サーバーに接続中」の文字だけ (amu 指示: 他の要素は全部なし)
  if (!snap || !takenByOther) return <div className="seat-connecting">サーバーに接続中</div>;

  return (
    <div className="m-screen join seat-wait">
      <header className="brand">
        <div className="brand-sub">遠慮の塊 解消マシン</div>
        <h1 className="seat-big">{letter}</h1>
        <div className="seat-sub">{SEAT_LABEL[seat]}の席 · ROOM {code}</div>
      </header>
      <Karaage size={120} />
      <p className="hint big">この席は「{occupant!.name}」が使用中</p>
      <button className="btn primary big" onClick={async () => { await kickSeat(code, occupant!.playerId); joinSent.current = 0; }}>
        この端末で {seatTitle(seat)} を使う
      </button>
      {error && <div className="toast">{error}</div>}
    </div>
  );
}

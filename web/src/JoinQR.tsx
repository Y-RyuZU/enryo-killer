import { useEffect, useState } from "react";

// 参加用QR。qrcode は初回表示時に遅延ロード (別 chunk)。プロジェクタでも読めるよう白地に黒固定。
const cache = new Map<string, string>(); // url -> dataURL

function useQr(url: string) {
  const [src, setSrc] = useState<string | null>(() => cache.get(url) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const hit = cache.get(url);
    if (hit) { setSrc(hit); setFailed(false); return; }
    let alive = true;
    setSrc(null);
    (async () => {
      const { toDataURL } = await import("qrcode");
      const d = await toDataURL(url, {
        errorCorrectionLevel: "M", // URL が短いので M でモジュールを大きく
        margin: 2,
        width: 1024, // 高解像度で作って CSS で縮小
        color: { dark: "#000000", light: "#ffffff" },
      });
      cache.set(url, d);
      if (alive) { setSrc(d); setFailed(false); }
    })().catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [url]);
  return { src, failed };
}

export function JoinQR({ url }: { url: string }) {
  const { src, failed } = useQr(url);
  if (failed) return <div className="qr-fallback">QR生成失敗<br />URLを入力してね</div>;
  return <div className="qr-box">{src ? <img className="qr-img" src={src} alt={`参加用QR: ${url}`} /> : <div className="qr-skel" />}</div>;
}

export function JoinQROverlay({ url, code, onClose }: { url: string; code: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="qr-overlay" role="dialog" aria-modal="true" aria-label="参加用QRコード" onClick={onClose}>
      <div className="qr-overlay-inner">
        <div className="qr-overlay-title">スマホで読み取って参加！</div>
        <JoinQR url={url} />
        <div className="qr-overlay-code">{code}</div>
        <div className="qr-overlay-url">{url}</div>
        <div className="qr-overlay-hint">クリック / Esc / Q で閉じる</div>
      </div>
    </div>
  );
}

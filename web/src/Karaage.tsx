// 唐揚げ1個 on 皿 (SVG)
export function Karaage({ size = 80 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-50 -50 100 100">
      <ellipse rx="46" ry="46" fill="#f6f1e7" stroke="#c9bfae" strokeWidth="3" />
      <ellipse rx="36" ry="36" fill="none" stroke="#2f5f8a" strokeWidth="2" strokeDasharray="4 5" />
      <path d="M-20 -6 C-24 -22 -4 -28 6 -22 C20 -26 28 -10 22 2 C28 16 12 26 0 22 C-14 28 -26 14 -20 -6 Z" fill="#c8731f" stroke="#8a4a12" strokeWidth="2.5" />
      <path d="M-10 -10 q6 -4 12 0 M4 4 q6 -2 8 4 M-12 6 q4 4 10 2" stroke="#e7a24a" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M18 -26 l14 -6 l-4 14 z" fill="#f2d649" stroke="#b39b1c" strokeWidth="1.5" />
    </svg>
  );
}

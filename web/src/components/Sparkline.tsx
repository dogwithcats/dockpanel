import { useId } from 'react';

/** Minimal area sparkline. `max` fixes the Y scale (e.g. 100 for percentages). */
export function Sparkline({
  data,
  color = 'var(--accent)',
  max,
  height = 54,
  className = 'chart',
  points = 60,
}: {
  data: number[];
  color?: string;
  max?: number;
  height?: number;
  className?: string;
  points?: number;
}) {
  const id = useId();
  const w = 300;
  const h = height;
  const series = data.slice(-points);
  const top = Math.max(max ?? 0, ...series, 1e-9) * (max ? 1 : 1.15);
  const step = w / Math.max(1, points - 1);
  const offset = (points - series.length) * step;
  const xy = series.map((v, i) => [offset + i * step, h - 2 - (Math.max(0, v) / top) * (h - 6)] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = xy.length ? `${line} L${xy[xy.length - 1][0].toFixed(1)},${h} L${xy[0][0].toFixed(1)},${h} Z` : '';

  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {xy.length > 1 && (
        <>
          <path d={area} fill={`url(#${id})`} />
          <path d={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

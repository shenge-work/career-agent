/* =============================================================
 * N14 · 成长页纯 SVG 图表（零依赖，严格黑白灰）。
 * 状态区分只用灰阶深浅 + 线型（实线/虚线）+ 加粗，不使用任何彩色 token。
 * ============================================================= */

const GRAY = {
  grid: '#ebebeb',
  axis: '#bbb',
  text: '#777',
  line0: '#1a1a1a',
  line1: '#555',
  line2: '#999',
  line3: '#bbb',
  fill: '#e0e0e0',
  fillStrong: '#999',
};

/** 折线图：lines[i].values 为按时间序的档位序列（1~4），x 轴为场次序号。 */
export function LineTrend({
  lines,
  height = 200,
}: {
  lines: Array<{ label: string; values: number[] }>;
  height?: number;
}) {
  const width = 640;
  const padL = 34;
  const padR = 12;
  const padT = 16;
  const padB = 30;
  const maxX = Math.max(1, ...lines.map((l) => l.values.length)) - 1 || 1;
  const minY = 1;
  const maxY = 4;

  const x = (i: number) => padL + (maxX === 0 ? 0 : (i / maxX) * (width - padL - padR));
  const y = (v: number) => padT + ((maxY - v) / (maxY - minY)) * (height - padT - padB);

  const yTicks = [1, 2, 3, 4];
  const dashStyles = ['', '6 4', '2 3', '1 4'];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="iv-chart" role="img" aria-label="维度趋势折线图">
      {/* 网格与 Y 轴刻度 */}
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke={GRAY.grid} strokeWidth={1} />
          <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill={GRAY.text}>
            {t}
          </text>
        </g>
      ))}
      {/* X 轴 */}
      <line x1={padL} x2={width - padR} y1={y(minY)} y2={y(minY)} stroke={GRAY.axis} strokeWidth={1} />

      {lines.map((line, li) => {
        const pts = line.values
          .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
          .join(' ');
        const color = [GRAY.line0, GRAY.line1, GRAY.line2, GRAY.line3][li % 4];
        return (
          <g key={li}>
            <polyline
              points={pts}
              fill="none"
              stroke={color}
              strokeWidth={li === 0 ? 2 : 1.4}
              strokeDasharray={dashStyles[li % dashStyles.length]}
            />
            {line.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={li === 0 ? 2.4 : 1.8} fill={color} />
            ))}
          </g>
        );
      })}

      {/* 图例 */}
      {lines.map((line, li) => (
        <text
          key={li}
          x={padL + li * 110}
          y={height - 8}
          fontSize={10}
          fill={GRAY.text}
        >
          <tspan stroke={[GRAY.line0, GRAY.line1, GRAY.line2, GRAY.line3][li % 4]} strokeDasharray={dashStyles[li % dashStyles.length]}>
            ──
          </tspan>{' '}
          {line.label}
        </text>
      ))}
    </svg>
  );
}

/** 雷达图：labels 为维度名，first/recent 为 1~4 档（浅灰=首次，深灰+粗描边=最近）。 */
export function RadarChart({
  labels,
  first,
  recent,
  size = 260,
}: {
  labels: string[];
  first: Array<number | null>;
  recent: Array<number | null>;
  size?: number;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const rMax = size / 2 - 40;
  const n = labels.length;
  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pt = (i: number, level: number | null) => {
    const r = level == null ? 0 : (Math.max(1, Math.min(4, level)) / 4) * rMax;
    return [cx + Math.cos(angle(i)) * r, cy + Math.sin(angle(i)) * r] as const;
  };

  const poly = (vals: Array<number | null>, fill: string, stroke: string, w: number) =>
    vals
      .map((v, i) => {
        const [px, py] = pt(i, v);
        return `${px.toFixed(1)},${py.toFixed(1)}`;
      })
      .join(' ');

  const rings = [1, 2, 3, 4];

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" className="iv-chart" role="img" aria-label="能力雷达图">
      {rings.map((r) => (
        <polygon
          key={r}
          points={labels
            .map((_, i) => {
              const [px, py] = pt(i, r);
              return `${px.toFixed(1)},${py.toFixed(1)}`;
            })
            .join(' ')}
          fill="none"
          stroke={GRAY.grid}
          strokeWidth={1}
        />
      ))}
      {labels.map((_, i) => {
        const [px, py] = pt(i, 4);
        return <line key={i} x1={cx} y1={cy} x2={px} y2={py} stroke={GRAY.grid} strokeWidth={1} />;
      })}

      <polygon points={poly(first, GRAY.fill, GRAY.fill, 1)} fill={GRAY.fill} fillOpacity={0.5} stroke={GRAY.fillStrong} strokeWidth={1} strokeDasharray="3 3" />
      <polygon points={poly(recent, GRAY.fill, GRAY.line0, 2)} fill="none" stroke={GRAY.line0} strokeWidth={2} />

      {labels.map((label, i) => {
        const [px, py] = pt(i, 4.55);
        return (
          <text
            key={i}
            x={px}
            y={py}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={11}
            fill={GRAY.text}
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}

/** 练习日历：深灰=练过，浅灰=未练；累计口径，中断不清零。 */
export function PracticeCalendar({ days, weeks = 16 }: { days: string[]; weeks?: number }) {
  const set = new Set(days);
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end.getTime() - (weeks * 7 - 1) * 86400000);

  const cols: Date[] = [];
  for (let i = 0; i < weeks; i += 1) {
    for (let d = 0; d < 7; d += 1) {
      cols.push(new Date(start.getTime() + (i * 7 + d) * 86400000));
    }
  }

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  return (
    <div className="iv-calendar" aria-label="练习日历">
      {cols.map((d, i) => {
        const active = set.has(fmt(d));
        return (
          <span
            key={i}
            className={'iv-cal-cell' + (active ? ' on' : '')}
            title={fmt(d)}
          />
        );
      })}
    </div>
  );
}

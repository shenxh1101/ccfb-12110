import { esc, formatNumber } from './dom.js';

export function edgeChartSvg(curve = []) {
  const width = 820;
  const height = 280;
  const margin = { top: 18, right: 22, bottom: 34, left: 52 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  if (!curve || curve.length === 0) {
    return `<div class="empty"><div class="empty-icon">📈</div><h3>还没有覆盖率曲线</h3><p>启动 Fuzz 后，这里会按执行数记录唯一边数增长。</p></div>`;
  }

  const xs = curve.map((p) => p.x ?? p.mutation ?? 0);
  const edges = curve.map((p) => p.edges ?? 0);
  const crashes = curve.map((p) => p.crashes ?? 0);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const maxEdges = Math.max(...edges, 1);
  const maxCrashes = Math.max(...crashes, 1);

  const x = (v) => margin.left + ((v - minX) / Math.max(1, maxX - minX)) * innerW;
  const yEdge = (v) => margin.top + innerH - (v / maxEdges) * innerH;
  const yCrash = (v) => margin.top + innerH - (v / maxCrashes) * innerH;

  const edgePath = curve.map((p, i) => `${i ? 'L' : 'M'}${x(p.x ?? 0).toFixed(1)},${yEdge(p.edges ?? 0).toFixed(1)}`).join(' ');
  const areaPath = `${edgePath} L${x(maxX).toFixed(1)},${(margin.top + innerH).toFixed(1)} L${x(minX).toFixed(1)},${(margin.top + innerH).toFixed(1)} Z`;
  const crashPath = curve.map((p, i) => `${i ? 'L' : 'M'}${x(p.x ?? 0).toFixed(1)},${yCrash(p.crashes ?? 0).toFixed(1)}`).join(' ');

  const gridValues = [0, 0.25, 0.5, 0.75, 1];
  const grid = gridValues
    .map((t) => {
      const y = margin.top + innerH * (1 - t);
      const value = Math.round(maxEdges * t);
      return `
        <line x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}" stroke="#243142" stroke-width="1" stroke-dasharray="${t === 0 ? '0' : '4 5'}"/>
        <text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" fill="#64748b" font-size="11" font-family="ui-monospace, monospace">${formatNumber(value)}</text>`;
    })
    .join('');

  const last = curve[curve.length - 1];
  return `
  <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="edge coverage curve">
    <defs>
      <linearGradient id="edgeFill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#c8ff3d" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#c8ff3d" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    <path d="${areaPath}" fill="url(#edgeFill)"/>
    <path d="${edgePath}" fill="none" stroke="#c8ff3d" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <path d="${crashPath}" fill="none" stroke="#ff5d6c" stroke-width="1.8" stroke-dasharray="6 4" opacity="0.8" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(last.x ?? 0)}" cy="${yEdge(last.edges ?? 0)}" r="4.5" fill="#c8ff3d" stroke="#0b0f14" stroke-width="2"/>
    <text x="${margin.left}" y="${height - 10}" fill="#64748b" font-size="11" font-family="ui-monospace, monospace">${formatNumber(minX)} exec</text>
    <text x="${width - margin.right}" y="${height - 10}" text-anchor="end" fill="#64748b" font-size="11" font-family="ui-monospace, monospace">${formatNumber(maxX)} exec</text>
    <text x="${x(last.x ?? 0) - 8}" y="${yEdge(last.edges ?? 0) - 10}" text-anchor="end" fill="#c8ff3d" font-size="12" font-weight="800" font-family="ui-monospace, monospace">${esc(last.edges)}</text>
  </svg>
  <div class="chart-legend">
    <span class="legend-key"><i class="legend-line"></i>唯一边数</span>
    <span class="legend-key"><i class="legend-line crash"></i>去重崩溃数（独立纵轴）</span>
  </div>`;
}

export function sparkline(values = []) {
  if (!values || values.length < 2) return '<span class="spark">—</span>';
  const w = 120;
  const h = 34;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const d = values
    .map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / Math.max(1, max - min)) * (h - 6)).toFixed(1)}`)
    .join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
}

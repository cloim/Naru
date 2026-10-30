import React, { useEffect, useRef, useState } from 'react';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Tooltip,
  Filler,
} from 'chart.js';
import { t } from '../i18n.js';
import { cn, tw } from '../tw.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Filler);
const time = (value) => new Date(value).toLocaleTimeString();

export default function ResourceChart({
  title,
  points,
  field,
  format,
  color = '#35664d',
  ceiling = 0,
  compact = false,
}) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const activeIndex = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const current = points.at(-1)?.[field];
  const hasData = points.some((point) => Number.isFinite(point[field]));

  useEffect(() => {
    const chart = new Chart(canvasRef.current, {
      type: 'line',
      data: { datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: {
            type: 'linear',
            grid: { display: false },
            ticks: {
              display: !compact,
              maxTicksLimit: 3,
              maxRotation: 0,
              color: '#69776d',
              font: { size: 10 },
              callback: (value) => time(value),
            },
          },
          y: {
            beginAtZero: true,
            grid: { display: !compact, color: '#e5ebe2' },
            ticks: { display: !compact, maxTicksLimit: 4, color: '#69776d', font: { size: 10 } },
            border: { display: false },
          },
        },
        plugins: {
          tooltip: {
            enabled: false,
            external: ({ tooltip: model }) => {
              const point = model.opacity ? model.dataPoints?.[0] : null;
              activeIndex.current = point?.dataIndex ?? null;
              setTooltip(point ? { timestamp: point.parsed.x, value: point.parsed.y } : null);
            },
          },
        },
      },
    });
    chartRef.current = chart;
    return () => {
      chartRef.current = null;
      chart.destroy();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    chart.data.datasets = [
      {
        label: title,
        data: points.map((point) => ({
          x: point.timestamp,
          y: Number.isFinite(point[field]) ? point[field] : null,
        })),
        borderColor: color,
        borderWidth: 2,
        pointRadius: compact ? 0 : 2,
        fill: compact ? 'origin' : false,
        backgroundColor: compact ? color + '1f' : color,
        pointHoverRadius: 4,
        spanGaps: false,
      },
    ];
    chart.options.scales.y.suggestedMax = ceiling || undefined;
    const start = points[0]?.timestamp || Date.now();
    chart.options.scales.x.min = start;
    chart.options.scales.x.max = Math.max(points.at(-1)?.timestamp || start, start + 1000);
    chart.options.scales.y.ticks.callback = (value) => format(value);
    chart.update('none');
    // Do not leave a tooltip referring to a different sample after polling or scope changes.
    chart.setActiveElements([]);
    chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    setTooltip(null);
    activeIndex.current = null;
  }, [points, field, title, format, color, ceiling]);

  function showPoint(direction = 0) {
    const chart = chartRef.current;
    const indices = points.flatMap((point, index) =>
      Number.isFinite(point[field]) ? [index] : [],
    );
    if (!indices.length) return;
    const position =
      activeIndex.current === null ? indices.length - 1 : indices.indexOf(activeIndex.current);
    const index = indices[Math.max(0, Math.min(indices.length - 1, position + direction))];
    const point = chart.getDatasetMeta(0).data[index];
    chart.setActiveElements([{ datasetIndex: 0, index }]);
    chart.tooltip.setActiveElements([{ datasetIndex: 0, index }], { x: point.x, y: point.y });
    chart.update('none');
  }
  function hideTooltip() {
    const chart = chartRef.current;
    chart.setActiveElements([]);
    chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    chart.update('none');
    activeIndex.current = null;
    setTooltip(null);
  }
  return (
    <section className={cn(tw.panel, compact ? 'px-4 py-3.5' : 'p-5')}>
      <div className="flex items-center justify-between gap-3">
        <h3 className={cn('font-semibold', compact ? 'text-[12px] text-muted' : 'text-[13px]')}>
          {title}
        </h3>
        <strong
          className={cn(
            'tabular-nums',
            compact ? 'font-display text-[20px] text-ink' : 'font-mono text-[18px]',
          )}
          style={compact ? undefined : { color }}
        >
          {Number.isFinite(current) ? (
            format(current)
          ) : (
            <span className={compact ? 'font-sans text-[12px] font-medium text-muted' : ''}>
              {t('수집 중')}
            </span>
          )}
        </strong>
      </div>
      {!compact && <p className="mt-3 text-right text-[11px] text-muted">{t('최근 5분')}</p>}
      <div className={cn('relative mt-2 min-w-0', compact ? 'h-[84px]' : 'h-[170px]')}>
        <canvas
          ref={canvasRef}
          role="img"
          tabIndex={0}
          aria-label={`${title}: ${Number.isFinite(current) ? format(current) : t('수집 중')}`}
          onFocus={() => showPoint()}
          onBlur={hideTooltip}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              showPoint(event.key === 'ArrowLeft' ? -1 : 1);
            }
            if (event.key === 'Escape') hideTooltip();
          }}
        />
        {tooltip && (
          <div
            role="tooltip"
            className="pointer-events-none absolute right-2 top-1 z-10 max-w-full rounded-md border border-line bg-console px-3 py-2 text-xs text-white shadow-lg"
          >
            {time(tooltip.timestamp)} | {title}: {format(tooltip.value)}
          </div>
        )}
        {!hasData && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-muted">
            {t('리소스 사용량을 아직 수집하지 못했습니다.')}
          </div>
        )}
      </div>
    </section>
  );
}

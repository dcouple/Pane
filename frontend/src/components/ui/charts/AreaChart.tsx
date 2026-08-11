import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { linearScale, niceMax, niceTicks } from './chartScales';

export interface AreaSeries {
  label: string;
  color: string;
  /** One value per point, aligned with `labels`. */
  values: number[];
}

export interface AreaChartProps {
  labels: string[];
  series: AreaSeries[];
  /** Formats y-axis ticks, tooltip values and the accessible summary. */
  formatValue: (value: number) => string;
  height?: number;
  /** Sentence describing the data for screen readers. */
  ariaLabel: string;
  /** Stack series on top of each other instead of overlaying them. */
  stacked?: boolean;
}

const PADDING = { top: 8, right: 8, bottom: 20, left: 44 };
const VIEW_WIDTH = 640;

/**
 * Stacked or overlaid area chart drawn as plain SVG, with a hover readout.
 *
 * Accessibility: the `<svg>` is a single `role="img"` with a summarising
 * label rather than a grid of focusable points — there is nothing to activate,
 * so exposing hundreds of tab stops would only get in the way. The hover
 * readout is a pointer convenience on top of that, not the only route to the
 * numbers; the page states its totals in text as well.
 */
export function AreaChart({
  labels,
  series,
  formatValue,
  height = 200,
  ariaLabel,
  stacked = true,
}: AreaChartProps) {
  const gradientId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  /** Index of the point under the pointer, or null when the pointer is away. */
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const innerWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
  const innerHeight = height - PADDING.top - PADDING.bottom;

  const { paths, ticks, max, stackedTops } = useMemo(() => {
    const pointCount = labels.length;
    if (pointCount === 0 || series.length === 0) {
      return {
        paths: [] as Array<{ area: string; line: string; color: string }>,
        ticks: [0, 1],
        max: 1,
        stackedTops: [] as number[][],
      };
    }

    // Running baseline per x position; stays at zero when not stacking.
    const baseline = new Array<number>(pointCount).fill(0);
    const tops: number[][] = [];

    for (const entry of series) {
      const seriesTops = entry.values.map((value, index) => (stacked ? baseline[index] + value : value));
      if (stacked) seriesTops.forEach((top, index) => { baseline[index] = top; });
      tops.push(seriesTops);
    }

    const peak = Math.max(1, ...tops.flat());
    const axisMax = niceMax(peak);

    const x = (index: number) =>
      pointCount === 1
        ? PADDING.left + innerWidth / 2
        : linearScale(index, 0, pointCount - 1, PADDING.left, PADDING.left + innerWidth);
    const y = (value: number) =>
      linearScale(value, 0, axisMax, PADDING.top + innerHeight, PADDING.top);

    const built = series.map((entry, seriesIndex) => {
      const seriesTops = tops[seriesIndex];
      const bottoms = stacked
        ? (seriesIndex === 0 ? new Array<number>(pointCount).fill(0) : tops[seriesIndex - 1])
        : new Array<number>(pointCount).fill(0);

      const line = seriesTops
        .map((value, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(value)}`)
        .join(' ');
      const back = bottoms
        .map((value, index) => ({ value, index }))
        .reverse()
        .map(({ value, index }) => `L ${x(index)} ${y(value)}`)
        .join(' ');

      return { area: `${line} ${back} Z`, line, color: entry.color };
    });

    return { paths: built, ticks: niceTicks(peak), max: axisMax, stackedTops: tops };
  }, [labels, series, stacked, innerHeight, innerWidth]);

  /**
   * Snap the pointer to the nearest data point.
   *
   * The SVG is stretched to its box, so the maths goes through the rendered
   * rect rather than the viewBox: fraction across the element, back into
   * viewBox units, then invert the x scale. Bound on the wrapping element so
   * the whole card responds — chasing a 1.5px line with the mouse is not a
   * reading experience.
   */
  const handlePointer = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || labels.length === 0) return;

    const viewX = ((clientX - rect.left) / rect.width) * VIEW_WIDTH;
    const ratio = labels.length === 1 ? 0 : (viewX - PADDING.left) / innerWidth;
    const index = Math.round(ratio * (labels.length - 1));
    setHoverIndex(Math.min(Math.max(index, 0), labels.length - 1));
  }, [labels.length, innerWidth]);

  if (labels.length === 0) {
    return (
      <p className="py-8 text-center text-xs text-text-muted">No data in this range.</p>
    );
  }

  const hoverX = hoverIndex === null
    ? 0
    : labels.length === 1
      ? PADDING.left + innerWidth / 2
      : linearScale(hoverIndex, 0, labels.length - 1, PADDING.left, PADDING.left + innerWidth);
  /** Keep the tooltip inside the box when hovering near the right edge. */
  const tooltipOnLeft = hoverX > PADDING.left + innerWidth * 0.6;

  return (
    <div
      ref={containerRef}
      className="relative"
      onPointerMove={event => handlePointer(event.clientX)}
      onPointerLeave={() => setHoverIndex(null)}
    >
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="none"
      >
        <defs>
          {paths.map((path, index) => (
            <linearGradient key={index} id={`${gradientId}-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={path.color} stopOpacity={0.45} />
              <stop offset="100%" stopColor={path.color} stopOpacity={0.05} />
            </linearGradient>
          ))}
        </defs>

        {/* Gridlines and y-axis labels */}
        {ticks.map(tick => {
          const y = linearScale(tick, 0, max, PADDING.top + innerHeight, PADDING.top);
          return (
            <g key={tick}>
              <line
                x1={PADDING.left}
                y1={y}
                x2={PADDING.left + innerWidth}
                y2={y}
                stroke="currentColor"
                strokeWidth={0.5}
                className="text-border-secondary"
                opacity={0.5}
              />
              <text
                x={PADDING.left - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-current text-text-muted"
                style={{ fontSize: 9 }}
              >
                {formatValue(tick)}
              </text>
            </g>
          );
        })}

        {paths.map((path, index) => (
          <g key={index}>
            <path d={path.area} fill={`url(#${gradientId}-${index})`} />
            <path d={path.line} fill="none" stroke={path.color} strokeWidth={1.5} />
          </g>
        ))}

        {/* Crosshair on the hovered point, with a dot where each line runs */}
        {hoverIndex !== null && (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              y1={PADDING.top}
              x2={hoverX}
              y2={PADDING.top + innerHeight}
              stroke="currentColor"
              strokeWidth={0.75}
              className="text-text-muted"
            />
            {series.map((entry, index) => (
              <circle
                key={entry.label}
                cx={hoverX}
                cy={linearScale(
                  stackedTops[index]?.[hoverIndex] ?? 0,
                  0,
                  max,
                  PADDING.top + innerHeight,
                  PADDING.top
                )}
                r={2}
                fill={entry.color}
              />
            ))}
          </g>
        )}

        {/* First and last x labels only — a dense axis is unreadable at this size */}
        <text x={PADDING.left} y={height - 6} className="fill-current text-text-muted" style={{ fontSize: 9 }}>
          {labels[0]}
        </text>
        {labels.length > 1 && (
          <text
            x={PADDING.left + innerWidth}
            y={height - 6}
            textAnchor="end"
            className="fill-current text-text-muted"
            style={{ fontSize: 9 }}
          >
            {labels[labels.length - 1]}
          </text>
        )}
      </svg>

      {/*
        Tooltip as HTML rather than SVG text: the chart stretches to fit its box
        and anything inside the viewBox stretches with it, type included.
      */}
      {hoverIndex !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[9rem] rounded border border-border-primary bg-surface-primary/95 px-2 py-1.5 shadow-lg"
          style={tooltipOnLeft
            ? { right: `${(1 - hoverX / VIEW_WIDTH) * 100 + 2}%` }
            : { left: `${(hoverX / VIEW_WIDTH) * 100 + 2}%` }}
        >
          <p className="mb-1 text-[10px] font-medium text-text-primary">{labels[hoverIndex]}</p>
          <ul className="space-y-0.5">
            {series.map(entry => (
              <li key={entry.label} className="flex items-center gap-1.5 text-[10px] text-text-secondary">
                <span
                  className="h-1.5 w-1.5 flex-shrink-0 rounded-sm"
                  style={{ backgroundColor: entry.color }}
                  aria-hidden="true"
                />
                <span className="flex-1 truncate">{entry.label}</span>
                <span className="tabular-nums text-text-primary">
                  {formatValue(entry.values[hoverIndex] ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default AreaChart;

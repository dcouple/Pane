import { arcPath } from './chartScales';

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

export interface DonutChartProps {
  slices: DonutSlice[];
  formatValue: (value: number) => string;
  ariaLabel: string;
  /** Large text in the middle of the ring. */
  centerLabel?: string;
  centerSublabel?: string;
  size?: number;
}

/**
 * Donut chart plus legend. The ring is decorative — every number it encodes is
 * also printed in the legend, so the SVG itself is `aria-hidden` and the whole
 * figure carries one summary label.
 */
export function DonutChart({
  slices,
  formatValue,
  ariaLabel,
  centerLabel,
  centerSublabel,
  size = 132,
}: DonutChartProps) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const center = size / 2;
  const outerRadius = center - 2;
  const innerRadius = outerRadius * 0.62;

  let cursor = 0;
  const arcs = slices.map(slice => {
    const fraction = total > 0 ? slice.value / total : 0;
    const path = arcPath(center, center, outerRadius, innerRadius, cursor, cursor + fraction);
    cursor += fraction;
    return { ...slice, path, fraction };
  });

  return (
    <figure className="flex items-center gap-4" aria-label={ariaLabel}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="flex-shrink-0">
        {total === 0 ? (
          <circle
            cx={center}
            cy={center}
            r={(outerRadius + innerRadius) / 2}
            fill="none"
            stroke="currentColor"
            strokeWidth={outerRadius - innerRadius}
            className="text-surface-tertiary"
          />
        ) : (
          arcs.map(arc => arc.path && <path key={arc.label} d={arc.path} fill={arc.color} />)
        )}

        {centerLabel && (
          <text
            x={center}
            y={center - 1}
            textAnchor="middle"
            className="fill-current text-text-primary"
            style={{ fontSize: 15, fontWeight: 600 }}
          >
            {centerLabel}
          </text>
        )}
        {centerSublabel && (
          <text
            x={center}
            y={center + 12}
            textAnchor="middle"
            className="fill-current text-text-muted"
            style={{ fontSize: 9 }}
          >
            {centerSublabel}
          </text>
        )}
      </svg>

      <figcaption className="min-w-0 flex-1">
        <ul className="space-y-1">
          {arcs.map(arc => (
            <li key={arc.label} className="flex items-center gap-2 text-[11px]">
              <span
                className="h-2 w-2 flex-shrink-0 rounded-sm"
                style={{ backgroundColor: arc.color }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-text-secondary">{arc.label}</span>
              <span className="flex-shrink-0 tabular-nums text-text-tertiary">
                {formatValue(arc.value)}
              </span>
              <span className="w-9 flex-shrink-0 text-right tabular-nums text-text-muted">
                {total > 0 ? `${Math.round(arc.fraction * 100)}%` : '—'}
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

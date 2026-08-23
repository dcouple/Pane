import { arcPath, formatTokens } from '../ui/charts/chartScales';
import type { UsageWindow } from '../../../../shared/types/usage';

const SIZE = 148;
/** Three-quarter dial: leaves a gap at the bottom for the reset label. */
const SWEEP = 0.75;

function utilizationColor(utilization: number): string {
  if (utilization >= 0.9) return 'var(--color-status-error, #e05a6b)';
  if (utilization >= 0.7) return 'var(--color-status-warning, #e0913a)';
  return 'var(--color-status-success, #37b877)';
}

function formatReset(resetsAtMs: number | null): string {
  if (!resetsAtMs) return 'No activity in this window';
  const remainingMs = resetsAtMs - Date.now();
  if (remainingMs <= 0) return 'Window has reset';

  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.round((remainingMs % 3_600_000) / 60_000);
  return hours > 0 ? `Oldest usage ages out in ${hours}h ${minutes}m` : `Oldest usage ages out in ${minutes}m`;
}

/**
 * What the current pace means for the window.
 *
 * The window total alone is a state, not a direction: 10% full and idle is a
 * different situation from 10% full and climbing. The last hour is the honest
 * proxy for "right now" — extrapolating from the 5-hour average would smooth
 * away exactly the burst the user is asking about.
 */
function formatPace(usageWindow: UsageWindow): string | null {
  const perHour = usageWindow.recentHourTokens;
  if (perHour <= 0) return 'Nothing in the last hour';

  const rate = `${formatTokens(perHour)}/h in the last hour`;
  const limit = usageWindow.limitTokens;
  if (limit === null) return rate;

  const remaining = limit - usageWindow.totals.totalTokens;
  if (remaining <= 0) return `${rate} · at the limit`;

  const hoursToFull = remaining / perHour;
  if (hoursToFull > usageWindow.windowHours) return `${rate} · well inside the limit`;

  return hoursToFull < 1
    ? `${rate} · limit in under an hour`
    : `${rate} · limit in ~${Math.round(hoursToFull)}h`;
}

export interface LimitGaugeProps {
  window: UsageWindow;
}

/**
 * Rolling-window utilisation dial.
 *
 * When no limit is configured the backend falls back to the largest window
 * ever observed. That is a lower bound, not the real cap, so the source is
 * labelled explicitly rather than presented as an authoritative quota.
 */
export function LimitGauge({ window: usageWindow }: LimitGaugeProps) {
  const center = SIZE / 2;
  const outerRadius = center - 4;
  const innerRadius = outerRadius * 0.72;
  const utilization = usageWindow.utilization ?? 0;
  const hasLimit = usageWindow.utilization !== null && usageWindow.limitTokens !== null;
  const pace = formatPace(usageWindow);

  // The dial starts at the lower-left so its gap sits at the bottom.
  const startFraction = (1 - SWEEP) / 2 + 0.5;
  const track = arcPath(center, center, outerRadius, innerRadius, 0, SWEEP);
  const filled = hasLimit
    ? arcPath(center, center, outerRadius, innerRadius, 0, SWEEP * utilization)
    : '';

  const summary = hasLimit
    ? `${Math.round(utilization * 100)}% of the ${usageWindow.windowHours}-hour window used`
    : `${formatTokens(usageWindow.totals.totalTokens)} tokens used in the last ${usageWindow.windowHours} hours; no limit known`;

  return (
    <div className="flex flex-col items-center">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={summary}
        style={{ transform: `rotate(${startFraction * 360}deg)` }}
      >
        <path d={track} className="fill-current text-surface-tertiary" />
        {filled && <path d={filled} fill={utilizationColor(utilization)} />}
      </svg>

      {/* Text sits outside the rotated SVG so it stays upright. */}
      <div className="-mt-[5.6rem] mb-8 flex flex-col items-center">
        <span className="text-2xl font-semibold tabular-nums text-text-primary">
          {hasLimit ? `${Math.round(utilization * 100)}%` : '—'}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          {usageWindow.windowHours}h window
        </span>
      </div>

      <p className="text-center text-[11px] text-text-secondary">
        {formatTokens(usageWindow.totals.totalTokens)} tokens
        {usageWindow.limitTokens !== null && (
          <> of ~{formatTokens(usageWindow.limitTokens)}</>
        )}
      </p>
      <p className="mt-0.5 text-center text-[10px] text-text-muted">{formatReset(usageWindow.resetsAtMs)}</p>
      {pace && (
        <p className="mt-0.5 text-center text-[10px] font-medium text-text-secondary">{pace}</p>
      )}
      {usageWindow.limitSource === 'observed-max' && (
        <p className="mt-1 max-w-[16rem] text-center text-[10px] text-text-muted">
          No limit set — comparing against your highest recorded {usageWindow.windowHours}h window.
        </p>
      )}
      {usageWindow.limitSource === 'unknown' && (
        <p className="mt-1 max-w-[16rem] text-center text-[10px] text-text-muted">
          Not enough history yet to estimate a limit.
        </p>
      )}
    </div>
  );
}

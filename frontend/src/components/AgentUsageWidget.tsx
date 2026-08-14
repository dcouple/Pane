import { RefreshCw } from 'lucide-react';
import type { AgentUsageLimit } from '../../../shared/types/agentUsage';
import { useAgentUsage } from '../hooks/useAgentUsage';
import { cn } from '../utils/cn';
import { OpenAIIcon } from './ui/BrandIcons';
import { Tooltip } from './ui/Tooltip';

interface AgentUsageWidgetProps {
  sessionId: string;
  compact?: boolean;
}

function formatResetTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function usageColor(remainingPercent: number): string {
  if (remainingPercent <= 20) return 'bg-status-error';
  if (remainingPercent <= 40) return 'bg-status-warning';
  return 'bg-status-success';
}

function UsageLimitRow({ limit, compact }: { limit: AgentUsageLimit; compact: boolean }) {
  const resetTime = formatResetTime(limit.resetsAt);
  return (
    <div className={cn('min-w-0', compact && 'w-44 flex-shrink-0')}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-text-secondary" title={limit.name}>{limit.name}</span>
        <span className="flex-shrink-0 font-medium text-text-primary">{limit.remainingPercent}% left</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${limit.name} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={limit.remainingPercent}
        className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-surface-tertiary"
      >
        <div
          className={cn('h-full transition-[width] duration-300', usageColor(limit.remainingPercent))}
          style={{ width: `${limit.remainingPercent}%` }}
        />
      </div>
      {resetTime && <div className="mt-1 text-[10px] text-text-tertiary">Resets {resetTime}</div>}
    </div>
  );
}

export function AgentUsageWidget({ sessionId, compact = false }: AgentUsageWidgetProps) {
  const { snapshot, isLoading, error, refresh } = useAgentUsage(sessionId, true);
  const provider = snapshot?.providers.find(item => item.id === 'codex');
  const unavailableMessage = error || provider?.error;

  return (
    <section
      aria-label="Codex usage"
      className={cn(
        'border-b border-border-primary',
        compact ? 'flex items-center gap-4 overflow-x-auto px-3 py-2' : 'px-3 py-2',
      )}
    >
      <div className={cn('flex min-w-0 items-center gap-2', compact ? 'w-44 flex-shrink-0' : 'mb-2')}>
        <OpenAIIcon className="h-3.5 w-3.5 flex-shrink-0 text-text-secondary" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase text-text-tertiary">Codex usage</div>
          {provider?.plan && (
            <div
              className="truncate text-[10px] text-text-tertiary"
              title={provider.plan}
            >
              {provider.plan}
            </div>
          )}
        </div>
        <Tooltip content="Refresh Codex usage" side={compact ? 'top' : 'left'}>
          <button
            type="button"
            aria-label="Refresh Codex usage"
            disabled={isLoading}
            onClick={() => void refresh(true)}
            className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw aria-hidden="true" className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </button>
        </Tooltip>
      </div>

      <div aria-live="polite" className={cn(compact ? 'flex items-center gap-4' : 'space-y-2')}>
        {!provider && isLoading && <div className="text-xs text-text-tertiary">Loading usage...</div>}
        {unavailableMessage && (
          <div className="text-xs text-text-tertiary" title={unavailableMessage}>Codex usage unavailable</div>
        )}
        {provider?.status === 'available' && provider.limits.length === 0 && (
          <div className="text-xs text-text-tertiary">No subscription limits reported</div>
        )}
        {provider?.status === 'available' && provider.limits.map(limit => (
          <UsageLimitRow key={limit.id} limit={limit} compact={compact} />
        ))}
      </div>
    </section>
  );
}

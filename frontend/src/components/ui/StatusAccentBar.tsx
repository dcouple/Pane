import React from 'react';
import { cn } from '../../utils/cn';
import type { AgentDisplayStatus } from '../../../../shared/types/agentStatus';

interface StatusAccentBarProps {
  status: AgentDisplayStatus;
  /** Whether this row is the selected one (used only to color the fallback bar). */
  isActive?: boolean;
  className?: string;
}

const barColor = {
  blocked: 'bg-status-error',
  working: 'bg-status-info',
  done: 'bg-status-info',
  idle: 'bg-status-success',
} satisfies Record<Exclude<AgentDisplayStatus, 'unknown'>, string>;

/**
 * The always-present left accent bar on a session row. It follows the at-a-glance
 * agent status: red = blocked, blue with an up/down loading sweep = working,
 * blue = done, green = idle. For rows with no tracked agent (`unknown`) it shows
 * the selection accent when active and nothing otherwise.
 */
export const StatusAccentBar: React.FC<StatusAccentBarProps> = ({ status, isActive, className }) => {
  if (status === 'unknown') {
    return (
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-1 transition-colors',
          isActive ? 'bg-interactive' : 'bg-transparent',
          className,
        )}
        aria-hidden
      />
    );
  }

  return (
    <div
      className={cn('absolute left-0 top-0 bottom-0 w-1 overflow-hidden', barColor[status], className)}
      role="status"
      aria-label={`Agent ${status}`}
    >
      {status === 'working' && (
        <div className="absolute inset-x-0 h-1/2 animate-status-working bg-gradient-to-b from-transparent via-white/70 to-transparent" />
      )}
    </div>
  );
};

import React from 'react';
import { cn } from '../../utils/cn';
import type { AgentDisplayStatus } from '../../../../shared/types/agentStatus';

interface StatusAccentBarProps {
  status: AgentDisplayStatus;
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
 * blue = done, green = idle. Rows with no tracked agent (`unknown`) get no bar.
 */
export const StatusAccentBar: React.FC<StatusAccentBarProps> = ({ status, className }) => {
  // Selection is shown by the row background, not a bar.
  if (status === 'unknown') return null;

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

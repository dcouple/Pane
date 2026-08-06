import React from 'react';
import { useSessionAgentDisplayStatus } from '../hooks/useAgentStatus';
import { AgentActivityDot, AgentStatusDot } from './ui/AgentStatusDot';

interface SessionStatusBadgeProps {
  sessionId: string;
  size?: 'sm' | 'md';
}

/**
 * Session dot for the sidebar / session list: the herd-of-agents status
 * (blocked / working / done / idle) rolled up over the session's terminal
 * panels. `unknown` means no terminal panel has reported yet (or the session
 * has none); an inert placeholder holds the dot's footprint.
 */
export const SessionStatusBadge: React.FC<SessionStatusBadgeProps> = ({ sessionId, size = 'md' }) => {
  const displayStatus = useSessionAgentDisplayStatus(sessionId);

  if (displayStatus === 'unknown') {
    return <AgentActivityDot active={false} size={size} />;
  }

  return <AgentStatusDot status={displayStatus} size={size} />;
};

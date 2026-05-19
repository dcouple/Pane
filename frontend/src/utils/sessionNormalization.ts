import type { Session, SessionOutput } from '../types/session';

type TimestampLike = string | Date | null | undefined;

type SessionWire = Omit<Session, 'createdAt' | 'lastActivity' | 'lastViewedAt' | 'runStartedAt'> & {
  createdAt?: TimestampLike;
  lastActivity?: TimestampLike;
  lastViewedAt?: TimestampLike;
  runStartedAt?: TimestampLike;
};

type SessionOutputWire = Omit<SessionOutput, 'timestamp'> & {
  timestamp?: TimestampLike;
};

function normalizeTimestamp(value: TimestampLike): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }

  return value;
}

export function normalizeSession(session: SessionWire): Session {
  return {
    ...session,
    createdAt: normalizeTimestamp(session.createdAt) ?? '',
    lastActivity: normalizeTimestamp(session.lastActivity),
    lastViewedAt: normalizeTimestamp(session.lastViewedAt),
    runStartedAt: normalizeTimestamp(session.runStartedAt),
  };
}

export function normalizeSessions(sessions: SessionWire[]): Session[] {
  return sessions.map(normalizeSession);
}

export function normalizeSessionOutput(output: SessionOutputWire): SessionOutput {
  return {
    ...output,
    timestamp: normalizeTimestamp(output.timestamp) ?? '',
  };
}

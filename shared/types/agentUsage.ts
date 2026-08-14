export type AgentUsageProviderId = 'codex';

export interface AgentUsageLimit {
  id: string;
  name: string;
  remainingPercent: number;
  windowDurationMinutes: number | null;
  resetsAt: string | null;
}

export interface AgentUsageProviderSnapshot {
  id: AgentUsageProviderId;
  name: string;
  status: 'available' | 'unavailable';
  plan: string | null;
  limits: AgentUsageLimit[];
  fetchedAt: string;
  error?: string;
}

export interface AgentUsageSnapshot {
  providers: AgentUsageProviderSnapshot[];
  fetchedAt: string;
}

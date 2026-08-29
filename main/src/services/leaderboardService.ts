import { app } from 'electron';
import { execFileSync } from 'child_process';
import * as os from 'os';
import { usageManager } from './usage/usageManager';
import { ShellDetector } from '../utils/shellDetector';
import type { ConfigManager } from './configManager';
import type { AnalyticsIdentity } from '../types/config';
import type {
  LeaderboardSubmission,
  LeaderboardSubmitResult,
  LeaderboardResponse,
  LeaderboardStatus,
} from '../../../shared/types/leaderboard';
import type { UsageReport } from '../../../shared/types/usage';

const LEADERBOARD_API_BASE =
  process.env.PANE_LEADERBOARD_URL || 'https://runpane.com';
const SUBMIT_TIMEOUT_MS = 10_000;
const SCAN_WAIT_MS = 15_000;

function resolveDoNotTrack(): boolean {
  let value = process.env.DO_NOT_TRACK;

  if (value === undefined || value === '') {
    try {
      const shell = ShellDetector.getDefaultShell().path;
      const output = execFileSync(shell, ['-l', '-c', 'echo $DO_NOT_TRACK'], {
        encoding: 'utf8',
        timeout: 5000,
        cwd: os.homedir(),
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (output) value = output;
    } catch {
      // Shell probe failed — treat as unset
    }
  }

  if (value === undefined || value === '') return false;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return true;
}

function buildSubmission(
  report: UsageReport,
  identity: AnalyticsIdentity,
  paneVersion: string,
): LeaderboardSubmission {
  return {
    installId: identity.installId!,
    githubUsername: identity.githubUsername || undefined,
    gitEmailHash: identity.gitEmailHash || undefined,
    totalTokens: report.totals.totalTokens,
    inputTokens: report.totals.inputTokens,
    outputTokens: report.totals.outputTokens,
    cacheReadTokens: report.totals.cacheReadTokens,
    cacheCreationTokens: report.totals.cacheCreationTokens,
    messageCount: report.totals.messageCount,
    estimatedCostUsd: report.totals.estimatedCostUsd,
    costIncomplete: report.totals.costIncomplete,
    cacheSavingsUsd: report.totals.cacheSavingsUsd,
    byModel: report.byModel.slice(0, 50).map(m => ({
      model: m.model,
      provider: m.provider,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheReadTokens: m.cacheReadTokens,
      cacheCreationTokens: m.cacheCreationTokens,
      totalTokens: m.totalTokens,
      estimatedCostUsd: m.estimatedCostUsd,
      costIncomplete: m.costIncomplete,
    })),
    windowDays: 30,
    submittedAtMs: Date.now(),
    paneVersion,
  };
}

export class LeaderboardService {
  private doNotTrack: boolean;

  constructor(private configManager: ConfigManager) {
    this.doNotTrack = resolveDoNotTrack();
  }

  getStatus(): LeaderboardStatus {
    const config = this.configManager.getConfig().leaderboard;
    return {
      optIn: config?.optIn ?? false,
      lastRank: config?.lastRank ?? null,
      lastDisplayName: config?.lastDisplayName ?? null,
      lastSubmittedAtMs: config?.lastSubmittedAtMs ?? null,
      doNotTrack: this.doNotTrack,
    };
  }

  async join(): Promise<LeaderboardSubmitResult> {
    if (this.doNotTrack) {
      throw new Error('DO_NOT_TRACK is set — leaderboard submissions are blocked');
    }

    await this.configManager.updateConfig({
      leaderboard: {
        ...this.configManager.getConfig().leaderboard,
        optIn: true,
        joinedAtMs: Date.now(),
      },
    });

    return this.submit();
  }

  async leave(): Promise<void> {
    const config = this.configManager.getConfig();
    const installId = config.analytics?.installId;

    if (installId) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
        await fetch(`${LEADERBOARD_API_BASE}/api/runpane/leaderboard/submit`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ installId }),
          signal: controller.signal,
        });
        clearTimeout(timer);
      } catch (error) {
        console.warn('[Leaderboard] DELETE failed (row will expire):', error);
      }
    }

    await this.configManager.updateConfig({
      leaderboard: {
        optIn: false,
      },
    });
  }

  async submit(): Promise<LeaderboardSubmitResult> {
    if (this.doNotTrack) {
      throw new Error('DO_NOT_TRACK is set — leaderboard submissions are blocked');
    }

    const config = this.configManager.getConfig();
    if (!config.leaderboard?.optIn) {
      throw new Error('Not opted in to the leaderboard');
    }

    const analytics = config.analytics;
    if (!analytics?.installId) {
      throw new Error('No install ID available');
    }

    const identity: AnalyticsIdentity = {
      distinctId: analytics.distinctId || '',
      identitySource: analytics.identitySource || 'anonymous',
      installId: analytics.installId,
      githubUsername: analytics.githubUsername,
      gitEmail: analytics.gitEmail,
      gitEmailHash: analytics.gitEmailHash,
    };

    const DAY_MS = 24 * 60 * 60 * 1000;
    const toMs = Date.now();
    const report = usageManager.getReport({
      fromMs: toMs - 30 * DAY_MS,
      toMs,
    });

    const submission = buildSubmission(report, identity, app.getVersion());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

    const response = await fetch(
      `${LEADERBOARD_API_BASE}/api/runpane/leaderboard/submit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
        signal: controller.signal,
      },
    );
    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Leaderboard submit failed (${response.status}): ${text}`);
    }

    const result: LeaderboardSubmitResult = await response.json();

    await this.configManager.updateConfig({
      leaderboard: {
        ...config.leaderboard,
        lastSubmittedAtMs: Date.now(),
        lastRank: result.rank,
        lastDisplayName: result.displayName,
      },
    });

    return result;
  }

  async fetchLeaderboard(): Promise<LeaderboardResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

    const response = await fetch(
      `${LEADERBOARD_API_BASE}/api/runpane/leaderboard`,
      { signal: controller.signal },
    );
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`Failed to fetch leaderboard (${response.status})`);
    }

    return response.json();
  }

  async submitOnAppOpen(): Promise<void> {
    if (this.doNotTrack) return;
    if (!this.configManager.getConfig().leaderboard?.optIn) return;

    const status = usageManager.getStatus();
    if (status.scanning) {
      const started = Date.now();
      await new Promise<void>(resolve => {
        const check = () => {
          if (!usageManager.getStatus().scanning || Date.now() - started > SCAN_WAIT_MS) {
            resolve();
            return;
          }
          setTimeout(check, 1000);
        };
        check();
      });
    }

    if (usageManager.getStatus().scanning) {
      console.log('[Leaderboard] Scan still running after wait bound — skipping app-open submission');
      return;
    }

    try {
      await this.submit();
      console.log('[Leaderboard] App-open submission succeeded');
    } catch (error) {
      console.warn('[Leaderboard] App-open submission failed:', error);
    }
  }
}

import type { RunpaneAgentId, RunpanePanelBlockedState } from '../../../shared/types/runpaneOrchestration';

export type RunpaneInterstitialClassification =
  | { disposition: 'clear' }
  | { disposition: 'allow'; kind: 'codex-update'; response: '2'; justification: string }
  | { disposition: 'deny' | 'unknown'; blocker: RunpanePanelBlockedState };

const DENY_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /(?:trust|do you trust).*(?:directory|folder|workspace)|(?:directory|folder|workspace).*(?:trust|trusted)/i, message: 'Directory trust requires explicit human input.' },
  { pattern: /authentication required|authenticate to continue|authorization required|sign[ -]?in to continue|log[ -]?in to continue|enter (?:an? )?(?:api )?(?:key|token)/i, message: 'Authentication requires explicit human input.' },
  { pattern: /permission|grant access|allow access/i, message: 'A permission decision requires explicit human input.' },
  { pattern: /delete|destroy|overwrite|irreversible|cannot be undone/i, message: 'A destructive confirmation requires explicit human input.' },
  { pattern: /terms (?:of|and)|privacy policy|payment|purchase|billing/i, message: 'Terms or payment decisions require explicit human input.' },
];

export function classifyRunpaneInterstitial(
  text: string,
  agentType: RunpaneAgentId | undefined,
  panelId: string,
): RunpaneInterstitialClassification {
  for (const denied of DENY_PATTERNS) {
    if (denied.pattern.test(text)) return {
      disposition: 'deny',
      blocker: { kind: 'unknown', message: denied.message, suggestedCommand: `runpane panels screen --panel ${panelId} --json` },
    };
  }
  if ((agentType === 'codex' || /codex/i.test(text)) && /update available/i.test(text) && /skip/i.test(text)) {
    return { disposition: 'allow', kind: 'codex-update', response: '2', justification: 'Skipping an optional update is reversible and leaves the installed agent unchanged.' };
  }
  if (/planning suggestion|press enter to continue|would you like to|(?:choose|select) (?:an?|one)|\[[yn]\/?[yn]?\]/i.test(text)) {
    return {
      disposition: 'unknown',
      blocker: { kind: 'unknown', message: 'An unrecognized interactive prompt requires explicit input.', suggestedCommand: `runpane panels screen --panel ${panelId} --json` },
    };
  }
  return { disposition: 'clear' };
}

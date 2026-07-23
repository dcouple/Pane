import type { RunpaneAgentId, RunpanePanelBlockedState } from '../../../shared/types/runpaneOrchestration';

export type RunpaneInterstitialClassification =
  | { disposition: 'clear' }
  | { disposition: 'allow'; kind: 'codex-update'; response: '2'; justification: string }
  | { disposition: 'deny' | 'unknown'; blocker: RunpanePanelBlockedState };

const SELF_CONTAINED_DENY_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /(?:do you trust|trust (?:the contents of )?)(?:this |the )?(?:directory|folder|workspace)|(?:directory|folder|workspace) (?:is not trusted|requires trust)/i, message: 'Directory trust requires explicit human input.' },
  { pattern: /(?:authentication required|authenticate to continue|authorization required|sign[ -]?in to continue|log[ -]?in to continue|enter (?:an? )?(?:api )?(?:key|token))/i, message: 'Authentication requires explicit human input.' },
];

const CONSEQUENTIAL_DENY_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /permission|grant access|allow access/i, message: 'A permission decision requires explicit human input.' },
  { pattern: /delete|destroy|overwrite|irreversible|cannot be undone/i, message: 'A destructive confirmation requires explicit human input.' },
  { pattern: /terms (?:of|and)|privacy policy|payment|purchase|billing/i, message: 'Terms or payment decisions require explicit human input.' },
];

const PROMPT_STRUCTURE_PATTERN = /(?:\?\s*(?:\[[^\]]+\]|\([^)]+\))?\s*$|\[[yn]\s*\/\s*[yn]\]|\([yn]\s*\/\s*[yn]\)|\bpress (?:enter|return|any key|[a-z0-9])\b|\btype .+ to confirm\b|\bdo you want\b|\bwould you like\b|\bare you sure\b|\bconfirm(?:\s+(?:this|the|your|to)\b.*)?\??\s*$|\bcontinue\?\s*$|^\s*(?:please\s+)?(?:grant|allow|accept|agree|enter|provide|delete|destroy|overwrite)\b)/i;
const PROMPT_CONTINUATION_PATTERN = /^\s*(?:[>›❯]\s*|\[[yn]\s*\/\s*[yn]\]|\([yn]\s*\/\s*[yn]\)|(?:\d+|[a-z])[.)]\s+\S.*)$/i;

function hasPromptStructure(lines: string[], index: number): boolean {
  return PROMPT_STRUCTURE_PATTERN.test(lines[index])
    || (index + 1 < lines.length && PROMPT_CONTINUATION_PATTERN.test(lines[index + 1]));
}

export function classifyRunpaneInterstitial(
  text: string,
  agentType: RunpaneAgentId | undefined,
  panelId: string,
): RunpaneInterstitialClassification {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    for (const denied of SELF_CONTAINED_DENY_PATTERNS) {
      if (denied.pattern.test(line.trim())) return {
        disposition: 'deny',
        blocker: { kind: 'unknown', message: denied.message, suggestedCommand: `runpane panels screen --panel ${panelId} --json` },
      };
    }
  }
  for (const [index, line] of lines.entries()) {
    for (const denied of CONSEQUENTIAL_DENY_PATTERNS) {
      if (denied.pattern.test(line) && hasPromptStructure(lines, index)) return {
        disposition: 'deny',
        blocker: { kind: 'unknown', message: denied.message, suggestedCommand: `runpane panels screen --panel ${panelId} --json` },
      };
    }
  }
  if ((agentType === 'codex' || /codex/i.test(text)) && /update available/i.test(text) && /skip/i.test(text)) {
    return { disposition: 'allow', kind: 'codex-update', response: '2', justification: 'Skipping an optional update is reversible and leaves the installed agent unchanged.' };
  }
  const numberedOptions = lines.filter(line => /^\s*\d+[.)]\s+\S/.test(line)).length;
  if (/planning suggestion|press enter to continue|would you like to|(?:choose|select) (?:an?|one)|\[[yn]\s*\/\s*[yn]\]|\([yn]\s*\/\s*[yn]\)/i.test(text)
    || numberedOptions >= 2
    || lines.some(line => /^\s*(?:>|›|❯|→)\s*(?:\d+[.)]\s+|yes\b|no\b|continue\b|cancel\b|skip\b|exit\b)/i.test(line))) {
    return {
      disposition: 'unknown',
      blocker: { kind: 'unknown', message: 'An unrecognized interactive prompt requires explicit input.', suggestedCommand: `runpane panels screen --panel ${panelId} --json` },
    };
  }
  return { disposition: 'clear' };
}

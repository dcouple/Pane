/**
 * Per-agent status-detection manifests for Pane's at-a-glance agent status.
 *
 * Each manifest is a priority-ordered rule set consumed by {@link detectAgentState}
 * in manifestEngine. Rules classify a pane's live terminal snapshot as `blocked`
 * (waiting on the human), `working`, or `idle`; `unknown` + skipStateUpdate marks
 * agent-owned viewers (transcript/model picker) so the previously known state is
 * held. Working is also corroborated by PTY byte-activity in the monitor.
 *
 * Rules encode the visible chrome each CLI agent renders (permission prompts,
 * spinners, prompt boxes) so classification is derived from what the user would
 * see on screen, not from process-level guesswork.
 */

import type { AgentManifest } from './manifestEngine';

/** Braille spinner glyphs Claude/Codex animate in their OSC title / status line. */
const SPINNER_TITLE = /^[\u{2800}-\u{28FF}] /u;
const CODEX_SPINNER = /(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)/u;

export const CLAUDE_MANIFEST: AgentManifest = {
  id: 'claude',
  rules: [
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1100,
      region: 'osc_title',
      visibleWorking: true,
      regex: [SPINNER_TITLE],
    },
    {
      id: 'btw_overlay_working',
      state: 'working',
      priority: 975,
      region: 'bottom_non_empty_lines(5)',
      visibleWorking: true,
      lineRegex: [/^\s*\/btw(?:\s|$)/, /esc to close\s*$/i],
    },
    {
      id: 'transcript_viewer',
      state: 'unknown',
      priority: 1000,
      region: 'bottom_non_empty_lines(3)',
      skipStateUpdate: true,
      contains: ['showing detailed transcript'],
      any: [
        { contains: ['ctrl+o', 'to toggle'] },
        { contains: ['ctrl+e', 'show all'] },
        { contains: ['ctrl+e', 'collapse'] },
        { contains: ['↑↓ scroll'] },
        { contains: ['? for shortcuts'] },
      ],
    },
    {
      id: 'live_blocked_form',
      state: 'blocked',
      priority: 980,
      region: 'after_last_horizontal_rule',
      visibleBlocker: true,
      contains: ['enter to select', 'esc to cancel'],
      any: [
        { contains: ['tab/arrow keys to navigate'] },
        { contains: ['arrow keys to navigate'] },
        { contains: ['arrows to navigate'] },
        { contains: ['↑/↓ to navigate'] },
        { contains: ['↑↓ to navigate'] },
      ],
    },
    {
      id: 'dynamic_workflow_prompt',
      state: 'blocked',
      priority: 980,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['run a dynamic workflow?', 'esc to cancel'],
    },
    {
      id: 'live_prompt_box',
      state: 'idle',
      priority: 950,
      region: 'prompt_box_body',
      visibleIdle: true,
      lineRegex: [/^\s*❯/],
      not: [
        { contains: ['enter to select'] },
        { contains: ['esc to cancel'] },
        { contains: ['tab/arrow keys'] },
        { contains: ['arrow keys to navigate'] },
        { contains: ['↑/↓ to navigate'] },
      ],
    },
    {
      id: 'model_picker_menu',
      state: 'unknown',
      priority: 900,
      region: 'whole_recent',
      skipStateUpdate: true,
      contains: ['select model', 'enter to set as default', 'esc to cancel'],
      not: [{ contains: ['do you want to proceed?'] }, { contains: ['enter to select'] }],
    },
    {
      id: 'bash_permission_prompt',
      state: 'blocked',
      priority: 850,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['do you want to proceed?'],
      any: [
        { contains: ['bash command'] },
        { contains: ['bash('] },
        { contains: ['contains expansion'] },
        { contains: ['tab to amend'] },
        { contains: ['ctrl+e to explain'] },
      ],
      all: [
        {
          any: [
            { lineRegex: [/^\s*❯?\s*yes\b/i] },
            { lineRegex: [/^\s*1\.\s*yes\b/i] },
            { lineRegex: [/^\s*2\.\s*no\b/i] },
          ],
        },
      ],
    },
    {
      id: 'generic_permission_prompt',
      state: 'blocked',
      priority: 840,
      region: 'after_last_horizontal_rule',
      visibleBlocker: true,
      contains: ['do you want to proceed?', 'esc to cancel'],
      all: [
        {
          any: [
            { lineRegex: [/^\s*❯?\s*1\.\s*yes\b/i] },
            { lineRegex: [/^\s*2\.\s*yes\b/i] },
            { lineRegex: [/^\s*2\.\s*no\b/i] },
            { lineRegex: [/^\s*3\.\s*no\b/i] },
          ],
        },
      ],
    },
    {
      id: 'legacy_no_prompt_blocker',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      any: [
        { contains: ['do you want to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['would you like to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['waiting for permission'] },
        { contains: ['do you want to allow this connection?'] },
        { contains: ['tab to amend'] },
        { contains: ['ctrl+e to explain'] },
        { contains: ['do you want to proceed?', 'esc to cancel'] },
        { contains: ['review your answers'] },
        { contains: ['skip interview and plan immediately'] },
      ],
      not: [{ regex: [/^\s*❯\s*$/m] }],
    },
    {
      id: 'osc_title_idle',
      state: 'idle',
      priority: 250,
      region: 'osc_title',
      visibleIdle: true,
      regex: [/^\u{2733} /u],
    },
    {
      id: 'osc_progress_idle',
      state: 'idle',
      priority: 250,
      region: 'osc_progress',
      regex: [/^4;0/],
    },
  ],
};

export const CODEX_MANIFEST: AgentManifest = {
  id: 'codex',
  rules: [
    {
      id: 'osc_title_blocked',
      state: 'blocked',
      priority: 1100,
      region: 'osc_title',
      visibleBlocker: true,
      contains: ['Action Required'],
    },
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1050,
      region: 'osc_title',
      visibleWorking: true,
      regex: [CODEX_SPINNER],
    },
    {
      id: 'transcript_viewer',
      state: 'unknown',
      priority: 1000,
      region: 'after_last_prompt_marker',
      skipStateUpdate: true,
      contains: ['↑/↓ to scroll', 'pgup/pgdn to', 'home/end to jump', 'q to quit'],
      any: [{ contains: ['esc to edit prev'] }, { contains: ['esc/← to edit prev'] }],
    },
    {
      id: 'live_strong_blocker',
      state: 'blocked',
      priority: 900,
      region: 'after_last_prompt_marker',
      visibleBlocker: true,
      any: [
        { contains: ['press enter to confirm or esc to cancel'] },
        { contains: ['enter to submit answer'] },
        { contains: ['enter to submit all'] },
        { contains: ['allow command?'] },
      ],
    },
    {
      id: 'weak_blocker',
      state: 'blocked',
      priority: 600,
      region: 'whole_recent',
      any: [
        { contains: ['[y/n]'] },
        { contains: ['yes (y)'] },
        { contains: ['do you want to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['would you like to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
      ],
    },
    {
      id: 'screen_working_fallback',
      state: 'working',
      priority: 500,
      region: 'bottom_non_empty_lines(3)',
      visibleWorking: true,
      lineRegex: [/^[•◦]\s+Working \([^)]*esc to interrupt\)(?: · .*)?$/],
      not: [{ contains: ['■ Conversation interrupted'] }],
    },
    {
      id: 'osc_title_idle',
      state: 'idle',
      priority: 100,
      region: 'osc_title',
      visibleIdle: true,
      regex: [/\S/],
      not: [{ regex: [CODEX_SPINNER] }, { contains: ['Action Required'] }],
    },
  ],
};

/**
 * Universal fallback for any terminal panel without a bespoke manifest — other
 * CLI agents (opencode, aider, ...) and plain shells alike. Detects the common
 * permission-prompt shapes; working/idle otherwise come from PTY activity and
 * the idle fallback, which is the old activity system's signal generalized.
 */
export const GENERIC_MANIFEST: AgentManifest = {
  id: 'generic',
  rules: [
    {
      id: 'generic_permission_prompt',
      state: 'blocked',
      priority: 600,
      region: 'whole_recent',
      any: [
        { contains: ['do you want to proceed?'] },
        { contains: ['[y/n]'] },
        { contains: ['(y/n)'] },
        { contains: ['press enter to confirm'] },
        { contains: ['allow command?'] },
        { contains: ['waiting for permission'] },
        { contains: ['do you want to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['would you like to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
      ],
      not: [{ regex: [/^\s*❯\s*$/m] }],
    },
  ],
};

const MANIFESTS_BY_AGENT: Record<string, AgentManifest> = {
  claude: CLAUDE_MANIFEST,
  codex: CODEX_MANIFEST,
};

/**
 * Resolve the manifest for a panel's agent type. Known agents get their bespoke
 * manifest; everything else — unrecognized CLI agents and plain shells — gets
 * the generic fallback, so every terminal panel is covered by one status system.
 */
export function getManifestForAgent(agentType: string | undefined | null): AgentManifest {
  if (!agentType) return GENERIC_MANIFEST;
  return MANIFESTS_BY_AGENT[agentType] ?? GENERIC_MANIFEST;
}

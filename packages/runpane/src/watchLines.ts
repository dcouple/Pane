export type WatchFormat = 'lines' | 'json';

export function effectiveWatchHeartbeatMs(seconds: number): number {
  const configuredMs = seconds * 1_000;
  return configuredMs > 0 ? Math.min(configuredMs, 120_000) : 0;
}

interface WatchEntry {
  gen: number;
  at: string;
  kind: string;
  paneId: string;
  paneName: string;
  panelId?: string;
  heldInput?: string;
  heldInputPresent?: boolean;
  exitCode?: number;
  baseline?: true;
  changedWhileAway?: boolean;
  idleMs?: number;
  idleCount?: number;
}

export interface WatchResult {
  epoch: string;
  generation: number;
  entries: WatchEntry[];
  dropped?: number;
  reset?: { reason: string };
}

function sanitizeName(value: string): string {
  const printable = [...value]
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint >= 127 && codePoint <= 159 ? ' ' : character;
    })
    .join('');
  return printable.replace(/\s+/gu, ' ').trim() || '<unnamed>';
}

function formatEntryLine(entry: WatchEntry): string | undefined {
  if (entry.baseline && !entry.changedWhileAway) return undefined;
  const name = sanitizeName(entry.paneName);
  const pane = `pane ${sanitizeName(entry.paneId)}`;
  const panel = entry.panelId ? ` panel ${sanitizeName(entry.panelId)}` : '';
  if (entry.changedWhileAway) return `CHANGED ${name} ${pane}${panel}`;
  switch (entry.kind) {
    case 'agent.ready': return `READY ${name} ${pane}${panel}`;
    case 'agent.busy': return `BUSY ${name} ${pane}${panel}`;
    case 'agent.blocked': return `BLOCKED ${name} ${pane}${panel}`;
    case 'agent.unknown': return `UNKNOWN ${name} ${pane}${panel}`;
    case 'agent.idle': {
      const minutes = Math.max(0, Math.floor((entry.idleMs ?? 0) / 60_000));
      return `IDLE ${name} ${minutes}m ${pane}${panel}`;
    }
    case 'pane.created': return `NEW ${name} ${pane}`;
    case 'pane.gone': return `GONE ${name} ${pane}`;
    case 'panel.exited': return `EXIT ${name} ${pane}${panel} code ${entry.exitCode ?? 'unknown'}`;
    default: return `UNKNOWN ${name} ${pane}${panel}`;
  }
}

export function formatWaitResult(result: WatchResult, format: WatchFormat): string[] {
  if (format === 'json') {
    const lines: string[] = [];
    if (result.reset) {
      lines.push(JSON.stringify({ kind: '_reset', reason: result.reset.reason, epoch: result.epoch }));
    }
    if (result.dropped !== undefined) lines.push(JSON.stringify({ kind: '_dropped', count: result.dropped }));
    lines.push(...result.entries.map(entry => JSON.stringify(entry)));
    return lines;
  }

  const lines: string[] = [];
  if (result.reset) lines.push(`RESET ${sanitizeName(result.reset.reason)} epoch ${sanitizeName(result.epoch)}`);
  if (result.dropped !== undefined) lines.push(`DROPPED ${result.dropped}`);
  for (const entry of result.entries) {
    const line = formatEntryLine(entry);
    if (line) lines.push(line);
    if ((entry.kind === 'agent.ready' || entry.kind === 'agent.idle') && (entry.heldInputPresent || entry.heldInput)) {
      lines.push(`STUCK ${sanitizeName(entry.paneName)} pane ${sanitizeName(entry.paneId)}${entry.panelId ? ` panel ${sanitizeName(entry.panelId)}` : ''} held-input-present`);
    }
  }
  return lines;
}

export function formatNonEntry(
  kind: '_ok' | '_heartbeat' | '_error' | '_reconnected',
  fields: Record<string, string | number | undefined>,
  format: WatchFormat,
): string {
  if (format === 'json') return JSON.stringify({ kind, ...fields });
  if (kind === '_ok') return `WATCH OK gen ${fields.generation} epoch ${sanitizeName(String(fields.epoch))}`;
  if (kind === '_heartbeat') return `HEARTBEAT gen ${fields.generation} at ${fields.at}`;
  if (kind === '_reconnected') return `WATCH RECONNECTED gen ${fields.generation}`;
  return `WATCH ERROR ${sanitizeName(String(fields.code))}: ${sanitizeName(String(fields.message))}`;
}

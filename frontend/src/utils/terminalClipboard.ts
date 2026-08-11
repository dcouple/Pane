interface TerminalCopyShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function isTerminalCopyShortcut(event: TerminalCopyShortcutEvent, isMac: boolean): boolean {
  if (event.key.toLowerCase() !== 'c' || event.altKey) return false;
  if (isMac) return event.metaKey && !event.ctrlKey && !event.shiftKey;
  return event.ctrlKey && event.shiftKey && !event.metaKey;
}

export async function copyTerminalText(text: string): Promise<boolean> {
  if (!text) return false;
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard access is unavailable');
  }
  await navigator.clipboard.writeText(text);
  return true;
}

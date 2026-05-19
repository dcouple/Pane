import { ClipboardPaste, Command, Send, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RemotePwaTerminalShortcut } from '../../../../shared/types/remoteDaemon';

interface RemoteTerminalInputBarProps {
  shortcuts: RemotePwaTerminalShortcut[];
  shortcutsLoading?: boolean;
  disabled?: boolean;
  onOpenShortcuts?: () => void;
  onResetTerminal: () => void;
  onSendInput: (data: string) => void;
}

const CONTROL_KEYS = [
  { label: 'Stop', title: 'Send Ctrl-C to stop the running command', data: '\x03' },
  { label: 'Esc', title: 'Send Escape', data: '\x1b' },
  { label: 'Tab', title: 'Send Tab', data: '\t' },
  { label: 'Enter', title: 'Send Enter', data: '\r' },
  { label: 'Up', title: 'Send Up Arrow', data: '\x1b[A' },
  { label: 'Down', title: 'Send Down Arrow', data: '\x1b[B' },
] as const;

export function RemoteTerminalInputBar({
  shortcuts,
  shortcutsLoading = false,
  disabled = false,
  onOpenShortcuts,
  onResetTerminal,
  onSendInput,
}: RemoteTerminalInputBarProps) {
  const [draft, setDraft] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);

  const enabledShortcuts = useMemo(
    () => shortcuts.filter(shortcut => shortcut.enabled !== false && shortcut.text.trim()),
    [shortcuts],
  );

  const sendInput = (data: string) => {
    if (disabled || !data) return;
    onSendInput(data);
  };

  const sendDraft = () => {
    if (!draft.trim()) return;
    sendInput(`${draft}\r`);
    setDraft('');
  };

  const insertText = (text: string) => {
    if (!text) return;
    setDraft(current => `${current}${text}`);
    setClipboardError(null);
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard?.readText?.();
      if (!text) {
        setClipboardError('Clipboard is empty or unavailable.');
        return;
      }
      insertText(text);
    } catch {
      setClipboardError('Browser clipboard access is blocked. Paste into the input instead.');
    }
  };

  return (
    <div className="relative shrink-0 border-t border-border-primary bg-surface-primary p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden">
      {showShortcuts && (
        <div className="absolute bottom-full left-2 right-2 mb-2 max-h-64 overflow-y-auto rounded-lg border border-border-primary bg-surface-primary shadow-dropdown">
          <div className="flex items-center justify-between border-b border-border-primary px-3 py-2">
            <span className="text-sm font-semibold text-text-primary">Terminal Shortcuts</span>
            <button
              type="button"
              onClick={() => setShowShortcuts(false)}
              className="rounded-md p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
              aria-label="Close shortcuts"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {shortcutsLoading ? (
            <p className="px-3 py-4 text-sm text-text-tertiary">Loading host shortcuts...</p>
          ) : enabledShortcuts.length > 0 ? (
            <div className="p-1.5">
              {enabledShortcuts.map(shortcut => (
                <button
                  key={shortcut.id}
                  type="button"
                  onClick={() => {
                    insertText(shortcut.text);
                    setShowShortcuts(false);
                  }}
                  className="flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left hover:bg-surface-hover"
                >
                  <span className="mt-0.5 rounded border border-border-secondary px-1.5 py-0.5 text-[11px] font-semibold uppercase text-text-tertiary">
                    {shortcut.key}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text-primary">
                      {shortcut.label || `Shortcut ${shortcut.key.toUpperCase()}`}
                    </span>
                    <span className="line-clamp-2 text-xs text-text-tertiary">{shortcut.text}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="px-3 py-4 text-sm text-text-tertiary">No enabled terminal shortcuts on this host.</p>
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              sendDraft();
            }
          }}
          rows={2}
          disabled={disabled}
          placeholder="Type command or prompt..."
          className="max-h-32 min-h-14 flex-1 resize-none rounded-lg border border-border-secondary bg-bg-primary px-3 py-2.5 text-sm leading-5 text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-interactive disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => { void pasteClipboard(); }}
          disabled={disabled}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-border-secondary text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Paste clipboard into input"
          title="Paste"
        >
          <ClipboardPaste className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={sendDraft}
          disabled={disabled || !draft.trim()}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-accent-primary text-white hover:bg-accent-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Send input"
          title="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {CONTROL_KEYS.map(control => (
          <button
            key={control.label}
            type="button"
            onClick={() => sendInput(control.data)}
            disabled={disabled}
            title={control.title}
            className="h-8 shrink-0 rounded-md border border-border-secondary px-2.5 text-xs font-semibold text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {control.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onResetTerminal}
          disabled={disabled}
          title="Clear terminal scrollback"
          className="h-8 shrink-0 rounded-md border border-border-secondary px-2.5 text-xs font-semibold text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={() => {
            setShowShortcuts(value => {
              if (!value) {
                onOpenShortcuts?.();
              }
              return !value;
            });
          }}
          disabled={disabled}
          className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-border-secondary px-2.5 text-xs font-semibold text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Command className="h-3.5 w-3.5" />
          Shortcuts
        </button>
      </div>

      {clipboardError && (
        <p className="mt-1 text-xs text-status-error">{clipboardError}</p>
      )}
    </div>
  );
}

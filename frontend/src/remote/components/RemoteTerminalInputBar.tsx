import { ClipboardPaste, Command, Loader2, Mic, Send, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  RemotePwaTerminalShortcut,
  RemotePwaVoiceTranscriptionAffordance,
} from '../../../../shared/types/remoteDaemon';
import type {
  VoiceDeepgramTokenResult,
  VoiceStreamingFinalizeRequest,
  VoiceTranscriptionMode,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from '../../../../shared/types/voiceTranscription';
import { useRemoteVoiceDictation } from '../hooks/useRemoteVoiceDictation';

interface RemoteTerminalInputBarProps {
  shortcuts: RemotePwaTerminalShortcut[];
  voiceTranscription: RemotePwaVoiceTranscriptionAffordance;
  shortcutsLoading?: boolean;
  disabled?: boolean;
  onOpenShortcuts?: () => void;
  onResetTerminal: () => void;
  onSendInput: (data: string) => void;
  onTranscribeAudio?: (request: VoiceTranscriptionRequest) => Promise<VoiceTranscriptionResult>;
  onCreateStreamingSocket?: () => WebSocket;
  onGetDeepgramToken?: () => Promise<VoiceDeepgramTokenResult>;
  onFinalizeStreamingAudio?: (request: VoiceStreamingFinalizeRequest) => Promise<VoiceTranscriptionResult>;
}

const CONTROL_KEYS = [
  { label: 'Stop', title: 'Send Ctrl-C to stop the running command', data: '\x03' },
  { label: 'Esc', title: 'Send Escape', data: '\x1b' },
  { label: 'Tab', title: 'Send Tab', data: '\t' },
  { label: 'Enter', title: 'Send Enter', data: '\r' },
  { label: 'Up', title: 'Send Up Arrow', data: '\x1b[A' },
  { label: 'Down', title: 'Send Down Arrow', data: '\x1b[B' },
] as const;

function appendTranscriptDraft(current: string, transcript: string): string {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) {
    return current;
  }

  if (!current.trim()) {
    return trimmedTranscript;
  }

  return `${current}${/\s$/.test(current) ? '' : ' '}${trimmedTranscript}`;
}

export function RemoteTerminalInputBar({
  shortcuts,
  voiceTranscription,
  shortcutsLoading = false,
  disabled = false,
  onOpenShortcuts,
  onResetTerminal,
  onSendInput,
  onTranscribeAudio,
  onCreateStreamingSocket,
  onGetDeepgramToken,
  onFinalizeStreamingAudio,
}: RemoteTerminalInputBarProps) {
  const [draft, setDraft] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<VoiceTranscriptionMode>(voiceTranscription.defaultMode);

  const enabledShortcuts = useMemo(
    () => shortcuts.filter(shortcut => shortcut.enabled !== false && shortcut.text.trim()),
    [shortcuts],
  );
  const availableVoiceModes = voiceTranscription.availableModes;
  const selectedVoiceMode = availableVoiceModes.includes(voiceMode)
    ? voiceMode
    : voiceTranscription.defaultMode;
  const canUseSelectedVoiceMode = availableVoiceModes.includes(selectedVoiceMode);

  const appendTranscript = (text: string) => {
    setDraft(current => appendTranscriptDraft(current, text));
  };

  const voice = useRemoteVoiceDictation({
    mode: selectedVoiceMode,
    onTranscript: appendTranscript,
    onTranscribeAudio,
    onCreateStreamingSocket,
    onGetDeepgramToken,
    onFinalizeStreamingAudio,
  });

  useEffect(() => {
    if (!availableVoiceModes.includes(voiceMode)) {
      setVoiceMode(voiceTranscription.defaultMode);
    }
  }, [availableVoiceModes, voiceMode, voiceTranscription.defaultMode]);

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
    voice.clearError();
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
        <div className="relative min-w-0 flex-1">
          <textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendDraft();
              }
            }}
            rows={6}
            disabled={disabled}
            placeholder="Type command or prompt..."
            className="max-h-56 min-h-32 w-full resize-none rounded-lg border border-border-secondary bg-bg-primary px-3 py-2.5 pr-14 text-xs leading-4 text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-interactive disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => { void voice.toggle(); }}
            disabled={(!voice.isRecording && (disabled || voice.isTranscribing || !canUseSelectedVoiceMode))}
            className={`absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-md border bg-bg-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              voice.isRecording
                ? 'border-status-error/50 text-status-error hover:bg-status-error/10'
                : 'border-border-secondary text-text-secondary hover:bg-surface-hover hover:text-text-primary'
            }`}
            aria-label={voice.isRecording ? 'Stop voice recording' : 'Start voice recording'}
            title={voice.isRecording ? 'Stop recording' : 'Voice input'}
          >
            {voice.isTranscribing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : voice.isRecording ? (
              <Square className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </button>
        </div>
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
        <button
          type="button"
          onClick={() => { void pasteClipboard(); }}
          disabled={disabled}
          className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-border-secondary px-2.5 text-xs font-semibold text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Paste clipboard into input"
          title="Paste"
        >
          <ClipboardPaste className="h-3.5 w-3.5" />
          Paste
        </button>
        {availableVoiceModes.length > 1 && (
          <div className="flex h-8 overflow-hidden rounded-md border border-border-secondary">
            {availableVoiceModes.map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => setVoiceMode(mode)}
                disabled={disabled || voice.isRecording || voice.isTranscribing}
                aria-pressed={selectedVoiceMode === mode}
                title={`${voiceTranscription.modes[mode].latencyLabel}. ${voiceTranscription.modes[mode].priceLabel}`}
                className={`px-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  selectedVoiceMode === mode
                    ? 'bg-interactive text-white'
                    : 'bg-bg-primary text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                }`}
              >
                {voiceTranscription.modes[mode].label}
              </button>
            ))}
          </div>
        )}
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

      {(clipboardError || voice.error || voice.isRecording || voice.isTranscribing || voice.interimTranscript || voice.streamingTranscript) && (
        <div className="mt-1 space-y-1">
          {clipboardError && (
            <p className="text-xs text-status-error">{clipboardError}</p>
          )}
          {voice.error && (
            <p className="text-xs text-status-error">{voice.error}</p>
          )}
          {(voice.streamingTranscript || voice.interimTranscript) && (
            <p className="line-clamp-2 text-xs text-text-tertiary">
              {voice.streamingTranscript}
              {voice.streamingTranscript && voice.interimTranscript ? ' ' : ''}
              {voice.interimTranscript && <span className="text-text-muted">{voice.interimTranscript}</span>}
            </p>
          )}
          {voice.isRecording && (
            <p className="text-xs text-status-warning">
              {voice.activeMode === 'streaming' ? 'Live transcription active...' : 'Recording voice input...'}
            </p>
          )}
          {voice.isTranscribing && (
            <p className="text-xs text-text-tertiary">Cleaning up voice transcript...</p>
          )}
        </div>
      )}
    </div>
  );
}

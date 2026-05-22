import { ClipboardPaste, Command, Loader2, Mic, Send, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RemotePwaTerminalShortcut } from '../../../../shared/types/remoteDaemon';
import type { VoiceTranscriptionRequest, VoiceTranscriptionResult } from '../../../../shared/types/voiceTranscription';

interface RemoteTerminalInputBarProps {
  shortcuts: RemotePwaTerminalShortcut[];
  shortcutsLoading?: boolean;
  disabled?: boolean;
  onOpenShortcuts?: () => void;
  onResetTerminal: () => void;
  onSendInput: (data: string) => void;
  onTranscribeAudio?: (request: VoiceTranscriptionRequest) => Promise<VoiceTranscriptionResult>;
}

const MAX_RECORDING_MS = 60_000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const PREFERRED_RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const;

const CONTROL_KEYS = [
  { label: 'Stop', title: 'Send Ctrl-C to stop the running command', data: '\x03' },
  { label: 'Esc', title: 'Send Escape', data: '\x1b' },
  { label: 'Tab', title: 'Send Tab', data: '\t' },
  { label: 'Enter', title: 'Send Enter', data: '\r' },
  { label: 'Up', title: 'Send Up Arrow', data: '\x1b[A' },
  { label: 'Down', title: 'Send Down Arrow', data: '\x1b[B' },
] as const;

function selectRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') {
    return undefined;
  }

  return PREFERRED_RECORDING_MIME_TYPES.find(mimeType => MediaRecorder.isTypeSupported(mimeType));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Unable to read voice recording.'));
      }
    };
    reader.onerror = () => reject(new Error('Unable to read voice recording.'));
    reader.readAsDataURL(blob);
  });
}

function getVoiceErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Voice transcription failed.';
}

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
  shortcutsLoading = false,
  disabled = false,
  onOpenShortcuts,
  onResetTerminal,
  onSendInput,
  onTranscribeAudio,
}: RemoteTerminalInputBarProps) {
  const [draft, setDraft] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef(0);
  const recordingFailedRef = useRef(false);
  const maxRecordingTimerRef = useRef<number | null>(null);

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
    setVoiceError(null);
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

  const clearMaxRecordingTimer = () => {
    if (maxRecordingTimerRef.current !== null) {
      window.clearTimeout(maxRecordingTimerRef.current);
      maxRecordingTimerRef.current = null;
    }
  };

  const stopRecordingStream = () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  };

  const appendTranscript = (text: string) => {
    setDraft(current => appendTranscriptDraft(current, text));
    setVoiceError(null);
  };

  const finishRecording = async (recorder: MediaRecorder) => {
    clearMaxRecordingTimer();
    setIsRecording(false);
    stopRecordingStream();
    recorderRef.current = null;

    const chunks = recordingChunksRef.current;
    recordingChunksRef.current = [];
    if (recordingFailedRef.current) {
      recordingFailedRef.current = false;
      return;
    }
    if (chunks.length === 0) {
      return;
    }

    const mimeType = recorder.mimeType || chunks[0]?.type || 'audio/webm';
    const audioBlob = new Blob(chunks, { type: mimeType });
    if (audioBlob.size === 0) {
      setVoiceError('Voice recording was empty.');
      return;
    }
    if (audioBlob.size > MAX_AUDIO_BYTES) {
      setVoiceError('Recording is too large. Keep voice clips under 10 MB.');
      return;
    }
    if (!onTranscribeAudio) {
      setVoiceError('Voice transcription is unavailable.');
      return;
    }

    setIsTranscribing(true);
    try {
      const audioDataUrl = await blobToDataUrl(audioBlob);
      const result = await onTranscribeAudio({
        audioDataUrl,
        mimeType,
        durationMs: Date.now() - recordingStartedAtRef.current,
        language: 'en',
      });
      appendTranscript(result.text);
    } catch (error) {
      setVoiceError(getVoiceErrorMessage(error));
    } finally {
      setIsTranscribing(false);
    }
  };

  const startRecording = async () => {
    if (!onTranscribeAudio) {
      setVoiceError('Voice transcription is unavailable.');
      return;
    }
    if (disabled || isRecording || isTranscribing) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceError('Voice recording is not supported in this browser.');
      return;
    }

    try {
      setClipboardError(null);
      setVoiceError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const selectedMimeType = selectRecordingMimeType();
      const recorder = selectedMimeType
        ? new MediaRecorder(stream, { mimeType: selectedMimeType })
        : new MediaRecorder(stream);

      streamRef.current = stream;
      recorderRef.current = recorder;
      recordingChunksRef.current = [];
      recordingFailedRef.current = false;
      recordingStartedAtRef.current = Date.now();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        recordingFailedRef.current = true;
        setVoiceError('Voice recording failed.');
        stopRecording();
      };
      recorder.onstop = () => {
        void finishRecording(recorder);
      };

      recorder.start();
      setIsRecording(true);
      maxRecordingTimerRef.current = window.setTimeout(stopRecording, MAX_RECORDING_MS);
    } catch (error) {
      stopRecordingStream();
      recorderRef.current = null;
      recordingChunksRef.current = [];
      recordingFailedRef.current = false;
      setVoiceError(getVoiceErrorMessage(error));
    }
  };

  useEffect(() => () => {
    clearMaxRecordingTimer();
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
    }
    stopRecordingStream();
  }, []);

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
            rows={4}
            disabled={disabled}
            placeholder="Type command or prompt..."
            className="max-h-40 min-h-24 w-full resize-none rounded-lg border border-border-secondary bg-bg-primary px-3 py-2.5 pr-12 text-xs leading-4 text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-interactive disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            type="button"
            onClick={isRecording ? stopRecording : () => { void startRecording(); }}
            disabled={(!isRecording && disabled) || isTranscribing || !onTranscribeAudio}
            className={`absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-md border bg-bg-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              isRecording
                ? 'border-status-error/50 text-status-error hover:bg-status-error/10'
                : 'border-border-secondary text-text-secondary hover:bg-surface-hover hover:text-text-primary'
            }`}
            aria-label={isRecording ? 'Stop voice recording' : 'Start voice recording'}
            title={isRecording ? 'Stop recording' : 'Voice input'}
          >
            {isTranscribing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isRecording ? (
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

      {(clipboardError || voiceError || isRecording || isTranscribing) && (
        <div className="mt-1 space-y-1">
          {clipboardError && (
            <p className="text-xs text-status-error">{clipboardError}</p>
          )}
          {voiceError && (
            <p className="text-xs text-status-error">{voiceError}</p>
          )}
          {isRecording && (
            <p className="text-xs text-status-warning">Recording voice input...</p>
          )}
          {isTranscribing && (
            <p className="text-xs text-text-tertiary">Transcribing voice input...</p>
          )}
        </div>
      )}
    </div>
  );
}

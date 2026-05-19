import { useState } from 'react';
import { ArrowRight, ClipboardPaste, Monitor, Trash2 } from 'lucide-react';
import type { RemotePaneConnectionProfile } from '../../../../shared/types/remoteDaemon';

interface RemoteConnectionScreenProps {
  savedProfiles: RemotePaneConnectionProfile[];
  error: string | null;
  onConnectCode: (code: string) => Promise<void>;
  onConnectProfile: (profile: RemotePaneConnectionProfile) => Promise<void>;
  onForgetProfile: (profileId: string) => void;
}

export function RemoteConnectionScreen({
  savedProfiles,
  error,
  onConnectCode,
  onConnectProfile,
  onForgetProfile,
}: RemoteConnectionScreenProps) {
  const [code, setCode] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const canReadClipboard = typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText);

  const handleSubmit = async () => {
    let connectionCode = code.trim();
    if (!connectionCode && canReadClipboard) {
      try {
        connectionCode = (await navigator.clipboard.readText()).trim();
        setCode(connectionCode);
      } catch {
        setClipboardError('Clipboard access was blocked. Paste the connection code manually.');
        return;
      }
    }

    if (!connectionCode) return;

    setIsConnecting(true);
    setClipboardError(null);
    try {
      await onConnectCode(connectionCode);
      setCode('');
    } catch {
      // The parent owns the visible error state.
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <main className="flex min-h-dvh w-full items-center justify-center overflow-y-auto bg-bg-primary px-4 py-6 text-text-primary sm:p-6">
      <section className="w-full max-w-sm rounded-lg border border-border-primary bg-surface-primary p-5 shadow-lg sm:max-w-lg sm:p-6">
        <div className="mb-6 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-secondary text-interactive">
            <Monitor className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-text-primary">Remote Pane</h1>
            <p className="text-sm text-text-secondary">Connect to a Pane host using a connection code from Settings &gt; Remote Pane.</p>
          </div>
        </div>

        <label className="mb-2 block text-sm font-medium text-text-secondary" htmlFor="connection-code">
          Connection Code
        </label>
        <textarea
          id="connection-code"
          value={code}
          onChange={event => setCode(event.target.value)}
          placeholder="pane-remote://..."
          className="min-h-32 max-h-52 w-full resize-y rounded-md border border-border-primary bg-bg-secondary p-3 font-mono text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border-focus"
        />

        {(error || clipboardError) && (
          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
            <p>{error || clipboardError}</p>
            {error && (
              <p className="mt-2 text-xs text-red-500/90">
                If this profile uses Tailscale, install or open Tailscale on this device, sign in to the same tailnet as the host, then retry.
              </p>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-stretch sm:justify-end">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isConnecting || (!code.trim() && !canReadClipboard)}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-interactive px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:py-2"
          >
            {code.trim() ? <ArrowRight className="h-4 w-4" /> : <ClipboardPaste className="h-4 w-4" />}
            {isConnecting ? 'Connecting...' : code.trim() ? 'Import & Connect' : 'Paste & Connect'}
          </button>
        </div>

        {savedProfiles.length > 0 && (
          <div className="mt-7 border-t border-border-primary pt-5">
            <h2 className="mb-3 text-sm font-semibold text-text-secondary">Saved profiles</h2>
            <div className="space-y-2">
              {savedProfiles.map(profile => (
                <div key={profile.id} className="flex flex-col gap-3 rounded-md border border-border-primary bg-surface-secondary px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">{profile.label}</p>
                    <p className="truncate text-xs text-text-tertiary">{profile.baseUrl}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { void onConnectProfile(profile).catch(() => {}); }}
                      className="min-w-0 flex-1 rounded-md bg-interactive px-3 py-2 text-sm font-semibold text-white hover:opacity-90 sm:flex-none sm:py-1.5"
                    >
                      Connect
                    </button>
                    <button
                      type="button"
                      onClick={() => onForgetProfile(profile.id)}
                      className="rounded-md p-2 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
                      aria-label={`Forget ${profile.label}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

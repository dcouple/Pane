import { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle, Clipboard, Download, ExternalLink, Loader2, Terminal } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isMac } from '../utils/platformUtils';

interface UpdateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  versionInfo?: {
    current: string;
    latest: string;
    hasUpdate: boolean;
    releaseUrl?: string;
    downloadUrl?: string;
    releaseNotes?: string;
  };
}

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';

interface DownloadProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

export function UpdateDialog({ isOpen, onClose, versionInfo }: UpdateDialogProps) {
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPackaged, setIsPackaged] = useState(false);

  // Reset internal state whenever the dialog opens so stale error/progress state
  // from a previous attempt doesn't persist across opens
  useEffect(() => {
    if (isOpen) {
      setUpdateState('idle');
      setDownloadProgress(null);
      setError(null);
      setMessage(null);
    }
  }, [isOpen]);

  useEffect(() => {
    // Check if app is packaged (auto-update only works in packaged apps)
    if (window.electronAPI?.isPackaged) {
      window.electronAPI.isPackaged().then((packaged) => {
        console.log('[UpdateDialog] App packaged state:', packaged);
        setIsPackaged(packaged);
      });
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !window.electronAPI?.events) return;

    // Set up auto-updater event listeners
    const cleanupFns: Array<() => void> = [];

    cleanupFns.push(
      window.electronAPI.events.onUpdaterCheckingForUpdate(() => {
        setUpdateState('checking');
        setError(null);
      })
    );

    cleanupFns.push(
      window.electronAPI.events.onUpdaterUpdateAvailable((info) => {
        console.log('Update available:', info);
        setUpdateState('available');
      })
    );

    cleanupFns.push(
      window.electronAPI.events.onUpdaterUpdateNotAvailable((info) => {
        console.log('No update available:', info);
        setUpdateState('idle');
      })
    );

    cleanupFns.push(
      window.electronAPI.events.onUpdaterDownloadProgress((progress) => {
        setUpdateState('downloading');
        setDownloadProgress(progress);
      })
    );

    cleanupFns.push(
      window.electronAPI.events.onUpdaterUpdateDownloaded((info) => {
        console.log('Update downloaded:', info);
        setUpdateState('downloaded');
        setDownloadProgress(null);
      })
    );

    cleanupFns.push(
      window.electronAPI.events.onUpdaterError((err) => {
        console.error('Update error:', err);
        setUpdateState('error');
        setError(err.message || 'An unknown error occurred');
      })
    );

    return () => {
      cleanupFns.forEach(fn => fn());
    };
  }, [isOpen]);

  const handleCheckForUpdates = async () => {
    if (!window.electronAPI?.updater) {
      setError('Update functionality not available');
      return;
    }
    try {
      setError(null);
      setMessage(null);
      await window.electronAPI.updater.checkAndDownload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to check for updates');
      setUpdateState('error');
    }
  };

  const handleDownloadUpdate = async () => {
    if (!window.electronAPI?.updater) {
      setError('Update functionality not available');
      return;
    }
    try {
      setError(null);
      setMessage(null);
      await window.electronAPI.updater.downloadUpdate();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to download update');
      setUpdateState('error');
    }
  };

  const handleInstallUpdate = async () => {
    if (!window.electronAPI?.updater) {
      setError('Update functionality not available');
      return;
    }
    try {
      await window.electronAPI.updater.installUpdate();
      // App will restart, so no need to handle response
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to install update');
      setUpdateState('error');
    }
  };

  const handleCopyUpdateCommand = async () => {
    if (!window.electronAPI?.updater) {
      setError('Update functionality not available');
      return;
    }

    try {
      const response = await window.electronAPI.updater.copyUpdateCommand();
      if (response.success) {
        setError(null);
        setMessage('Update command copied. Paste it into Terminal and press Return.');
      } else {
        setMessage(null);
        setError(response.error || 'Failed to copy update command');
        setUpdateState('error');
      }
    } catch (err: unknown) {
      setMessage(null);
      setError(err instanceof Error ? err.message : 'Failed to copy update command');
      setUpdateState('error');
    }
  };

  const handleOpenTerminalWithCommand = async () => {
    if (!window.electronAPI?.updater) {
      setError('Update functionality not available');
      return;
    }

    try {
      const response = await window.electronAPI.updater.openTerminalWithCommand();
      if (response.success) {
        setError(null);
        setMessage('Terminal opened and the update command was copied. Paste it and press Return.');
      } else {
        setMessage(null);
        setError(response.error || 'Failed to open Terminal');
        setUpdateState('error');
      }
    } catch (err: unknown) {
      setMessage(null);
      setError(err instanceof Error ? err.message : 'Failed to open Terminal');
      setUpdateState('error');
    }
  };

  const openDmgDownload = () => {
    if (versionInfo?.downloadUrl) {
      window.electronAPI.openExternal(versionInfo.downloadUrl);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatSpeed = (bytesPerSecond: number) => {
    return formatBytes(bytesPerSecond) + '/s';
  };

  const renderMacUpdateActions = () => (
    <div className="space-y-4">
      <div className="space-y-3">
        <Button
          onClick={handleOpenTerminalWithCommand}
          variant="primary"
          size="lg"
          fullWidth
          icon={<Terminal className="w-4 h-4" />}
        >
          Copy command and open Terminal
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleCopyUpdateCommand}
            variant="secondary"
            size="sm"
            icon={<Clipboard className="w-4 h-4" />}
          >
            Copy command
          </Button>
          <Button
            onClick={openDmgDownload}
            variant="secondary"
            size="sm"
            icon={<Download className="w-4 h-4" />}
            disabled={!versionInfo?.downloadUrl}
          >
            Download DMG
          </Button>
          {versionInfo?.releaseUrl && (
            <Button
              onClick={() => window.electronAPI.openExternal(versionInfo.releaseUrl!)}
              variant="secondary"
              size="sm"
              icon={<ExternalLink className="w-4 h-4" />}
            >
              View on GitHub
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-3 text-sm">
        <p className="text-text-secondary">
          This opens Terminal and copies the Pane update command.
          Paste it, press Return, and the latest Pane installer will download and open.
        </p>
        <p className="text-text-secondary">
          After the DMG opens: close Pane, drag Pane.app into Applications, and choose Replace.
          Your settings and sessions are preserved.
        </p>
        <code className="block bg-surface-primary border border-border-primary rounded px-3 py-2 text-xs text-text-primary font-mono break-all">
          curl -fsSL https://runpane.com/install.sh | sh
        </code>
      </div>
    </div>
  );

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" showCloseButton={false}>
      <ModalHeader onClose={updateState === 'downloading' ? undefined : onClose}>
        <div className="flex items-center gap-3">
          <Download className="w-6 h-6 text-interactive" />
          <h2 className="text-xl font-semibold text-text-primary">Software Update</h2>
        </div>
      </ModalHeader>

      <ModalBody className="space-y-6">
          {versionInfo && (
            <div>
              <div className="text-text-secondary mb-2">
                Current version: <span className="font-mono text-text-primary">{versionInfo.current}</span>
              </div>
              {versionInfo.hasUpdate && (
                <div className="text-text-secondary">
                  Latest version: <span className="font-mono text-status-success">{versionInfo.latest}</span>
                </div>
              )}
            </div>
          )}

          {/* Update State UI */}
          <div className="space-y-4">
            {updateState === 'idle' && versionInfo?.hasUpdate && (
              <div className="bg-surface-secondary rounded-lg p-4">
                <h3 className="text-lg font-medium text-text-primary mb-2">Update Available</h3>
                <p className="text-text-secondary mb-4">
                  A new version of Pane is available.
                  {isPackaged && isMac()
                    ? ' Use the terminal-assisted update path below.'
                    : isPackaged
                      ? ' Click below to download and install the update.'
                      : ' Auto-update is only available in the packaged app.'}
                </p>

                {/*
                 * Temporary workaround pending Apple code signing:
                 * On macOS, electron-updater's quitAndInstall() fails because Gatekeeper
                 * quarantines unsigned .zip replacements. Until the builds are signed, we
                 * skip the in-app download flow entirely on macOS and direct users to
                 * manually download and drag-install from GitHub instead.
                 */}
                {isPackaged && isMac() ? (
                  renderMacUpdateActions()
                ) : isPackaged ? (
                  <Button
                    onClick={handleCheckForUpdates}
                    variant="primary"
                    icon={<Download className="w-4 h-4" />}
                  >
                    Download Update
                  </Button>
                ) : (
                  <Button
                    onClick={() => versionInfo.releaseUrl && window.electronAPI.openExternal(versionInfo.releaseUrl)}
                    variant="primary"
                  >
                    View Release
                  </Button>
                )}
              </div>
            )}

            {updateState === 'checking' && (
              <div className="flex items-center gap-3 text-text-secondary">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Checking for updates...</span>
              </div>
            )}

            {updateState === 'available' && (
              <div className="bg-surface-secondary rounded-lg p-4">
                <h3 className="text-lg font-medium text-text-primary mb-2">Ready to Download</h3>
                <p className="text-text-secondary mb-4">
                  The update is ready to download. This may take a few minutes depending on your connection.
                </p>
                <Button
                  onClick={handleDownloadUpdate}
                  variant="primary"
                  icon={<Download className="w-4 h-4" />}
                >
                  Start Download
                </Button>
              </div>
            )}

            {updateState === 'downloading' && downloadProgress && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 text-text-secondary">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Downloading update...</span>
                </div>
                
                <div className="bg-surface-secondary rounded-lg p-4 space-y-3">
                  <div className="flex justify-between text-sm text-text-tertiary">
                    <span>{formatBytes(downloadProgress.transferred)} / {formatBytes(downloadProgress.total)}</span>
                    <span>{formatSpeed(downloadProgress.bytesPerSecond)}</span>
                  </div>
                  
                  <div className="w-full bg-surface-tertiary rounded-full h-2">
                    <div 
                      className="bg-interactive h-2 rounded-full transition-all duration-300"
                      style={{ width: `${downloadProgress.percent}%` }}
                    />
                  </div>
                  
                  <div className="text-center text-sm text-text-tertiary">
                    {Math.round(downloadProgress.percent)}%
                  </div>
                </div>
              </div>
            )}

            {updateState === 'downloaded' && (
              <div className="bg-status-success/10 border border-status-success/30 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-5 h-5 text-status-success mt-0.5" />
                  <div className="flex-1">
                    <h3 className="text-lg font-medium text-status-success mb-2">Update Downloaded</h3>
                    {/* Safety guard: quitAndInstall() doesn't work on unsigned macOS builds */}
                    {isMac() ? (
                      <div className="space-y-4">
                        <p className="text-text-secondary">
                          Please install the update manually to ensure it works correctly on macOS.
                        </p>
                        {renderMacUpdateActions()}
                      </div>
                    ) : (
                      <>
                        <p className="text-text-secondary mb-4">
                          The update has been downloaded successfully. Pane will restart to apply the update.
                        </p>
                        <Button
                          onClick={handleInstallUpdate}
                          variant="primary"
                          className="bg-status-success hover:bg-status-success/90"
                        >
                          Restart and Install
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {updateState === 'error' && error && (
              <div className="space-y-4">
                {/* Manual Download Box */}
                {isMac() ? (
                  <div className="bg-interactive/10 border border-interactive/30 rounded-lg p-4">
                    <h3 className="text-lg font-medium text-interactive mb-3">Manual Update Available</h3>
                    {renderMacUpdateActions()}
                  </div>
                ) : versionInfo?.releaseUrl && (
                  <div className="bg-interactive/10 border border-interactive/30 rounded-lg p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-medium text-interactive mb-1">Manual Update Available</h3>
                        <p className="text-sm text-text-secondary">
                          Automatic update failed, but you can download the latest version manually.
                        </p>
                      </div>
                      <Button
                        onClick={() => window.electronAPI.openExternal(versionInfo.releaseUrl!)}
                        variant="primary"
                        icon={<Download className="w-4 h-4" />}
                      >
                        Download from GitHub
                      </Button>
                    </div>
                  </div>
                )}

                {/* Error Details */}
                <div className="bg-status-error/10 border border-status-error/30 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-status-error mt-0.5" />
                    <div className="flex-1">
                      <h3 className="text-lg font-medium text-status-error mb-2">Update Error</h3>
                      <p className="text-text-secondary mb-2">{error}</p>
                      <div className="space-y-3">
                        {isMac() ? (
                          <p className="text-sm text-text-secondary">
                            Use the update command above, or download the DMG directly. After the DMG opens,
                            close Pane, drag Pane.app into Applications, and choose Replace.
                          </p>
                        ) : (
                          <>
                            <p className="text-sm text-text-tertiary">
                              To update manually:
                            </p>
                            <ol className="text-sm text-text-secondary list-decimal list-inside ml-2 space-y-2">
                              <li>Click "Download from GitHub" above</li>
                              <li>Download the installer from the release page</li>
                              <li>Close Pane</li>
                              <li>Open the downloaded installer</li>
                              <li>Launch the new version of Pane</li>
                            </ol>
                          </>
                        )}
                        <p className="text-sm text-text-tertiary mt-3">
                          Your settings and sessions will be preserved during the update.
                        </p>
                        {(error.includes('404') || error.includes('latest-mac.yml')) && (
                          <div className="mt-3 p-2 bg-surface-primary rounded text-xs text-text-tertiary">
                            <p className="font-semibold mb-1">Technical Details:</p>
                            <p>The release may be missing required update metadata files, or you may be testing with a development version.</p>
                          </div>
                        )}
                      </div>
                      {versionInfo?.releaseUrl && (
                        <button
                          onClick={() => window.electronAPI.openExternal(versionInfo.releaseUrl!)}
                          className="mt-3 text-sm text-interactive hover:text-interactive-hover underline"
                        >
                          View Release on GitHub
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {message && (
              <div className="bg-status-success/10 border border-status-success/30 rounded-lg p-3 text-sm text-status-success">
                {message}
              </div>
            )}

            {!versionInfo?.hasUpdate && updateState === 'idle' && (
              <div className="text-center py-8">
                <CheckCircle className="w-12 h-12 text-status-success mx-auto mb-3" />
                <p className="text-text-secondary">You're running the latest version of Pane!</p>
              </div>
            )}
          </div>

          {/* Release Notes */}
          {versionInfo?.releaseNotes && (
            <div className="mt-6">
              <h3 className="text-lg font-medium text-text-primary mb-3">Release Notes</h3>
              <div className="bg-surface-secondary rounded-lg p-4 max-h-64 overflow-y-auto">
                <div className="text-sm">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => <h1 className="text-2xl font-bold mt-4 mb-3 text-text-primary">{children}</h1>,
                      h2: ({ children }) => <h2 className="text-xl font-bold mt-3 mb-2 text-text-primary">{children}</h2>,
                      h3: ({ children }) => <h3 className="text-lg font-bold mt-2 mb-2 text-text-primary">{children}</h3>,
                      h4: ({ children }) => <h4 className="text-base font-bold mt-2 mb-1 text-text-primary">{children}</h4>,
                      p: ({ children }) => <p className="mb-3 text-text-primary">{children}</p>,
                      ul: ({ children }) => <ul className="list-disc mb-3 ml-6 text-text-primary">{children}</ul>,
                      ol: ({ children }) => <ol className="list-decimal mb-3 ml-6 text-text-primary">{children}</ol>,
                      li: ({ children }) => <li className="mb-1 text-text-primary">{children}</li>,
                      blockquote: ({ children }) => (
                        <blockquote className="border-l-4 border-border-secondary pl-4 italic my-3 text-text-tertiary">
                          {children}
                        </blockquote>
                      ),
                      a: ({ href, children }) => (
                        <a href={href} className="text-interactive hover:text-interactive-hover underline" target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      ),
                      code: ({ children }) => (
                        <code className="bg-surface-tertiary px-1 py-0.5 rounded text-text-primary font-mono text-xs">
                          {children}
                        </code>
                      ),
                      hr: () => <hr className="my-4 border-border-primary" />,
                    }}
                  >
                    {versionInfo.releaseNotes}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          )}
      </ModalBody>

      <ModalFooter>
        <div className="flex justify-between items-center w-full">
          <div className="text-sm text-text-tertiary">
            {versionInfo?.releaseUrl && (
              <button
                onClick={() => window.electronAPI.openExternal(versionInfo.releaseUrl!)}
                className="hover:text-text-secondary underline transition-colors"
              >
                View on GitHub
              </button>
            )}
          </div>
          <Button
            onClick={onClose}
            variant="secondary"
            disabled={updateState === 'downloading'}
          >
            Close
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}

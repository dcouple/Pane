import { useState, useEffect, useCallback } from 'react';
import { GitFork, Download, AlertCircle, Star, ExternalLink, CheckCircle2, Loader2 } from 'lucide-react';
import { usePaneLogo } from '../hooks/usePaneLogo';
import { Modal, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { capture } from '../services/posthog';

type DialogStep = 'detecting' | 'ready' | 'cloning' | 'success' | 'error';

interface EnvironmentInfo {
  gitInstalled: boolean;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
}

interface OnboardingDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function OnboardingDialog({ isOpen, onClose }: OnboardingDialogProps) {
  const paneLogo = usePaneLogo();
  const [step, setStep] = useState<DialogStep>('detecting');
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [hasStarred, setHasStarred] = useState(false);
  const [shouldStarOnSetup, setShouldStarOnSetup] = useState(true);

  const detectEnvironment = useCallback(async () => {
    setStep('detecting');
    try {
      const result = await window.electronAPI.onboarding.detectEnvironment();
      if (result.success && result.data) {
        setEnv(result.data as EnvironmentInfo);
        setStep('ready');
      } else {
        setEnv({ gitInstalled: false, ghInstalled: false, ghAuthenticated: false });
        setStep('ready');
      }
    } catch {
      setEnv({ gitInstalled: false, ghInstalled: false, ghAuthenticated: false });
      setStep('ready');
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      detectEnvironment();
      capture('onboarding_started');
    }
  }, [isOpen, detectEnvironment]);

  const handleSetup = async () => {
    setStep('cloning');
    try {
      const result = await window.electronAPI.onboarding.setupDefaultRepo();
      if (result.success) {
        // Best-effort star during setup when the user opted in and gh is authed.
        // Fire-and-forget: star failure or latency must not block or delay the
        // transition to the success screen. When the promise later resolves,
        // setHasStarred will flip the success-screen copy to "Thanks!".
        if (shouldStarOnSetup && env?.ghAuthenticated) {
          void window.electronAPI.onboarding.starRepo()
            .then((starResult) => {
              if (starResult?.success) {
                setHasStarred(true);
                capture('onboarding_repo_starred_during_setup');
              }
            })
            .catch(() => {
              // swallow: star failure is non-fatal
            });
        }
        setStep('success');
      } else {
        setErrorMessage(result.error || 'Failed to set up project');
        setStep('error');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'An unexpected error occurred');
      setStep('error');
    }
  };

  const handleStar = async () => {
    try {
      const result = await window.electronAPI.onboarding.starRepo();
      if (result.success) {
        setHasStarred(true);
      } else {
        // Fall back to opening in browser
        window.electronAPI.openExternal('https://github.com/Dcouple-Inc/Pane');
        setHasStarred(true);
      }
    } catch {
      window.electronAPI.openExternal('https://github.com/Dcouple-Inc/Pane');
      setHasStarred(true);
    }
  };

  const handleSkip = async () => {
    capture('onboarding_skipped');
    try {
      if (window.electron?.invoke) {
        await window.electron.invoke('preferences:set', 'onboarding_repo_setup', 'true');
      }
    } catch {
      // Ensure dialog closes even if preference write fails
    }
    onClose();
  };

  const handleFinish = async () => {
    try {
      if (window.electron?.invoke) {
        await window.electron.invoke('preferences:set', 'onboarding_repo_setup', 'true');
      }
    } catch {
      // Ensure dialog closes even if preference write fails
    }
    // Parent onClose handler dispatches 'project-changed', so no need to dispatch here
    onClose();
  };

  const handleRetry = () => {
    setErrorMessage('');
    detectEnvironment();
  };

  const handleOpenGitGuide = () => {
    window.electronAPI.openExternal('https://git-scm.com/downloads');
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {}}
      size="md"
      closeOnOverlayClick={false}
      closeOnEscape={false}
      showCloseButton={false}
    >
      {/* Header */}
      <div className="p-6 border-b border-border-primary">
        <div className="flex items-center">
          <img src={paneLogo} alt="Pane" className="h-10 w-10 mr-3" />
          <h1 className="text-lg font-semibold text-text-primary">Get Started with Pane</h1>
        </div>
      </div>

      <ModalBody>
        {step === 'detecting' && (
          <div className="flex flex-col items-center py-8 gap-4">
            <Loader2 className="h-8 w-8 text-interactive animate-spin" />
            <p className="text-text-secondary">Checking your setup...</p>
          </div>
        )}

        {step === 'ready' && env && (
          <div className="space-y-4">
            {env.ghAuthenticated ? (
              <>
                <div className="flex items-start gap-3">
                  <GitFork className="h-6 w-6 text-interactive flex-shrink-0 mt-0.5" />
                  <div className="space-y-2">
                    <p className="text-text-primary font-medium">
                      Start with Pane as your first project
                    </p>
                    <p className="text-text-secondary text-sm">
                      Start developing with Pane.
                    </p>
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input
                    type="checkbox"
                    checked={shouldStarOnSetup}
                    onChange={(e) => setShouldStarOnSetup(e.target.checked)}
                    className="rounded border-border-primary text-interactive focus:ring-interactive"
                  />
                  <Star className="h-3.5 w-3.5 text-text-secondary flex-shrink-0" />
                  <Tooltip
                    side="top"
                    interactive
                    content={
                      <div className="max-w-xs whitespace-normal">
                        Stars are the cheapest form of support, and they help this project reach more developers. Pane is built by Dcouple, a self-funded two-person studio.
                      </div>
                    }
                  >
                    <span className="text-text-secondary text-xs underline decoration-dotted underline-offset-2">
                      Help us keep building Pane independently
                    </span>
                  </Tooltip>
                </label>
              </>
            ) : env.gitInstalled ? (
              <div className="flex items-start gap-3">
                <Download className="h-6 w-6 text-interactive flex-shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <p className="text-text-primary font-medium">
                    Clone Repository
                  </p>
                  <p className="text-text-secondary text-sm">
                    We&apos;ll clone the Pane repository so you can explore it right away.
                    You can fork it later on GitHub if you want to contribute.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <AlertCircle className="h-6 w-6 text-status-warning flex-shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <p className="text-text-primary font-medium">
                    Git Required
                  </p>
                  <p className="text-text-secondary text-sm">
                    Git is required to use Pane. Please install Git and restart the application.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'cloning' && (
          <div className="flex flex-col items-center py-8 gap-4">
            <Loader2 className="h-8 w-8 text-interactive animate-spin" />
            <p className="text-text-primary font-medium">Setting up your project...</p>
            <p className="text-text-secondary text-sm">This may take a moment</p>
          </div>
        )}

        {step === 'success' && (
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-6 w-6 text-status-success flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-text-primary font-medium">Pane is ready!</p>
                <p className="text-text-secondary text-sm">
                  The Pane repository has been set up as your first project.
                </p>
              </div>
            </div>

            {/* Star prompt */}
            <div className="p-4 bg-surface-secondary border border-border-secondary rounded-lg">
              <div className="flex items-start gap-3">
                <Star className={`h-5 w-5 flex-shrink-0 mt-0.5 ${hasStarred ? 'text-yellow-500 fill-yellow-500' : 'text-text-secondary'}`} />
                <div className="space-y-2 flex-1">
                  <p className="text-text-primary text-sm">
                    {hasStarred
                      ? 'Thanks for your support!'
                      : 'If you like Pane, consider starring us on GitHub!'}
                  </p>
                  {!hasStarred && (
                    <button
                      onClick={handleStar}
                      className="inline-flex items-center gap-1.5 text-sm text-interactive hover:text-interactive-hover transition-colors"
                    >
                      <Star className="h-4 w-4" />
                      Star on GitHub
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-6 w-6 text-status-error flex-shrink-0 mt-0.5" />
              <div className="space-y-2">
                <p className="text-text-primary font-medium">Setup Failed</p>
                <p className="text-text-secondary text-sm">{errorMessage}</p>
              </div>
            </div>
          </div>
        )}
      </ModalBody>

      <ModalFooter className="flex justify-between items-center">
        {step === 'detecting' && (
          <>
            <Button onClick={handleSkip} variant="ghost">Skip</Button>
            <div />
          </>
        )}

        {step === 'ready' && env && (
          <>
            <Button onClick={handleSkip} variant="ghost">Skip</Button>
            {env.ghAuthenticated ? (
              <Button onClick={handleSetup} variant="primary" icon={<GitFork className="h-4 w-4" />}>
                Let&apos;s go
              </Button>
            ) : env.gitInstalled ? (
              <Button onClick={handleSetup} variant="primary" icon={<Download className="h-4 w-4" />}>
                Clone Repository
              </Button>
            ) : (
              <Button onClick={handleOpenGitGuide} variant="primary" icon={<ExternalLink className="h-4 w-4" />}>
                Install Git
              </Button>
            )}
          </>
        )}

        {step === 'cloning' && (
          <>
            <div />
            <Button variant="primary" disabled loading loadingText="Setting up...">
              Setting up...
            </Button>
          </>
        )}

        {step === 'success' && (
          <>
            <div />
            <Button onClick={handleFinish} variant="primary">
              Get Started
            </Button>
          </>
        )}

        {step === 'error' && (
          <>
            <Button onClick={handleSkip} variant="ghost">Skip</Button>
            <Button onClick={handleRetry} variant="primary">
              Try Again
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

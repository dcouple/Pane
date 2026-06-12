import { useState, useEffect, useCallback } from 'react';
import { GitFork, Download, AlertCircle, Star, ExternalLink, Loader2 } from 'lucide-react';
import { usePaneLogo } from '../hooks/usePaneLogo';
import { Modal, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { capture } from '../services/posthog';

type DialogStep = 'detecting' | 'ready';

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
  const [shouldSupportOnSetup, setShouldSupportOnSetup] = useState(true);
  const [showSupportPopover, setShowSupportPopover] = useState(false);
  const [showOptOutConfirm, setShowOptOutConfirm] = useState(false);

  const markOnboardingComplete = async () => {
    try {
      if (window.electron?.invoke) {
        await window.electron.invoke('preferences:set', 'onboarding_repo_setup', 'true');
      }
    } catch {
      // Ensure dialog closes even if preference write fails
    }
  };

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
    await markOnboardingComplete();
    onClose();

    if (shouldSupportOnSetup && env?.ghAuthenticated) {
      void window.electronAPI.onboarding.supportProject()
        .then((supportResult) => {
          if (supportResult?.success) {
            capture('onboarding_project_supported_during_setup');
          }
        })
        .catch(() => {
          // swallow: support failure is non-fatal
        });
    }

    void window.electronAPI.onboarding.setupDefaultRepo()
      .then((result) => {
        if (result.success) {
          window.dispatchEvent(new Event('project-changed'));
        } else {
          console.error('[Onboarding] Background setup failed:', result.error || 'Failed to set up project');
        }
      })
      .catch((error) => {
        console.error('[Onboarding] Background setup failed:', error);
      });
  };

  const handleSkip = async () => {
    capture('onboarding_skipped');
    await markOnboardingComplete();
    onClose();
  };

  const handleSupportCheckboxChange = (checked: boolean) => {
    if (!checked && shouldSupportOnSetup) {
      setShowSupportPopover(false);
      setShowOptOutConfirm(true);
      return;
    }

    setShouldSupportOnSetup(checked);
  };

  const handleKeepSupporting = () => {
    setShouldSupportOnSetup(true);
    setShowOptOutConfirm(false);
  };

  const handleConfirmOptOut = () => {
    setShouldSupportOnSetup(false);
    setShowOptOutConfirm(false);
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

      <ModalBody className={step === 'ready' && env?.ghAuthenticated ? 'overflow-visible' : undefined}>
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
                      Start developing with Pane as your first project
                    </p>
                    <p className="text-text-secondary text-sm">
                      We&apos;ll set up a real codebase so you&apos;re not staring at a blank screen.
                    </p>
                  </div>
                </div>
                <div
                  className="relative w-fit ml-9"
                  onMouseEnter={() => {
                    if (!showOptOutConfirm) setShowSupportPopover(true);
                  }}
                  onMouseLeave={() => setShowSupportPopover(false)}
                  onFocus={() => {
                    if (!showOptOutConfirm) setShowSupportPopover(true);
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                      setShowSupportPopover(false);
                    }
                  }}
                >
                  {(showSupportPopover || showOptOutConfirm) && (
                    <div className="absolute left-0 bottom-full mb-3 w-80 z-30 rounded-lg border border-border-primary bg-surface-primary shadow-lg p-4">
                      {showOptOutConfirm ? (
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <p className="text-sm font-semibold text-text-primary">Keep supporting independent development?</p>
                            <p className="text-xs leading-relaxed text-text-secondary">
                              Pane is built by Parsa, a self-funded developer, not a large corporation. A GitHub star for Pane and a follow are the easiest free way to support the project so it can keep growing.
                            </p>
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={handleConfirmOptOut}>
                              Uncheck anyway
                            </Button>
                            <Button variant="primary" size="sm" onClick={handleKeepSupporting}>
                              Keep supporting
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-text-primary">Support Pane with a star and follow</p>
                          <p className="text-xs leading-relaxed text-text-secondary">
                            Pane is built by Parsa, a self-funded developer. A GitHub star for Pane and a follow are the easiest free way to support the project so it can keep growing.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  <label className="flex items-center gap-2 cursor-pointer w-fit">
                    <input
                      type="checkbox"
                      checked={shouldSupportOnSetup}
                      onChange={(e) => handleSupportCheckboxChange(e.target.checked)}
                      className="rounded border-border-primary text-interactive focus:ring-interactive"
                    />
                    <Star className="h-3.5 w-3.5 text-text-secondary flex-shrink-0" />
                    <span className="text-text-secondary text-xs underline decoration-dotted underline-offset-2">
                      Help us keep building Pane independently
                    </span>
                  </label>
                </div>
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

      </ModalFooter>
    </Modal>
  );
}

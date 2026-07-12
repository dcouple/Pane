import React from 'react';
import { BarChart3 } from 'lucide-react';
import { usePaneLogo } from '../hooks/usePaneLogo';
import { Modal, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { useConfigStore } from '../stores/configStore';
import {
  aliasInstallIdentity,
  aliasInstallIdentityDirect,
  aliasWebVisitor,
  aliasWebVisitorDirect,
  captureAndOptOut,
  captureUnconditionally,
  discardPendingEvents,
  flushPendingEvents,
  initPostHog,
} from '../services/posthog';
import type { AnalyticsIdentity } from '../types/config';

interface AnalyticsConsentDialogProps {
  isOpen: boolean;
  onClose: (accepted: boolean) => void;
  analyticsIdentity?: AnalyticsIdentity;
  onResolveAnalyticsIdentity: () => Promise<AnalyticsIdentity | undefined>;
  onCaptureFirstOpen: (identity?: AnalyticsIdentity) => Promise<void>;
}

export default function AnalyticsConsentDialog({
  isOpen,
  onClose,
  analyticsIdentity,
  onResolveAnalyticsIdentity,
  onCaptureFirstOpen,
}: AnalyticsConsentDialogProps) {
  const paneLogo = usePaneLogo();
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const { config, updateConfig } = useConfigStore();

  const handleAccept = async () => {
    setIsSubmitting(true);
    try {
      const identity = analyticsIdentity ?? await onResolveAnalyticsIdentity();

      await updateConfig({
        analytics: {
          ...config?.analytics,
          enabled: true,
        },
      });

      initPostHog({
        enabled: true,
        posthogApiKey: config?.analytics?.posthogApiKey,
        posthogHost: config?.analytics?.posthogHost,
        identity,
      }, { flushPendingEvents: false });

      aliasInstallIdentity(identity);

      if (identity?.webDistinctId) {
        aliasWebVisitor(identity.webDistinctId, identity.distinctId);
        void window.electronAPI?.analytics?.redeemAttribution?.();
      }

      await captureUnconditionally('analytics_opted_in', undefined, identity);
      await onCaptureFirstOpen(identity);
      flushPendingEvents();

      // Mark consent as shown
      if (window.electron?.invoke) {
        await window.electron.invoke('preferences:set', 'analytics_consent_shown', 'true');
      }

      onClose(true);
    } catch (error) {
      console.error('[AnalyticsConsent] Error accepting analytics:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDecline = async () => {
    setIsSubmitting(true);
    try {
      const identity = analyticsIdentity ?? await onResolveAnalyticsIdentity();

      initPostHog({
        enabled: false,
        posthogApiKey: config?.analytics?.posthogApiKey,
        posthogHost: config?.analytics?.posthogHost,
        identity,
      }, { flushPendingEvents: false });

      await aliasInstallIdentityDirect(identity);

      if (identity?.webDistinctId) {
        await aliasWebVisitorDirect(identity);
        void window.electronAPI?.analytics?.redeemAttribution?.();
      }

      await onCaptureFirstOpen(identity);
      await captureAndOptOut('analytics_opted_out', undefined, identity);
      discardPendingEvents();

      // Mark consent as shown before the config update re-registers analytics listeners.
      if (window.electron?.invoke) {
        await window.electron.invoke('preferences:set', 'analytics_consent_shown', 'true');
      }

      // Disable analytics (keep it disabled since it's opt-in)
      await updateConfig({
        analytics: {
          ...config?.analytics,
          enabled: false,
        },
      });

      onClose(false);
    } catch (error) {
      console.error('[AnalyticsConsent] Error declining analytics:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={() => {}} size="md" closeOnOverlayClick={false} closeOnEscape={false} showCloseButton={false} ariaLabel="Help Improve Pane">
      {/* Header */}
      <div className="p-6 border-b border-border-primary">
        <div className="flex items-center">
          <img src={paneLogo} alt="Pane" className="h-10 w-10 mr-3" />
          <h1 className="text-lg font-semibold text-text-primary">Help Improve Pane</h1>
        </div>
      </div>

      <ModalBody>
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <BarChart3 className="h-6 w-6 text-interactive flex-shrink-0 mt-0.5" />
            <div className="space-y-3">
              <p className="text-text-primary">
                We do not collect any code, prompts, or file paths.
              </p>
              <p className="text-text-secondary">
                Your data helps us make Pane better. You can change this anytime in Settings.
              </p>
            </div>
          </div>
        </div>
      </ModalBody>

      <ModalFooter className="flex justify-between items-center">
        <Button
          onClick={handleDecline}
          variant="ghost"
          disabled={isSubmitting}
        >
          No thanks
        </Button>
        <Button
          onClick={handleAccept}
          variant="primary"
          disabled={isSubmitting}
          loading={isSubmitting}
        >
          Enable analytics
        </Button>
      </ModalFooter>
    </Modal>
  );
}

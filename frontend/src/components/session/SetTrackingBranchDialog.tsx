import { Button } from '../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';

interface SetTrackingBranchDialogProps {
  isOpen: boolean;
  currentUpstream: string | null;
  remoteBranches: string[];
  checkoutLabel?: string;
  onSelect: (branch: string) => void;
  onClose: () => void;
}

export function SetTrackingBranchDialog({
  isOpen,
  currentUpstream,
  remoteBranches,
  checkoutLabel = 'this checkout',
  onSelect,
  onClose,
}: SetTrackingBranchDialogProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      showCloseButton={false}
      ariaLabel="Set Tracking Branch"
    >
      <ModalHeader title="Set Tracking Branch" />
      <ModalBody className="space-y-3">
        {currentUpstream && (
          <p className="text-sm text-text-secondary">
            Currently tracking: <span className="text-text-primary font-mono">{currentUpstream}</span>
          </p>
        )}
        <p className="text-sm text-text-secondary">
          Select a remote branch for {checkoutLabel} to track:
        </p>
        <div className="space-y-1">
          {remoteBranches.length === 0 ? (
            <p className="text-sm text-text-tertiary italic">No remote branches found</p>
          ) : remoteBranches.map(branch => (
            <button
              key={branch}
              type="button"
              onClick={() => onSelect(branch)}
              className={`w-full text-left px-3 py-2 rounded text-sm font-mono hover:bg-bg-secondary transition-colors ${
                branch === currentUpstream ? 'bg-bg-secondary text-accent-primary' : 'text-text-primary'
              }`}
            >
              {branch}
              {branch === currentUpstream && <span className="ml-2 text-xs">(current)</span>}
            </button>
          ))}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" className="w-full" onClick={onClose}>Cancel</Button>
      </ModalFooter>
    </Modal>
  );
}

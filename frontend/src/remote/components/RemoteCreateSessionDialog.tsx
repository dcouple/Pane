import { ChevronDown, GitBranch, GitFork, Pin, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { generatePaneName, sanitizePaneName } from '../../utils/paneName';
import type { RemoteBranchInfo, RemoteProjectWithSessions, RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';

/**
 * Remote Pane runs as a browser PWA, not inside Electron. Keep create-dialog
 * preferences on browser-safe storage or daemon adapter calls; do not use the
 * desktop session preference store because it writes through window.electronAPI.
 */
const REMOTE_START_PINNED_PREFERENCE_KEY = 'pane.remoteCreateSession.startPinned';

interface RemoteCreateSessionDialogProps {
  adapter: RemoteRuntimeAdapter;
  project: RemoteProjectWithSessions;
  onClose: () => void;
  onCreated: (sessionName: string) => Promise<void>;
}

export function RemoteCreateSessionDialog({
  adapter,
  project,
  onClose,
  onCreated,
}: RemoteCreateSessionDialogProps) {
  const [branches, setBranches] = useState<RemoteBranchInfo[]>([]);
  const [baseBranch, setBaseBranch] = useState('');
  const [paneName, setPaneName] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [useWorktree, setUseWorktree] = useState(true);
  const [startPinned, setStartPinned] = useState(() => loadRemoteStartPinnedPreference());
  const [loadingBranches, setLoadingBranches] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [userEditedName, setUserEditedName] = useState(false);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  const existingNames = useMemo(() => new Set((project.sessions ?? []).map(session => session.name)), [project.sessions]);

  const filteredBranches = useMemo(() => {
    const normalizedSearch = branchSearch.trim().toLowerCase();
    const source = normalizedSearch
      ? branches.filter(branch => branch.name.toLowerCase().includes(normalizedSearch))
      : branches;
    const remote = source.filter(branch => branch.isRemote);
    const local = source.filter(branch => !branch.isRemote);
    return [...remote, ...local];
  }, [branchSearch, branches]);

  const setSelectedBranch = useCallback((branchName: string) => {
    setBaseBranch(branchName);
    setBranchOpen(false);
    setBranchSearch('');
    if (!userEditedName) {
      setPaneName(generatePaneName(branchName, existingNames, branches));
    }
  }, [branches, existingNames, userEditedName]);

  useEffect(() => {
    let cancelled = false;

    async function loadBranches() {
      setLoadingBranches(true);
      setError(null);
      try {
        const [branchList, detectedBranch] = await Promise.all([
          adapter.listProjectBranches(project.id),
          adapter.detectProjectBranch(project.path).catch(() => 'main'),
        ]);
        if (cancelled) return;

        setBranches(branchList);
        const remoteMain = branchList.find(branch => branch.isRemote && (branch.name === 'origin/main' || branch.name === 'origin/master'));
        const detected = branchList.find(branch => branch.name === detectedBranch || branch.name === `origin/${detectedBranch}`);
        const current = branchList.find(branch => branch.isCurrent);
        const fallbackBranchName = remoteMain?.name ?? detected?.name ?? current?.name ?? branchList[0]?.name ?? detectedBranch;

        if (fallbackBranchName) {
          setBaseBranch(fallbackBranchName);
          setPaneName(generatePaneName(fallbackBranchName, existingNames, branchList));
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load branches');
        }
      } finally {
        if (!cancelled) {
          setLoadingBranches(false);
        }
      }
    }

    void loadBranches();
    return () => {
      cancelled = true;
    };
  }, [adapter, existingNames, project.id, project.path]);

  useEffect(() => {
    if (!branchOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(event.target as Node)) {
        setBranchOpen(false);
        setBranchSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [branchOpen]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (loadingBranches || submitting) return;

    const cleanedName = sanitizePaneName(paneName);
    if (!cleanedName) {
      setError('Pane name is required.');
      return;
    }
    if (!baseBranch) {
      setError('Base branch is required.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await adapter.createSession({
        prompt: '',
        worktreeTemplate: cleanedName,
        count: 1,
        toolType: 'none',
        permissionMode: 'ignore',
        projectId: project.id,
        isMainRepo: !useWorktree,
        baseBranch,
        startPinned,
      });
      await onCreated(cleanedName);
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create pane');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end bg-black/65 p-0 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-label={`New Pane in ${project.name}`}>
      <button
        type="button"
        className="absolute inset-0"
        aria-label="Close new pane dialog"
        onClick={() => {
          if (!submitting) onClose();
        }}
      />
      <form
        onSubmit={handleSubmit}
        className="relative z-10 flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-xl border border-border-primary bg-surface-primary shadow-2xl sm:max-w-xl sm:rounded-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border-primary px-5 py-4">
          <h2 className="min-w-0 truncate text-lg font-semibold text-text-primary">New Pane in {project.name}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="ml-3 rounded-md p-2 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className="border-b border-border-primary p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <GitBranch className="h-4 w-4 text-text-tertiary" />
              <label htmlFor="remote-create-branch">Base Branch</label>
            </div>
            <div ref={branchDropdownRef} className="relative">
              <button
                id="remote-create-branch"
                type="button"
                disabled={loadingBranches || branches.length === 0}
                onClick={() => setBranchOpen(previous => !previous)}
                className="flex h-12 w-full items-center justify-between gap-3 rounded-md border border-border-primary bg-surface-secondary px-3 text-left text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="truncate">{loadingBranches ? 'Loading branches...' : baseBranch || 'No branches found'}</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-text-tertiary" />
              </button>

              {branchOpen && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-border-primary bg-surface-primary shadow-xl">
                  <div className="flex items-center gap-2 border-b border-border-primary px-3 py-2">
                    <Search className="h-4 w-4 shrink-0 text-text-tertiary" />
                    <input
                      value={branchSearch}
                      onChange={(event) => setBranchSearch(event.target.value)}
                      autoFocus
                      className="h-8 min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                      placeholder="Search branches"
                    />
                  </div>
                  <div className="max-h-56 overflow-y-auto py-1">
                    {filteredBranches.map(branch => (
                      <button
                        key={branch.name}
                        type="button"
                        onClick={() => setSelectedBranch(branch.name)}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-hover ${
                          branch.name === baseBranch ? 'text-text-primary' : 'text-text-secondary'
                        }`}
                      >
                        <span className="truncate">{branch.name}</span>
                        {branch.isCurrent && <span className="shrink-0 text-xs text-text-tertiary">current</span>}
                      </button>
                    ))}
                    {filteredBranches.length === 0 && (
                      <div className="px-3 py-3 text-sm text-text-secondary">No branches match.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <p className="mt-2 text-xs text-text-tertiary">Remote branches will track their remote for git pull/push.</p>
          </section>

          <section className="border-b border-border-primary p-5">
            <label htmlFor="remote-create-name" className="mb-2 block text-sm font-semibold text-text-primary">Pane Name</label>
            <input
              id="remote-create-name"
              value={paneName}
              onChange={(event) => {
                setPaneName(event.target.value);
                setUserEditedName(true);
              }}
              className="h-12 w-full rounded-md border border-border-primary bg-surface-secondary px-3 text-text-primary outline-none focus:border-interactive focus:ring-2 focus:ring-interactive"
              placeholder="pane-name"
            />
            <p className="mt-2 text-xs text-text-tertiary">Auto-filled from branch. Edit to customize.</p>
          </section>

          <section className="border-b border-border-primary p-5">
            <label className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 gap-3">
                <Pin className="mt-1 h-4 w-4 shrink-0 text-text-tertiary" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-text-primary">Start pinned</span>
                  <span className="mt-1 block text-sm text-text-secondary">Show this pane in the pinned section immediately.</span>
                </span>
              </span>
              <span className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${startPinned ? 'bg-interactive' : 'bg-surface-tertiary'}`}>
                <input
                  type="checkbox"
                  checked={startPinned}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setStartPinned(checked);
                    saveRemoteStartPinnedPreference(checked);
                  }}
                  className="peer sr-only"
                  aria-label="Start pinned"
                />
                <span className={`absolute top-1 h-5 w-5 rounded-full bg-text-primary transition-transform ${startPinned ? 'translate-x-6' : 'translate-x-1'}`} />
              </span>
            </label>
          </section>

          <section className="p-5">
            <label className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 gap-3">
                <GitFork className="mt-1 h-4 w-4 shrink-0 text-text-tertiary" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-text-primary">Use worktree</span>
                  <span className="mt-1 block text-sm text-text-secondary">Run in an isolated git worktree.</span>
                </span>
              </span>
              <span className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${useWorktree ? 'bg-interactive' : 'bg-surface-tertiary'}`}>
                <input
                  type="checkbox"
                  checked={useWorktree}
                  onChange={(event) => setUseWorktree(event.target.checked)}
                  className="peer sr-only"
                  aria-label="Use worktree"
                />
                <span className={`absolute top-1 h-5 w-5 rounded-full bg-text-primary transition-transform ${useWorktree ? 'translate-x-6' : 'translate-x-1'}`} />
              </span>
            </label>
          </section>

          {error && (
            <div className="mx-5 mb-5 rounded-md border border-status-error/40 bg-status-error/10 p-3 text-sm text-status-error">
              {error}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border-primary p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loadingBranches || submitting || !baseBranch}
            className="rounded-md bg-interactive px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}


function loadRemoteStartPinnedPreference(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(REMOTE_START_PINNED_PREFERENCE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveRemoteStartPinnedPreference(value: boolean): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(REMOTE_START_PINNED_PREFERENCE_KEY, value ? 'true' : 'false');
    }
  } catch {
    // Ignore storage failures so the current create flow can still use local state.
  }
}

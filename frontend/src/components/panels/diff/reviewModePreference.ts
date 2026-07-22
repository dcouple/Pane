export type ReviewMode = 'github' | 'local';

const REVIEW_MODE_STORAGE_KEY = 'pane-review-default-mode';
const REVIEW_MODE_CHANGED_EVENT = 'review-default-mode-changed';
const REVIEW_OPEN_LOCAL_EVENT = 'review:open-local';
const pendingLocalModeSessions = new Set<string>();

function isReviewMode(value: string | null): value is ReviewMode {
  return value === 'github' || value === 'local';
}

export function getReviewDefaultMode(): ReviewMode {
  if (typeof window === 'undefined') return 'github';
  const stored = window.localStorage.getItem(REVIEW_MODE_STORAGE_KEY);
  return isReviewMode(stored) ? stored : 'github';
}

export function getEffectiveReviewMode(mode: ReviewMode, hasReviewUrl: boolean): ReviewMode {
  return mode === 'github' && !hasReviewUrl ? 'local' : mode;
}

export function setReviewDefaultMode(mode: ReviewMode): void {
  window.localStorage.setItem(REVIEW_MODE_STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent(REVIEW_MODE_CHANGED_EVENT, { detail: { mode } }));
}

export function requestLocalReviewMode(sessionId: string): void {
  pendingLocalModeSessions.add(sessionId);
  window.dispatchEvent(new CustomEvent(REVIEW_OPEN_LOCAL_EVENT, {
    detail: { sessionId },
  }));
}

export function consumeLocalReviewModeRequest(sessionId: string): boolean {
  if (!pendingLocalModeSessions.has(sessionId)) return false;
  pendingLocalModeSessions.delete(sessionId);
  return true;
}

export function subscribeLocalReviewModeRequest(callback: (sessionId: string) => void): () => void {
  const handleOpenLocal = (event: Event) => {
    const { sessionId } = (event as CustomEvent<{ sessionId?: string }>).detail || {};
    if (sessionId) callback(sessionId);
  };

  window.addEventListener(REVIEW_OPEN_LOCAL_EVENT, handleOpenLocal);
  return () => window.removeEventListener(REVIEW_OPEN_LOCAL_EVENT, handleOpenLocal);
}

export function subscribeReviewDefaultMode(callback: (mode: ReviewMode) => void): () => void {
  const handleCustomEvent = (event: Event) => {
    const mode = (event as CustomEvent<{ mode?: string }>).detail?.mode ?? null;
    if (isReviewMode(mode)) callback(mode);
  };

  const handleStorageEvent = (event: StorageEvent) => {
    if (event.key !== REVIEW_MODE_STORAGE_KEY) return;
    callback(isReviewMode(event.newValue) ? event.newValue : 'github');
  };

  window.addEventListener(REVIEW_MODE_CHANGED_EVENT, handleCustomEvent);
  window.addEventListener('storage', handleStorageEvent);

  return () => {
    window.removeEventListener(REVIEW_MODE_CHANGED_EVENT, handleCustomEvent);
    window.removeEventListener('storage', handleStorageEvent);
  };
}

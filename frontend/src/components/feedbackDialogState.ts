import type {
  FeedbackType,
  SubmitFeedbackFailure,
  SubmitFeedbackRequest,
  SubmitFeedbackSuccess,
} from '../../../shared/types/feedback';

export interface FeedbackDialogState {
  type: FeedbackType;
  title: string;
  body: string;
  includeAppDetails: boolean;
  status: 'idle' | 'submitting' | 'success' | 'error';
  issueUrl?: string;
  error?: string;
  fallbackUrl?: string;
}

export type FeedbackDialogAction =
  | { type: 'reset' }
  | { type: 'set-type'; value: FeedbackType }
  | { type: 'set-title'; value: string }
  | { type: 'set-body'; value: string }
  | { type: 'set-include-details'; value: boolean }
  | { type: 'submit-start' }
  | { type: 'submit-success'; issueUrl: string }
  | { type: 'submit-error'; error: string; fallbackUrl?: string };

export function createInitialFeedbackDialogState(): FeedbackDialogState {
  return {
    type: 'bug',
    title: '',
    body: '',
    includeAppDetails: true,
    status: 'idle',
  };
}

export function feedbackDialogReducer(
  state: FeedbackDialogState,
  action: FeedbackDialogAction,
): FeedbackDialogState {
  switch (action.type) {
    case 'reset':
      return createInitialFeedbackDialogState();
    case 'set-type':
      return { ...state, type: action.value, status: 'idle', error: undefined, fallbackUrl: undefined };
    case 'set-title':
      return { ...state, title: action.value, status: 'idle', error: undefined, fallbackUrl: undefined };
    case 'set-body':
      return { ...state, body: action.value, status: 'idle', error: undefined, fallbackUrl: undefined };
    case 'set-include-details':
      return { ...state, includeAppDetails: action.value };
    case 'submit-start':
      return { ...state, status: 'submitting', error: undefined, fallbackUrl: undefined };
    case 'submit-success':
      return { ...state, status: 'success', issueUrl: action.issueUrl };
    case 'submit-error':
      return { ...state, status: 'error', error: action.error, fallbackUrl: action.fallbackUrl };
  }
}

export function canSubmitFeedback(state: FeedbackDialogState): boolean {
  return Boolean(state.body.trim()) && state.status !== 'submitting';
}

interface FeedbackResponse {
  success: boolean;
  data?: SubmitFeedbackSuccess | SubmitFeedbackFailure;
  error?: string;
}

export async function executeFeedbackSubmission(
  request: SubmitFeedbackRequest,
  submit: (request: SubmitFeedbackRequest) => Promise<FeedbackResponse>,
  signal?: AbortSignal,
): Promise<FeedbackDialogAction | undefined> {
  try {
    const response = await submit(request);
    if (signal?.aborted) return undefined;
    if (response.success && response.data && 'issueUrl' in response.data) {
      return { type: 'submit-success', issueUrl: response.data.issueUrl };
    }
    const fallbackUrl = response.data && 'fallbackUrl' in response.data
      ? response.data.fallbackUrl
      : undefined;
    return {
      type: 'submit-error',
      error: response.error || 'Pane could not create the GitHub issue.',
      fallbackUrl,
    };
  } catch (error) {
    if (signal?.aborted) return undefined;
    return {
      type: 'submit-error',
      error: error instanceof Error ? error.message : 'Pane could not create the GitHub issue.',
    };
  }
}

interface OpenExternalResponse {
  success: boolean;
  error?: string;
}

export async function openFeedbackUrl(
  url: string,
  openExternal: (url: string) => Promise<OpenExternalResponse>,
): Promise<string | undefined> {
  try {
    const response = await openExternal(url);
    return response.success ? undefined : response.error || 'Could not open the browser.';
  } catch (error) {
    return error instanceof Error ? error.message : 'Could not open the browser.';
  }
}

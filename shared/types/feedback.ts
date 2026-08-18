export type FeedbackType = 'bug' | 'feature' | 'general';

export interface FeedbackAppDetails {
  version: string;
  gitCommit: string;
}

export interface SubmitFeedbackRequest {
  type: FeedbackType;
  title: string;
  body: string;
  includeAppDetails: boolean;
  appDetails?: FeedbackAppDetails;
}

export interface SubmitFeedbackSuccess {
  issueUrl: string;
}

export interface SubmitFeedbackFailure {
  fallbackUrl: string;
}

import type { AiAnalysis, AnalysisState } from '../shared/analysis';
export interface LocalAnalysisRequest {
  requestId: string;
  sessionId: string;
  shotId: string;
  inputRevision: number;
  sourceFingerprint: string;
  fingerprint: string;
  createdAt: string;
  retryUntil: string;
  state: AnalysisState;
  result?: AiAnalysis;
  errorCode?: string;
}

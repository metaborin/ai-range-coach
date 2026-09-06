import { newId } from './domain';
import type { SessionStorage } from './storage';
import { makeAnalysisRequest } from './analysisSnapshot';
import { analysisFetch, AnalysisHttpError } from './analysisClient';
import { REQUEST_RETENTION_MS, type AiAnalysis, type AnalysisReply, type AnalysisRequest } from '../shared/analysis';
import type { LocalAnalysisRequest } from './analysisTypes';
export type { LocalAnalysisRequest } from './analysisTypes';

export class AnalysisService {
  private readonly bodies = new Map<string, AnalysisRequest>();
  constructor(private readonly storage: SessionStorage, private readonly apiUrl: string) {}
  list(sessionId: string): Promise<LocalAnalysisRequest[]> { return this.storage.analysisList(sessionId); }
  async prepare(sessionId: string): Promise<LocalAnalysisRequest> {
    const saved = await this.storage.load(sessionId);
    if (!saved) throw new Error('保存済み記録を開いてください。');
    const now = Date.now();
    const requestId = `${now}_${newId()}`;
    const createdAt = new Date(now).toISOString();
    const body = await makeAnalysisRequest(saved.session, saved.assets, requestId, createdAt);
    const local: LocalAnalysisRequest = { requestId, createdAt, sessionId, shotId: body.input.shotId,
      inputRevision: body.input.inputRevision, sourceFingerprint: body.input.sourceFingerprint,
      fingerprint: body.fingerprint, state: 'pending', retryUntil: new Date(now + REQUEST_RETENTION_MS).toISOString() };
    await this.storage.prepareAnalysis(local, saved.session);
    this.bodies.set(requestId, body);
    return local;
  }
  async start(local: LocalAnalysisRequest, password: string, signal?: AbortSignal): Promise<AnalysisReply> {
    const body = this.bodies.get(local.requestId);
    if (!body) throw new Error('既存の要求の状態を確認してください。自動で再送しません。');
    this.bodies.delete(local.requestId); // At most one POST per prepared snapshot, even after an error.
    return this.communicate(local, password, body, signal);
  }
  async check(local: LocalAnalysisRequest, password: string, signal?: AbortSignal): Promise<AnalysisReply> {
    if (Date.now() > Date.parse(local.retryUntil)) {
      await this.storage.updateAnalysisRequest(local.requestId, { state: 'expired' });
      return { ...local, state: 'expired' };
    }
    return this.communicate(local, password, undefined, signal);
  }
  private async communicate(local: LocalAnalysisRequest, password: string, body?: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisReply> {
    try {
      const reply = await analysisFetch(this.apiUrl, local, password, body, signal);
      try { await this.storage.updateAnalysisRequest(local.requestId, { state: reply.state, result: reply.result, errorCode: reply.errorCode }); }
      catch (error) { if (!reply.result) throw error; /* Return a successful result for an in-memory save retry. */ }
      return reply;
    } catch (error) {
      const failed = error instanceof AnalysisHttpError && [400, 401, 403, 409, 410, 413, 429].includes(error.status);
      await this.storage.updateAnalysisRequest(local.requestId, { state: failed ? 'failed' : 'unknown' }).catch(() => undefined);
      throw error;
    }
  }
  markUnknown(requestId: string): Promise<void> {
    this.bodies.delete(requestId);
    return this.storage.updateAnalysisRequest(requestId, { state: 'unknown' }, true);
  }
  saveResult(local: LocalAnalysisRequest, result: AiAnalysis): Promise<boolean> { return this.storage.saveAnalysisResult(local, result); }
}

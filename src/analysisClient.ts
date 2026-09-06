import { validateAiAnalysis, type AnalysisReply, type AnalysisRequest } from '../shared/analysis';
import type { LocalAnalysisRequest } from './analysisTypes';

function endpoint(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url.origin : null; }
  catch { return null; }
}
export async function loadAnalysisConfig(): Promise<string | null> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}analysis-config.json`, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) return null;
    return endpoint((await response.json()).apiUrl);
  } catch { return null; }
}
export class AnalysisHttpError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 || status === 403 ? '専用パスワードを確認してください。'
      : status === 429 ? '利用回数または連続操作の上限です。時間を空けてください。'
      : status === 409 ? '別の分析が進行中、または要求の内容が一致しません。既存の状態を確認してください。'
      : status === 400 || status === 413 ? '送信内容を確認できません。4場面と当たり・方向を確認してください。'
      : status === 410 ? 'この要求の照会期限が終了しました。新規分析は別の利用回数を消費します。'
      : '分析サーバーへ接続できませんでした。同じ要求の状態を確認してください。');
  }
}
export async function analysisFetch(apiUrl: string, local: LocalAnalysisRequest, password: string, body?: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisReply> {
  if (!endpoint(apiUrl)) throw new Error('AI分析は準備中です。');
  if (!password || /[\r\n]/.test(password)) throw new Error('専用パスワードを入力してください。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 75000);
  try {
    const response = await fetch(`${apiUrl}/v1/analyses${body ? '' : `/${encodeURIComponent(local.requestId)}`}`, {
      method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { Authorization: `Bearer ${password}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
    });
    if (!response.ok) throw new AnalysisHttpError(response.status);
    const value = await response.json() as AnalysisReply;
    if (!value || value.requestId !== local.requestId || !['pending', 'succeeded', 'failed', 'unknown', 'expired', 'not_found'].includes(value.state)) throw new Error('分析の応答を確認できませんでした。');
    if (value.state !== 'succeeded' && value.result !== undefined) throw new Error('完了していない分析に結果が含まれています。');
    if (!['not_found', 'expired'].includes(value.state) && (value.fingerprint !== local.fingerprint || value.shotId !== local.shotId || value.inputRevision !== local.inputRevision)) throw new Error('分析結果の対象が一致しません。');
    if (value.state === 'succeeded' && (!validateAiAnalysis(value.result) || value.result.requestId !== local.requestId
      || value.result.fingerprint !== local.fingerprint || value.result.sourceFingerprint !== local.sourceFingerprint
      || value.result.shotId !== local.shotId || value.result.inputRevision !== local.inputRevision)) throw new Error('分析結果の形式を確認できませんでした。');
    // Do not propagate server bodies or arbitrary error strings to the UI/logs.
    return { ...value, message: undefined, errorCode: typeof value.errorCode === 'string' && /^[a-z_]{1,50}$/.test(value.errorCode) ? value.errorCode : undefined };
  } catch (error) {
    if (error instanceof AnalysisHttpError) throw error;
    // Do not retain network/library errors that might include request credentials or bodies.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('通信の完了を確認できませんでした。同じ要求の状態を確認してください。待機の終了は課金の取消ではありません。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

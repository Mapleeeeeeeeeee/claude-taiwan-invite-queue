import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiErrorResponse, ErrorCode } from '../shared/types';
import type { AppEnv } from './appServices';
import { AppError } from './errors';
import { logError, logWarn } from './logger';

export const INTERNAL_ERROR_MESSAGE = '系統忙碌中，請稍後再試一次';
const MALFORMED_REQUEST_MESSAGE = '請求內容格式錯誤，請確認送出的資料是有效的 JSON';

/** 所有錯誤回應 body 的唯一組裝點。 */
export function buildErrorBody(code: ErrorCode, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

export function createUnauthorizedError(): AppError {
  return new AppError('UNAUTHORIZED', '請先使用 Google 帳號登入', 401);
}

export function createRateLimitedError(): AppError {
  return new AppError('RATE_LIMITED', '操作太頻繁，請稍後再試', 429);
}

/** Hono 全域 `onError`：把 `AppError`、壞 JSON 與未預期錯誤統一轉成標準錯誤回應。 */
export function handleError(err: Error, c: Context<AppEnv>): Response {
  const userId = c.get('userId');
  if (err instanceof AppError) {
    logWarn('api.app_error', {
      code: err.code,
      statusCode: err.statusCode,
      method: c.req.method,
      path: c.req.path,
      userId,
    });
    return c.json(buildErrorBody(err.code, err.message), err.statusCode as ContentfulStatusCode);
  }

  // zValidator 遇到壞 JSON 或空 body 會丟 400 的 HTTPException，這是使用者送錯內容，不是系統錯誤。
  if (err instanceof HTTPException && err.status === 400) {
    logWarn('api.malformed_request', {
      method: c.req.method,
      path: c.req.path,
      userId,
    });
    return c.json(buildErrorBody('INVALID_INPUT', MALFORMED_REQUEST_MESSAGE), 400);
  }

  logError('api.unhandled_error', {
    method: c.req.method,
    path: c.req.path,
    userId,
    errorMessage: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json(buildErrorBody('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE), 500);
}

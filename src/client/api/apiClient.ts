import {
  isErrorCode,
  type ApiErrorResponse,
  type ApiSuccessResponse,
  type BoardDto,
  type CancelQueueResult,
  type ConfirmSlotResult,
  type ErrorCode,
  type JoinQueueResult,
  type LoginResult,
  type LogoutResult,
  type MeDto,
  type PushSubscriptionInput,
  type QueueTrack,
  type ReportSlotInvalidResult,
  type RevealSlotResult,
  type SlotCount,
  type SubmitLinkResult,
  type SubscribePushResult,
  type TestPushResult,
} from '../../shared/types';

export class ApiClientError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface SubmitLinkPayload {
  rawUrlInput: string;
  slotCount: SlotCount;
  track: QueueTrack;
  nickname?: string;
}

export interface JoinQueuePayload {
  thankYouMessage: string;
  track: QueueTrack;
  nickname?: string;
}

export interface DevLoginPayload {
  email: string;
  nickname?: string;
  googleSub?: string;
}

export interface GoogleLoginPayload {
  idToken: string;
  nickname?: string;
}

export interface FetchBoardOptions {
  /**
   * 為 `true` 時跳過瀏覽器 HTTP 快取直接問伺服器，並用回應更新快取。
   * 使用者自己的動作完成後要立刻看到結果時才設定，其餘載入沿用快取。
   */
  bypassBrowserCache?: boolean;
}

export type FetchFunction = typeof fetch;

export interface InviteApiClient {
  fetchBoard(options?: FetchBoardOptions): Promise<BoardDto>;
  fetchMe(): Promise<MeDto>;
  loginWithGoogle(payload: GoogleLoginPayload): Promise<LoginResult>;
  loginWithDevAccount(payload: DevLoginPayload): Promise<LoginResult>;
  logout(): Promise<LogoutResult>;
  submitInviteLink(payload: SubmitLinkPayload): Promise<SubmitLinkResult>;
  joinQueue(payload: JoinQueuePayload): Promise<JoinQueueResult>;
  revealSlot(): Promise<RevealSlotResult>;
  confirmSlot(): Promise<ConfirmSlotResult>;
  reportSlotInvalid(): Promise<ReportSlotInvalidResult>;
  cancelQueue(): Promise<CancelQueueResult>;
  subscribePush(payload: PushSubscriptionInput): Promise<SubscribePushResult>;
  testPushNotification(): Promise<TestPushResult>;
}

const DEFAULT_NETWORK_ERROR_MESSAGE = '暫時無法連線至伺服器，請稍後再試一次';
const DEFAULT_SERVER_ERROR_MESSAGE = '系統忙碌中，請稍後再試一次';

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const errorField = (value as { error: unknown }).error;
  if (typeof errorField !== 'object' || errorField === null) {
    return false;
  }
  const code = (errorField as { code?: unknown }).code;
  const message = (errorField as { message?: unknown }).message;
  return isErrorCode(code) && typeof message === 'string';
}

function isApiSuccessResponse<T>(value: unknown): value is ApiSuccessResponse<T> {
  return typeof value === 'object' && value !== null && 'data' in value;
}

/**
 * Creates a strongly-typed API client wrapping `fetch` for all backend endpoints.
 * Throws `ApiClientError` when the server returns a non-2xx status or when a network failure occurs.
 */
export function createApiClient(fetchImpl: FetchFunction = fetch): InviteApiClient {
  async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        ...init,
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new ApiClientError('INTERNAL_ERROR', DEFAULT_NETWORK_ERROR_MESSAGE, 0);
      }
      throw error;
    }

    let parsedBody: unknown = null;
    try {
      parsedBody = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        parsedBody = null;
      } else {
        throw error;
      }
    }

    if (!response.ok) {
      if (isApiErrorResponse(parsedBody)) {
        throw new ApiClientError(
          parsedBody.error.code,
          parsedBody.error.message,
          response.status
        );
      }
      throw new ApiClientError(
        'INTERNAL_ERROR',
        DEFAULT_SERVER_ERROR_MESSAGE,
        response.status
      );
    }

    if (!isApiSuccessResponse<T>(parsedBody)) {
      throw new ApiClientError(
        'INTERNAL_ERROR',
        DEFAULT_SERVER_ERROR_MESSAGE,
        response.status
      );
    }

    return parsedBody.data;
  }

  return {
    fetchBoard(options) {
      // 用 reload 而非 no-store，因為 no-store 不會更新快取，下一次一般載入仍會拿到舊的看板。
      return requestJson<BoardDto>('/api/board', {
        method: 'GET',
        ...(options?.bypassBrowserCache ? { cache: 'reload' } : {}),
      });
    },
    fetchMe() {
      return requestJson<MeDto>('/api/me', { method: 'GET' });
    },
    loginWithGoogle(payload) {
      return requestJson<LoginResult>('/api/auth/google', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    loginWithDevAccount(payload) {
      return requestJson<LoginResult>('/api/auth/dev-login', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    logout() {
      return requestJson<LogoutResult>('/api/auth/logout', {
        method: 'POST',
      });
    },
    submitInviteLink(payload) {
      return requestJson<SubmitLinkResult>('/api/links', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    joinQueue(payload) {
      return requestJson<JoinQueueResult>('/api/queue', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    revealSlot() {
      return requestJson<RevealSlotResult>(
        '/api/queue/reveal',
        { method: 'POST' }
      );
    },
    confirmSlot() {
      return requestJson<ConfirmSlotResult>('/api/queue/confirm', {
        method: 'POST',
      });
    },
    reportSlotInvalid() {
      return requestJson<ReportSlotInvalidResult>(
        '/api/queue/report-invalid',
        { method: 'POST' }
      );
    },
    cancelQueue() {
      return requestJson<CancelQueueResult>('/api/queue/cancel', {
        method: 'POST',
      });
    },
    subscribePush(payload) {
      return requestJson<SubscribePushResult>('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    testPushNotification() {
      return requestJson<TestPushResult>(
        '/api/push/test',
        { method: 'POST' }
      );
    },
  };
}

export const defaultApiClient = createApiClient();

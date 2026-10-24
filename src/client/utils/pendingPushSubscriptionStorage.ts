import type { PushSubscriptionInput } from '../../shared/types';

const PENDING_PUSH_STORAGE_KEY = 'claude_invite_pending_push_sub';

function isPushSubscriptionInput(value: unknown): value is PushSubscriptionInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { endpoint, keys } = value as Record<string, unknown>;
  if (typeof endpoint !== 'string' || typeof keys !== 'object' || keys === null) {
    return false;
  }
  const { p256dh, auth } = keys as Record<string, unknown>;
  return typeof p256dh === 'string' && typeof auth === 'string';
}

/**
 * 讀出訪客登入前暫存的推播訂閱。沒有暫存、內容不是合法 JSON 或結構不符時回傳 `null`；
 * 瀏覽器禁用儲存（`DOMException`）同樣回傳 `null`，其他錯誤照常拋出。
 */
export function readPendingPushSubscription(): PushSubscriptionInput | null {
  try {
    const cached = sessionStorage.getItem(PENDING_PUSH_STORAGE_KEY);
    if (cached === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(cached);
    return isPushSubscriptionInput(parsed) ? parsed : null;
  } catch (error) {
    if (error instanceof DOMException || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/** 暫存只是便利功能，瀏覽器禁用儲存（`DOMException`）時略過，其他錯誤照常拋出。 */
export function writePendingPushSubscription(subscription: PushSubscriptionInput): void {
  try {
    sessionStorage.setItem(PENDING_PUSH_STORAGE_KEY, JSON.stringify(subscription));
  } catch (error) {
    if (!(error instanceof DOMException)) {
      throw error;
    }
  }
}

export function clearPendingPushSubscription(): void {
  try {
    sessionStorage.removeItem(PENDING_PUSH_STORAGE_KEY);
  } catch (error) {
    if (!(error instanceof DOMException)) {
      throw error;
    }
  }
}

import { decodeBase64Url } from 'hono/utils/encode';
import type { PushSubscriptionInput } from '../../shared/types';

/**
 * 向瀏覽器請求通知權限並建立 Web Push 訂閱。
 * 瀏覽器不支援推播、使用者拒絕權限、缺少 `vapidPublicKey` 或訂閱失敗時，一律回傳 `subscription: null`，
 * 呼叫端不可把 null 當成已訂閱；權限結果請讀 `Notification.permission`。
 */
export async function requestBrowserPushSubscription(params: {
  vapidPublicKey?: string;
}): Promise<{ subscription: PushSubscriptionInput | null }> {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return { subscription: null };
  }

  const permission = await Notification.requestPermission();
  if (permission === 'denied' || !params.vapidPublicKey) {
    return { subscription: null };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(params.vapidPublicKey),
    });
    const { endpoint, keys } = sub.toJSON();
    if (endpoint && keys?.p256dh && keys.auth) {
      return { subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } } };
    }
  } catch (error) {
    if (!(error instanceof DOMException || error instanceof TypeError)) {
      throw error;
    }
  }

  return { subscription: null };
}

/**
 * 讀出這個瀏覽器目前的推播訂閱。沒有 service worker、沒有訂閱或瀏覽器拒絕查詢時回傳 `null`。
 * 這裡用 `getRegistration()` 而不是 `ready`，因為沒有註冊 service worker 時 `ready` 永遠不會 resolve，
 * 登出流程會卡住。
 */
export async function findBrowserPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return (await registration?.pushManager.getSubscription()) ?? null;
  } catch (error) {
    if (error instanceof DOMException || error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

/** 取消這個瀏覽器的推播訂閱；瀏覽器拒絕取消時略過，因為伺服器那端的訂閱已經刪除。 */
export async function unsubscribeBrowserPush(subscription: PushSubscription): Promise<void> {
  try {
    await subscription.unsubscribe();
  } catch (error) {
    if (!(error instanceof DOMException || error instanceof TypeError)) {
      throw error;
    }
  }
}

import { useCallback, useEffect, useState } from 'react';
import type { MeDto, PushSubscriptionInput } from '../../shared/types';
import {
  clearPendingPushSubscription,
  readPendingPushSubscription,
  writePendingPushSubscription,
} from '../utils/pendingPushSubscriptionStorage';
import { requestBrowserPushSubscription } from '../utils/webPushSubscription';

export type RequestPushSubscription = (params: {
  vapidPublicKey?: string;
}) => Promise<{ subscription: PushSubscriptionInput | null }>;

export type PushPermissionState = NotificationPermission | 'unsupported';

export interface UsePushSubscriptionOptions {
  me: MeDto | null;
  /** 把瀏覽器核發的訂閱綁到目前登入的帳號；成功回傳 true。`successMessage` 是綁定成功後要顯示的提示。 */
  bindSubscription: (subscription: PushSubscriptionInput, successMessage: string) => Promise<boolean>;
  /** 向瀏覽器要求推播權限並訂閱；預設為 `requestBrowserPushSubscription`。 */
  requestPushSubscription?: RequestPushSubscription;
}

export interface UsePushSubscriptionReturn {
  permissionState: PushPermissionState;
  /** 訪客已允許通知、訂閱暫存在本機，登入後會自動綁定。 */
  hasPendingGuestSubscription: boolean;
  /**
   * 向瀏覽器要求推播權限並訂閱。已登入就直接綁定（成功提示用 `successMessage`），
   * 未登入就暫存在本機，等登入後自動綁定。
   * 回傳 true 代表瀏覽器給出訂閱且已綁定或暫存；拒絕、不支援或綁定失敗時回傳 false。
   */
  enablePush: (successMessage?: string) => Promise<boolean>;
}

/** 給 `useInviteApp` 內部使用的完整回傳；畫面元件只拿得到 `UsePushSubscriptionReturn` 的欄位。 */
export interface UsePushSubscriptionHandle extends UsePushSubscriptionReturn {
  /** 丟掉訪客暫存的訂閱（狀態與 sessionStorage 一起清），登出取消瀏覽器訂閱後使用。 */
  discardPendingGuestSubscription: () => void;
}

function readNotificationPermission(): PushPermissionState {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export function usePushSubscription({
  me,
  bindSubscription,
  requestPushSubscription = requestBrowserPushSubscription,
}: UsePushSubscriptionOptions): UsePushSubscriptionHandle {
  const [permissionState, setPermissionState] = useState<PushPermissionState>(
    readNotificationPermission
  );
  const [pendingGuestSubscription, setPendingGuestSubscription] =
    useState<PushSubscriptionInput | null>(readPendingPushSubscription);

  const isLoggedIn = me?.user != null;
  const vapidPublicKey = me?.vapidPublicKey;

  const discardPendingGuestSubscription = useCallback(() => {
    setPendingGuestSubscription(null);
    clearPendingPushSubscription();
  }, []);

  // 訪客在登入前已允許通知時，登入完成後自動把暫存的訂閱綁到帳號上。
  useEffect(() => {
    if (!isLoggedIn || !pendingGuestSubscription) {
      return;
    }
    void bindSubscription(pendingGuestSubscription, '').then((isBound) => {
      if (isBound) {
        discardPendingGuestSubscription();
      }
    });
  }, [isLoggedIn, pendingGuestSubscription, bindSubscription, discardPendingGuestSubscription]);

  const enablePush = useCallback(
    async (successMessage = ''): Promise<boolean> => {
      const { subscription } = await requestPushSubscription({ vapidPublicKey });
      setPermissionState(readNotificationPermission());
      if (!subscription) {
        return false;
      }
      if (isLoggedIn) {
        return bindSubscription(subscription, successMessage);
      }
      setPendingGuestSubscription(subscription);
      writePendingPushSubscription(subscription);
      return true;
    },
    [bindSubscription, isLoggedIn, requestPushSubscription, vapidPublicKey]
  );

  return {
    permissionState,
    hasPendingGuestSubscription: pendingGuestSubscription !== null,
    enablePush,
    discardPendingGuestSubscription,
  };
}

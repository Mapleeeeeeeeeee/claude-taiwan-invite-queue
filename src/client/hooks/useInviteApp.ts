import { useCallback, useEffect, useState } from 'react';
import {
  CONFIRM_DURATION_MINUTES,
  DEFAULT_QUEUE_TRACK,
  DEFAULT_SLOT_COUNT,
  getRemainingRetryCount,
  RESERVATION_DURATION_HOURS,
  type BoardDto,
  type MeDto,
  type PushSubscriptionInput,
  type QueueTrack,
  type SlotCount,
} from '../../shared/types';
import {
  ApiClientError,
  defaultApiClient,
  type DevLoginPayload,
  type FetchBoardOptions,
  type InviteApiClient,
} from '../api/apiClient';
import {
  usePushSubscription,
  type RequestPushSubscription,
  type UsePushSubscriptionReturn,
} from './usePushSubscription';
import { findBrowserPushSubscription, unsubscribeBrowserPush } from '../utils/webPushSubscription';
import { useRefreshOnResume } from './useRefreshOnResume';

export type ActiveTab = 'receiver' | 'provider';

export interface UseInviteAppOptions {
  apiClient?: InviteApiClient;
  /** 提供者分享成功後用來取得瀏覽器推播訂閱；預設為 `requestBrowserPushSubscription`。 */
  requestPushSubscription?: RequestPushSubscription;
  autoLoadOnMount?: boolean;
}

export interface UseInviteAppReturn {
  board: BoardDto | null;
  me: MeDto | null;
  isLoading: boolean;
  isSubmitting: boolean;
  boardError: string | null;
  actionError: string | null;
  /** 最近一次動作因未登入（`UNAUTHORIZED`）失敗，View 應顯示登入引導而非錯誤訊息。 */
  isLoginRequired: boolean;
  actionSuccessMessage: string | null;
  activeTab: ActiveTab;
  nicknameInput: string;
  /** 去掉前後空白後的暱稱；全是空白就視為沒填，回傳 `undefined`。送給 API 的暱稱一律用它。 */
  providedNickname: string | undefined;
  thankYouMessageInput: string;
  rawUrlInput: string;
  slotCountInput: SlotCount;
  providerTrackInput: QueueTrack;
  /** 直接採用伺服器回傳的新手軌資格；未登入時視為具資格（不顯示再領取提示）。 */
  isEligibleForNewbieTrack: boolean;
  isReportInvalidConfirmOpen: boolean;
  setActiveTab: (tab: ActiveTab) => void;
  setNicknameInput: (value: string) => void;
  setThankYouMessageInput: (value: string) => void;
  setRawUrlInput: (value: string) => void;
  setSlotCountInput: (value: SlotCount) => void;
  setProviderTrackInput: (track: QueueTrack) => void;
  openReportInvalidConfirm: () => void;
  closeReportInvalidConfirm: () => void;
  clearMessages: () => void;
  refreshAll: () => Promise<void>;
  loginWithGoogle: (idToken: string, nickname?: string) => Promise<boolean>;
  loginWithDevAccount: (payload: DevLoginPayload) => Promise<boolean>;
  logout: () => Promise<void>;
  joinQueue: () => Promise<boolean>;
  revealSlot: () => Promise<boolean>;
  confirmSlot: () => Promise<boolean>;
  reportSlotInvalid: () => Promise<boolean>;
  cancelQueue: () => Promise<boolean>;
  /**
   * 提交邀請連結；成功後若使用者尚未訂閱推播，會再向瀏覽器要求推播權限並訂閱。
   * 回傳值只代表連結是否提交成功，推播訂閱失敗不影響它。
   */
  submitInviteLink: () => Promise<boolean>;
  /** 推播訂閱的權限狀態、訪客暫存與開啟動作；`PushToggleButton` 直接吃這個物件。 */
  push: UsePushSubscriptionReturn;
  testPushNotification: () => Promise<boolean>;
}

const CONFLICT_STATUS_CODE = 409;
const FALLBACK_BOARD_ERROR_MESSAGE = '暫時無法載入最新看板資訊，請點擊重新整理';
const FALLBACK_ACTION_ERROR_MESSAGE = '系統忙碌中，請稍後再試一次';

function reuseIfEqual<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

export function useInviteApp(options?: UseInviteAppOptions): UseInviteAppReturn {
  const apiClient = options?.apiClient ?? defaultApiClient;
  const autoLoadOnMount = options?.autoLoadOnMount ?? true;

  const [board, setBoard] = useState<BoardDto | null>(null);
  const [me, setMe] = useState<MeDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(autoLoadOnMount);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionErrorCode, setActionErrorCode] = useState<string | null>(null);
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('receiver');
  const [nicknameInput, setNicknameInput] = useState<string>('');
  const [thankYouMessageInput, setThankYouMessageInput] = useState<string>('');
  const [rawUrlInput, setRawUrlInput] = useState<string>('');
  const [slotCountInput, setSlotCountInput] = useState<SlotCount>(DEFAULT_SLOT_COUNT);
  const [providerTrackInput, setProviderTrackInput] = useState<QueueTrack>(DEFAULT_QUEUE_TRACK);
  const [isReportInvalidConfirmOpen, setIsReportInvalidConfirmOpen] = useState<boolean>(false);

  const isEligibleForNewbieTrack = me?.user?.isEligibleForNewbieTrack ?? true;
  const providedNickname = nicknameInput.trim() || undefined;
  const isLoginRequired = actionErrorCode === 'UNAUTHORIZED';

  const clearMessages = useCallback(() => {
    setActionError(null);
    setActionErrorCode(null);
    setActionSuccessMessage(null);
  }, []);

  const fetchLatest = useCallback(
    async (boardOptions?: FetchBoardOptions) => {
      const [latestBoard, latestMe] = await Promise.all([
        apiClient.fetchBoard(boardOptions),
        apiClient.fetchMe(),
      ]);
      // 內容沒變就保留舊參照，感謝牆跑馬燈才不會因為每次重抓而跳回起點。
      setBoard((previousBoard) => {
        if (!previousBoard) {
          return latestBoard;
        }
        return reuseIfEqual(previousBoard, {
          ...latestBoard,
          thankYouWall: reuseIfEqual(previousBoard.thankYouWall, latestBoard.thankYouWall),
        });
      });
      setMe((previousMe) => (previousMe ? reuseIfEqual(previousMe, latestMe) : latestMe));
      if (latestMe.user) {
        const { nickname } = latestMe.user;
        setNicknameInput((prev) => (prev.trim() ? prev : nickname));
      }
    },
    [apiClient]
  );

  const loadLatest = useCallback(
    async (boardOptions?: FetchBoardOptions) => {
      setIsLoading(true);
      setBoardError(null);
      try {
        await fetchLatest(boardOptions);
      } catch (error) {
        if (error instanceof ApiClientError) {
          setBoardError(error.message || FALLBACK_BOARD_ERROR_MESSAGE);
        } else {
          setBoardError(FALLBACK_BOARD_ERROR_MESSAGE);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [fetchLatest]
  );

  // 回到前景的刷新不切換 isLoading、失敗也不顯示看板錯誤，畫面上已有的內容原地更新或維持原樣。
  // 使用者是被推播叫回來的，所以跳過 15 秒快取，才看得到推播所指的最新名額。
  const refreshOnResume = useCallback(async () => {
    try {
      await fetchLatest({ bypassBrowserCache: true });
    } catch (error) {
      if (!(error instanceof ApiClientError)) {
        throw error;
      }
    }
  }, [fetchLatest]);

  const refreshAll = useCallback(() => loadLatest(), [loadLatest]);

  // 動作改變了伺服器狀態，看板要立刻反映，不能被瀏覽器 15 秒快取擋住。
  const refreshAfterAction = useCallback(
    () => loadLatest({ bypassBrowserCache: true }),
    [loadLatest]
  );

  useEffect(() => {
    if (!autoLoadOnMount) {
      return;
    }
    void refreshAll();
  }, [autoLoadOnMount, refreshAll]);

  useRefreshOnResume({
    refresh: refreshOnResume,
    isPaused: isSubmitting,
    isEnabled: autoLoadOnMount,
  });

  const runAction = useCallback(
    async (
      operation: () => Promise<string>,
      onErrorCleanup?: () => void
    ): Promise<boolean> => {
      setIsSubmitting(true);
      clearMessages();
      try {
        const successMessage = await operation();
        await refreshAfterAction();
        setActionSuccessMessage(successMessage);
        return true;
      } catch (error) {
        onErrorCleanup?.();
        if (error instanceof ApiClientError) {
          setActionError(error.message);
          setActionErrorCode(error.code);
          // 409 代表本機的 me 與伺服器狀態不同步（例如新手軌資格已變），重新讀取才不會重送同一個錯誤請求。
          if (error.statusCode === CONFLICT_STATUS_CODE) {
            await refreshAfterAction();
          }
        } else {
          setActionError(FALLBACK_ACTION_ERROR_MESSAGE);
        }
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [clearMessages, refreshAfterAction]
  );

  const loginWithGoogle = useCallback(
    (idToken: string, nickname?: string): Promise<boolean> =>
      runAction(async () => {
        const result = await apiClient.loginWithGoogle({ idToken, nickname });
        setNicknameInput(result.user.nickname);
        return `歡迎回來，${result.user.nickname}！`;
      }),
    [apiClient, runAction]
  );

  const loginWithDevAccount = useCallback(
    (payload: DevLoginPayload): Promise<boolean> =>
      runAction(async () => {
        const result = await apiClient.loginWithDevAccount(payload);
        setNicknameInput(result.user.nickname);
        return `已切換測試帳號：${result.user.nickname}`;
      }),
    [apiClient, runAction]
  );

  const logout = useCallback(async (): Promise<void> => {
    await runAction(async () => {
      const pushSubscription = await findBrowserPushSubscription();
      await apiClient.logout(pushSubscription?.endpoint);
      if (pushSubscription) {
        await unsubscribeBrowserPush(pushSubscription);
      }
      setNicknameInput('');
      setProviderTrackInput(DEFAULT_QUEUE_TRACK);
      return '已登出帳號';
    });
  }, [apiClient, runAction]);

  const joinQueue = useCallback(
    (): Promise<boolean> =>
      runAction(async () => {
        const result = await apiClient.joinQueue({
          thankYouMessage: thankYouMessageInput,
          track: isEligibleForNewbieTrack ? 'newbie' : 'community',
          nickname: providedNickname,
        });
        return result.status === 'reserved'
          ? `已為你保留名額，請於 ${RESERVATION_DURATION_HOURS} 小時內解鎖查看邀請連結！`
          : '排隊成功！輪到你時會發送手機推播通知';
      }),
    [apiClient, isEligibleForNewbieTrack, providedNickname, runAction, thankYouMessageInput]
  );

  const revealSlot = useCallback(
    (): Promise<boolean> =>
      runAction(async () => {
        await apiClient.revealSlot();
        return `已解鎖邀請連結！請於 ${CONFIRM_DURATION_MINUTES} 分鐘內前往使用並確認啟用`;
      }),
    [apiClient, runAction]
  );

  const confirmSlot = useCallback(
    (): Promise<boolean> =>
      runAction(async () => {
        await apiClient.confirmSlot();
        return '感謝小卡已送達提供者！';
      }),
    [apiClient, runAction]
  );

  const openReportInvalidConfirm = useCallback(() => {
    setIsReportInvalidConfirmOpen(true);
  }, []);

  const closeReportInvalidConfirm = useCallback(() => {
    setIsReportInvalidConfirmOpen(false);
  }, []);

  const reportSlotInvalid = useCallback(
    (): Promise<boolean> =>
      runAction(
        async () => {
          const remainingRetryCount = getRemainingRetryCount(
            (me?.user?.invalidRetryCount ?? 0) + 1
          );
          const result = await apiClient.reportSlotInvalid();
          setIsReportInvalidConfirmOpen(false);
          return result.requeuedStatus === 'reserved'
            ? '已為你優先排回隊伍最前面，並立即配對到下一組可用名額！'
            : `已為你優先排回隊伍最前面（剩餘重排機會 ${remainingRetryCount} 次），將優先為你配對下一組`;
        },
        () => {
          setIsReportInvalidConfirmOpen(false);
        }
      ),
    [apiClient, me, runAction]
  );

  const cancelQueue = useCallback(
    (): Promise<boolean> =>
      runAction(async () => {
        await apiClient.cancelQueue();
        return '已取消排隊';
      }),
    [apiClient, runAction]
  );

  // 推播狀態會直接反映於畫面的推播指示條，所以預設不帶成功提示，避免跳出多餘的橫幅。
  const bindPushSubscription = useCallback(
    (subscription: PushSubscriptionInput, successMessage: string): Promise<boolean> =>
      runAction(async () => {
        await apiClient.subscribePush(subscription);
        return successMessage;
      }),
    [apiClient, runAction]
  );

  const push = usePushSubscription({
    me,
    bindSubscription: bindPushSubscription,
    requestPushSubscription: options?.requestPushSubscription,
  });

  const submitInviteLink = useCallback(async (): Promise<boolean> => {
    let shareSuccessMessage = '';
    const isSubmitted = await runAction(async () => {
      const result = await apiClient.submitInviteLink({
        rawUrlInput,
        slotCount: slotCountInput,
        track: providerTrackInput,
        nickname: providedNickname,
      });
      setRawUrlInput('');
      setSlotCountInput(DEFAULT_SLOT_COUNT);
      setProviderTrackInput(DEFAULT_QUEUE_TRACK);
      shareSuccessMessage =
        result.matchedCount > 0
          ? `分享成功！已立即為 ${result.matchedCount} 位排隊版友保留名額`
          : '分享成功！名額已加入可用池等待版友領取';
      return shareSuccessMessage;
    });

    if (isSubmitted && me?.user && !me.user.hasPushSubscription) {
      // 訂閱動作也會清空訊息，所以把分享成功的提示再帶一次，使用者才看得到。
      await push.enablePush(shareSuccessMessage);
    }
    return isSubmitted;
  }, [
    apiClient,
    me,
    providedNickname,
    providerTrackInput,
    push,
    rawUrlInput,
    runAction,
    slotCountInput,
  ]);

  const testPushNotification = useCallback(
    (): Promise<boolean> =>
      runAction(async () => {
        const result = await apiClient.testPushNotification();
        return result.message;
      }),
    [apiClient, runAction]
  );

  return {
    board,
    me,
    isLoading,
    isSubmitting,
    boardError,
    actionError,
    isLoginRequired,
    actionSuccessMessage,
    activeTab,
    nicknameInput,
    providedNickname,
    thankYouMessageInput,
    rawUrlInput,
    slotCountInput,
    providerTrackInput,
    isEligibleForNewbieTrack,
    isReportInvalidConfirmOpen,
    setActiveTab,
    setNicknameInput,
    setThankYouMessageInput,
    setRawUrlInput,
    setSlotCountInput,
    setProviderTrackInput,
    openReportInvalidConfirm,
    closeReportInvalidConfirm,
    clearMessages,
    refreshAll,
    loginWithGoogle,
    loginWithDevAccount,
    logout,
    joinQueue,
    revealSlot,
    confirmSlot,
    reportSlotInvalid,
    cancelQueue,
    submitInviteLink,
    push,
    testPushNotification,
  };
}

import { useEffect, useRef } from "react";

/**
 * 兩次回到前景刷新之間至少要隔的時間。
 * 太長會讓「剛看過畫面、背景收到推播、馬上點通知回來」的人看到舊狀態；
 * 太短擋不住 iOS 切換 App 手勢造成的連續 hide/show。5 秒夠擋後者，又短於一般的切換往返。
 */
export const RESUME_REFRESH_MIN_GAP_MS = 5_000;

export interface UseRefreshOnResumeOptions {
  /** 回到前景時要執行的刷新；實作端負責不干擾畫面（不顯示載入中、不蓋掉輸入）。 */
  refresh: () => Promise<void>;
  /** 為 `true` 時略過這次回到前景，例如提交動作進行中，動作自己完成後會重新讀取。 */
  isPaused: boolean;
  /** 為 `false` 時完全不監聽。 */
  isEnabled: boolean;
}

/**
 * 頁面從背景回到前景（切回 App、點推播通知）或從 bfcache 還原時刷新一次，
 * 使用者不必手動下拉。間隔不足 `RESUME_REFRESH_MIN_GAP_MS` 的重複事件會被略過，
 * 同一次回到前景同時觸發 `visibilitychange` 與 `pageshow` 時也只會刷新一次。
 */
export function useRefreshOnResume({
  refresh,
  isPaused,
  isEnabled,
}: UseRefreshOnResumeOptions) {
  const lastRefreshStartedAtRef = useRef<number | null>(null);
  const refreshRef = useRef(refresh);
  const isPausedRef = useRef(isPaused);

  // 監聽器只註冊一次，所以事件處理要透過 ref 讀到最新的 refresh 與暫停狀態。
  refreshRef.current = refresh;
  isPausedRef.current = isPaused;

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    function refreshIfDue() {
      if (isPausedRef.current) {
        return;
      }
      const now = Date.now();
      const lastStartedAt = lastRefreshStartedAtRef.current;
      if (
        lastStartedAt !== null &&
        now - lastStartedAt < RESUME_REFRESH_MIN_GAP_MS
      ) {
        return;
      }
      lastRefreshStartedAtRef.current = now;
      void refreshRef.current();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        refreshIfDue();
      }
    }

    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        refreshIfDue();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [isEnabled]);
}

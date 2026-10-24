import { useEffect, useRef, useState } from 'react';

export interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void> | void;
}

const THRESHOLD_PX = 55;
const MAX_DISTANCE_PX = 80;
const SCROLL_TOP_TOLERANCE_PX = 5;
const PULL_DAMPING_RATIO = 0.45;
const REFRESHING_HOLD_DISTANCE_PX = 45;
const THRESHOLD_VIBRATION_MS = 12;
// 與 styles.css 的 dialog.modal 一致；非模態 <dialog> 也有 open 屬性，所以要連 class 一起比對。
const OPEN_MODAL_DIALOG_SELECTOR = 'dialog.modal[open]';

export function usePullToRefresh({ onRefresh }: UsePullToRefreshOptions) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [hasReachedThreshold, setHasReachedThreshold] = useState(false);

  const startYRef = useRef(0);
  const isTrackingRef = useRef(false);
  const isRefreshingRef = useRef(false);
  const hasVibratedRef = useRef(false);
  const hasReachedThresholdRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);

  // 監聽器只註冊一次，所以事件處理要透過 ref 讀到最新的 onRefresh 與狀態。
  isRefreshingRef.current = isRefreshing;
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    function updateHasReachedThreshold(reached: boolean) {
      hasReachedThresholdRef.current = reached;
      setHasReachedThreshold(reached);
    }

    function handleTouchStart(e: TouchEvent) {
      if (window.scrollY > SCROLL_TOP_TOLERANCE_PX || isRefreshingRef.current) {
        return;
      }
      // 模態對話框的遮罩不擋 window 上的觸控事件，頁首下拉或列表在頂端時往下拖都會傳到這裡。
      if (document.querySelector(OPEN_MODAL_DIALOG_SELECTOR)) {
        return;
      }
      const touch = e.touches[0];
      if (!touch) {
        return;
      }
      startYRef.current = touch.clientY;
      isTrackingRef.current = true;
      hasVibratedRef.current = false;
    }

    function handleTouchMove(e: TouchEvent) {
      if (!isTrackingRef.current || isRefreshingRef.current) {
        return;
      }
      if (window.scrollY > SCROLL_TOP_TOLERANCE_PX) {
        isTrackingRef.current = false;
        setPullDistance(0);
        setIsPulling(false);
        return;
      }

      const touch = e.touches[0];
      if (!touch) {
        return;
      }
      const rawDelta = touch.clientY - startYRef.current;
      if (rawDelta > 0) {
        const damped = Math.min(MAX_DISTANCE_PX, rawDelta * PULL_DAMPING_RATIO);
        setPullDistance(damped);
        setIsPulling(true);

        const reached = damped >= THRESHOLD_PX;
        updateHasReachedThreshold(reached);

        // iOS Safari 沒有 navigator.vibrate，所以要先檢查再呼叫。
        if (reached && !hasVibratedRef.current) {
          hasVibratedRef.current = true;
          if ('vibrate' in navigator) {
            navigator.vibrate(THRESHOLD_VIBRATION_MS);
          }
        }
      } else {
        setPullDistance(0);
        setIsPulling(false);
        updateHasReachedThreshold(false);
      }
    }

    async function handleTouchEnd() {
      if (!isTrackingRef.current || isRefreshingRef.current) {
        return;
      }
      isTrackingRef.current = false;
      setIsPulling(false);

      if (!hasReachedThresholdRef.current) {
        setPullDistance(0);
        updateHasReachedThreshold(false);
        return;
      }

      setIsRefreshing(true);
      setPullDistance(REFRESHING_HOLD_DISTANCE_PX);
      try {
        await onRefreshRef.current();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
        updateHasReachedThreshold(false);
      }
    }

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleTouchEnd);

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, []);

  return {
    pullDistance,
    isPulling,
    isRefreshing,
    hasReachedThreshold,
  };
}

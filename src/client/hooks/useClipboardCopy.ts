import { useCallback, useEffect, useRef, useState } from 'react';
import { COPIED_FEEDBACK_DURATION_MS } from '../constants';

export interface UseClipboardCopyReturn {
  /** 最近一次複製成功後的 `COPIED_FEEDBACK_DURATION_MS` 毫秒內為 true。 */
  hasCopied: boolean;
  /**
   * 把文字寫入剪貼簿。瀏覽器沒有剪貼簿 API，或使用者／瀏覽器拒絕寫入（`DOMException`）時，
   * 不顯示複製成功回饋也不丟錯；其他錯誤照常拋出。
   */
  copyText: (text: string) => Promise<void>;
}

export function useClipboardCopy(): UseClipboardCopyReturn {
  const [hasCopied, setHasCopied] = useState(false);
  const feedbackTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    },
    []
  );

  const copyText = useCallback(async (text: string): Promise<void> => {
    if (!navigator.clipboard?.writeText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      if (error instanceof DOMException) {
        return;
      }
      throw error;
    }
    setHasCopied(true);
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(
      () => setHasCopied(false),
      COPIED_FEEDBACK_DURATION_MS
    );
  }, []);

  return { hasCopied, copyText };
}

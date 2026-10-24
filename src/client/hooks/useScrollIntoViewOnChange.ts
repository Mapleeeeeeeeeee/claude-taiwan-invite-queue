import { useEffect, useRef, type RefObject } from 'react';

/**
 * 回傳要掛在提示元素上的 ref；`message` 從空值變成有值、或內容改變時，把該元素捲進可視範圍。
 * 內容沒變的重新渲染不會再捲動，`message` 為 null 時不做事。
 */
export function useScrollIntoViewOnChange<T extends HTMLElement>(
  message: string | null
): RefObject<T | null> {
  const elementRef = useRef<T>(null);

  // 窄螢幕上觸發動作的按鈕與提示相距一個畫面以上，提示出現在畫面外，使用者會以為沒有反應。
  // 不指定 behavior，預設的 auto 會跟隨 CSS 的 scroll-behavior；本站沒設平滑捲動，所以不會有動畫，prefers-reduced-motion 也自然被尊重。
  useEffect(() => {
    if (message) {
      elementRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [message]);

  return elementRef;
}

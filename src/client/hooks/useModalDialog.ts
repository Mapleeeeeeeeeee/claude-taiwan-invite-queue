import {
  useLayoutEffect,
  useRef,
  type DialogHTMLAttributes,
  type RefObject,
} from 'react';

export type ModalDialogProps = Pick<
  DialogHTMLAttributes<HTMLDialogElement>,
  'onClick' | 'onCancel' | 'onPointerDown' | 'onPointerUp'
> & {
  ref: RefObject<HTMLDialogElement | null>;
};

/**
 * 讓元件掛載時以 `showModal()` 開成原生模態 `<dialog>`，卸載時關閉並把焦點還給開啟前的焦點元素。
 * 回傳值直接展開到 `<dialog>` 上：Escape 觸發的 `cancel` 事件與點擊 `::backdrop` 都會呼叫 `onClose`，
 * 由呼叫端決定卸載元件。
 *
 * 開啟前的焦點元素若在關閉時已不在文件中，焦點不會移動。
 * 點擊 `::backdrop` 時事件目標是 `<dialog>` 本身，所以 `<dialog>` 不能有 padding，內容要由內層容器撐滿。
 * 這裡不用 `closedby="any"`，因為 Safari 尚未正式支援。
 */
export function useModalDialog(onClose: () => void): ModalDialogProps {
  const ref = useRef<HTMLDialogElement>(null);
  // 一次點擊由按下與放開組成；只有兩者都落在 <dialog> 本身才算點遮罩。
  // 沒有收到 pointer 事件的 click（例如輔助科技觸發）視為點遮罩。
  const isPressOnBackdropRef = useRef(true);
  const isReleaseOnBackdropRef = useRef(true);

  // 對話框是關閉時才卸載，React 會先把 <dialog> 從 DOM 移除，再執行 useEffect 的清理函式；
  // 瀏覽器在節點已脫離文件後才收到 close()，不會還原焦點，焦點就掉回 <body>。
  // 所以改用 layout effect 讓 close() 趕在移除之前，並且自己把焦點還給開啟前的元素。
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    const opener = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  return {
    ref,
    onCancel: onClose,
    onPointerDown: (event) => {
      isPressOnBackdropRef.current = event.target === event.currentTarget;
      isReleaseOnBackdropRef.current = true;
    },
    onPointerUp: (event) => {
      isReleaseOnBackdropRef.current = event.target === event.currentTarget;
    },
    onClick: (event) => {
      // 在卡片內按下、拖到遮罩放開（或反過來）時，click 的目標會變成 <dialog>，不能當成點遮罩。
      const isBackdropClick =
        event.target === event.currentTarget &&
        isPressOnBackdropRef.current &&
        isReleaseOnBackdropRef.current;
      isPressOnBackdropRef.current = true;
      isReleaseOnBackdropRef.current = true;
      if (isBackdropClick) {
        onClose();
      }
    },
  };
}

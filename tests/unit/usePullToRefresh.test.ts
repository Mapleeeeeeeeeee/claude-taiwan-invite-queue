// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePullToRefresh } from '../../src/client/hooks/usePullToRefresh';

function dispatchTouch(type: 'touchstart' | 'touchmove' | 'touchend', clientY?: number) {
  const event = new Event(type);
  Object.assign(event, { touches: clientY === undefined ? [] : [{ clientY }] });
  act(() => {
    window.dispatchEvent(event);
  });
}

describe('usePullToRefresh Hook', () => {
  it('下拉超過門檻後放開，呼叫最新一次 render 傳入的 onRefresh 並在完成後復原', async () => {
    const staleRefresh = vi.fn();
    const latestRefresh = vi.fn(async () => {});
    const { result, rerender } = renderHook(({ onRefresh }) => usePullToRefresh({ onRefresh }), {
      initialProps: { onRefresh: staleRefresh },
    });
    rerender({ onRefresh: latestRefresh });

    dispatchTouch('touchstart', 0);
    dispatchTouch('touchmove', 200);
    expect(result.current.hasReachedThreshold).toBe(true);

    await act(async () => {
      dispatchTouch('touchend');
    });

    expect(latestRefresh).toHaveBeenCalledTimes(1);
    expect(staleRefresh).not.toHaveBeenCalled();
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.pullDistance).toBe(0);
  });

  it('下拉未達門檻就放開時，不觸發 onRefresh', () => {
    const onRefresh = vi.fn();
    const { result } = renderHook(() => usePullToRefresh({ onRefresh }));

    dispatchTouch('touchstart', 0);
    dispatchTouch('touchmove', 40);
    expect(result.current.isPulling).toBe(true);
    expect(result.current.hasReachedThreshold).toBe(false);
    dispatchTouch('touchend');

    expect(onRefresh).not.toHaveBeenCalled();
    expect(result.current.pullDistance).toBe(0);
  });

  describe('有開啟中的模態對話框時', () => {
    afterEach(() => {
      document.body.innerHTML = '';
    });

    function openModalDialog() {
      const dialog = document.createElement('dialog');
      dialog.className = 'modal';
      dialog.setAttribute('open', '');
      document.body.appendChild(dialog);
      return dialog;
    }

    it('Given 對話框開著 When 在頁面上往下拖並放開 Then 不出現下拉提示也不呼叫 onRefresh', () => {
      const onRefresh = vi.fn();
      const { result } = renderHook(() => usePullToRefresh({ onRefresh }));
      openModalDialog();

      dispatchTouch('touchstart', 0);
      dispatchTouch('touchmove', 200);
      dispatchTouch('touchend');

      expect(result.current.isPulling).toBe(false);
      expect(result.current.pullDistance).toBe(0);
      expect(onRefresh).not.toHaveBeenCalled();
    });

    it('Given 對話框已關閉 When 在頁面上往下拖並放開 Then 照常呼叫 onRefresh', async () => {
      const onRefresh = vi.fn(async () => {});
      renderHook(() => usePullToRefresh({ onRefresh }));
      openModalDialog().removeAttribute('open');

      dispatchTouch('touchstart', 0);
      dispatchTouch('touchmove', 200);
      await act(async () => {
        dispatchTouch('touchend');
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });
});

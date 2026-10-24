// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPIED_FEEDBACK_DURATION_MS } from '../../src/client/constants';
import { useClipboardCopy } from '../../src/client/hooks/useClipboardCopy';

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('useClipboardCopy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (navigator as unknown as Record<string, unknown>).clipboard;
  });

  it('複製成功後顯示已複製，過了回饋時間就恢復', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    const { result } = renderHook(() => useClipboardCopy());

    await act(async () => {
      await result.current.copyText('https://claude.ai/referral/abc');
    });
    expect(writeText).toHaveBeenCalledWith('https://claude.ai/referral/abc');
    expect(result.current.hasCopied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(COPIED_FEEDBACK_DURATION_MS);
    });
    expect(result.current.hasCopied).toBe(false);
  });

  it('剪貼簿拒絕寫入（DOMException）時不顯示已複製，也不丟錯', async () => {
    stubClipboard(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const { result } = renderHook(() => useClipboardCopy());

    await act(async () => {
      await result.current.copyText('x');
    });

    expect(result.current.hasCopied).toBe(false);
  });

  it('剪貼簿丟出非預期錯誤時，錯誤照常往上拋', async () => {
    stubClipboard(async () => {
      throw new RangeError('unexpected');
    });
    const { result } = renderHook(() => useClipboardCopy());

    await expect(result.current.copyText('x')).rejects.toThrow(RangeError);
    expect(result.current.hasCopied).toBe(false);
  });

  it('瀏覽器沒有剪貼簿 API 時，不顯示已複製', async () => {
    const { result } = renderHook(() => useClipboardCopy());

    await act(async () => {
      await result.current.copyText('x');
    });

    expect(result.current.hasCopied).toBe(false);
  });

  it('回饋時間內元件卸載時清掉計時器，不留下待執行的 timeout', async () => {
    stubClipboard(async () => {});
    const { result, unmount } = renderHook(() => useClipboardCopy());
    await act(async () => {
      await result.current.copyText('x');
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

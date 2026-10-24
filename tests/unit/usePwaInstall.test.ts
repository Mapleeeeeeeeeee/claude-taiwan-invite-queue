// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePwaInstall } from '../../src/client/hooks/usePwaInstall';

describe('usePwaInstall Hook (PWA 一鍵加入主畫面)', () => {
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

  function stubNavigator(name: 'userAgent' | 'platform' | 'maxTouchPoints', value: unknown) {
    if (!originalDescriptors.has(name)) {
      originalDescriptors.set(name, Object.getOwnPropertyDescriptor(navigator, name));
    }
    Object.defineProperty(navigator, name, { value, configurable: true });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Regression: iPadOS 測試改過的 platform 與 maxTouchPoints 沒有還原，打亂順序時會污染其他測試 (test-review Should Fix usePwaInstall)
  afterEach(() => {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) {
        Object.defineProperty(navigator, name, descriptor);
      } else {
        delete (navigator as unknown as Record<string, unknown>)[name];
      }
    }
    originalDescriptors.clear();
  });

  it('初始狀態非 standalone 且尚未收到 beforeinstallprompt 時，預設無法直接安裝 (非 iOS)', () => {
    stubNavigator('userAgent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0');

    const { result } = renderHook(() => usePwaInstall());
    expect(result.current.isStandalone).toBe(false);
    expect(result.current.isInstallable).toBe(false);
    expect(result.current.isIos).toBe(false);
  });

  it('收到 beforeinstallprompt 事件後應標記為可安裝，呼叫 installPwa 觸發原生 prompt', async () => {
    const { result } = renderHook(() => usePwaInstall());

    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const mockChoice = Promise.resolve({ outcome: 'accepted' as const, platform: 'web' });

    const fakeEvent = new Event('beforeinstallprompt');
    Object.assign(fakeEvent, {
      platforms: ['web'],
      prompt: mockPrompt,
      userChoice: mockChoice,
    });

    act(() => {
      window.dispatchEvent(fakeEvent);
    });

    expect(result.current.isInstallable).toBe(true);

    let installed = false;
    await act(async () => {
      installed = await result.current.installPwa();
    });

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(installed).toBe(true);
  });

  it('使用者在 beforeinstallprompt 原生對話框點擊取消 (dismissed) 時，installPwa 回傳 false', async () => {
    const { result } = renderHook(() => usePwaInstall());

    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const mockChoice = Promise.resolve({ outcome: 'dismissed' as const, platform: 'web' });

    const fakeEvent = new Event('beforeinstallprompt');
    Object.assign(fakeEvent, {
      platforms: ['web'],
      prompt: mockPrompt,
      userChoice: mockChoice,
    });

    act(() => {
      window.dispatchEvent(fakeEvent);
    });

    let installed = true;
    await act(async () => {
      installed = await result.current.installPwa();
    });

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(installed).toBe(false);
  });

  it('在 iPadOS 13+ 觸控桌面裝置上應標記為 isIos', () => {
    stubNavigator('userAgent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15');
    stubNavigator('platform', 'MacIntel');
    stubNavigator('maxTouchPoints', 5);

    const { result } = renderHook(() => usePwaInstall());
    expect(result.current.isIos).toBe(true);
    expect(result.current.isInstallable).toBe(true);
  });

  it('在 iOS 裝置上應標記為 isIos，點擊 installPwa 應開啟 iOS 專用步驟指引', async () => {
    stubNavigator('userAgent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');

    const { result } = renderHook(() => usePwaInstall());
    expect(result.current.isIos).toBe(true);
    expect(result.current.isInstallable).toBe(true);
    expect(result.current.isIosGuideOpen).toBe(false);

    await act(async () => {
      await result.current.installPwa();
    });

    expect(result.current.isIosGuideOpen).toBe(true);

    act(() => {
      result.current.closeIosGuide();
    });
    expect(result.current.isIosGuideOpen).toBe(false);
  });

  it('收到 appinstalled 事件後，應自動更新為 standalone 並關閉引導', () => {
    const { result } = renderHook(() => usePwaInstall());

    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });

    expect(result.current.isStandalone).toBe(true);
    expect(result.current.isInstallable).toBe(false);
  });
});

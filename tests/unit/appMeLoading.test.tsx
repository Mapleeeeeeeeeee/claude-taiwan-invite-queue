// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardDto, MeDto } from '../../src/shared/types';
import type { InviteApiClient } from '../../src/client/api/apiClient';
import { App } from '../../src/client/App';

const GIS_SCRIPT_SELECTOR = 'script[src^="https://accounts.google.com/gsi/client"]';

const board: BoardDto = {
  availableSlotsCount: 0,
  waitingQueueCount: 0,
  totalConfirmedCount: 0,
  newbieSlotsCount: 0,
  communitySlotsCount: 0,
  newbieQueueCount: 0,
  communityQueueCount: 0,
  thankYouWall: [],
};

const productionAnonymousMe: MeDto = {
  user: null,
  myQueue: null,
  myConfirmedClaim: null,
  mySharedLinks: [],
  vapidPublicKey: 'test-vapid-public-key',
  devLoginEnabled: false,
  googleClientId: 'production-client-id.apps.googleusercontent.com',
};

/** 讓測試決定 `/api/me` 什麼時候回來，才能在載入前後各做一次操作。 */
function renderAppWithDeferredMe() {
  let resolveMe: (me: MeDto) => void = () => {};
  const mePromise = new Promise<MeDto>((resolve) => {
    resolveMe = resolve;
  });
  const apiClient = {
    fetchBoard: vi.fn(async () => board),
    fetchMe: vi.fn(() => mePromise),
  } as unknown as InviteApiClient;
  render(<App hookOptions={{ apiClient }} />);
  return {
    finishLoadingMe: () =>
      act(async () => {
        resolveMe(productionAnonymousMe);
        await mePromise;
      }),
  };
}

afterEach(cleanup);

describe('App 在 /api/me 載入完成前後', () => {
  // Regression: me 載入後整頁重新掛載，使用者正在輸入的欄位失去焦點與內容
  it('使用者已在輸入暱稱時，me 載入後同一個輸入框仍保留焦點與內容', async () => {
    const { finishLoadingMe } = renderAppWithDeferredMe();
    const nicknameInput = screen.getByLabelText('你的顯示暱稱') as HTMLInputElement;
    nicknameInput.focus();
    fireEvent.change(nicknameInput, { target: { value: '阿明' } });

    await finishLoadingMe();

    // 確認載入完成後 Google 登入元件確實已經掛上，才有「掛上前後」可比。
    await waitFor(() => expect(document.querySelector(GIS_SCRIPT_SELECTOR)).not.toBeNull());
    expect(screen.getByLabelText('你的顯示暱稱')).toBe(nicknameInput);
    expect(document.activeElement).toBe(nicknameInput);
    expect(nicknameInput.value).toBe('阿明');
  });

  // Regression: beforeinstallprompt 在 /api/me 回來前觸發，整頁重新掛載後事件遺失，Android 安裝橫幅不出現
  it('beforeinstallprompt 在 me 載入前觸發時，載入完成後安裝橫幅仍在，按下按鈕會呼叫當時保存的 prompt', async () => {
    const { finishLoadingMe } = renderAppWithDeferredMe();
    const installPrompt = vi.fn().mockResolvedValue(undefined);
    const beforeInstallPromptEvent = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      platforms: ['web'],
      prompt: installPrompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }),
    });
    act(() => {
      window.dispatchEvent(beforeInstallPromptEvent);
    });

    await finishLoadingMe();
    await waitFor(() => expect(document.querySelector(GIS_SCRIPT_SELECTOR)).not.toBeNull());

    expect(screen.getByTestId('pwa-install-banner')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '加入主畫面' }));
    });
    expect(installPrompt).toHaveBeenCalledTimes(1);
  });
});

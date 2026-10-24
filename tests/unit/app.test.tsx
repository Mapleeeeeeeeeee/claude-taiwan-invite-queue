// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardDto, MeDto } from '../../src/shared/types';
import type { InviteApiClient } from '../../src/client/api/apiClient';
import { App } from '../../src/client/App';

afterEach(cleanup);

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

function createAnonymousMe(devLoginEnabled: boolean): MeDto {
  return {
    user: null,
    myQueue: null,
    myConfirmedClaim: null,
    mySharedLinks: [],
    vapidPublicKey: 'test-vapid-public-key',
    devLoginEnabled,
    googleClientId: 'test-google-client-id',
  };
}

function renderAppWithServerFlag(devLoginEnabled: boolean) {
  const apiClient = {
    fetchBoard: vi.fn(async () => board),
    fetchMe: vi.fn(async () => createAnonymousMe(devLoginEnabled)),
  } as unknown as InviteApiClient;
  render(<App hookOptions={{ apiClient }} />);
  return apiClient;
}

describe('App 開發登入入口', () => {
  it('伺服器開放開發登入時，顯示開發測試快捷登入列', async () => {
    renderAppWithServerFlag(true);

    expect(await screen.findByLabelText('開發環境快捷登入')).not.toBeNull();
  });

  it('伺服器未開放開發登入時，不顯示開發測試快捷登入列', async () => {
    const apiClient = renderAppWithServerFlag(false);
    await waitFor(() => expect(apiClient.fetchMe).toHaveBeenCalled());
    // 等伺服器回應套用到畫面後再確認，避免把「尚未載入」誤判成「不顯示」。
    await act(async () => {
      await vi.mocked(apiClient.fetchMe).mock.results[0]!.value;
    });

    expect(screen.queryByLabelText('開發環境快捷登入')).toBeNull();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardDto, MeDto } from '../../src/shared/types';
import type { InviteApiClient } from '../../src/client/api/apiClient';
import { App } from '../../src/client/App';

const GIS_SCRIPT_SELECTOR = 'script[src^="https://accounts.google.com/gsi/client"]';
const PRODUCTION_CLIENT_ID = 'production-client-id.apps.googleusercontent.com';

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

const loggedInUser: NonNullable<MeDto['user']> = {
  id: 1,
  email: 'member@example.com',
  nickname: '版友',
  invalidRetryCount: 0,
  invalidLinkStrikeCount: 0,
  isProviderBlocked: false,
  hasPushSubscription: false,
  isEligibleForNewbieTrack: true,
  hasSharedLinks: false,
};

function createMe(overrides: Partial<MeDto>): MeDto {
  return {
    user: null,
    myQueue: null,
    myConfirmedClaim: null,
    mySharedLinks: [],
    vapidPublicKey: 'test-vapid-public-key',
    devLoginEnabled: false,
    googleClientId: PRODUCTION_CLIENT_ID,
    ...overrides,
  };
}

function installFakeGoogleIdentityServices() {
  const accountsId = {
    initialize: vi.fn(),
    renderButton: vi.fn(),
    disableAutoSelect: vi.fn(),
  };
  Object.defineProperty(window, 'google', {
    configurable: true,
    value: { accounts: { id: accountsId } },
  });
  return accountsId;
}

function renderApp(me: MeDto) {
  const apiClient = {
    fetchBoard: vi.fn(async () => board),
    fetchMe: vi.fn(async () => me),
    loginWithGoogle: vi.fn(async () => ({
      user: { id: 1, email: 'member@example.com', nickname: '版友' },
    })),
    logout: vi.fn(async () => ({ loggedOut: true })),
  } as unknown as InviteApiClient;
  render(<App hookOptions={{ apiClient }} />);
  return apiClient;
}

async function findGisScript(): Promise<HTMLScriptElement> {
  await waitFor(() => expect(document.querySelector(GIS_SCRIPT_SELECTOR)).not.toBeNull());
  return document.querySelector<HTMLScriptElement>(GIS_SCRIPT_SELECTOR)!;
}

let accountsId: ReturnType<typeof installFakeGoogleIdentityServices>;

beforeEach(() => {
  accountsId = installFakeGoogleIdentityServices();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'google');
});

describe('Google 官方按鈕登入（正式環境）', () => {
  it('伺服器未開放開發登入時，載入 GIS script，載入完成後用 me.googleClientId 初始化並渲染繁體中文按鈕', async () => {
    renderApp(createMe({}));

    fireEvent.load(await findGisScript());

    await waitFor(() => expect(accountsId.renderButton).toHaveBeenCalled());
    expect(accountsId.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: PRODUCTION_CLIENT_ID, ux_mode: 'popup' })
    );
    expect(accountsId.renderButton).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ locale: 'zh-TW' })
    );
  });

  it.each([
    { typedNickname: '', expectedNickname: undefined },
    { typedNickname: '  阿明 ', expectedNickname: '阿明' },
  ])(
    'callback 收到 credential 時，以暱稱「$typedNickname」呼叫登入 API 並重新抓取我的狀態',
    async ({ typedNickname, expectedNickname }) => {
      const apiClient = renderApp(createMe({}));
      fireEvent.load(await findGisScript());
      await waitFor(() => expect(accountsId.initialize).toHaveBeenCalled());
      fireEvent.change(await screen.findByLabelText('你的顯示暱稱'), {
        target: { value: typedNickname },
      });
      const { callback } = accountsId.initialize.mock.lastCall![0] as {
        callback: (response: { credential: string }) => void;
      };

      callback({ credential: 'google-id-token' });

      await waitFor(() =>
        expect(apiClient.loginWithGoogle).toHaveBeenCalledWith({
          idToken: 'google-id-token',
          nickname: expectedNickname,
        })
      );
      await waitFor(() => expect(apiClient.fetchMe).toHaveBeenCalledTimes(2));
    }
  );

  it('登入後使用者已填的感謝小卡仍留在輸入框', async () => {
    renderApp(createMe({}));
    fireEvent.load(await findGisScript());
    await waitFor(() => expect(accountsId.initialize).toHaveBeenCalled());
    fireEvent.change(await screen.findByLabelText(/給提供者的感謝小卡/), {
      target: { value: '謝謝你的分享' },
    });
    const { callback } = accountsId.initialize.mock.lastCall![0] as {
      callback: (response: { credential: string }) => void;
    };

    callback({ credential: 'google-id-token' });

    await waitFor(() => expect(screen.queryByText(/歡迎回來/)).not.toBeNull());
    expect((screen.getByLabelText(/給提供者的感謝小卡/) as HTMLTextAreaElement).value).toBe(
      '謝謝你的分享'
    );
  });

  it('script 載入失敗時顯示提示，按重新載入後再插入一次 script 並渲染按鈕', async () => {
    renderApp(createMe({}));
    fireEvent.error(await findGisScript());

    expect((await screen.findAllByRole('alert'))[0]!.textContent).toContain('Google 登入元件載入失敗');
    fireEvent.click(screen.getAllByRole('button', { name: '重新載入' })[0]!);
    fireEvent.load(await findGisScript());

    await waitFor(() => expect(accountsId.renderButton).toHaveBeenCalled());
    expect(screen.queryByText(/Google 登入元件載入失敗/)).toBeNull();
  });

  it('登出時通知 Google 停用自動選取帳號', async () => {
    const apiClient = renderApp(createMe({ user: loggedInUser }));

    fireEvent.click(await screen.findByRole('button', { name: '登出' }));

    await waitFor(() => expect(apiClient.logout).toHaveBeenCalled());
    expect(accountsId.disableAutoSelect).toHaveBeenCalled();
  });
});

describe('本機開發登入', () => {
  it('伺服器開放開發登入時，不載入 GIS script，仍顯示自訂的 Google 登入按鈕與開發快捷列', async () => {
    const apiClient = renderApp(createMe({ devLoginEnabled: true }));

    expect(await screen.findByLabelText('開發環境快捷登入')).not.toBeNull();
    expect(apiClient.fetchMe).toHaveBeenCalled();
    expect(document.querySelector(GIS_SCRIPT_SELECTOR)).toBeNull();
    expect(accountsId.initialize).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Google 帳號登入' })).not.toBeNull();
  });
});

// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushToggleButton } from '../../src/client/components/PushToggleButton';
import { usePushSubscription } from '../../src/client/hooks/usePushSubscription';
import type { MeDto, PushSubscriptionInput } from '../../src/shared/types';
import { renderWithPwaInstall as render } from '../helpers/renderWithPwaInstall';

const PENDING_PUSH_STORAGE_KEY = 'claude_invite_pending_push_sub';

/** 把 `usePushSubscription` 接到 `PushToggleButton`，和 `useInviteApp` 的接法一致。 */
function PushToggleHarness({
  me,
  onSubscribePush,
}: {
  me: MeDto | null;
  onSubscribePush: (subscription: PushSubscriptionInput, successMessage: string) => Promise<boolean>;
}) {
  const push = usePushSubscription({ me, bindSubscription: onSubscribePush });
  return <PushToggleButton me={me} isSubmitting={false} push={push} />;
}

describe('PushToggleButton UX & Subscription Binding', () => {
  const browserSubscription: PushSubscriptionInput = {
    endpoint: 'https://push.example.test/sub/browser-issued',
    keys: { p256dh: 'browser-p256dh-key', auth: 'browser-auth-key' },
  };

  const guestMe: MeDto = {
    user: null,
    myQueue: null,
    myConfirmedClaim: null,
    mySharedLinks: [],
    devLoginEnabled: false,
    googleClientId: 'test-google-client-id',
    vapidPublicKey: 'demo-vapid-key',
  };

  const loggedInMe: MeDto = {
    ...guestMe,
    user: {
      id: 42,
      email: 'user@claude-tw.dev',
      nickname: '小明',
      hasPushSubscription: false,
      invalidRetryCount: 0,
      invalidLinkStrikeCount: 0,
      isProviderBlocked: false,
      isEligibleForNewbieTrack: true,
      hasSharedLinks: false,
    },
  };

  /** 模擬支援 Web Push 的瀏覽器：`subscribe` 的結果由測試決定。 */
  function stubPushCapableBrowser(subscribe: () => Promise<unknown>) {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn(async () => 'granted'),
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { ready: Promise.resolve({ pushManager: { subscribe } }) },
      configurable: true,
    });
  }

  function stubSuccessfulSubscribe() {
    stubPushCapableBrowser(async () => ({ toJSON: () => browserSubscription }));
  }

  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  });

  it('未登入訪客點擊推播，暫存訂閱並顯示等待登入綁定提示且不調用後端 API', async () => {
    stubSuccessfulSubscribe();
    const handleSubscribePush = vi.fn(async () => true);

    render(
      <PushToggleHarness me={guestMe} onSubscribePush={handleSubscribePush} />
    );

    const button = screen.getByRole('button', { name: /開啟手機推播通知/ });
    expect(button).not.toBeNull();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(handleSubscribePush).not.toHaveBeenCalled();
    expect(screen.getByText(/通知權限已允許（登入後自動綁定）/)).not.toBeNull();
  });

  it('訪客暫存推播後完成登入，自動觸發 onSubscribePush 並帶上瀏覽器核發的訂閱', async () => {
    stubSuccessfulSubscribe();
    const handleSubscribePush = vi.fn(async () => true);

    const { rerender } = render(
      <PushToggleHarness me={guestMe} onSubscribePush={handleSubscribePush} />
    );

    const button = screen.getByRole('button', { name: /開啟手機推播通知/ });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(handleSubscribePush).not.toHaveBeenCalled();

    await act(async () => {
      rerender(
        <PushToggleHarness me={loggedInMe} onSubscribePush={handleSubscribePush} />
      );
    });

    expect(handleSubscribePush).toHaveBeenCalledTimes(1);
    expect(handleSubscribePush).toHaveBeenCalledWith(browserSubscription, '');
    expect(sessionStorage.getItem(PENDING_PUSH_STORAGE_KEY)).toBeNull();
  });

  it('同一個分頁重新載入後，登入前暫存的訂閱仍在，登入後會自動綁定', async () => {
    sessionStorage.setItem(PENDING_PUSH_STORAGE_KEY, JSON.stringify(browserSubscription));
    const handleSubscribePush = vi.fn(async () => true);

    const { rerender } = render(
      <PushToggleHarness me={guestMe} onSubscribePush={handleSubscribePush} />
    );
    expect(screen.getByText(/通知權限已允許（登入後自動綁定）/)).not.toBeNull();

    await act(async () => {
      rerender(<PushToggleHarness me={loggedInMe} onSubscribePush={handleSubscribePush} />);
    });

    expect(handleSubscribePush).toHaveBeenCalledWith(browserSubscription, '');
  });

  it.each([
    ['不是合法 JSON', '{not json'],
    ['缺少加密金鑰', JSON.stringify({ endpoint: browserSubscription.endpoint })],
    ['endpoint 不是字串', JSON.stringify({ endpoint: 42, keys: browserSubscription.keys })],
    ['是 JSON null', 'null'],
  ])('暫存的訂閱內容%s時，當作沒有暫存，不送去綁定', async (_label, cached) => {
    sessionStorage.setItem(PENDING_PUSH_STORAGE_KEY, cached);
    const handleSubscribePush = vi.fn(async () => true);

    const { rerender } = render(
      <PushToggleHarness me={guestMe} onSubscribePush={handleSubscribePush} />
    );
    await act(async () => {
      rerender(<PushToggleHarness me={loggedInMe} onSubscribePush={handleSubscribePush} />);
    });

    expect(screen.queryByText(/通知權限已允許/)).toBeNull();
    expect(handleSubscribePush).not.toHaveBeenCalled();
  });

  // Regression: 瀏覽器訂閱失敗時前端捏造假訂閱並顯示推播已就緒 (review-cleanliness 假訂閱, review-convention #10)
  it.each([
    ['PushManager 訂閱丟出 DOMException', async () => { throw new DOMException('push service error', 'AbortError'); }],
    ['訂閱結果缺少加密金鑰', async () => ({ toJSON: () => ({ endpoint: browserSubscription.endpoint }) })],
  ])('點擊開啟推播時若%s，不暫存訂閱也不顯示就緒，按鈕仍可再試', async (_label, subscribe) => {
    stubPushCapableBrowser(subscribe);
    const handleSubscribePush = vi.fn(async () => true);

    render(
      <PushToggleHarness me={guestMe} onSubscribePush={handleSubscribePush} />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /開啟手機推播通知/ }));
    });

    expect(handleSubscribePush).not.toHaveBeenCalled();
    expect(screen.queryByText(/通知權限已允許/)).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(screen.getByRole('button', { name: /開啟手機推播通知/ })).not.toBeNull();
  });

  it('瀏覽器不支援 Notification 時，顯示此瀏覽器不支援推播而不提供開啟按鈕', () => {
    render(
      <PushToggleHarness me={null} onSubscribePush={vi.fn(async () => true)} />
    );

    expect(screen.getByText('此瀏覽器不支援推播')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /開啟手機推播通知/ })).toBeNull();
  });
  // Regression: 通知權限被封鎖的說明只放在 title 提示，設計文件要求的是畫面上看得到的文字
  it('通知權限被瀏覽器封鎖時，按鈕維持停用，並直接顯示開啟權限的說明文字', () => {
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn() });

    render(<PushToggleHarness me={guestMe} onSubscribePush={vi.fn(async () => true)} />);

    expect((screen.getByRole('button', { name: /通知權限已關閉/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText('你已在瀏覽器設定中封鎖通知，請至網站設定開啟權限，或記得定時回來查看進度')
    ).not.toBeNull();
  });

  describe('iPhone Safari 尚未加入主畫面', () => {
    const IPHONE_USER_AGENT =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
    let originalUserAgent: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
      Object.defineProperty(navigator, 'userAgent', { value: IPHONE_USER_AGENT, configurable: true });
    });

    afterEach(() => {
      if (originalUserAgent) {
        Object.defineProperty(navigator, 'userAgent', originalUserAgent);
      } else {
        delete (navigator as unknown as Record<string, unknown>).userAgent;
      }
    });

    // Regression: 推播按鈕自己持有 iOS 引導的開關，但引導視窗只由安裝橫幅渲染，點了沒有任何反應
    it('點擊「加到主畫面開啟推播」時，開啟 iOS 加入主畫面的引導視窗', () => {
      render(<PushToggleHarness me={guestMe} onSubscribePush={vi.fn(async () => true)} />);

      fireEvent.click(screen.getByRole('button', { name: /加到主畫面開啟推播/ }));

      const dialog = screen.getByRole('dialog', { name: '如何將網頁加入 iPhone 主畫面' });
      expect(dialog.hasAttribute('open')).toBe(true);
    });
  });
});

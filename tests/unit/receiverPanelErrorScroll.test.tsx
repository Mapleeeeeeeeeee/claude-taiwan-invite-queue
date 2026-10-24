// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeDto, MyQueueEntryDto } from '../../src/shared/types';
import { ReceiverPanel, type ReceiverPanelProps } from '../../src/client/components/ReceiverPanel';

const scrollIntoView = vi.fn();

// jsdom 沒有實作 scrollIntoView，錯誤提示出現時元件會呼叫它。
beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

function createLoggedInMe(overrides?: Partial<MeDto>): MeDto {
  return {
    user: {
      id: 10,
      email: 'alice@claude-tw.dev',
      nickname: 'Alice',
      invalidRetryCount: 0,
      invalidLinkStrikeCount: 0,
      isProviderBlocked: false,
      hasPushSubscription: false,
      isEligibleForNewbieTrack: true,
      hasSharedLinks: false,
    },
    myQueue: null,
    myConfirmedClaim: null,
    mySharedLinks: [],
    vapidPublicKey: 'test-vapid-public-key',
    devLoginEnabled: false,
    googleClientId: 'test-google-client-id',
    ...overrides,
  };
}

const revealedQueue: MyQueueEntryDto = {
  id: 1,
  status: 'revealed',
  track: 'newbie',
  queuePosition: null,
  thankYouMessage: '謝謝版友分享！',
  slotId: 1,
  providerNickname: '小張',
  referralUrl: 'https://claude.ai/referral/rNFlbuU0OA',
  reserveExpiresAt: null,
  confirmExpiresAt: '2099-01-01T00:00:00.000Z',
  canReportInvalid: true,
  isRequeuedWithPriority: false,
};

function createPanelProps(overrides?: Partial<ReceiverPanelProps>): ReceiverPanelProps {
  return {
    me: createLoggedInMe({ myQueue: revealedQueue }),
    isSubmitting: false,
    actionError: null,
    isLoginRequired: false,
    nicknameInput: '阿明',
    thankYouMessageInput: '合法的感謝小卡內容！',
    isEligibleForNewbieTrack: true,
    isReportInvalidConfirmOpen: false,
    onNicknameChange: vi.fn(),
    onThankYouMessageChange: vi.fn(),
    onJoinQueue: vi.fn(async () => true),
    onRevealSlot: vi.fn(async () => true),
    onConfirmSlot: vi.fn(async () => true),
    onOpenReportInvalidConfirm: vi.fn(),
    onCloseReportInvalidConfirm: vi.fn(),
    onReportSlotInvalid: vi.fn(async () => true),
    onCancelQueue: vi.fn(async () => true),
    onCountdownExpire: vi.fn(),
    onRequireLogin: vi.fn(),
    push: {
      permissionState: 'default',
      hasPendingGuestSubscription: false,
      enablePush: vi.fn(async () => true),
    },
    onTestPush: vi.fn(async () => true),
    ...overrides,
  };
}

describe('ReceiverPanel 操作失敗時捲到錯誤提示', () => {
  it('Given 沒有錯誤 When 錯誤新出現 Then 把錯誤提示捲進可視範圍', () => {
    const { rerender } = render(<ReceiverPanel {...createPanelProps()} />);
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender(<ReceiverPanel {...createPanelProps({ actionError: '操作太頻繁，請稍後再試' })} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('alert'));
  });

  it('Given 已領過一次而在排隊表單 When 排隊失敗 Then 也把錯誤提示捲進可視範圍', () => {
    const props = createPanelProps({ me: createLoggedInMe() });
    const { rerender } = render(<ReceiverPanel {...props} />);

    rerender(<ReceiverPanel {...props} actionError="操作太頻繁，請稍後再試" />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('alert'));
  });

  it('Given 錯誤已顯示 When 父層因其他原因重新渲染 Then 不再捲動', () => {
    const props = createPanelProps({ actionError: '操作太頻繁，請稍後再試' });
    const { rerender } = render(<ReceiverPanel {...props} />);
    scrollIntoView.mockClear();

    rerender(<ReceiverPanel {...props} isSubmitting />);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('Given 錯誤已顯示 When 錯誤內容改變 Then 再捲動一次', () => {
    const { rerender } = render(
      <ReceiverPanel {...createPanelProps({ actionError: '操作太頻繁，請稍後再試' })} />
    );
    scrollIntoView.mockClear();

    rerender(<ReceiverPanel {...createPanelProps({ actionError: '名額已被領走' })} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('Given 同一個錯誤被清除後再次出現 When 再次操作失敗 Then 再捲動一次', () => {
    const error = '操作太頻繁，請稍後再試';
    const { rerender } = render(<ReceiverPanel {...createPanelProps({ actionError: error })} />);
    rerender(<ReceiverPanel {...createPanelProps({ actionError: null })} />);
    scrollIntoView.mockClear();

    rerender(<ReceiverPanel {...createPanelProps({ actionError: error })} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('Given 需要登入 When 有錯誤訊息 Then 不顯示也不捲動，交給登入引導', () => {
    render(
      <ReceiverPanel
        {...createPanelProps({ actionError: '請先登入', isLoginRequired: true, me: null })}
      />
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

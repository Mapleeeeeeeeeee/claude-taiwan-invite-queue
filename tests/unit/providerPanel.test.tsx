// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderPanel,
  type ProviderPanelProps,
} from '../../src/client/components/ProviderPanel';
import type { MeDto, MySharedLinkDto } from '../../src/shared/types';
import { renderWithPwaInstall as render } from '../helpers/renderWithPwaInstall';

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

function createPanelProps(overrides?: Partial<ProviderPanelProps>): ProviderPanelProps {
  return {
    me: null,
    isSubmitting: false,
    actionError: null,
    isLoginRequired: false,
    nicknameInput: '小張',
    rawUrlInput: 'https://claude.ai/referral/shareTest01',
    slotCountInput: 3,
    providerTrackInput: 'newbie',
    onNicknameChange: vi.fn(),
    onRawUrlChange: vi.fn(),
    onSlotCountChange: vi.fn(),
    onProviderTrackChange: vi.fn(),
    onSubmitInviteLink: vi.fn(async () => true),
    push: { permissionState: 'default', hasPendingGuestSubscription: false, enablePush: vi.fn(async () => true) },
    onRequireLogin: vi.fn(),
    onTestPush: vi.fn(async () => true),
    ...overrides,
  };
}

describe('ProviderPanel 名額受眾單選', () => {
  it('預設選中新手，點選再領取選項時通知父層切換為 community', () => {
    const handleTrackChange = vi.fn();
    render(<ProviderPanel {...createPanelProps({ onProviderTrackChange: handleTrackChange })} />);

    const newbieOption = screen.getByRole('radio', { name: /限新手首次體驗/ });
    const communityOption = screen.getByRole('radio', { name: /開放再領取軌/ });
    expect(newbieOption.getAttribute('aria-checked')).toBe('true');
    expect(communityOption.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(communityOption);

    expect(handleTrackChange).toHaveBeenCalledWith('community');
  });

  it('未登入時送出表單只觸發登入，不提交連結', () => {
    const handleSubmit = vi.fn(async () => true);
    const handleRequireLogin = vi.fn();
    render(
      <ProviderPanel
        {...createPanelProps({
          onSubmitInviteLink: handleSubmit,
          onRequireLogin: handleRequireLogin,
        })}
      />
    );

    fireEvent.submit(screen.getByLabelText(/Claude 邀請連結/).closest('form')!);

    expect(handleRequireLogin).toHaveBeenCalledTimes(1);
    expect(handleSubmit).not.toHaveBeenCalled();
  });
});

describe('ProviderPanel 分享失敗的錯誤提示位置', () => {
  it('分享失敗時，錯誤提示出現在邀請連結輸入框之後', () => {
    render(<ProviderPanel {...createPanelProps({ actionError: '這個邀請代碼已經有人分享過了' })} />);

    const urlInput = screen.getByLabelText(/Claude 邀請連結/);
    const errorAlert = screen.getByRole('alert');

    expect(errorAlert.textContent).toContain('這個邀請代碼已經有人分享過了');
    expect(urlInput.compareDocumentPosition(errorAlert)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('ProviderPanel 分享失敗時捲到錯誤提示', () => {
  it('Given 沒有錯誤 When 錯誤新出現 Then 把錯誤提示捲進可視範圍', () => {
    const { rerender } = render(<ProviderPanel {...createPanelProps()} />);
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender(<ProviderPanel {...createPanelProps({ actionError: '這個邀請代碼已經有人分享過了' })} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('alert'));
  });

  it('Given 錯誤已顯示 When 父層因其他原因重新渲染 Then 不再捲動', () => {
    const props = createPanelProps({ actionError: '這個邀請代碼已經有人分享過了' });
    const { rerender } = render(<ProviderPanel {...props} />);
    scrollIntoView.mockClear();

    rerender(<ProviderPanel {...props} rawUrlInput="https://claude.ai/referral/other" />);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('Given 錯誤已顯示 When 錯誤內容改變 Then 再捲動一次', () => {
    const { rerender } = render(
      <ProviderPanel {...createPanelProps({ actionError: '這個邀請代碼已經有人分享過了' })} />
    );
    scrollIntoView.mockClear();

    rerender(<ProviderPanel {...createPanelProps({ actionError: '操作太頻繁，請稍後再試' })} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('Given 同一個錯誤被清除後再次出現 When 再次送出失敗 Then 再捲動一次', () => {
    const error = '這個邀請代碼已經有人分享過了';
    const { rerender } = render(<ProviderPanel {...createPanelProps({ actionError: error })} />);
    rerender(<ProviderPanel {...createPanelProps({ actionError: null })} />);
    scrollIntoView.mockClear();

    rerender(<ProviderPanel {...createPanelProps({ actionError: error })} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('Given 需要登入 When 有錯誤訊息 Then 不顯示也不捲動，交給登入引導', () => {
    render(
      <ProviderPanel {...createPanelProps({ actionError: '請先登入', isLoginRequired: true })} />
    );

    expect(screen.getByRole('region', { name: '登入引導提示' })).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

function createProviderMe(overrides?: {
  mySharedLinks?: MySharedLinkDto[];
  isProviderBlocked?: boolean;
}): MeDto {
  return {
    user: {
      id: 20,
      email: 'provider@claude-tw.dev',
      nickname: '小張',
      invalidRetryCount: 0,
      invalidLinkStrikeCount: 0,
      isProviderBlocked: overrides?.isProviderBlocked ?? false,
      hasPushSubscription: false,
      isEligibleForNewbieTrack: true,
      hasSharedLinks: (overrides?.mySharedLinks ?? []).length > 0,
    },
    myQueue: null,
    myConfirmedClaim: null,
    mySharedLinks: overrides?.mySharedLinks ?? [],
    vapidPublicKey: 'test-vapid-public-key',
    devLoginEnabled: false,
    googleClientId: 'test-google-client-id',
  };
}

describe('ProviderPanel 我的分享紀錄', () => {
  it('Given 尚未分享過連結 When 渲染 Then 顯示分享紀錄的空狀態提示', () => {
    render(<ProviderPanel {...createPanelProps({ me: createProviderMe() })} />);

    expect(screen.getByText(/尚未分享過邀請連結/)).not.toBeNull();
  });

  it('Given 已分享一組連結 When 渲染 Then 每個名額顯示序號、軌道、狀態，已確認的名額附上領取者與收到的感謝小卡', () => {
    const sharedLink: MySharedLinkDto = {
      id: 1,
      referralCode: 'rNFlbuU0OA',
      normalizedUrl: 'https://claude.ai/referral/rNFlbuU0OA',
      totalSlots: 3,
      createdAt: '2026-10-24T00:00:00.000Z',
      slots: [
        {
          id: 11,
          status: 'confirmed',
          track: 'newbie',
          receiverNickname: '小明',
          thankYouMessage: '謝謝好心版友分享！',
          confirmedAt: '2026-10-24T01:00:00.000Z',
        },
        {
          id: 12,
          status: 'available',
          track: 'community',
          receiverNickname: null,
          thankYouMessage: null,
          confirmedAt: null,
        },
        {
          id: 13,
          status: 'invalidated',
          track: 'newbie',
          receiverNickname: '阿華',
          thankYouMessage: null,
          confirmedAt: null,
        },
      ],
    };
    render(<ProviderPanel {...createPanelProps({ me: createProviderMe({ mySharedLinks: [sharedLink] }) })} />);

    expect(screen.queryByText(/尚未分享過邀請連結/)).toBeNull();
    expect(screen.getByText('https://claude.ai/referral/rNFlbuU0OA')).not.toBeNull();
    expect(screen.getByText('共 3 個名額')).not.toBeNull();

    const [confirmedSlot, availableSlot, invalidatedSlot] = screen
      .getAllByRole('listitem')
      .map((item) => within(item));
    expect(confirmedSlot!.getByText('名額 #1')).not.toBeNull();
    expect(confirmedSlot!.getByText('新手')).not.toBeNull();
    expect(confirmedSlot!.getByText('已成功啟用')).not.toBeNull();
    expect(confirmedSlot!.getByText('小明')).not.toBeNull();
    expect(confirmedSlot!.getByText('收到感謝小卡：「謝謝好心版友分享！」')).not.toBeNull();
    expect(availableSlot!.getByText('再領取')).not.toBeNull();
    expect(availableSlot!.getByText('等待排隊者中')).not.toBeNull();
    expect(availableSlot!.queryByText(/領取版友/)).toBeNull();
    expect(availableSlot!.queryByText(/收到感謝小卡/)).toBeNull();
    expect(invalidatedSlot!.getByText('被回報無效')).not.toBeNull();
    expect(invalidatedSlot!.queryByText(/收到感謝小卡/)).toBeNull();
  });
});

describe('ProviderPanel 被暫停提供權限的提供者', () => {
  it('Given 提供者因連結多次被回報無效而被暫停 When 渲染 Then 顯示暫停提示並且沒有分享表單', () => {
    render(<ProviderPanel {...createPanelProps({ me: createProviderMe({ isProviderBlocked: true }) })} />);

    expect(screen.getByText(/目前已暫停提供權限/)).not.toBeNull();
    expect(screen.queryByLabelText(/Claude 邀請連結/)).toBeNull();
    expect(screen.queryByRole('button', { name: '送出分享邀請連結' })).toBeNull();
  });
});

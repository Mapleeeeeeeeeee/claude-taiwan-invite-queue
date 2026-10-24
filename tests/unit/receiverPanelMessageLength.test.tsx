// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReceiverPanel, type ReceiverPanelProps } from '../../src/client/components/ReceiverPanel';

afterEach(cleanup);

function createPanelProps(thankYouMessageInput: string): ReceiverPanelProps {
  return {
    me: null,
    isSubmitting: false,
    actionError: null,
    isLoginRequired: false,
    nicknameInput: '阿明',
    thankYouMessageInput,
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
  };
}

describe('ReceiverPanel 感謝小卡字數以 Unicode 碼點計算', () => {
  it('輸入 200 個 emoji 時計數器顯示 200 / 200，送出按鈕仍可用', () => {
    render(<ReceiverPanel {...createPanelProps('😀'.repeat(200))} />);

    expect(screen.getByText('200 / 200')).not.toBeNull();
    const submitButton = screen.getByRole('button', { name: '使用 Google 帳號登入' });
    expect(submitButton.hasAttribute('disabled')).toBe(false);
  });

  it('輸入 201 個 emoji 時提示超過 1 字並停用送出按鈕', () => {
    render(<ReceiverPanel {...createPanelProps('😀'.repeat(201))} />);

    expect(screen.getByText(/已超過 1 字/)).not.toBeNull();
    const submitButton = screen.getByRole('button', { name: /字數超過 200 字上限/ });
    expect(submitButton.hasAttribute('disabled')).toBe(true);
  });
});

describe('ReceiverPanel 感謝小卡沒有可見字元', () => {
  it.each([
    { name: '5 個零寬空白', message: '\u200B'.repeat(5) },
    { name: '全是空白與換行', message: '     \n  ' },
  ])('輸入$name 時停用送出按鈕並提示需要可見文字', ({ message }) => {
    render(<ReceiverPanel {...createPanelProps(message)} />);

    const submitButton = screen.getByRole('button', { name: /感謝小卡需包含可見文字/ });
    expect(submitButton.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/請輸入至少一個可見字元/)).not.toBeNull();
  });

  it('輸入可見文字夾零寬字元時送出按鈕仍可用', () => {
    render(<ReceiverPanel {...createPanelProps('\u200B\u200B謝\u200B\u200B')} />);

    const submitButton = screen.getByRole('button', { name: '使用 Google 帳號登入' });
    expect(submitButton.hasAttribute('disabled')).toBe(false);
  });
});

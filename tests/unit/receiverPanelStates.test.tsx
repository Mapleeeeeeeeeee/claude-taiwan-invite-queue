// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_NICKNAME_LENGTH, type MeDto, type MyQueueEntryDto } from '../../src/shared/types';
import { ReceiverPanel, type ReceiverPanelProps } from '../../src/client/components/ReceiverPanel';

const NOW = new Date('2026-10-22T01:00:00.000Z');
const REFERRAL_URL = 'https://claude.ai/referral/rNFlbuU0OA';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

function createQueueEntry(overrides: Partial<MyQueueEntryDto>): MyQueueEntryDto {
  return {
    id: 1,
    status: 'waiting',
    track: 'newbie',
    queuePosition: null,
    thankYouMessage: '謝謝版友分享！',
    slotId: null,
    providerNickname: '小張',
    referralUrl: null,
    reserveExpiresAt: null,
    confirmExpiresAt: null,
    canReportInvalid: true,
    isRequeuedWithPriority: false,
    ...overrides,
  };
}

function createPanelProps(overrides?: Partial<ReceiverPanelProps>): ReceiverPanelProps {
  return {
    me: null,
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

function renderWithQueue(myQueue: MyQueueEntryDto, overrides?: Partial<ReceiverPanelProps>) {
  const props = createPanelProps({ me: createLoggedInMe({ myQueue }), ...overrides });
  const view = render(<ReceiverPanel {...props} />);
  return { props, ...view };
}

describe('ReceiverPanel 已保留名額（reserved）', () => {
  const reservedEntry = createQueueEntry({
    status: 'reserved',
    slotId: 9,
    reserveExpiresAt: '2026-10-22T07:00:00.000Z',
  });

  it('顯示提供者暱稱與保留倒數，且不顯示完整邀請連結', () => {
    renderWithQueue({ ...reservedEntry, referralUrl: null });

    const card = screen.getByTestId('queue-state-reserved');
    expect(within(card).getByText('小張')).not.toBeNull();
    expect(card.querySelector('.countdown-timer')!.textContent).toBe('06:00:00');
    expect(screen.queryByTestId('revealed-referral-url')).toBeNull();
  });

  it('提供者暱稱為空時改用「好心版友」', () => {
    renderWithQueue({ ...reservedEntry, providerNickname: null });

    expect(within(screen.getByTestId('queue-state-reserved')).getByText('好心版友')).not.toBeNull();
  });

  it('點擊解鎖按鈕時呼叫 onRevealSlot，點擊放棄按鈕時呼叫 onCancelQueue', () => {
    const { props } = renderWithQueue(reservedEntry);

    fireEvent.click(screen.getByRole('button', { name: /確認需要，解鎖查看邀請連結/ }));
    expect(props.onRevealSlot).toHaveBeenCalledTimes(1);
    expect(props.onCancelQueue).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '暫無需求，放棄名額留給下一位' }));
    expect(props.onCancelQueue).toHaveBeenCalledTimes(1);
  });

  it('送出中時解鎖與放棄按鈕都停用', () => {
    renderWithQueue(reservedEntry, { isSubmitting: true });

    expect(
      screen.getByRole('button', { name: /確認需要，解鎖查看邀請連結/ }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: '暫無需求，放棄名額留給下一位' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('保留倒數歸零時通知父層同步狀態', () => {
    const { props } = renderWithQueue({ ...reservedEntry, reserveExpiresAt: '2026-10-22T00:59:00.000Z' });

    expect(props.onCountdownExpire).toHaveBeenCalledTimes(1);
  });
});

describe('ReceiverPanel 已解鎖（revealed）', () => {
  const revealedEntry = createQueueEntry({
    status: 'revealed',
    slotId: 9,
    referralUrl: REFERRAL_URL,
    confirmExpiresAt: '2026-10-22T01:30:00.000Z',
    canReportInvalid: true,
  });

  it('顯示邀請連結、提供者暱稱與確認倒數，並提供前往啟用的外部連結', () => {
    renderWithQueue(revealedEntry);

    const card = screen.getByTestId('queue-state-revealed');
    expect(screen.getByTestId('revealed-referral-url').textContent).toBe(REFERRAL_URL);
    expect(within(card).getByText('小張')).not.toBeNull();
    expect(card.querySelector('.countdown-timer')!.textContent).toBe('30:00');
    const link = screen.getByRole('link', { name: '前往啟用連結' });
    expect(link.getAttribute('href')).toBe(REFERRAL_URL);
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('點擊複製按鈕時把邀請連結寫入剪貼簿，並暫時顯示「已複製連結」', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderWithQueue(revealedEntry);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /複製邀請連結/ }));
    });

    expect(writeText).toHaveBeenCalledWith(REFERRAL_URL);
    expect(screen.getByRole('button', { name: /已複製連結/ })).not.toBeNull();
  });

  it('點擊確認啟用時呼叫 onConfirmSlot', () => {
    const { props } = renderWithQueue(revealedEntry);

    fireEvent.click(screen.getByRole('button', { name: /確認啟用並送出感謝/ }));

    expect(props.onConfirmSlot).toHaveBeenCalledTimes(1);
  });

  it('送出中時確認啟用與回報無效按鈕都停用', () => {
    renderWithQueue(revealedEntry, { isSubmitting: true });

    expect(
      screen.getByRole('button', { name: /確認啟用並送出感謝/ }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: /邀請連結無效或已額滿/ }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('還有重排額度時，點擊「邀請連結無效或已額滿」只開啟確認，不直接回報', () => {
    const { props } = renderWithQueue(revealedEntry);

    fireEvent.click(screen.getByRole('button', { name: /邀請連結無效或已額滿/ }));

    expect(props.onOpenReportInvalidConfirm).toHaveBeenCalledTimes(1);
    expect(props.onReportSlotInvalid).not.toHaveBeenCalled();
  });

  it('重排額度用完時，只顯示停用的額度用完按鈕', () => {
    renderWithQueue({ ...revealedEntry, canReportInvalid: false });

    expect(screen.queryByRole('button', { name: /邀請連結無效或已額滿/ })).toBeNull();
    const exhaustedButton = screen.getByRole('button', { name: /已用完無效重排額度（限 1 次）/ });
    expect(exhaustedButton.hasAttribute('disabled')).toBe(true);
  });

  it('確認視窗未開啟時不渲染回報無效對話框', () => {
    renderWithQueue(revealedEntry, { isReportInvalidConfirmOpen: false });

    expect(screen.queryByRole('dialog', { name: '確認回報無效' })).toBeNull();
  });

  describe('回報無效確認視窗已開啟', () => {
    it('顯示警語；返回按鈕呼叫 onCloseReportInvalidConfirm，確定按鈕呼叫 onReportSlotInvalid', () => {
      const { props } = renderWithQueue(revealedEntry, { isReportInvalidConfirmOpen: true });

      const dialog = within(screen.getByRole('dialog', { name: '確認回報無效' }));
      expect(dialog.getByText('確定這組邀請連結無法使用嗎？')).not.toBeNull();
      expect(dialog.getByText(/每個帳號終身僅限使用 1 次無效重排機會/)).not.toBeNull();

      fireEvent.click(dialog.getByRole('button', { name: '返回再試一次' }));
      expect(props.onCloseReportInvalidConfirm).toHaveBeenCalledTimes(1);
      expect(props.onReportSlotInvalid).not.toHaveBeenCalled();

      fireEvent.click(dialog.getByRole('button', { name: '確定回報無效並優先重排' }));
      expect(props.onReportSlotInvalid).toHaveBeenCalledTimes(1);
    });

    // 瀏覽器在模態 <dialog> 上按 Escape 時，先對它觸發 cancel 事件，再關閉。
    it('按 Escape 時呼叫 onCloseReportInvalidConfirm，不回報無效', () => {
      const { props } = renderWithQueue(revealedEntry, { isReportInvalidConfirmOpen: true });

      fireEvent(
        screen.getByRole('dialog', { name: '確認回報無效' }),
        new Event('cancel', { cancelable: true }),
      );

      expect(props.onCloseReportInvalidConfirm).toHaveBeenCalledTimes(1);
      expect(props.onReportSlotInvalid).not.toHaveBeenCalled();
    });

    it('點擊視窗外圍（遮罩）時關閉，點擊卡片本身時不關閉', () => {
      const { props } = renderWithQueue(revealedEntry, { isReportInvalidConfirmOpen: true });
      const dialog = screen.getByRole('dialog', { name: '確認回報無效' });

      fireEvent.click(within(dialog).getByText('確定這組邀請連結無法使用嗎？'));
      expect(props.onCloseReportInvalidConfirm).not.toHaveBeenCalled();

      fireEvent.click(dialog);
      expect(props.onCloseReportInvalidConfirm).toHaveBeenCalledTimes(1);
    });

    it('送出中時兩個按鈕都停用', () => {
      renderWithQueue(revealedEntry, { isReportInvalidConfirmOpen: true, isSubmitting: true });

      const dialog = within(screen.getByRole('dialog', { name: '確認回報無效' }));
      expect(dialog.getByRole('button', { name: '返回再試一次' }).hasAttribute('disabled')).toBe(true);
      expect(
        dialog.getByRole('button', { name: '確定回報無效並優先重排' }).hasAttribute('disabled'),
      ).toBe(true);
    });
  });
});

describe('ReceiverPanel 排隊等待中取消排隊', () => {
  it('點擊取消排隊時呼叫 onCancelQueue；送出中時按鈕停用', () => {
    const waitingEntry = createQueueEntry({ status: 'waiting', queuePosition: 2 });
    const { props, rerender } = renderWithQueue(waitingEntry);

    fireEvent.click(screen.getByRole('button', { name: '取消排隊' }));
    expect(props.onCancelQueue).toHaveBeenCalledTimes(1);

    rerender(<ReceiverPanel {...props} isSubmitting />);
    expect(screen.getByRole('button', { name: '取消排隊' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('ReceiverPanel 領取歷史卡', () => {
  const confirmedClaim = createQueueEntry({
    status: 'confirmed',
    slotId: 55,
    providerNickname: '小張',
    referralUrl: REFERRAL_URL,
    thankYouMessage: '謝謝小張版友熱情分享！祝順心！',
  });

  function renderHistory(claim: MyQueueEntryDto) {
    render(<ReceiverPanel {...createPanelProps({ me: createLoggedInMe({ myConfirmedClaim: claim }) })} />);
  }

  it('預設收合，點擊摘要列後展開邀請連結與感謝小卡，再點一次收合', () => {
    renderHistory(confirmedClaim);
    const summaryBar = screen.getByRole('button', { name: /已成功啟用試用名額/ });

    expect(summaryBar.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(REFERRAL_URL)).toBeNull();

    fireEvent.click(summaryBar);
    expect(summaryBar.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(REFERRAL_URL)).not.toBeNull();
    expect(screen.getByText('送給 小張 的感謝小卡：')).not.toBeNull();
    expect(screen.getByText('「謝謝小張版友熱情分享！祝順心！」')).not.toBeNull();

    fireEvent.click(summaryBar);
    expect(screen.queryByText(REFERRAL_URL)).toBeNull();
  });

  it('提供者暱稱為空時，摘要列用「好心版友」，感謝小卡收件人用「提供者」', () => {
    renderHistory({ ...confirmedClaim, providerNickname: null });

    expect(within(screen.getByTestId('claim-history-card')).getByText('好心版友')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /已成功啟用試用名額/ }));
    expect(screen.getByText('送給 提供者 的感謝小卡：')).not.toBeNull();
  });

  it('沒有邀請連結備查時，展開後只顯示感謝小卡', () => {
    renderHistory({ ...confirmedClaim, referralUrl: null });

    fireEvent.click(screen.getByRole('button', { name: /已成功啟用試用名額/ }));

    expect(screen.queryByText(/邀請連結備查/)).toBeNull();
    expect(screen.getByText('「謝謝小張版友熱情分享！祝順心！」')).not.toBeNull();
  });

  it('點擊複製按鈕時把備查邀請連結寫入剪貼簿', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderHistory(confirmedClaim);
    fireEvent.click(screen.getByRole('button', { name: /已成功啟用試用名額/ }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /複製邀請連結/ }));
    });

    expect(writeText).toHaveBeenCalledWith(REFERRAL_URL);
  });
});

describe('ReceiverPanel 加入排隊表單', () => {
  function renderForm(overrides?: Partial<ReceiverPanelProps>) {
    const props = createPanelProps(overrides);
    render(<ReceiverPanel {...props} />);
    return props;
  }

  it('已登入且訊息合法時送出，呼叫 onJoinQueue 而不要求登入', () => {
    const props = renderForm({ me: createLoggedInMe() });

    fireEvent.click(screen.getByRole('button', { name: '加入排隊領取邀請連結' }));

    expect(props.onJoinQueue).toHaveBeenCalledTimes(1);
    expect(props.onRequireLogin).not.toHaveBeenCalled();
  });

  it('未登入時送出，改呼叫 onRequireLogin 而不排隊', () => {
    const props = renderForm({ me: null });

    fireEvent.click(screen.getByRole('button', { name: '使用 Google 帳號登入' }));

    expect(props.onRequireLogin).toHaveBeenCalledTimes(1);
    expect(props.onJoinQueue).not.toHaveBeenCalled();
  });

  it('送出中時送出按鈕停用', () => {
    renderForm({ me: createLoggedInMe(), isSubmitting: true });

    expect(
      screen.getByRole('button', { name: '加入排隊領取邀請連結' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('暱稱與感謝小卡輸入框回報變更給父層', () => {
    const props = renderForm({ me: createLoggedInMe() });

    fireEvent.change(screen.getByLabelText('你的顯示暱稱'), { target: { value: '阿華' } });
    fireEvent.change(screen.getByLabelText(/給提供者的感謝小卡/), { target: { value: '多謝' } });

    expect(props.onNicknameChange).toHaveBeenCalledWith('阿華');
    expect(props.onThankYouMessageChange).toHaveBeenCalledWith('多謝');
  });

  it('暱稱輸入框限制最大長度，感謝小卡為必填', () => {
    renderForm({ me: createLoggedInMe() });

    expect(screen.getByLabelText('你的顯示暱稱').getAttribute('maxlength')).toBe(
      String(MAX_NICKNAME_LENGTH),
    );
    expect(screen.getByLabelText(/給提供者的感謝小卡/).hasAttribute('required')).toBe(true);
  });

  it('排隊狀態為 expired 時，表單上方提示名額保留已逾時', () => {
    render(
      <ReceiverPanel
        {...createPanelProps({
          me: createLoggedInMe({ myQueue: createQueueEntry({ status: 'expired' }) }),
        })}
      />,
    );

    expect(screen.getByText(/名額保留已逾時，已讓給下一位版友/)).not.toBeNull();
    expect(screen.getByRole('button', { name: '加入排隊領取邀請連結' })).not.toBeNull();
  });

  it('沒有逾時紀錄時不顯示逾時提示', () => {
    renderForm({ me: createLoggedInMe() });

    expect(screen.queryByText(/名額保留已逾時/)).toBeNull();
  });
});

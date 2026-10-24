import { vi } from 'vitest';
import type { MeDto } from '../../src/shared/types';
import type { ReceiverPanelProps } from '../../src/client/components/ReceiverPanel';

export function createLoggedInMe(overrides?: Partial<MeDto>): MeDto {
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

/** 未登入、尚未排隊的 ReceiverPanel props，各測試用 overrides 改出自己要的狀態。 */
export function createPanelProps(overrides?: Partial<ReceiverPanelProps>): ReceiverPanelProps {
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

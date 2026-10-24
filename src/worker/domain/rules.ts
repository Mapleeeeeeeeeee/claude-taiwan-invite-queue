import { MAX_INVALID_RETRY_COUNT, type SlotStatus } from '../../shared/types';

interface NormalizedReferralLink {
  referralCode: string;
  normalizedUrl: string;
}

const CLAUDE_REFERRAL_BASE_URL = 'https://claude.ai/referral/';
const PROVIDER_BLOCK_STRIKE_THRESHOLD = 2;

/** 新加入排隊的預設優先權；回報無效而重排的紀錄優先權高於此值。 */
export const DEFAULT_QUEUE_PRIORITY = 0;

const CLAUDE_REFERRAL_URL_PATTERN =
  /https?:\/\/(?:www\.)?claude\.ai\/referral\/([A-Za-z0-9_-]+)(?:\/)?(?=[?#\s]|$|[^A-Za-z0-9_/-])/i;

/**
 * Extracts the referral code from raw user input (which may contain surrounding text or query parameters)
 * and returns the normalized URL `https://claude.ai/referral/<referralCode>`.
 * Returns `null` if no valid Claude referral URL is present.
 */
export function extractAndNormalizeReferralLink(rawInput: string): NormalizedReferralLink | null {
  const trimmedInput = rawInput.trim();
  if (!trimmedInput) {
    return null;
  }

  const match = CLAUDE_REFERRAL_URL_PATTERN.exec(trimmedInput);
  if (!match || !match[1]) {
    return null;
  }

  const referralCode = match[1];
  return {
    referralCode,
    normalizedUrl: `${CLAUDE_REFERRAL_BASE_URL}${referralCode}`,
  };
}

/**
 * Determines whether an invite link counts as a "completely invalid link" (完全無效連結).
 * Returns `true` only when all slots have reached a terminal state (none are 'available', 'reserved', or 'revealed'),
 * zero slots are 'confirmed', and at least one slot is 'invalidated'.
 */
export function isCompletelyInvalidLink(slotStatuses: SlotStatus[]): boolean {
  if (slotStatuses.length === 0) {
    return false;
  }

  const hasActiveSlot = slotStatuses.some(
    (status) => status === 'available' || status === 'reserved' || status === 'revealed'
  );
  if (hasActiveSlot) {
    return false;
  }

  const hasConfirmedSlot = slotStatuses.some((status) => status === 'confirmed');
  if (hasConfirmedSlot) {
    return false;
  }

  return slotStatuses.some((status) => status === 'invalidated');
}

/**
 * 新手軌只開放給「尚未用過試用、也沒有分享過邀請連結」的使用者：
 * 任何軌道上有已確認啟用的領取紀錄，或曾分享過邀請連結，都不具資格。
 */
export function isEligibleForNewbieTrack(params: {
  hasConfirmedClaim: boolean;
  hasSharedLinks: boolean;
}): boolean {
  return !params.hasConfirmedClaim && !params.hasSharedLinks;
}

export function isProviderBlocked(completelyInvalidLinkCount: number): boolean {
  return completelyInvalidLinkCount >= PROVIDER_BLOCK_STRIKE_THRESHOLD;
}

export function canUserReportInvalid(params: {
  slotStatus: SlotStatus;
  invalidRetryCount: number;
  confirmExpiresAtIso: string | null;
  nowIso: string;
}): boolean {
  if (params.slotStatus !== 'revealed') {
    return false;
  }

  if (params.invalidRetryCount >= MAX_INVALID_RETRY_COUNT) {
    return false;
  }

  if (!params.confirmExpiresAtIso) {
    return false;
  }

  const expiresAtMs = Date.parse(params.confirmExpiresAtIso);
  const nowMs = Date.parse(params.nowIso);
  if (Number.isNaN(expiresAtMs) || Number.isNaN(nowMs)) {
    return false;
  }

  return nowMs < expiresAtMs;
}

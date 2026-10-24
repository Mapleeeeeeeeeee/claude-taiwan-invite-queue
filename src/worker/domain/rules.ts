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
 * 從使用者貼上的內容（可能夾雜其他文字或網址參數）取出邀請代碼，
 * 並回傳正規化網址 `https://claude.ai/referral/<referralCode>`。
 * 內容裡沒有合法的 Claude 邀請連結時回傳 `null`。
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
 * 判斷邀請連結是否為完全無效連結：所有名額都已結束（沒有 `available`、`reserved`、`revealed`），
 * 沒有任何 `confirmed`，且至少有一個 `invalidated`。名額清單為空時回傳 `false`。
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
 * 任一軌道有 `confirmed` 的領取紀錄，或曾分享過邀請連結，都不具新手軌資格。
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

import { describe, expect, it } from 'vitest';
import {
  canUserReportInvalid,
  extractAndNormalizeReferralLink,
  isCompletelyInvalidLink,
  isEligibleForNewbieTrack,
  isProviderBlocked,
} from '../../src/worker/domain/rules';

describe('extractAndNormalizeReferralLink', () => {
  it('能從帶有 query 參數（如 ?s=ios）的網址中精準擷取邀請代碼並正規化', () => {
    const result = extractAndNormalizeReferralLink('https://claude.ai/referral/rNFlbuU0OA?s=ios');
    expect(result).toEqual({
      referralCode: 'rNFlbuU0OA',
      normalizedUrl: 'https://claude.ai/referral/rNFlbuU0OA',
    });
  });

  it('能從夾雜在中文句子中的字串擷取正規邀請連結與代碼', () => {
    const result = extractAndNormalizeReferralLink(
      '這是我的邀請碼 https://claude.ai/referral/rNFlbuU0OA?s=ios 拿去用吧'
    );
    expect(result).toEqual({
      referralCode: 'rNFlbuU0OA',
      normalizedUrl: 'https://claude.ai/referral/rNFlbuU0OA',
    });
  });

  it('能從緊鄰中文且未帶空格的文字中精準擷取邀請代碼', () => {
    const result = extractAndNormalizeReferralLink(
      '分享邀請碼：https://claude.ai/referral/AbC-123_xyz請慢用'
    );
    expect(result).toEqual({
      referralCode: 'AbC-123_xyz',
      normalizedUrl: 'https://claude.ai/referral/AbC-123_xyz',
    });
  });

  it('輸入非 Claude 官方邀請連結或空白字串時回傳 null', () => {
    expect(extractAndNormalizeReferralLink('')).toBeNull();
    expect(extractAndNormalizeReferralLink('   ')).toBeNull();
    expect(extractAndNormalizeReferralLink('https://claude.ai/chats')).toBeNull();
    expect(extractAndNormalizeReferralLink('https://example.com/referral/rNFlbuU0OA')).toBeNull();
    expect(extractAndNormalizeReferralLink('https://claude.ai/referral/')).toBeNull();
    expect(extractAndNormalizeReferralLink('https://claude.ai/referral/abc/extra')).toBeNull();
  });
});

describe('isCompletelyInvalidLink & isProviderBlocked', () => {
  it('好心人保護：只要有任一名額成功啟用，即使其他名額被回報無效亦不判定為完全無效連結', () => {
    expect(isCompletelyInvalidLink(['confirmed', 'confirmed', 'invalidated'])).toBe(false);
    expect(isCompletelyInvalidLink(['confirmed', 'invalidated', 'closed'])).toBe(false);
  });

  it('名額仍處於進行中（可領取、保留中或解鎖看碼中）時不判定為完全無效連結', () => {
    expect(isCompletelyInvalidLink(['invalidated', 'available', 'available'])).toBe(false);
    expect(isCompletelyInvalidLink(['invalidated', 'reserved', 'closed'])).toBe(false);
    expect(isCompletelyInvalidLink(['invalidated', 'revealed', 'closed'])).toBe(false);
    expect(isCompletelyInvalidLink([])).toBe(false);
  });

  it('當名額全數結束且 0 人成功啟用、至少 1 人回報無效時，判定為完全無效連結', () => {
    expect(isCompletelyInvalidLink(['invalidated', 'closed', 'closed'])).toBe(true);
    expect(isCompletelyInvalidLink(['invalidated'])).toBe(true);
    expect(isCompletelyInvalidLink(['invalidated', 'invalidated'])).toBe(true);
  });

  it('提供者累計達到 2 組以上完全無效連結時判定為停權，未達 2 組前正常', () => {
    expect(isProviderBlocked(0)).toBe(false);
    expect(isProviderBlocked(1)).toBe(false);
    expect(isProviderBlocked(2)).toBe(true);
    expect(isProviderBlocked(3)).toBe(true);
  });
});

describe('isEligibleForNewbieTrack', () => {
  it.each([
    { 情境: '沒有任何已確認領取紀錄且未分享過連結', hasConfirmedClaim: false, hasSharedLinks: false, expected: true },
    { 情境: '在任一軌道有已確認的領取紀錄', hasConfirmedClaim: true, hasSharedLinks: false, expected: false },
    { 情境: '曾分享過邀請連結', hasConfirmedClaim: false, hasSharedLinks: true, expected: false },
    { 情境: '既領取過又分享過', hasConfirmedClaim: true, hasSharedLinks: true, expected: false },
  ])('使用者$情境時，新手軌資格為 $expected', ({ hasConfirmedClaim, hasSharedLinks, expected }) => {
    expect(isEligibleForNewbieTrack({ hasConfirmedClaim, hasSharedLinks })).toBe(expected);
  });
});

describe('canUserReportInvalid', () => {
  const baseNowIso = '2026-10-21T10:15:00.000Z';
  const validExpiresIso = '2026-10-21T10:30:00.000Z';

  it('名額已解鎖看碼、在 30 分鐘確認窗口內且尚未用過重排額度時，允許回報無效', () => {
    expect(
      canUserReportInvalid({
        slotStatus: 'revealed',
        invalidRetryCount: 0,
        confirmExpiresAtIso: validExpiresIso,
        nowIso: baseNowIso,
      })
    ).toBe(true);

    expect(
      canUserReportInvalid({
        slotStatus: 'revealed',
        invalidRetryCount: 0,
        confirmExpiresAtIso: validExpiresIso,
        nowIso: '2026-10-21T10:29:59.000Z',
      })
    ).toBe(true);

    // 剛好到達或超過截止時間時，已進入逾時自動確認階段，禁止回報無效
    expect(
      canUserReportInvalid({
        slotStatus: 'revealed',
        invalidRetryCount: 0,
        confirmExpiresAtIso: validExpiresIso,
        nowIso: validExpiresIso,
      })
    ).toBe(false);
  });

  it('領取者已使用過終身 1 次重排額度時，禁止回報無效', () => {
    expect(
      canUserReportInvalid({
        slotStatus: 'revealed',
        invalidRetryCount: 1,
        confirmExpiresAtIso: validExpiresIso,
        nowIso: baseNowIso,
      })
    ).toBe(false);
  });

  it('超過 30 分鐘確認窗口或截止時間為空時，禁止回報無效', () => {
    expect(
      canUserReportInvalid({
        slotStatus: 'revealed',
        invalidRetryCount: 0,
        confirmExpiresAtIso: validExpiresIso,
        nowIso: '2026-10-21T10:30:01.000Z',
      })
    ).toBe(false);

    expect(
      canUserReportInvalid({
        slotStatus: 'revealed',
        invalidRetryCount: 0,
        confirmExpiresAtIso: null,
        nowIso: baseNowIso,
      })
    ).toBe(false);
  });

  it('名額非處於已解鎖狀態（如保留中或已確認）時，禁止回報無效', () => {
    expect(
      canUserReportInvalid({
        slotStatus: 'reserved',
        invalidRetryCount: 0,
        confirmExpiresAtIso: validExpiresIso,
        nowIso: baseNowIso,
      })
    ).toBe(false);

    expect(
      canUserReportInvalid({
        slotStatus: 'confirmed',
        invalidRetryCount: 0,
        confirmExpiresAtIso: validExpiresIso,
        nowIso: baseNowIso,
      })
    ).toBe(false);
  });
});

import {
  CONFIRM_DURATION_MINUTES,
  CONFIRM_DURATION_MS,
  MAX_INVALID_RETRY_COUNT,
  RESERVATION_DURATION_HOURS,
  RESERVATION_DURATION_MS,
  type JoinQueueResult,
  type QueueStatus,
  type QueueTrack,
  type ReportSlotInvalidResult,
  type RevealSlotResult,
  type SlotCount,
  type SubmitLinkResult,
} from '../../shared/types';
import {
  canUserReportInvalid,
  extractAndNormalizeReferralLink,
  isCompletelyInvalidLink,
  isEligibleForNewbieTrack,
  isProviderBlocked,
} from '../domain/rules';
import {
  type MatchAssignment,
  matchTicketsToAvailableSlots,
  slotTracksMatchableBy,
} from '../domain/matchingEngine';
import { AppError } from '../errors';
import { logInfo, logWarn } from '../logger';
import {
  type InviteQueueRepository,
  type SlotConfirmationPushContext,
  createAlreadyInQueueError,
} from '../repositories/inviteQueueRepository';
import type { UserRepository } from '../repositories/userRepository';
import type { PushNotificationPayload, WebPushService } from './webPushService';

export interface SubmitLinkInput {
  userId: number;
  nickname?: string;
  rawUrlInput: string;
  slotCount: SlotCount;
  track: QueueTrack;
  now?: Date;
}

export interface JoinQueueInput {
  userId: number;
  nickname?: string;
  thankYouMessage: string;
  /** 省略時依新手資格自動分軌：具資格排 `newbie`，不具資格排 `community`。 */
  track?: QueueTrack;
  now?: Date;
}

// 每個可用席次最多只會碰到一張「提供者自己的票」要跳過，所以每軌取席次數的兩倍，就不會因跳過而漏配。
const MATCHING_CANDIDATES_PER_SLOT = 2;

// 一輪配對被 guard 拒絕，代表讀到的席次或號碼牌已被別的請求配走，要重讀再配。
// 壓力測試把上限降到 1 輪（不重讀）時多數交錯順序會失敗，所以重讀是必要的；
// 上限 5 是避免異常資料下無限迴圈的保險，不是實測出來的收斂輪數。
// 超過上限時剩下的席次留給下一次觸發或每 5 分鐘的排程。
const MAX_MATCHING_ROUNDS = 5;

const CLAIMED_NEWBIE_TRACK_MESSAGE =
  '你已成功領取過新手體驗名額囉！若欲為第二個帳號領取，請選擇「再領取」軌道';
const SHARED_NEWBIE_TRACK_MESSAGE =
  '感謝你熱心分享邀請碼！新手名額請優先保留給首次體驗的版友，若欲領取請選擇「再領取」軌道';
const CLAIMED_AND_SHARED_NEWBIE_TRACK_MESSAGE =
  '你已成功領取過新手體驗名額囉！你也分享過邀請連結，新手名額請優先保留給首次體驗的版友。若欲為第二個帳號領取，請選擇「再領取」軌道';

const queueEntryNotFoundError = () =>
  new AppError('QUEUE_ENTRY_NOT_FOUND', '找不到進行中的排隊紀錄', 404);
const slotDataMissingError = () =>
  new AppError('INTERNAL_ERROR', '找不到對應的邀請名額資料', 500);
const cannotCancelError = () =>
  new AppError('INVALID_STATE_TRANSITION', '目前的狀態無法取消排隊', 409);
const reservationExpiredError = () =>
  new AppError('RESERVATION_EXPIRED', '名額保留已逾時，若仍需要請重新加入排隊', 409);
const noRevealedSlotToConfirmError = () =>
  new AppError('INVALID_STATE_TRANSITION', '目前沒有待確認的已解鎖名額', 409);

/** 把一件不必等它完成就能回應請求的工作交給執行環境，例如 Workers 的 `ctx.waitUntil`。 */
export type RunInBackground = (task: Promise<unknown>) => void;

export class InviteQueueService {
  /**
   * @param runInBackground 推播送出的方式。有注入時，推播交給它在回應之後繼續送；
   *   沒注入時（單元與整合測試）就地 await，讓測試可以確定性地斷言推播內容。
   * @param onSlotConfirmed 席次被確認（手動或逾時自動）後呼叫，要連累計已領取數的快取一起清；
   *   這時不再另外呼叫 `onBoardChanged`，所以它必須也清掉看板快取。
   */
  constructor(
    private readonly repo: InviteQueueRepository,
    private readonly userRepo: UserRepository,
    private readonly pushService: WebPushService,
    private readonly onBoardChanged?: () => void,
    private readonly onSlotConfirmed?: () => void,
    private readonly runInBackground?: RunInBackground
  ) {}

  async submitInviteLink(
    input: SubmitLinkInput
  ): Promise<SubmitLinkResult> {
    const normalized = extractAndNormalizeReferralLink(input.rawUrlInput);
    if (!normalized) {
      throw new AppError(
        'INVALID_REFERRAL_URL',
        '請貼上正確的 Claude 邀請連結（格式如 https://claude.ai/referral/...）',
        400
      );
    }

    const now = input.now ?? new Date();
    const nowIso = now.toISOString();

    await this.processExpirations(now);

    // 提供者的違規計數在每次名額狀態改變時就已同步，這裡直接讀，不重算。
    const provider = await this.userRepo.findUserById(input.userId);
    if (!provider) {
      throw new AppError('UNAUTHORIZED', '請先使用 Google 帳號登入', 401);
    }
    if (isProviderBlocked(provider.invalidLinkStrikeCount)) {
      throw new AppError(
        'PROVIDER_BLOCKED',
        '由於先前提供的連結多次被回報無效，目前已暫停提供權限',
        403
      );
    }

    // 邀請代碼重複由 repository 的 unique 違反轉成 DUPLICATE_REFERRAL_CODE。
    const { linkId } = await this.repo.createLinkWithSlots({
      providerUserId: input.userId,
      referralCode: normalized.referralCode,
      normalizedUrl: normalized.normalizedUrl,
      slotCount: input.slotCount,
      track: input.track,
      nowIso,
    });

    await this.updateNicknameIfProvided(input.userId, input.nickname);

    const assignments = await this.matchAvailableSlotsToQueue(now);
    const matchedCount = assignments.filter(({ slot }) => slot.linkId === linkId).length;
    this.onBoardChanged?.();

    logInfo('link.submitted', {
      userId: input.userId,
      linkId,
      slotCount: input.slotCount,
      track: input.track,
      matchedCount,
    });

    return { linkId, matchedCount };
  }

  /**
   * 加入排隊並嘗試立即配對。
   *
   * 回傳的 `status` 是本請求結束時觀察到的狀態：交錯的請求可能在之後才把這張票配走，
   * 此時仍回 `waiting`。最終狀態以 `GET /api/me` 為準。
   */
  async joinQueue(
    input: JoinQueueInput
  ): Promise<JoinQueueResult> {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();

    await this.processExpirations(now);

    const track = await this.resolveJoinTrack(input.userId, input.track);

    // 重複排隊由 repository 的 unique 違反轉成 ALREADY_IN_QUEUE。
    const queueEntryId = await this.repo.createQueueEntry({
      userId: input.userId,
      thankYouMessage: input.thankYouMessage,
      track,
      nowIso,
    });

    await this.updateNicknameIfProvided(input.userId, input.nickname);

    const assignments = await this.matchAvailableSlotsToQueue(now);
    this.onBoardChanged?.();

    const finalStatus = wasTicketAssigned(assignments, queueEntryId) ? 'reserved' : 'waiting';
    logInfo('queue.joined', {
      userId: input.userId,
      queueEntryId,
      status: finalStatus,
    });

    return {
      queueEntryId,
      status: finalStatus,
    };
  }

  async cancelQueue(userId: number, now = new Date()): Promise<void> {
    const nowIso = now.toISOString();

    await this.processExpirations(now);

    const latestEntry = await this.requireLatestQueueEntry(userId);

    if (latestEntry.status === 'waiting') {
      const cancelled = await this.repo.cancelWaitingQueueEntry(latestEntry.id, nowIso);
      if (!cancelled) {
        throw cannotCancelError();
      }
      this.onBoardChanged?.();
      logInfo('queue.cancelled', {
        userId,
        queueEntryId: latestEntry.id,
        previousStatus: 'waiting',
      });
      return;
    }

    if (latestEntry.status === 'reserved' && latestEntry.slotId !== null) {
      const slotWithLink = await this.repo.findSlotWithLinkById(latestEntry.slotId);
      const cancelled = await this.repo.cancelReservedQueueEntryAndReleaseSlot(
        latestEntry.id,
        latestEntry.slotId,
        nowIso
      );
      if (!cancelled) {
        throw cannotCancelError();
      }
      if (slotWithLink) {
        await this.syncProviderStrikeCount(slotWithLink.providerUserId);
      }
      await this.matchAvailableSlotsToQueue(now);
      this.onBoardChanged?.();
      logInfo('queue.cancelled', {
        userId,
        queueEntryId: latestEntry.id,
        slotId: latestEntry.slotId,
        previousStatus: 'reserved',
      });
      return;
    }

    throw cannotCancelError();
  }

  async revealSlot(
    userId: number,
    now = new Date()
  ): Promise<RevealSlotResult> {
    const nowIso = now.toISOString();

    await this.processExpirations(now);

    const latestEntry = await this.requireLatestQueueEntry(userId);

    if (latestEntry.status === 'expired') {
      throw reservationExpiredError();
    }

    if (latestEntry.status === 'revealed' && latestEntry.slotId !== null) {
      return this.fetchRevealedSlotResult(latestEntry.slotId, latestEntry.confirmExpiresAt);
    }

    if (latestEntry.status !== 'reserved' || latestEntry.slotId === null) {
      throw new AppError('INVALID_STATE_TRANSITION', '目前沒有可解鎖的保留名額', 409);
    }

    const confirmExpiresAtIso = new Date(now.getTime() + CONFIRM_DURATION_MS).toISOString();

    const revealed = await this.repo.revealReservedSlot({
      slotId: latestEntry.slotId,
      queueEntryId: latestEntry.id,
      userId,
      nowIso,
      confirmExpiresAtIso,
    });

    if (!revealed) {
      // 同一位使用者並發重送時，輸的請求要照循序重送的方式冪等回傳，只有保留真的失效才回逾時。
      const reloadedEntry = await this.repo.findLatestQueueEntryByUser(userId);
      if (reloadedEntry?.status === 'revealed' && reloadedEntry.slotId === latestEntry.slotId) {
        return this.fetchRevealedSlotResult(reloadedEntry.slotId, reloadedEntry.confirmExpiresAt);
      }
      throw reservationExpiredError();
    }

    const result = await this.fetchRevealedSlotResult(latestEntry.slotId, confirmExpiresAtIso);

    logInfo('slot.revealed', {
      userId,
      slotId: latestEntry.slotId,
      queueEntryId: latestEntry.id,
      confirmExpiresAt: confirmExpiresAtIso,
    });

    return result;
  }

  async confirmSlot(userId: number, now = new Date()): Promise<void> {
    const nowIso = now.toISOString();

    const latestEntry = await this.requireLatestQueueEntry(userId);

    if (latestEntry.status === 'confirmed') {
      return;
    }

    if (latestEntry.status !== 'revealed' || latestEntry.slotId === null) {
      throw noRevealedSlotToConfirmError();
    }

    const confirmed = await this.repo.confirmRevealedSlot({
      slotId: latestEntry.slotId,
      queueEntryId: latestEntry.id,
      nowIso,
    });

    if (!confirmed) {
      // 輸給自動確認時紀錄已是 confirmed，照冪等回成功；輸給回報無效時紀錄已回到 waiting，不能回成功。
      const reloadedEntry = await this.repo.findLatestQueueEntryByUser(userId);
      if (reloadedEntry?.status === 'confirmed') {
        return;
      }
      throw noRevealedSlotToConfirmError();
    }

    logInfo('slot.confirmed', {
      userId,
      slotId: latestEntry.slotId,
      queueEntryId: latestEntry.id,
      trigger: 'manual',
    });

    await this.notifyProviderOnSlotConfirmed(latestEntry.slotId, latestEntry.id);
    this.onSlotConfirmed?.();
  }

  async reportSlotInvalid(
    userId: number,
    now = new Date()
  ): Promise<ReportSlotInvalidResult> {
    const nowIso = now.toISOString();

    await this.processExpirations(now);

    const [user, latestEntry] = await Promise.all([
      this.userRepo.findUserById(userId),
      this.repo.findLatestQueueEntryByUser(userId),
    ]);
    if (!user || !latestEntry) {
      throw queueEntryNotFoundError();
    }

    if (latestEntry.status === 'confirmed') {
      throw new AppError(
        'CONFIRM_WINDOW_EXPIRED',
        '此名額已完成啟用與感謝回饋，無法再變更狀態',
        409
      );
    }

    if (user.invalidRetryCount >= MAX_INVALID_RETRY_COUNT) {
      throw new AppError(
        'RETRY_QUOTA_EXHAUSTED',
        `每個帳號僅限使用 ${MAX_INVALID_RETRY_COUNT} 次無效重排機會`,
        409
      );
    }

    if (latestEntry.status !== 'revealed' || latestEntry.slotId === null) {
      throw new AppError('INVALID_STATE_TRANSITION', '目前的狀態無法回報無效', 409);
    }

    const slotWithLink = await this.repo.findSlotWithLinkById(latestEntry.slotId);
    if (!slotWithLink) {
      throw slotDataMissingError();
    }

    const allowed = canUserReportInvalid({
      slotStatus: slotWithLink.slot.status,
      invalidRetryCount: user.invalidRetryCount,
      confirmExpiresAtIso: latestEntry.confirmExpiresAt,
      nowIso,
    });

    if (!allowed) {
      throw new AppError(
        'CONFIRM_WINDOW_EXPIRED',
        `已超過 ${CONFIRM_DURATION_MINUTES} 分鐘回報期限或不符合重排資格`,
        409
      );
    }

    const updated = await this.repo.reportInvalidAndRequeue({
      slotId: slotWithLink.slot.id,
      linkId: slotWithLink.slot.linkId,
      queueEntryId: latestEntry.id,
      userId,
      nowIso,
    });

    if (!updated) {
      throw new AppError('INVALID_STATE_TRANSITION', '回報無效失敗，請重試', 409);
    }

    const newStrikeCount = await this.syncProviderStrikeCount(slotWithLink.providerUserId);
    if (isProviderBlocked(newStrikeCount)) {
      logWarn('provider.blocked', {
        providerUserId: slotWithLink.providerUserId,
        strikeCount: newStrikeCount,
      });
    }
    const assignments = await this.matchAvailableSlotsToQueue(now);
    this.onBoardChanged?.();

    const requeuedStatus = wasTicketAssigned(assignments, latestEntry.id) ? 'reserved' : 'waiting';
    logWarn('slot.reported_invalid', {
      userId,
      slotId: slotWithLink.slot.id,
      linkId: slotWithLink.slot.linkId,
      providerUserId: slotWithLink.providerUserId,
      requeuedStatus,
    });

    return {
      requeuedStatus,
    };
  }

  async processExpirations(
    now = new Date()
  ): Promise<{ expiredReservations: number; autoConfirmedSlots: number }> {
    const nowIso = now.toISOString();

    // 同一位提供者名下多個名額同時逾時，只需要在最後重算一次違規計數。
    const affectedProviderIds = new Set<number>();

    const [expiredReservedList, expiredRevealedList] = await Promise.all([
      this.repo.fetchExpiredReservations(nowIso),
      this.repo.fetchExpiredRevealedSlots(nowIso),
    ]);

    let expiredReservations = 0;
    for (const item of expiredReservedList) {
      const expired = await this.repo.expireReservationAndReleaseSlot({
        queueEntryId: item.queueEntryId,
        slotId: item.slotId,
        nowIso,
      });
      if (expired) {
        expiredReservations += 1;
        affectedProviderIds.add(item.providerUserId);
        logInfo('slot.reservation_expired', {
          userId: item.userId,
          slotId: item.slotId,
          queueEntryId: item.queueEntryId,
        });
      }
    }

    // 確認一筆就立刻通知提供者。後面的違規計數重算與配對若丟錯，這筆已確認的紀錄不會再被掃到，通知就補不回來。
    let autoConfirmedSlots = 0;
    for (const item of expiredRevealedList) {
      const confirmed = await this.repo.confirmRevealedSlot({
        slotId: item.slotId,
        queueEntryId: item.queueEntryId,
        nowIso,
      });
      if (confirmed) {
        autoConfirmedSlots += 1;
        affectedProviderIds.add(item.providerUserId);
        logInfo('slot.confirmed', {
          userId: item.userId,
          slotId: item.slotId,
          queueEntryId: item.queueEntryId,
          trigger: 'auto_confirm_timeout',
        });
        await this.notifyProviderOfConfirmation(item);
      }
    }

    await Promise.all([...affectedProviderIds].map((id) => this.syncProviderStrikeCount(id)));

    if (expiredReservations > 0) {
      await this.matchAvailableSlotsToQueue(now);
    }

    if (autoConfirmedSlots > 0) {
      this.onSlotConfirmed?.();
    } else if (expiredReservations > 0) {
      this.onBoardChanged?.();
    }

    return { expiredReservations, autoConfirmedSlots };
  }

  /**
   * 決定這次排隊的軌道。明確要求 `community` 時不檢查資格；省略時依資格自動分軌；
   * 明確要求 `newbie` 但不具資格時拒絕。
   * 已在排隊中的人一律先收到 ALREADY_IN_QUEUE，所以拒絕前要先確認這一點，與 createQueueEntry 的 unique 檢查順序一致。
   */
  private async resolveJoinTrack(
    userId: number,
    requestedTrack: QueueTrack | undefined
  ): Promise<QueueTrack> {
    if (requestedTrack === 'community') {
      return 'community';
    }

    const [hasConfirmedClaim, hasSharedLinks] = await Promise.all([
      this.repo.hasConfirmedClaimByUser(userId),
      this.repo.hasSharedLinksByUser(userId),
    ]);
    if (isEligibleForNewbieTrack({ hasConfirmedClaim, hasSharedLinks })) {
      return 'newbie';
    }
    if (requestedTrack === undefined) {
      return 'community';
    }

    if (await this.repo.findActiveQueueEntryByUser(userId)) {
      throw createAlreadyInQueueError();
    }
    throw new AppError(
      'NEWBIE_TRACK_ONLY',
      buildNewbieTrackOnlyMessage({ hasConfirmedClaim, hasSharedLinks }),
      409
    );
  }

  // 暱稱在 Router 已 trim 並要求至少一個字元，這裡只需要判斷有沒有帶。
  private async updateNicknameIfProvided(userId: number, nickname?: string): Promise<void> {
    if (nickname) {
      await this.userRepo.updateUserNickname(userId, nickname);
    }
  }

  private async requireLatestQueueEntry(userId: number) {
    const latestEntry = await this.repo.findLatestQueueEntryByUser(userId);
    if (!latestEntry) {
      throw queueEntryNotFoundError();
    }
    return latestEntry;
  }

  private async fetchRevealedSlotResult(
    slotId: number,
    confirmExpiresAt: string | null
  ): Promise<RevealSlotResult> {
    const slotWithLink = await this.repo.findSlotWithLinkById(slotId);
    if (!slotWithLink || !confirmExpiresAt) {
      throw slotDataMissingError();
    }
    return { referralUrl: slotWithLink.normalizedUrl, confirmExpiresAt };
  }

  private async syncProviderStrikeCount(providerUserId: number): Promise<number> {
    const linkSlotStatuses = await this.repo.fetchProviderLinksSlotStatuses(providerUserId);
    const strikeCount = linkSlotStatuses.filter((statuses) =>
      isCompletelyInvalidLink(statuses)
    ).length;
    await this.userRepo.updateProviderStrikeCount(providerUserId, strikeCount);
    return strikeCount;
  }

  /**
   * 配對所有可配的席次與排隊號碼牌，回傳實際配對成功的組合；沒有可配對時回傳空陣列。
   * 某一輪有配對被拒絕（讀到的資料已過期）時會重讀再配，最多 `MAX_MATCHING_ROUNDS` 輪。
   */
  private async matchAvailableSlotsToQueue(now: Date): Promise<MatchAssignment[]> {
    const assigned: MatchAssignment[] = [];

    for (let round = 0; round < MAX_MATCHING_ROUNDS; round++) {
      const { assigned: assignedInRound, hasRejection } = await this.runMatchingRound(now);
      assigned.push(...assignedInRound);
      if (!hasRejection) {
        break;
      }
    }

    return assigned;
  }

  private async runMatchingRound(
    now: Date
  ): Promise<{ assigned: MatchAssignment[]; hasRejection: boolean }> {
    const waitingTracks = await this.repo.fetchTracksWithWaitingEntries();
    const availableSlots = await this.repo.fetchAvailableSlotsForMatching(
      slotTracksMatchableBy(waitingTracks)
    );
    if (availableSlots.length === 0) {
      return { assigned: [], hasRejection: false };
    }

    const waitingTickets = await this.repo.fetchWaitingQueueEntriesForMatching(
      availableSlots.length * MATCHING_CANDIDATES_PER_SLOT
    );
    if (waitingTickets.length === 0) {
      return { assigned: [], hasRejection: false };
    }

    const nowIso = now.toISOString();
    const reserveExpiresAtIso = new Date(
      now.getTime() + RESERVATION_DURATION_MS
    ).toISOString();

    const assigned: MatchAssignment[] = [];
    let hasRejection = false;

    for (const assignment of matchTicketsToAvailableSlots(availableSlots, waitingTickets)) {
      const { slot, ticket } = assignment;
      const isAssigned = await this.repo.assignSlotToQueueEntry({
        slotId: slot.id,
        queueEntryId: ticket.id,
        userId: ticket.userId,
        reservedAtIso: nowIso,
        reserveExpiresAtIso,
      });

      if (!isAssigned) {
        hasRejection = true;
        continue;
      }

      assigned.push(assignment);
      await this.dispatchPush(ticket.userId, {
        title: '輪到你領取 Claude 邀請碼',
        body: `請在 ${RESERVATION_DURATION_HOURS} 小時內點擊解鎖，逾時將自動讓給下一位版友`,
        url: '/',
        tag: `slot-reserved-${slot.id}`,
      });
    }

    return { assigned, hasRejection };
  }

  /** 推播不影響資料狀態，所以有 `runInBackground` 時不讓請求等它送完。 */
  private async dispatchPush(userId: number, payload: PushNotificationPayload): Promise<void> {
    const delivery = this.pushService.sendNotificationToUser(userId, payload);
    if (this.runInBackground) {
      this.runInBackground(delivery);
      return;
    }
    await delivery;
  }

  private async notifyProviderOnSlotConfirmed(
    slotId: number,
    queueEntryId: number
  ): Promise<void> {
    const context = await this.repo.fetchSlotConfirmationPushContext(slotId, queueEntryId);
    if (!context) {
      return;
    }

    await this.syncProviderStrikeCount(context.providerUserId);
    await this.notifyProviderOfConfirmation(context);
  }

  private async notifyProviderOfConfirmation(context: SlotConfirmationPushContext): Promise<void> {
    await this.dispatchPush(context.providerUserId, {
      title: `你分享的邀請碼已成功幫助社友 ${context.receiverNickname}`,
      body: `對方留言：「${context.thankYouMessage}」`,
      url: '/',
      tag: `slot-confirmed-${context.slotId}`,
    });
  }
}

/** 領取過與分享過連結同時成立時用合併訊息，否則使用者只會看到其中一個原因。 */
function buildNewbieTrackOnlyMessage(params: {
  hasConfirmedClaim: boolean;
  hasSharedLinks: boolean;
}): string {
  if (params.hasConfirmedClaim && params.hasSharedLinks) {
    return CLAIMED_AND_SHARED_NEWBIE_TRACK_MESSAGE;
  }
  return params.hasConfirmedClaim ? CLAIMED_NEWBIE_TRACK_MESSAGE : SHARED_NEWBIE_TRACK_MESSAGE;
}

function wasTicketAssigned(assignments: readonly MatchAssignment[], queueEntryId: number): boolean {
  return assignments.some(({ ticket }) => ticket.id === queueEntryId);
}

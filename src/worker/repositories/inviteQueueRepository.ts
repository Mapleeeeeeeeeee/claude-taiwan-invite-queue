import {
  and,
  asc,
  desc,
  DrizzleQueryError,
  eq,
  exists,
  gt,
  inArray,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  MAX_INVALID_RETRY_COUNT,
  QUEUE_TRACKS,
  type QueueStatus,
  type QueueTrack,
  type SlotCount,
  type SlotStatus,
} from '../../shared/types';
import { parseQueueTrack } from '../db/queueTrack';
import { inviteLinks, inviteSlots, queueEntries, users } from '../db/schema';
import type { AvailableSlot, WaitingTicket } from '../domain/matchingEngine';
import { DEFAULT_QUEUE_PRIORITY } from '../domain/rules';
import { AppError } from '../errors';

const REQUEUED_PRIORITY = 1;

/** 排隊紀錄中，service 判斷狀態轉移與取得名額會用到的欄位。 */
interface QueueEntryRow {
  id: number;
  status: QueueStatus;
  slotId: number | null;
  confirmExpiresAt: string | null;
}

interface InviteSlotRow {
  id: number;
  linkId: number;
  status: SlotStatus;
}

export interface SlotConfirmationPushContext {
  slotId: number;
  providerUserId: number;
  receiverNickname: string;
  thankYouMessage: string;
}

interface ExpiredReservationRow {
  queueEntryId: number;
  slotId: number;
  userId: number;
  providerUserId: number;
}

/** 逾時未回報的已解鎖名額，附帶自動確認後通知提供者所需的欄位，處理時不必再逐筆回頭查。 */
interface ExpiredRevealedRow extends SlotConfirmationPushContext {
  queueEntryId: number;
  userId: number;
}

const QUEUE_ENTRY_COLUMNS = {
  id: queueEntries.id,
  status: queueEntries.status,
  slotId: queueEntries.slotId,
  confirmExpiresAt: queueEntries.confirmExpiresAt,
};

const EXPIRATION_SCAN_LIMIT = 100;

const siblingSlots = alias(inviteSlots, 'sibling_slots');

function allAffectedExactlyOne(
  results: D1Result[],
  indices: number[] = results.map((_, index) => index)
): boolean {
  return indices.every((index) => results[index]?.meta.changes === 1);
}

/** 重複排隊的錯誤由 service 的前置檢查與 repository 的 unique index 共用，兩邊的拒絕結果才會一致。 */
export function createAlreadyInQueueError(): AppError {
  return new AppError('ALREADY_IN_QUEUE', '你已經在排隊或領取流程中囉', 409);
}

/**
 * 單句查詢的錯誤會被 drizzle 包成 `DrizzleQueryError`，原始的 D1 錯誤在 `cause`；`db.batch` 的錯誤不會被包。
 * 包裝後的 message 帶有使用者送出的參數，所以只能檢查 `cause`，否則感謝小卡寫了這句話就會被誤判。
 */
function isUniqueConstraintError(error: unknown): boolean {
  const originalError = error instanceof DrizzleQueryError ? error.cause : error;
  return originalError instanceof Error && /UNIQUE constraint failed/i.test(originalError.message);
}

export class InviteQueueRepository {
  private readonly db: DrizzleD1Database;

  constructor(d1: D1Database) {
    this.db = drizzle(d1);
  }

  async fetchProviderLinksSlotStatuses(providerUserId: number): Promise<SlotStatus[][]> {
    const rows = await this.db
      .select({ linkId: inviteLinks.id, status: inviteSlots.status })
      .from(inviteLinks)
      .innerJoin(inviteSlots, eq(inviteSlots.linkId, inviteLinks.id))
      .where(eq(inviteLinks.providerUserId, providerUserId))
      .orderBy(asc(inviteLinks.id), asc(inviteSlots.slotIndex));

    const grouped = new Map<number, SlotStatus[]>();
    for (const row of rows) {
      const list = grouped.get(row.linkId) ?? [];
      list.push(row.status);
      grouped.set(row.linkId, list);
    }

    return Array.from(grouped.values());
  }

  /**
   * 用 `db.batch()` 原子地建立一筆 `invite_links` 與 `slotCount` 筆 `invite_slots`。
   * `referral_code` 已存在時丟出 `AppError('DUPLICATE_REFERRAL_CODE', ..., 409)`。
   */
  async createLinkWithSlots(params: {
    providerUserId: number;
    referralCode: string;
    normalizedUrl: string;
    slotCount: SlotCount;
    track: QueueTrack;
    nowIso: string;
  }): Promise<{ linkId: number }> {
    const insertLink = this.db.insert(inviteLinks).values({
      providerUserId: params.providerUserId,
      referralCode: params.referralCode,
      normalizedUrl: params.normalizedUrl,
      totalSlots: params.slotCount,
      createdAt: params.nowIso,
    });

    // 名額要掛在同一個 batch 剛建立的連結上，linkId 在送出前還不存在；
    // drizzle 的 values 只收純值，不收子查詢，所以用 sql 包住以邀請代碼查 id 的子查詢。
    const linkIdByReferralCode = sql<number>`${this.db
      .select({ id: inviteLinks.id })
      .from(inviteLinks)
      .where(eq(inviteLinks.referralCode, params.referralCode))}`;
    const insertSlots = this.db.insert(inviteSlots).values(
      Array.from({ length: params.slotCount }, (_, index) => ({
        linkId: linkIdByReferralCode,
        slotIndex: index + 1,
        status: 'available' as const,
        track: params.track,
        createdAt: params.nowIso,
      }))
    );

    let results: D1Result[];
    try {
      results = await this.db.batch([insertLink, insertSlots]);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError('DUPLICATE_REFERRAL_CODE', '這組邀請連結已經被分享過囉', 409);
      }
      throw error;
    }

    const linkId = results[0]?.meta.last_row_id ?? 0;
    if (linkId <= 0) {
      throw new AppError('INTERNAL_ERROR', '建立邀請連結失敗', 500);
    }

    return { linkId };
  }

  async findActiveQueueEntryByUser(userId: number): Promise<QueueEntryRow | null> {
    const row = await this.db
      .select(QUEUE_ENTRY_COLUMNS)
      .from(queueEntries)
      .where(
        and(
          eq(queueEntries.userId, userId),
          inArray(queueEntries.status, ['waiting', 'reserved', 'revealed'])
        )
      )
      .orderBy(desc(queueEntries.id))
      .limit(1)
      .get();
    return row ?? null;
  }

  /** 使用者在任一軌道是否有 `confirmed` 的領取紀錄。 */
  async hasConfirmedClaimByUser(userId: number): Promise<boolean> {
    const row = await this.db
      .select({ id: queueEntries.id })
      .from(queueEntries)
      .where(and(eq(queueEntries.userId, userId), eq(queueEntries.status, 'confirmed')))
      .limit(1)
      .get();
    return row !== undefined;
  }

  async hasSharedLinksByUser(userId: number): Promise<boolean> {
    const row = await this.db
      .select({ id: inviteLinks.id })
      .from(inviteLinks)
      .where(eq(inviteLinks.providerUserId, userId))
      .limit(1)
      .get();
    return row !== undefined;
  }

  async findLatestQueueEntryByUser(userId: number): Promise<QueueEntryRow | null> {
    const row = await this.db
      .select(QUEUE_ENTRY_COLUMNS)
      .from(queueEntries)
      .where(eq(queueEntries.userId, userId))
      .orderBy(desc(queueEntries.id))
      .limit(1)
      .get();
    return row ?? null;
  }

  /**
   * 為 `userId` 新增一筆 `waiting` 排隊紀錄。
   * 並發請求已讓同一位使用者有進行中的紀錄、觸發 partial unique index 時，丟出 `AppError('ALREADY_IN_QUEUE', ..., 409)`。
   */
  async createQueueEntry(params: {
    userId: number;
    thankYouMessage: string;
    nowIso: string;
    track: QueueTrack;
  }): Promise<number> {
    let result: D1Result;
    try {
      result = await this.db
        .insert(queueEntries)
        .values({
          userId: params.userId,
          status: 'waiting',
          track: params.track,
          priority: DEFAULT_QUEUE_PRIORITY,
          thankYouMessage: params.thankYouMessage,
          createdAt: params.nowIso,
          updatedAt: params.nowIso,
        })
        .run();
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw createAlreadyInQueueError();
      }
      throw error;
    }

    return result.meta.last_row_id;
  }

  /**
   * 回傳目前至少有一張 `waiting` 票券的軌道，順序同 `QUEUE_TRACKS`；沒有人排隊時回傳 `[]`。
   * 每個軌道只做一次走 `idx_queue_entries_track_waiting` 的 `LIMIT 1` 點查，成本不隨佇列長度增加。
   */
  async fetchTracksWithWaitingEntries(): Promise<QueueTrack[]> {
    const hasWaitingEntryByTrack = await Promise.all(
      QUEUE_TRACKS.map(async (track) => {
        const row = await this.db
          .select({ id: queueEntries.id })
          .from(queueEntries)
          .where(and(eq(queueEntries.track, track), eq(queueEntries.status, 'waiting')))
          .limit(1)
          .get();
        return row !== undefined;
      })
    );

    return QUEUE_TRACKS.filter((_, index) => hasWaitingEntryByTrack[index]);
  }

  /**
   * 回傳軌道在 `tracks` 內的所有 `available` 名額，最舊的在前；`tracks` 為空時不查詢，直接回傳 `[]`。
   * 刻意不加 `LIMIT`，因為同一位提供者的名額可能連續被跳過（自我配對），
   * 截斷清單會讓後面提供者的名額一直輪不到。
   */
  async fetchAvailableSlotsForMatching(tracks: readonly QueueTrack[]): Promise<AvailableSlot[]> {
    if (tracks.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({
        id: inviteSlots.id,
        linkId: inviteSlots.linkId,
        providerUserId: inviteLinks.providerUserId,
        track: inviteSlots.track,
      })
      .from(inviteSlots)
      .innerJoin(inviteLinks, eq(inviteLinks.id, inviteSlots.linkId))
      .where(and(eq(inviteSlots.status, 'available'), inArray(inviteSlots.track, [...tracks])))
      .orderBy(asc(inviteSlots.createdAt), asc(inviteSlots.id));

    return rows.map((row) => ({ ...row, track: parseQueueTrack(row.track) }));
  }

  /**
   * 回傳每個軌道最多 `limitPerTrack` 張 `waiting` 票券，合併後依全域 FIFO 順序
   * （`priority DESC, created_at ASC, id ASC`）排列。
   * 上限逐軌計算，所以某一軌大量積壓時，不會把另一軌的票券擠出視窗。
   */
  async fetchWaitingQueueEntriesForMatching(limitPerTrack: number): Promise<WaitingTicket[]> {
    // drizzle 沒有 window function 的建構器，每軌取前 N 筆的排名只能用 sql 寫 ROW_NUMBER() OVER。
    const rankInTrack = sql<number>`row_number() over (
      partition by ${queueEntries.track}
      order by ${queueEntries.priority} desc, ${queueEntries.createdAt} asc, ${queueEntries.id} asc
    )`.as('rank_in_track');
    const waitingEntries = this.db
      .select({
        id: queueEntries.id,
        userId: queueEntries.userId,
        track: queueEntries.track,
        priority: queueEntries.priority,
        createdAt: queueEntries.createdAt,
        rankInTrack,
      })
      .from(queueEntries)
      .where(eq(queueEntries.status, 'waiting'))
      .as('waiting_entries');

    const rows = await this.db
      .select({
        id: waitingEntries.id,
        userId: waitingEntries.userId,
        track: waitingEntries.track,
      })
      .from(waitingEntries)
      .where(lte(waitingEntries.rankInTrack, limitPerTrack))
      .orderBy(
        desc(waitingEntries.priority),
        asc(waitingEntries.createdAt),
        asc(waitingEntries.id)
      );

    return rows.map((row) => ({ ...row, track: parseQueueTrack(row.track) }));
  }

  /**
   * 用 `db.batch()` 原子地把一個 `available` 名額配給一筆 `waiting` 排隊紀錄。
   * 兩筆都更新成功時回傳 `true`；任一筆已被並發請求改掉時回傳 `false`。
   */
  async assignSlotToQueueEntry(params: {
    slotId: number;
    queueEntryId: number;
    userId: number;
    reservedAtIso: string;
    reserveExpiresAtIso: string;
  }): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .update(inviteSlots)
        .set({
          status: 'reserved',
          assignedUserId: params.userId,
          reservedAt: params.reservedAtIso,
          reserveExpiresAt: params.reserveExpiresAtIso,
        })
        .where(
          and(
            eq(inviteSlots.id, params.slotId),
            eq(inviteSlots.status, 'available'),
            exists(
              this.db
                .select({ id: queueEntries.id })
                .from(queueEntries)
                .where(
                  and(eq(queueEntries.id, params.queueEntryId), eq(queueEntries.status, 'waiting'))
                )
            )
          )
        ),
      this.db
        .update(queueEntries)
        .set({
          status: 'reserved',
          slotId: params.slotId,
          reserveExpiresAt: params.reserveExpiresAtIso,
          updatedAt: params.reservedAtIso,
        })
        .where(
          and(
            eq(queueEntries.id, params.queueEntryId),
            eq(queueEntries.status, 'waiting'),
            exists(
              this.db
                .select({ id: inviteSlots.id })
                .from(inviteSlots)
                .where(
                  and(
                    eq(inviteSlots.id, params.slotId),
                    eq(inviteSlots.status, 'reserved'),
                    eq(inviteSlots.assignedUserId, params.userId)
                  )
                )
            )
          )
        ),
    ]);

    return allAffectedExactlyOne(results);
  }

  async cancelWaitingQueueEntry(queueEntryId: number, nowIso: string): Promise<boolean> {
    const result = await this.db
      .update(queueEntries)
      .set({ status: 'cancelled', updatedAt: nowIso })
      .where(and(eq(queueEntries.id, queueEntryId), eq(queueEntries.status, 'waiting')))
      .run();

    return allAffectedExactlyOne([result]);
  }

  /**
   * 取消 `reserved` 的排隊紀錄並釋出它持有的名額。
   * 兩條語句互相綁定：名額必須仍保留給 `userId` 且這筆紀錄仍是 `reserved` 並持有該名額，才會釋出；
   * 紀錄也要等名額確實不再 `reserved` 才取消。
   * 否則舊請求會把已逾時結算後改保留給別人的名額放掉。
   */
  async cancelReservedQueueEntryAndReleaseSlot(params: {
    queueEntryId: number;
    slotId: number;
    userId: number;
    nowIso: string;
  }): Promise<boolean> {
    const entryStillHoldsSlot = exists(
      this.db
        .select({ id: queueEntries.id })
        .from(queueEntries)
        .where(
          and(
            eq(queueEntries.id, params.queueEntryId),
            eq(queueEntries.status, 'reserved'),
            eq(queueEntries.userId, params.userId),
            eq(queueEntries.slotId, params.slotId)
          )
        )
    );
    // 第一條語句沒有放掉名額時，名額仍是 reserved，第二條語句就不能取消紀錄。
    const slotWasReleased = exists(
      this.db
        .select({ id: inviteSlots.id })
        .from(inviteSlots)
        .where(and(eq(inviteSlots.id, params.slotId), ne(inviteSlots.status, 'reserved')))
    );

    const results = await this.db.batch([
      this.releaseReservedSlot(
        params.slotId,
        params.nowIso,
        and(eq(inviteSlots.assignedUserId, params.userId), entryStillHoldsSlot)
      ),
      this.db
        .update(queueEntries)
        .set({
          status: 'cancelled',
          slotId: null,
          reserveExpiresAt: null,
          updatedAt: params.nowIso,
        })
        .where(
          and(
            eq(queueEntries.id, params.queueEntryId),
            eq(queueEntries.status, 'reserved'),
            eq(queueEntries.userId, params.userId),
            eq(queueEntries.slotId, params.slotId),
            slotWasReleased
          )
        ),
    ]);

    return allAffectedExactlyOne(results);
  }

  async findSlotWithLinkById(
    slotId: number
  ): Promise<{ slot: InviteSlotRow; normalizedUrl: string; providerUserId: number } | null> {
    const row = await this.db
      .select({
        id: inviteSlots.id,
        linkId: inviteSlots.linkId,
        status: inviteSlots.status,
        normalizedUrl: inviteLinks.normalizedUrl,
        providerUserId: inviteLinks.providerUserId,
      })
      .from(inviteSlots)
      .innerJoin(inviteLinks, eq(inviteLinks.id, inviteSlots.linkId))
      .where(eq(inviteSlots.id, slotId))
      .get();

    if (!row) {
      return null;
    }

    const { normalizedUrl, providerUserId, ...slot } = row;
    return { slot, normalizedUrl, providerUserId };
  }

  /**
   * 解鎖 `reserved` 的名額。兩條語句互相綁定：名額要等排隊紀錄確實持有它且保留未逾時才解鎖，
   * 紀錄要等名額被這次請求解鎖才轉為 `revealed`，所以其中一邊已被別的請求改掉時不會只改到另一邊。
   */
  async revealReservedSlot(params: {
    slotId: number;
    queueEntryId: number;
    userId: number;
    nowIso: string;
    confirmExpiresAtIso: string;
  }): Promise<boolean> {
    const entryStillHoldsSlot = exists(
      this.db
        .select({ id: queueEntries.id })
        .from(queueEntries)
        .where(
          and(
            eq(queueEntries.id, params.queueEntryId),
            eq(queueEntries.status, 'reserved'),
            eq(queueEntries.userId, params.userId),
            eq(queueEntries.slotId, params.slotId),
            gt(queueEntries.reserveExpiresAt, params.nowIso)
          )
        )
    );
    const slotWasRevealedByThisRequest = exists(
      this.db
        .select({ id: inviteSlots.id })
        .from(inviteSlots)
        .where(
          and(
            eq(inviteSlots.id, params.slotId),
            eq(inviteSlots.status, 'revealed'),
            eq(inviteSlots.assignedUserId, params.userId),
            eq(inviteSlots.revealedAt, params.nowIso)
          )
        )
    );

    const results = await this.db.batch([
      this.db
        .update(inviteSlots)
        .set({
          status: 'revealed',
          revealedAt: params.nowIso,
          confirmExpiresAt: params.confirmExpiresAtIso,
        })
        .where(
          and(
            eq(inviteSlots.id, params.slotId),
            eq(inviteSlots.status, 'reserved'),
            eq(inviteSlots.assignedUserId, params.userId),
            gt(inviteSlots.reserveExpiresAt, params.nowIso),
            entryStillHoldsSlot
          )
        ),
      this.db
        .update(queueEntries)
        .set({
          status: 'revealed',
          confirmExpiresAt: params.confirmExpiresAtIso,
          updatedAt: params.nowIso,
        })
        .where(
          and(
            eq(queueEntries.id, params.queueEntryId),
            eq(queueEntries.status, 'reserved'),
            eq(queueEntries.userId, params.userId),
            eq(queueEntries.slotId, params.slotId),
            gt(queueEntries.reserveExpiresAt, params.nowIso),
            slotWasRevealedByThisRequest
          )
        ),
    ]);

    return allAffectedExactlyOne(results);
  }

  /**
   * 確認 `revealed` 的名額。兩條語句互相綁定：名額要等排隊紀錄確實持有它才確認，
   * 紀錄要等名額被這次請求確認才轉為 `confirmed`，所以舊請求不會把已改配其他名額的紀錄標成已確認。
   */
  async confirmRevealedSlot(params: {
    slotId: number;
    queueEntryId: number;
    nowIso: string;
  }): Promise<boolean> {
    const entryStillHoldsSlot = exists(
      this.db
        .select({ id: queueEntries.id })
        .from(queueEntries)
        .where(
          and(
            eq(queueEntries.id, params.queueEntryId),
            eq(queueEntries.status, 'revealed'),
            eq(queueEntries.slotId, params.slotId)
          )
        )
    );
    const slotWasConfirmedByThisRequest = exists(
      this.db
        .select({ id: inviteSlots.id })
        .from(inviteSlots)
        .where(
          and(
            eq(inviteSlots.id, params.slotId),
            eq(inviteSlots.status, 'confirmed'),
            eq(inviteSlots.confirmedAt, params.nowIso)
          )
        )
    );

    const results = await this.db.batch([
      this.db
        .update(inviteSlots)
        .set({ status: 'confirmed', confirmedAt: params.nowIso })
        .where(
          and(
            eq(inviteSlots.id, params.slotId),
            eq(inviteSlots.status, 'revealed'),
            entryStillHoldsSlot
          )
        ),
      this.db
        .update(queueEntries)
        .set({ status: 'confirmed', confirmedAt: params.nowIso, updatedAt: params.nowIso })
        .where(
          and(
            eq(queueEntries.id, params.queueEntryId),
            eq(queueEntries.status, 'revealed'),
            eq(queueEntries.slotId, params.slotId),
            slotWasConfirmedByThisRequest
          )
        ),
    ]);

    return allAffectedExactlyOne(results);
  }

  async fetchSlotConfirmationPushContext(
    slotId: number,
    queueEntryId: number
  ): Promise<SlotConfirmationPushContext | null> {
    const row = await this.db
      .select({
        slotId: inviteSlots.id,
        providerUserId: inviteLinks.providerUserId,
        receiverNickname: users.nickname,
        thankYouMessage: queueEntries.thankYouMessage,
      })
      .from(inviteSlots)
      .innerJoin(inviteLinks, eq(inviteLinks.id, inviteSlots.linkId))
      .innerJoin(queueEntries, eq(queueEntries.id, queueEntryId))
      .innerJoin(users, eq(users.id, queueEntries.userId))
      .where(eq(inviteSlots.id, slotId))
      .get();
    return row ?? null;
  }

  /**
   * 原子地把目前已解鎖的名額標為 `invalidated`、關閉同連結其餘的 `available` 名額、
   * 將領取者的 `invalid_retry_count` 加 1，並讓他以 `REQUEUED_PRIORITY` 回到 `waiting`。
   * 跨表的 `EXISTS` 條件讓任一前提不成立時，不會只改到其中幾張表。
   * 全部生效時回傳 `true`，前提已被並發請求改掉時回傳 `false`。
   */
  async reportInvalidAndRequeue(params: {
    slotId: number;
    linkId: number;
    queueEntryId: number;
    userId: number;
    nowIso: string;
  }): Promise<boolean> {
    // 後三條語句都要先確認第一條已把這個名額標成 invalidated，才有資格動作。
    const slotWasInvalidatedByThisReport = exists(
      this.db
        .select({ id: inviteSlots.id })
        .from(inviteSlots)
        .where(
          and(
            eq(inviteSlots.id, params.slotId),
            eq(inviteSlots.status, 'invalidated'),
            eq(inviteSlots.assignedUserId, params.userId),
            eq(inviteSlots.invalidatedAt, params.nowIso)
          )
        )
    );

    const results = await this.db.batch([
      this.db
        .update(inviteSlots)
        .set({ status: 'invalidated', invalidatedAt: params.nowIso })
        .where(
          and(
            eq(inviteSlots.id, params.slotId),
            eq(inviteSlots.status, 'revealed'),
            eq(inviteSlots.assignedUserId, params.userId),
            gt(inviteSlots.confirmExpiresAt, params.nowIso),
            exists(
              this.db
                .select({ id: users.id })
                .from(users)
                .where(
                  and(
                    eq(users.id, params.userId),
                    lt(users.invalidRetryCount, MAX_INVALID_RETRY_COUNT)
                  )
                )
            ),
            exists(
              this.db
                .select({ id: queueEntries.id })
                .from(queueEntries)
                .where(
                  and(
                    eq(queueEntries.id, params.queueEntryId),
                    eq(queueEntries.status, 'revealed'),
                    eq(queueEntries.userId, params.userId)
                  )
                )
            )
          )
        ),
      this.db
        .update(inviteSlots)
        .set({ status: 'closed', closedAt: params.nowIso })
        .where(
          and(
            eq(inviteSlots.linkId, params.linkId),
            eq(inviteSlots.status, 'available'),
            slotWasInvalidatedByThisReport
          )
        ),
      this.db
        .update(users)
        // drizzle 的 set 只收純值，欄位自增（讀值加 1）只能用 sql 表達。
        .set({ invalidRetryCount: sql`${users.invalidRetryCount} + 1` })
        .where(
          and(
            eq(users.id, params.userId),
            lt(users.invalidRetryCount, MAX_INVALID_RETRY_COUNT),
            slotWasInvalidatedByThisReport
          )
        ),
      this.db
        .update(queueEntries)
        .set({
          status: 'waiting',
          priority: REQUEUED_PRIORITY,
          slotId: null,
          reserveExpiresAt: null,
          confirmExpiresAt: null,
          updatedAt: params.nowIso,
        })
        .where(
          and(
            eq(queueEntries.id, params.queueEntryId),
            eq(queueEntries.status, 'revealed'),
            eq(queueEntries.userId, params.userId),
            slotWasInvalidatedByThisReport
          )
        ),
    ]);

    // 索引 1 的語句（關閉同連結其餘 available 名額）合法地可能影響 0 筆，所以不納入判斷。
    return allAffectedExactlyOne(results, [0, 2, 3]);
  }

  async fetchExpiredReservations(nowIso: string): Promise<ExpiredReservationRow[]> {
    return this.db
      .select({
        queueEntryId: queueEntries.id,
        slotId: inviteSlots.id,
        userId: queueEntries.userId,
        providerUserId: inviteLinks.providerUserId,
      })
      .from(queueEntries)
      .innerJoin(inviteSlots, eq(inviteSlots.id, queueEntries.slotId))
      .innerJoin(inviteLinks, eq(inviteLinks.id, inviteSlots.linkId))
      .where(and(eq(queueEntries.status, 'reserved'), lte(queueEntries.reserveExpiresAt, nowIso)))
      .orderBy(asc(queueEntries.reserveExpiresAt), asc(queueEntries.id))
      .limit(EXPIRATION_SCAN_LIMIT);
  }

  async expireReservationAndReleaseSlot(params: {
    queueEntryId: number;
    slotId: number;
    nowIso: string;
  }): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .update(queueEntries)
        .set({ status: 'expired', slotId: null, updatedAt: params.nowIso })
        .where(
          and(
            eq(queueEntries.id, params.queueEntryId),
            eq(queueEntries.status, 'reserved'),
            lte(queueEntries.reserveExpiresAt, params.nowIso)
          )
        ),
      this.releaseReservedSlot(
        params.slotId,
        params.nowIso,
        lte(inviteSlots.reserveExpiresAt, params.nowIso)
      ),
    ]);

    return allAffectedExactlyOne(results);
  }

  async fetchExpiredRevealedSlots(nowIso: string): Promise<ExpiredRevealedRow[]> {
    return this.db
      .select({
        queueEntryId: queueEntries.id,
        slotId: inviteSlots.id,
        userId: queueEntries.userId,
        providerUserId: inviteLinks.providerUserId,
        receiverNickname: users.nickname,
        thankYouMessage: queueEntries.thankYouMessage,
      })
      .from(queueEntries)
      .innerJoin(inviteSlots, eq(inviteSlots.id, queueEntries.slotId))
      .innerJoin(inviteLinks, eq(inviteLinks.id, inviteSlots.linkId))
      .innerJoin(users, eq(users.id, queueEntries.userId))
      .where(and(eq(queueEntries.status, 'revealed'), lte(queueEntries.confirmExpiresAt, nowIso)))
      .orderBy(asc(queueEntries.confirmExpiresAt), asc(queueEntries.id))
      .limit(EXPIRATION_SCAN_LIMIT);
  }

  /**
   * 把 `reserved` 的名額放回池子。同連結只要有 invalidated 的兄弟名額，釋出的名額就直接 closed，
   * 避免壞連結的碼再被配出去。`extraGuard` 讓呼叫端再加條件（例如保留期限已到）。
   */
  private releaseReservedSlot(slotId: number, nowIso: string, extraGuard?: SQL) {
    const hasInvalidatedSibling = exists(
      this.db
        .select({ id: siblingSlots.id })
        .from(siblingSlots)
        .where(
          and(eq(siblingSlots.linkId, inviteSlots.linkId), eq(siblingSlots.status, 'invalidated'))
        )
    );

    return this.db
      .update(inviteSlots)
      .set({
        // drizzle 沒有 CASE 運算式，status 與 closed_at 隨兄弟名額狀態二選一只能用 sql。
        status: sql`case when ${hasInvalidatedSibling} then 'closed' else 'available' end`,
        closedAt: sql`case when ${hasInvalidatedSibling} then ${nowIso} else null end`,
        assignedUserId: null,
        reservedAt: null,
        reserveExpiresAt: null,
      })
      .where(and(eq(inviteSlots.id, slotId), eq(inviteSlots.status, 'reserved'), extraGuard));
  }
}

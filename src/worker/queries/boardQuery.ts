import { and, count, desc, eq } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  THANK_YOU_WALL_LIMIT,
  type BoardDto,
  type QueueTrack,
  type ThankYouWallItemDto,
} from '../../shared/types';
import { parseQueueTrack } from '../db/queueTrack';
import { inviteLinks, inviteSlots, queueEntries, users } from '../db/schema';

export const BOARD_CACHE_TTL_MS = 15_000;

/**
 * `totalConfirmedCount` 的快取時間，也就是其他 Worker isolate 上這個數字落後實際狀態的上限。
 * 重算要掃過全部 `confirmed` 名額，D1 又依掃描列數計費，所以這個數字不跟著 15 秒的看板快取重算，
 * 一般的看板快取失效（`invalidateBoardCache`）也不重算它。
 * 名額被確認時，`invalidateBoardAndTotalConfirmedCount` 會清掉本 isolate 的這份快取，
 * 讓使用者按下確認啟用後馬上看到數字加一；快取存在各 isolate 的記憶體裡，
 * 清不到其他 isolate，所以它們最多晚 60 秒才追上。
 */
export const TOTAL_CONFIRMED_COUNT_CACHE_TTL_MS = 60_000;

interface BoardCacheState {
  data: BoardDto;
  cachedAtMs: number;
}

interface TotalConfirmedCountCacheState {
  // 數字屬於特定的資料庫，換了資料庫（例如每個測試各建一個）就不能沿用。
  db: D1Database;
  count: number;
  cachedAtMs: number;
}

let boardCache: BoardCacheState | null = null;
let inFlightBoardPromise: Promise<BoardDto> | null = null;
// 失效前就開始查的看板不能寫回快取，所以每次失效都換一代，寫入時比對。
let boardCacheGeneration = 0;
let totalConfirmedCountCache: TotalConfirmedCountCacheState | null = null;
// 與 boardCacheGeneration 同理：確認前就開始數的結果不能在確認後寫回快取。
let totalConfirmedCountGeneration = 0;

/** 清掉看板快取；`totalConfirmedCount` 的快取不在此列，名額被確認時改呼叫 `invalidateBoardAndTotalConfirmedCount`。 */
export function invalidateBoardCache(): void {
  boardCache = null;
  inFlightBoardPromise = null;
  boardCacheGeneration += 1;
}

/**
 * 名額被確認（`confirmed` 數增加）後呼叫：清掉看板快取與 `totalConfirmedCount` 的快取，
 * 下一次讀看板會重數 confirmed 名額。只清得到本 isolate 的記憶體，其他 isolate 要等 TTL 過期。
 */
export function invalidateBoardAndTotalConfirmedCount(): void {
  invalidateBoardCache();
  totalConfirmedCountCache = null;
  totalConfirmedCountGeneration += 1;
}

function isWithinTtl(cachedAtMs: number, nowMs: number, ttlMs: number): boolean {
  return nowMs >= cachedAtMs && nowMs - cachedAtMs < ttlMs;
}

function getFreshBoardCache(now: Date): BoardCacheState | null {
  if (boardCache === null || !isWithinTtl(boardCache.cachedAtMs, now.getTime(), BOARD_CACHE_TTL_MS)) {
    return null;
  }
  return boardCache;
}

export function isBoardCacheFresh(now: Date = new Date()): boolean {
  return getFreshBoardCache(now) !== null;
}

const receivers = alias(users, 'receivers');
const providers = alias(users, 'providers');

type TrackCounts = Record<QueueTrack, number>;

/** 把 `GROUP BY track` 的結果整理成每個軌道一個數字；資料庫出現未知軌道值時拋錯。 */
function countByTrack(rows: readonly { track: string; count: number }[]): TrackCounts {
  const counts: TrackCounts = { newbie: 0, community: 0 };
  for (const row of rows) {
    counts[parseQueueTrack(row.track)] += row.count;
  }
  return counts;
}

function sumOfTracks(counts: TrackCounts): number {
  return counts.newbie + counts.community;
}

async function fetchTotalConfirmedCount(
  d1: D1Database,
  db: DrizzleD1Database,
  now: Date
): Promise<number> {
  const cached = totalConfirmedCountCache;
  if (
    cached !== null &&
    cached.db === d1 &&
    isWithinTtl(cached.cachedAtMs, now.getTime(), TOTAL_CONFIRMED_COUNT_CACHE_TTL_MS)
  ) {
    return cached.count;
  }

  const generationAtStart = totalConfirmedCountGeneration;
  const [row] = await db
    .select({ count: count() })
    .from(inviteSlots)
    .where(eq(inviteSlots.status, 'confirmed'))
    .all();
  if (row === undefined) {
    throw new Error('COUNT(*) 查詢沒有回傳資料列');
  }
  if (generationAtStart === totalConfirmedCountGeneration) {
    totalConfirmedCountCache = { db: d1, count: row.count, cachedAtMs: now.getTime() };
  }
  return row.count;
}

async function queryBoardDto(d1: D1Database, now: Date): Promise<BoardDto> {
  const db = drizzle(d1);
  // 用 .all() 立刻送出查詢；直接 await 查詢建構器會晚一個 microtask 才送出，
  // 與 fetchBoardDto 在送出前記下的快取世代之間就多出一段空隙。
  const [availableSlotRows, queueByTrackRows, wallRows, totalConfirmedCount] = await Promise.all([
    db
      .select({ track: inviteSlots.track, count: count() })
      .from(inviteSlots)
      .where(eq(inviteSlots.status, 'available'))
      .groupBy(inviteSlots.track)
      .all(),
    db
      .select({ track: queueEntries.track, count: count() })
      .from(queueEntries)
      .where(eq(queueEntries.status, 'waiting'))
      .groupBy(queueEntries.track)
      .all(),
    db
      .select({
        slotId: inviteSlots.id,
        receiverNickname: receivers.nickname,
        providerNickname: providers.nickname,
        thankYouMessage: queueEntries.thankYouMessage,
        confirmedAt: queueEntries.confirmedAt,
      })
      .from(queueEntries)
      .innerJoin(inviteSlots, eq(inviteSlots.id, queueEntries.slotId))
      .innerJoin(inviteLinks, eq(inviteLinks.id, inviteSlots.linkId))
      .innerJoin(receivers, eq(receivers.id, queueEntries.userId))
      .innerJoin(providers, eq(providers.id, inviteLinks.providerUserId))
      .where(and(eq(queueEntries.status, 'confirmed'), eq(inviteSlots.status, 'confirmed')))
      .orderBy(desc(queueEntries.confirmedAt), desc(queueEntries.id))
      .limit(THANK_YOU_WALL_LIMIT)
      .all(),
    fetchTotalConfirmedCount(d1, db, now),
  ]);

  const thankYouWall: ThankYouWallItemDto[] = wallRows.map(({ confirmedAt, ...row }) => {
    // confirmed 的排隊紀錄一定有確認時間；欄位在 schema 是可空的，缺值代表資料壞了，不補預設值。
    if (confirmedAt === null) {
      throw new Error(`confirmed 的排隊紀錄 (slot ${row.slotId}) 沒有 confirmed_at`);
    }
    return { ...row, confirmedAt };
  });

  const availableSlots = countByTrack(availableSlotRows);
  const waitingQueue = countByTrack(queueByTrackRows);

  return {
    availableSlotsCount: sumOfTracks(availableSlots),
    waitingQueueCount: sumOfTracks(waitingQueue),
    totalConfirmedCount,
    newbieSlotsCount: availableSlots.newbie,
    communitySlotsCount: availableSlots.community,
    newbieQueueCount: waitingQueue.newbie,
    communityQueueCount: waitingQueue.community,
    thankYouWall,
  };
}

export async function fetchBoardDto(
  db: D1Database,
  now: Date = new Date()
): Promise<BoardDto> {
  const freshCache = getFreshBoardCache(now);
  if (freshCache !== null) {
    return freshCache.data;
  }
  if (inFlightBoardPromise) {
    return inFlightBoardPromise;
  }

  const generationAtStart = boardCacheGeneration;
  const thisFetch: Promise<BoardDto> = queryBoardDto(db, now)
    .then((dto) => {
      if (generationAtStart === boardCacheGeneration) {
        boardCache = { data: dto, cachedAtMs: now.getTime() };
      }
      return dto;
    })
    .finally(() => {
      if (inFlightBoardPromise === thisFetch) {
        inFlightBoardPromise = null;
      }
    });
  inFlightBoardPromise = thisFetch;

  return thisFetch;
}

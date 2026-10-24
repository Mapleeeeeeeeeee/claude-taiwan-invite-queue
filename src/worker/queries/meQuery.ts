import { and, asc, count, desc, eq, gt, lt, or } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';
import type { MeDto, MyQueueEntryDto, MySharedLinkDto } from '../../shared/types';
import { parseQueueTrack } from '../db/queueTrack';
import {
  inviteLinks,
  inviteSlots,
  pushSubscriptions,
  queueEntries,
  users,
} from '../db/schema';
import {
  DEFAULT_QUEUE_PRIORITY,
  canUserReportInvalid,
  isEligibleForNewbieTrack,
  isProviderBlocked,
} from '../domain/rules';

/** 與使用者無關、由伺服器環境決定的 `MeDto` 欄位。 */
type MeServerConfig = Pick<MeDto, 'vapidPublicKey' | 'devLoginEnabled' | 'googleClientId'>;

const providerUsers = alias(users, 'provider_users');
const receiverUsers = alias(users, 'receiver_users');

const MY_QUEUE_ENTRY_COLUMNS = {
  id: queueEntries.id,
  status: queueEntries.status,
  track: queueEntries.track,
  priority: queueEntries.priority,
  createdAt: queueEntries.createdAt,
  thankYouMessage: queueEntries.thankYouMessage,
  slotId: queueEntries.slotId,
  reserveExpiresAt: queueEntries.reserveExpiresAt,
  confirmExpiresAt: queueEntries.confirmExpiresAt,
  slotStatus: inviteSlots.status,
  normalizedUrl: inviteLinks.normalizedUrl,
  providerNickname: providerUsers.nickname,
};

type MyQueueEntryRow = NonNullable<Awaited<ReturnType<typeof fetchLatestQueueEntryRow>>>;

function buildAnonymousMeDto(serverConfig: MeServerConfig): MeDto {
  return {
    user: null,
    myQueue: null,
    myConfirmedClaim: null,
    mySharedLinks: [],
    ...serverConfig,
  };
}

export async function fetchMeDto(
  d1: D1Database,
  userId: number | null,
  serverConfig: MeServerConfig,
  now: Date = new Date()
): Promise<MeDto> {
  if (userId === null) {
    return buildAnonymousMeDto(serverConfig);
  }

  const db = drizzle(d1);

  // 這些查詢彼此不依賴，一次送出；「可否回報無效」需要的 invalidRetryCount 等 userRow 回來再算。
  const [userRow, pushSubscriptionRow, mySharedLinks, latestQueueEntryRow] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        nickname: users.nickname,
        invalidRetryCount: users.invalidRetryCount,
        invalidLinkStrikeCount: users.invalidLinkStrikeCount,
      })
      .from(users)
      .where(eq(users.id, userId))
      .get(),
    db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .limit(1)
      .get(),
    fetchMySharedLinks(db, userId),
    fetchLatestQueueEntryRow(db, userId),
  ]);

  if (!userRow) {
    return buildAnonymousMeDto(serverConfig);
  }

  const [queuePosition, confirmedClaimRow] = await Promise.all([
    latestQueueEntryRow?.status === 'waiting' ? fetchGlobalQueuePosition(db, latestQueueEntryRow) : null,
    findConfirmedClaimRow(db, userId, latestQueueEntryRow),
  ]);

  const { invalidRetryCount, invalidLinkStrikeCount } = userRow;
  const myQueue = latestQueueEntryRow
    ? toMyQueueEntryDto(latestQueueEntryRow, {
        queuePosition,
        canReportInvalid: canReportInvalid(latestQueueEntryRow, invalidRetryCount, now.toISOString()),
      })
    : null;
  const myConfirmedClaim = confirmedClaimRow
    ? toMyQueueEntryDto(confirmedClaimRow, { queuePosition: null, canReportInvalid: false })
    : null;

  return {
    user: {
      id: userRow.id,
      email: userRow.email,
      nickname: userRow.nickname,
      invalidRetryCount,
      invalidLinkStrikeCount,
      isProviderBlocked: isProviderBlocked(invalidLinkStrikeCount),
      hasPushSubscription: pushSubscriptionRow !== undefined,
      isEligibleForNewbieTrack: isEligibleForNewbieTrack({
        hasConfirmedClaim: myConfirmedClaim !== null,
        hasSharedLinks: mySharedLinks.length > 0,
      }),
      hasSharedLinks: mySharedLinks.length > 0,
    },
    myQueue,
    myConfirmedClaim,
    mySharedLinks,
    ...serverConfig,
  };
}

/** 排隊紀錄連同所屬名額、邀請連結與提供者暱稱（尚未領到名額時這些欄位為 null）。 */
function selectMyQueueEntries(db: DrizzleD1Database) {
  return db
    .select(MY_QUEUE_ENTRY_COLUMNS)
    .from(queueEntries)
    .leftJoin(inviteSlots, eq(inviteSlots.id, queueEntries.slotId))
    .leftJoin(inviteLinks, eq(inviteLinks.id, inviteSlots.linkId))
    .leftJoin(providerUsers, eq(providerUsers.id, inviteLinks.providerUserId));
}

/** 使用者最近一筆排隊紀錄，不論狀態。 */
async function fetchLatestQueueEntryRow(db: DrizzleD1Database, userId: number) {
  const row = await selectMyQueueEntries(db)
    .where(eq(queueEntries.userId, userId))
    .orderBy(desc(queueEntries.id))
    .limit(1)
    .get();
  return row ?? null;
}

/** 使用者最近一筆 `confirmed` 的排隊紀錄（任一軌道）。 */
async function fetchLatestConfirmedQueueEntryRow(db: DrizzleD1Database, userId: number) {
  const row = await selectMyQueueEntries(db)
    .where(and(eq(queueEntries.userId, userId), eq(queueEntries.status, 'confirmed')))
    .orderBy(desc(queueEntries.id))
    .limit(1)
    .get();
  return row ?? null;
}

/** 最新一筆已是 `confirmed` 時直接沿用，否則才查較早的已確認紀錄；沒有任何紀錄時不必查。 */
async function findConfirmedClaimRow(
  db: DrizzleD1Database,
  userId: number,
  latestQueueEntryRow: MyQueueEntryRow | null
): Promise<MyQueueEntryRow | null> {
  if (latestQueueEntryRow === null) {
    return null;
  }
  if (latestQueueEntryRow.status === 'confirmed') {
    return latestQueueEntryRow;
  }
  return fetchLatestConfirmedQueueEntryRow(db, userId);
}

function toMyQueueEntryDto(
  row: MyQueueEntryRow,
  derived: { queuePosition: number | null; canReportInvalid: boolean }
): MyQueueEntryDto {
  const isUrlVisible = row.status === 'revealed' || row.status === 'confirmed';
  return {
    id: row.id,
    status: row.status,
    track: parseQueueTrack(row.track),
    queuePosition: derived.queuePosition,
    thankYouMessage: row.thankYouMessage,
    slotId: row.slotId,
    providerNickname: row.providerNickname,
    referralUrl: isUrlVisible ? row.normalizedUrl : null,
    reserveExpiresAt: row.reserveExpiresAt,
    confirmExpiresAt: row.confirmExpiresAt,
    canReportInvalid: derived.canReportInvalid,
    isRequeuedWithPriority: row.priority > DEFAULT_QUEUE_PRIORITY,
  };
}

/** `waiting` 紀錄的全域排隊順位（優先權高者在前，同優先權依建立順序）。 */
async function fetchGlobalQueuePosition(
  db: DrizzleD1Database,
  waitingRow: MyQueueEntryRow
): Promise<number> {
  const aheadRow = await db
    .select({ waitingAheadCount: count() })
    .from(queueEntries)
    .where(
      and(
        eq(queueEntries.status, 'waiting'),
        or(
          gt(queueEntries.priority, waitingRow.priority),
          and(
            eq(queueEntries.priority, waitingRow.priority),
            or(
              lt(queueEntries.createdAt, waitingRow.createdAt),
              and(
                eq(queueEntries.createdAt, waitingRow.createdAt),
                lt(queueEntries.id, waitingRow.id)
              )
            )
          )
        )
      )
    )
    .get();

  return (aheadRow?.waitingAheadCount ?? 0) + 1;
}

function canReportInvalid(row: MyQueueEntryRow, invalidRetryCount: number, nowIso: string): boolean {
  return (
    row.status === 'revealed' &&
    row.slotStatus !== null &&
    canUserReportInvalid({
      slotStatus: row.slotStatus,
      invalidRetryCount,
      confirmExpiresAtIso: row.confirmExpiresAt,
      nowIso,
    })
  );
}

async function fetchMySharedLinks(
  db: DrizzleD1Database,
  providerUserId: number
): Promise<MySharedLinkDto[]> {
  const [linkRows, slotRows] = await Promise.all([
    db
      .select({
        id: inviteLinks.id,
        referralCode: inviteLinks.referralCode,
        normalizedUrl: inviteLinks.normalizedUrl,
        totalSlots: inviteLinks.totalSlots,
        createdAt: inviteLinks.createdAt,
      })
      .from(inviteLinks)
      .where(eq(inviteLinks.providerUserId, providerUserId))
      .orderBy(desc(inviteLinks.id)),
    db
      .select({
        id: inviteSlots.id,
        linkId: inviteSlots.linkId,
        status: inviteSlots.status,
        track: inviteSlots.track,
        confirmedAt: inviteSlots.confirmedAt,
        receiverNickname: receiverUsers.nickname,
        thankYouMessage: queueEntries.thankYouMessage,
      })
      .from(inviteSlots)
      .innerJoin(inviteLinks, eq(inviteLinks.id, inviteSlots.linkId))
      .leftJoin(receiverUsers, eq(receiverUsers.id, inviteSlots.assignedUserId))
      .leftJoin(
        queueEntries,
        and(eq(queueEntries.slotId, inviteSlots.id), eq(queueEntries.status, 'confirmed'))
      )
      .where(eq(inviteLinks.providerUserId, providerUserId))
      .orderBy(desc(inviteLinks.id), asc(inviteSlots.slotIndex)),
  ]);

  const slotsByLinkId = new Map<number, MySharedLinkDto['slots']>();
  for (const slot of slotRows) {
    const list = slotsByLinkId.get(slot.linkId) ?? [];
    list.push({
      id: slot.id,
      status: slot.status,
      track: parseQueueTrack(slot.track),
      receiverNickname: slot.receiverNickname,
      thankYouMessage: slot.status === 'confirmed' ? slot.thankYouMessage : null,
      confirmedAt: slot.confirmedAt,
    });
    slotsByLinkId.set(slot.linkId, list);
  }

  return linkRows.map((link) => ({
    ...link,
    slots: slotsByLinkId.get(link.id) ?? [],
  }));
}

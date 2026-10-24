import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { QueueStatus, SlotCount, SlotStatus } from '../../shared/types';

// schema 的真相來源是 migrations/ 的 SQL（wrangler 套用）。這裡的定義必須與 migrations 建出來的
// 資料庫一致，tests/integration/schemaDrift.test.ts 會逐項比對。

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  googleSub: text('google_sub').notNull().unique(),
  email: text('email').notNull().unique(),
  nickname: text('nickname').notNull(),
  invalidRetryCount: integer('invalid_retry_count').notNull().default(0),
  invalidLinkStrikeCount: integer('invalid_link_strike_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const inviteLinks = sqliteTable(
  'invite_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    providerUserId: integer('provider_user_id')
      .notNull()
      .references(() => users.id),
    referralCode: text('referral_code').notNull().unique(),
    normalizedUrl: text('normalized_url').notNull(),
    totalSlots: integer('total_slots').$type<SlotCount>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    check('invite_links_total_slots_check', sql`${table.totalSlots} IN (1, 2, 3)`),
    index('idx_invite_links_provider').on(table.providerUserId),
  ]
);

export const inviteSlots = sqliteTable(
  'invite_slots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    linkId: integer('link_id')
      .notNull()
      .references(() => inviteLinks.id),
    slotIndex: integer('slot_index').notNull(),
    status: text('status').$type<SlotStatus>().notNull(),
    assignedUserId: integer('assigned_user_id').references(() => users.id),
    reservedAt: text('reserved_at'),
    reserveExpiresAt: text('reserve_expires_at'),
    revealedAt: text('revealed_at'),
    confirmExpiresAt: text('confirm_expires_at'),
    confirmedAt: text('confirmed_at'),
    invalidatedAt: text('invalidated_at'),
    closedAt: text('closed_at'),
    createdAt: text('created_at').notNull(),
    // 沒有 CHECK 約束，讀出的值要經過 parseQueueTrack 才能當 QueueTrack 用。
    track: text('track').notNull().default('newbie'),
  },
  (table) => [
    check(
      'invite_slots_status_check',
      sql`${table.status} IN ('available', 'reserved', 'revealed', 'confirmed', 'invalidated', 'closed')`
    ),
    index('idx_invite_slots_status').on(table.status, table.createdAt),
    index('idx_invite_slots_link_id').on(table.linkId),
    index('idx_invite_slots_assigned_user').on(table.assignedUserId),
    index('idx_invite_slots_track_status').on(table.track, table.status, table.createdAt),
  ]
);

export const queueEntries = sqliteTable(
  'queue_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').$type<QueueStatus>().notNull(),
    priority: integer('priority').notNull().default(0),
    thankYouMessage: text('thank_you_message').notNull(),
    slotId: integer('slot_id').references(() => inviteSlots.id),
    reserveExpiresAt: text('reserve_expires_at'),
    confirmExpiresAt: text('confirm_expires_at'),
    confirmedAt: text('confirmed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    // 沒有 CHECK 約束，讀出的值要經過 parseQueueTrack 才能當 QueueTrack 用。
    track: text('track').notNull().default('newbie'),
  },
  (table) => [
    check(
      'queue_entries_status_check',
      sql`${table.status} IN ('waiting', 'reserved', 'revealed', 'confirmed', 'expired', 'cancelled')`
    ),
    index('idx_queue_entries_waiting_order').on(
      table.status,
      sql`${table.priority} DESC`,
      sql`${table.createdAt} ASC`,
      sql`${table.id} ASC`
    ),
    index('idx_queue_entries_user_id').on(table.userId, sql`${table.id} DESC`),
    index('idx_queue_entries_slot_id').on(table.slotId),
    uniqueIndex('idx_queue_entries_active_user')
      .on(table.userId)
      .where(sql`${table.status} IN ('waiting', 'reserved', 'revealed')`),
    uniqueIndex('idx_queue_entries_newbie_confirmed')
      .on(table.userId)
      .where(sql`${table.track} = 'newbie' AND ${table.status} = 'confirmed'`),
    index('idx_queue_entries_confirmed_order').on(
      table.status,
      sql`${table.confirmedAt} DESC`,
      sql`${table.id} DESC`
    ),
    index('idx_queue_entries_reserve_expires').on(
      table.status,
      sql`${table.reserveExpiresAt} ASC`,
      sql`${table.id} ASC`
    ),
    index('idx_queue_entries_confirm_expires').on(
      table.status,
      sql`${table.confirmExpiresAt} ASC`,
      sql`${table.id} ASC`
    ),
    index('idx_queue_entries_track_waiting').on(
      table.track,
      table.status,
      sql`${table.priority} DESC`,
      sql`${table.createdAt} ASC`,
      sql`${table.id} ASC`
    ),
  ]
);

export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_push_subscriptions_user_id').on(table.userId)]
);

export type UserSelect = typeof users.$inferSelect;

import { and, desc, eq, notInArray } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { pushSubscriptions } from '../db/schema';

export type StoredPushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

export class PushSubscriptionRepository {
  private readonly db: DrizzleD1Database;

  constructor(d1: D1Database) {
    this.db = drizzle(d1);
  }

  async upsertPushSubscription(params: {
    userId: number;
    endpoint: string;
    p256dh: string;
    auth: string;
    nowIso: string;
  }): Promise<void> {
    await this.db
      .insert(pushSubscriptions)
      .values({
        userId: params.userId,
        endpoint: params.endpoint,
        p256dh: params.p256dh,
        auth: params.auth,
        createdAt: params.nowIso,
        updatedAt: params.nowIso,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId: params.userId,
          p256dh: params.p256dh,
          auth: params.auth,
          updatedAt: params.nowIso,
        },
      })
      .run();
  }

  async fetchPushSubscriptionsByUserId(userId: number): Promise<StoredPushSubscriptionRow[]> {
    return this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all();
  }

  /** 只保留 `userId` 最近訂閱（`updated_at` 最新）的 `keepCount` 筆，刪掉其餘較舊的。 */
  async deleteOldestPushSubscriptionsBeyond(userId: number, keepCount: number): Promise<void> {
    const newestSubscriptionIds = this.db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(desc(pushSubscriptions.updatedAt), desc(pushSubscriptions.id))
      .limit(keepCount);

    await this.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          notInArray(pushSubscriptions.id, newestSubscriptionIds)
        )
      )
      .run();
  }

  /** 刪除 `endpoint` 的訂閱，但只限它屬於 `userId` 時；回傳是否真的刪了一筆（不屬於或不存在時為 `false`）。 */
  async deletePushSubscriptionOfUser(userId: number, endpoint: string): Promise<boolean> {
    const result = await this.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
      .run();
    return result.meta.changes > 0;
  }

  async deletePushSubscriptionByEndpoint(endpoint: string): Promise<void> {
    await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
  }
}

import { eq } from 'drizzle-orm';
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

  async deletePushSubscriptionByEndpoint(endpoint: string): Promise<void> {
    await this.db
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .run();
  }
}

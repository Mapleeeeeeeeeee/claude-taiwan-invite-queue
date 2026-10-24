import { and, eq, ne } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { users, type UserSelect } from '../db/schema';

type UserRow = UserSelect;

export class UserRepository {
  private readonly db: DrizzleD1Database;

  constructor(d1: D1Database) {
    this.db = drizzle(d1);
  }

  async findUserById(userId: number): Promise<UserRow | null> {
    const result = await this.db.select().from(users).where(eq(users.id, userId)).get();
    return result ?? null;
  }

  /**
   * 以 Google 帳號建立或更新使用者。
   * 新帳號的暱稱用 `defaultNickname`；已存在的帳號只有 `requestedNickname` 有值時才改暱稱，
   * 重新登入不會用 Google 顯示名稱覆蓋使用者自訂的暱稱。
   */
  async upsertUserByGoogleProfile(params: {
    googleSub: string;
    email: string;
    defaultNickname: string;
    requestedNickname?: string;
    nowIso: string;
  }): Promise<UserRow> {
    const existing = await this.db
      .select()
      .from(users)
      .where(eq(users.googleSub, params.googleSub))
      .get();

    if (existing) {
      const emailChanged = existing.email !== params.email;
      const nicknameChanged =
        params.requestedNickname !== undefined && existing.nickname !== params.requestedNickname;
      if (emailChanged || nicknameChanged) {
        const updates: Partial<{ email: string; nickname: string }> = {};
        if (emailChanged) updates.email = params.email;
        if (nicknameChanged) updates.nickname = params.requestedNickname;
        await this.db.update(users).set(updates).where(eq(users.id, existing.id)).run();
        return { ...existing, ...updates };
      }
      return existing;
    }

    const inserted = await this.db
      .insert(users)
      .values({
        googleSub: params.googleSub,
        email: params.email,
        nickname: params.requestedNickname ?? params.defaultNickname,
        invalidRetryCount: 0,
        invalidLinkStrikeCount: 0,
        createdAt: params.nowIso,
      })
      .returning()
      .get();

    return inserted;
  }

  /** 暱稱與現值相同時不寫入，D1 才不會把沒有變動的更新算成一次寫入。 */
  async updateUserNickname(userId: number, nickname: string): Promise<void> {
    await this.db
      .update(users)
      .set({ nickname })
      .where(and(eq(users.id, userId), ne(users.nickname, nickname)))
      .run();
  }

  /** 計數與現值相同時不寫入，原因同 `updateUserNickname`。 */
  async updateProviderStrikeCount(providerUserId: number, strikeCount: number): Promise<void> {
    await this.db
      .update(users)
      .set({ invalidLinkStrikeCount: strikeCount })
      .where(and(eq(users.id, providerUserId), ne(users.invalidLinkStrikeCount, strikeCount)))
      .run();
  }
}

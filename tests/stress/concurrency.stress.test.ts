import { describe, expect, it, vi } from "vitest";
import {
  THANK_YOU_WALL_LIMIT,
  type ApiSuccessResponse,
  type BoardDto,
  type MeDto,
} from "../../src/shared/types";
import { createApp, type Env } from "../../src/worker/index";
import { invalidateBoardCache } from "../../src/worker/queries/boardQuery";
import { createTestD1Database } from "../helpers/testD1";

const USER_COUNT = 100;
const PROVIDER_COUNT = 20;
const SLOTS_PER_LINK = 3;
const SLOT_COUNT = PROVIDER_COUNT * SLOTS_PER_LINK;
const RECEIVER_COUNT = USER_COUNT - PROVIDER_COUNT;
const WAITING_COUNT = RECEIVER_COUNT - SLOT_COUNT;

const MAX_YIELDS_PER_ACCESS = 4;
// 多個種子各自走出不同的交錯順序，避免只在某一種順序下碰巧通過。
const INTERLEAVING_SEEDS = [20261023, 1, 7, 42, 20240229, 987654321];

// 空閒時最慢的測試約 0.7 秒；多個 agent 同時跑讓機器 load average 超過 30 時會慢到超過預設的 5 秒而假紅，
// 所以給約 80 倍餘裕。用 vi.setConfig 只套在這個檔案，不動全域 testTimeout；
// 改成對每個 it 傳 timeout 會讓 prettier 把整個測試本體重排縮排。
const STRESS_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: STRESS_TEST_TIMEOUT_MS });

type TestSqlite = ReturnType<typeof createTestD1Database>["sqlite"];

/** 固定種子的偽隨機數，讓每次執行的交錯順序相同，失敗時可以重現。 */
function createSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * better-sqlite3 是同步的，`Promise.all` 的請求各自一路跑到底，不會在「讀可用席次」與
 * 「寫入配對」之間交錯，搶同一個名額的競態不會發生。這個裝飾器在每次 D1 存取前讓出事件迴圈，
 * 模擬 Workers 上每次 D1 往返都是真實 I/O 的情境。
 *
 * 讓出次數隨機而不是固定：固定次數時所有請求同步前進，會看到同一份資料而做出同一組配對，
 * 仍然搶不到同一個名額。
 */
function withInterleavedAccess(db: D1Database, seed: number): D1Database {
  const nextRandom = createSeededRandom(seed);
  const yieldToEventLoop = async (): Promise<void> => {
    const yieldCount = 1 + Math.floor(nextRandom() * MAX_YIELDS_PER_ACCESS);
    for (let i = 0; i < yieldCount; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  class YieldingStatement implements D1PreparedStatement {
    constructor(readonly inner: D1PreparedStatement) {}

    bind(...values: unknown[]): D1PreparedStatement {
      return new YieldingStatement(this.inner.bind(...values));
    }

    async first<T = unknown>(colName?: string): Promise<T | null> {
      await yieldToEventLoop();
      return colName === undefined
        ? this.inner.first<T>()
        : this.inner.first<T>(colName);
    }

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      await yieldToEventLoop();
      return this.inner.run<T>();
    }

    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      await yieldToEventLoop();
      return this.inner.all<T>();
    }

    raw<T = unknown[]>(options: {
      columnNames: true;
    }): Promise<[string[], ...T[]]>;
    raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
    async raw<T = unknown[]>(options?: {
      columnNames?: boolean;
    }): Promise<[string[], ...T[]] | T[]> {
      await yieldToEventLoop();
      return options?.columnNames
        ? this.inner.raw<T>({ columnNames: true })
        : this.inner.raw<T>();
    }
  }

  return {
    prepare: (query) => new YieldingStatement(db.prepare(query)),
    async batch<T = unknown>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> {
      await yieldToEventLoop();
      // 底層 batch 需要未包裝的 statement 才能同步執行整批交易。
      return db.batch<T>(
        statements.map((stmt) => (stmt as YieldingStatement).inner),
      );
    },
    exec: (query) => db.exec(query),
    dump: () => db.dump(),
    withSession: () => db.withSession(),
  };
}

interface StressUser {
  userId: number;
  cookie: string;
}

function createStressHarness(options: { interleavingSeed?: number }) {
  invalidateBoardCache();
  const { db: sqliteBackedDb, sqlite } = createTestD1Database();
  const env: Env = {
    DB:
      options.interleavingSeed === undefined
        ? sqliteBackedDb
        : withInterleavedAccess(sqliteBackedDb, options.interleavingSeed),
    ENVIRONMENT: "development",
    SESSION_SECRET: "stress-test-session-secret-key-12345",
    GOOGLE_CLIENT_ID: "stress-client-id",
    VAPID_PUBLIC_KEY: "stress-vapid-key",
  };
  const app = createApp({ now: () => new Date("2026-10-23T10:00:00.000Z") });

  async function loginUsers(count: number): Promise<StressUser[]> {
    return Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const res = await app.request(
          "/api/auth/dev-login",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: `stress_user_${i + 1}@example.com`,
              nickname: `用戶${i + 1}`,
            }),
          },
          env,
        );
        expect(res.status).toBe(200);
        const setCookie = res.headers.get("set-cookie");
        expect(setCookie).toContain("claude_tw_session=");
        const data = (await res.json()) as ApiSuccessResponse<{
          user: { id: number };
        }>;
        return { userId: data.data.user.id, cookie: setCookie!.split(";")[0]! };
      }),
    );
  }

  async function submitLinks(providers: StressUser[]): Promise<void> {
    await Promise.all(
      providers.map(async (provider, index) => {
        const code = `stressCode${index.toString().padStart(3, "0")}`;
        const res = await app.request(
          "/api/links",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: provider.cookie,
            },
            body: JSON.stringify({
              rawUrlInput: `https://claude.ai/referral/${code}?s=ios`,
              slotCount: SLOTS_PER_LINK,
            }),
          },
          env,
        );
        expect(res.status).toBe(201);
      }),
    );
  }

  async function joinQueue(receivers: StressUser[]): Promise<void> {
    await Promise.all(
      receivers.map(async (receiver, index) => {
        const res = await app.request(
          "/api/queue",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: receiver.cookie,
            },
            body: JSON.stringify({
              thankYouMessage: `謝謝大大分享！領取者編號 ${index + 1}`,
            }),
          },
          env,
        );
        expect(res.status).toBe(201);
      }),
    );
  }

  async function fetchMe(user: StressUser): Promise<MeDto> {
    const res = await app.request(
      "/api/me",
      { headers: { Cookie: user.cookie } },
      env,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as ApiSuccessResponse<MeDto>).data;
  }

  async function postAs(user: StressUser, path: string): Promise<Response> {
    return app.request(
      path,
      { method: "POST", headers: { Cookie: user.cookie } },
      env,
    );
  }

  return {
    app,
    env,
    sqlite,
    loginUsers,
    submitLinks,
    joinQueue,
    fetchMe,
    postAs,
  };
}

function findSlotsClaimedByMultipleEntries(sqlite: TestSqlite): unknown[] {
  return sqlite
    .prepare(
      `SELECT slot_id, COUNT(*) AS count
       FROM queue_entries
       WHERE slot_id IS NOT NULL
       GROUP BY slot_id
       HAVING COUNT(*) > 1`,
    )
    .all();
}

describe("壓力測試與資料一致性驗證 (Stress & Consistency)", () => {
  // D1 stub 是同步的，請求不會在讀寫之間交錯，所以這條測試驗證的是一整批流量走完全流程後
  // 數字對得上，不是搶名額的競態。競態由下一條測試負責。
  it("100 位使用者登入、20 組連結提交、80 位領取者排隊、解鎖、確認啟用後，名額、排隊順位與感謝牆數字一致", async () => {
    const {
      app,
      env,
      sqlite,
      loginUsers,
      submitLinks,
      joinQueue,
      fetchMe,
      postAs,
    } = createStressHarness({});

    // === Phase 1: 100 位使用者登入 ===
    const users = await loginUsers(USER_COUNT);
    expect(users).toHaveLength(USER_COUNT);

    const userDbCount = sqlite
      .prepare("SELECT COUNT(*) AS count FROM users")
      .get() as {
      count: number;
    };
    expect(userDbCount.count).toBe(USER_COUNT);

    // === Phase 2: 20 位提供者提交 20 組邀請連結（每組 3 個名額，共 60 個名額） ===
    await submitLinks(users.slice(0, PROVIDER_COUNT));

    const slotStats = sqlite
      .prepare(
        `SELECT status, COUNT(*) AS count FROM invite_slots GROUP BY status`,
      )
      .all() as Array<{ status: string; count: number }>;
    expect(slotStats).toEqual([{ status: "available", count: SLOT_COUNT }]);

    // === Phase 3: 80 位領取者排隊（60 個名額，20 人等候） ===
    const receivers = users.slice(PROVIDER_COUNT);
    expect(receivers).toHaveLength(RECEIVER_COUNT);
    await joinQueue(receivers);

    const receiverStates = await Promise.all(
      receivers.map(async (receiver) => {
        const me = await fetchMe(receiver);
        return {
          receiver,
          status: me.myQueue?.status,
          queuePosition: me.myQueue?.queuePosition,
        };
      }),
    );
    const matchedReceivers = receiverStates.filter(
      (r) => r.status === "reserved",
    );
    const waitingReceivers = receiverStates.filter(
      (r) => r.status === "waiting",
    );

    // 1. 剛好 60 個人拿到 reserved，剛好 20 個人進入 waiting
    expect(matchedReceivers).toHaveLength(SLOT_COUNT);
    expect(waitingReceivers).toHaveLength(WAITING_COUNT);

    // 2. 60 個 slot 全部轉為 reserved，無漏配
    const slotReservedCount = sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM invite_slots WHERE status = 'reserved'`,
      )
      .get() as { count: number };
    expect(slotReservedCount.count).toBe(SLOT_COUNT);

    // 3. 每個 reserved slot 都唯一對應 1 個 queue_entry
    expect(findSlotsClaimedByMultipleEntries(sqlite)).toHaveLength(0);

    // 4. 20 位 waiting 排隊者的排隊順位恰為 1 到 20，沒有重複也沒有缺號
    const waitingPositions = waitingReceivers
      .map((r) => r.queuePosition)
      .sort((a, b) => Number(a) - Number(b));
    expect(waitingPositions).toEqual(
      Array.from({ length: WAITING_COUNT }, (_, i) => i + 1),
    );

    // === Phase 4: 60 位獲配領取者解鎖看碼 ===
    const revealResults = await Promise.all(
      matchedReceivers.map(async ({ receiver }) => {
        const res = await postAs(receiver, "/api/queue/reveal");
        expect(res.status).toBe(200);
        const body = (await res.json()) as ApiSuccessResponse<{
          referralUrl: string;
        }>;
        expect(body.data.referralUrl).toMatch(
          /^https:\/\/claude\.ai\/referral\/stressCode/,
        );
        return body.data;
      }),
    );
    expect(revealResults).toHaveLength(SLOT_COUNT);

    // === Phase 5: 60 位領取者確認啟用 ===
    await Promise.all(
      matchedReceivers.map(async ({ receiver }) => {
        const res = await postAs(receiver, "/api/queue/confirm");
        expect(res.status).toBe(200);
      }),
    );

    // === Phase 6: 驗證感謝牆與看板資料彙整 ===
    invalidateBoardCache();
    const boardRes = await app.request("/api/board", { method: "GET" }, env);
    expect(boardRes.status).toBe(200);
    const board = ((await boardRes.json()) as ApiSuccessResponse<BoardDto>)
      .data;

    expect(board.totalConfirmedCount).toBe(SLOT_COUNT);
    expect(board.availableSlotsCount).toBe(0);
    expect(board.waitingQueueCount).toBe(WAITING_COUNT);
    // design 只說確認啟用的感謝小卡會刊登在感謝牆，沒有訂筆數上限；上限是實作選擇
    // （THANK_YOU_WALL_LIMIT）。60 張已確認的小卡超過上限，所以感謝牆應被截到上限筆數。
    expect(board.totalConfirmedCount).toBeGreaterThan(THANK_YOU_WALL_LIMIT);
    expect(board.thankYouWall).toHaveLength(THANK_YOU_WALL_LIMIT);
  });

  // Regression: 交錯時某一輪配對讀到過期的名額、被 guard 全部拒絕後不重試，名額與排隊者一直留著 (Round 4 B4 配對活性缺口)
  // 配對必須在同一個請求內重讀再配，名額與排隊者才不必等到下一次觸發才被配上。
  it.each(INTERLEAVING_SEEDS)(
    "每次 D1 存取都交錯時（種子 %i），80 位領取者搶 60 個名額，60 個名額全數保留給領取者、20 人繼續等候，且同一個名額不會配給兩位領取者",
    async (seed) => {
      const { sqlite, loginUsers, submitLinks, joinQueue } =
        createStressHarness({ interleavingSeed: seed });

      const users = await loginUsers(USER_COUNT);
      await submitLinks(users.slice(0, PROVIDER_COUNT));
      await joinQueue(users.slice(PROVIDER_COUNT));

      const countSlotsByStatus = (status: string) =>
        (
          sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM invite_slots WHERE status = ?`,
            )
            .get(status) as { count: number }
        ).count;
      const countEntriesByStatus = (status: string) =>
        (
          sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM queue_entries WHERE status = ?`,
            )
            .get(status) as { count: number }
        ).count;

      expect(countSlotsByStatus("reserved")).toBe(SLOT_COUNT);
      expect(countSlotsByStatus("available")).toBe(0);
      expect(countEntriesByStatus("reserved")).toBe(SLOT_COUNT);
      expect(countEntriesByStatus("waiting")).toBe(WAITING_COUNT);
      expect(findSlotsClaimedByMultipleEntries(sqlite)).toHaveLength(0);

      const reservedSlotsWithoutMatchingEntry = sqlite
        .prepare(
          `SELECT s.id FROM invite_slots s
           WHERE s.status = 'reserved'
             AND NOT EXISTS (
               SELECT 1 FROM queue_entries q
               WHERE q.slot_id = s.id AND q.status = 'reserved' AND q.user_id = s.assigned_user_id
             )`,
        )
        .all();
      expect(reservedSlotsWithoutMatchingEntry).toHaveLength(0);

      const reservedEntriesWithoutMatchingSlot = sqlite
        .prepare(
          `SELECT q.id FROM queue_entries q
           WHERE q.status = 'reserved'
             AND NOT EXISTS (
               SELECT 1 FROM invite_slots s
               WHERE s.id = q.slot_id AND s.status = 'reserved' AND s.assigned_user_id = q.user_id
             )`,
        )
        .all();
      expect(reservedEntriesWithoutMatchingSlot).toHaveLength(0);
    },
  );
});

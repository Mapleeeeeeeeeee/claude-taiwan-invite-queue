import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  THANK_YOU_WALL_LIMIT,
  type QueueStatus,
  type QueueTrack,
  type SlotStatus,
} from "../../src/shared/types";
import {
  BOARD_CACHE_TTL_MS,
  fetchBoardDto,
  invalidateBoardAndTotalConfirmedCount,
  invalidateBoardCache,
} from "../../src/worker/queries/boardQuery";
import { fetchMeDto } from "../../src/worker/queries/meQuery";
import { createTestD1Database } from "../helpers/testD1";

const NOW = new Date("2026-03-01T10:00:00.000Z");
const SERVER_CONFIG = {
  vapidPublicKey: "test-vapid-public-key",
  devLoginEnabled: false,
  googleClientId: "test-google-client-id",
};
const NOW_ISO = NOW.toISOString();

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

describe("看板與個人狀態查詢 (boardQuery)", () => {
  let db: D1Database;
  let sqlite: Database.Database;
  let recorded: RecordedStatement[];
  let recordingDb: D1Database;
  let nextSlotIndex: number;

  beforeEach(() => {
    invalidateBoardCache();
    const setup = createTestD1Database();
    db = setup.db;
    sqlite = setup.sqlite;
    recorded = [];
    nextSlotIndex = 1;
    // 包一層只記錄 SQL 與綁定值，查詢仍交給同一個資料庫執行。
    recordingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") {
          return Reflect.get(target, property, receiver);
        }
        return (sql: string): D1PreparedStatement => {
          const entry: RecordedStatement = { sql, binds: [] };
          recorded.push(entry);
          return new Proxy(target.prepare(sql), {
            get(statement, statementProperty, statementReceiver) {
              if (statementProperty !== "bind") {
                return Reflect.get(statement, statementProperty, statementReceiver);
              }
              return (...binds: unknown[]) => {
                entry.binds = binds;
                return statement.bind(...binds);
              };
            },
          });
        };
      },
    });
  });

  function seedUser(email: string): number {
    const info = sqlite
      .prepare(
        `INSERT INTO users (google_sub, email, nickname, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(`sub-${email}`, email, `暱稱-${email}`, NOW_ISO);
    return Number(info.lastInsertRowid);
  }

  function seedLink(providerUserId: number, referralCode: string): number {
    const info = sqlite
      .prepare(
        `INSERT INTO invite_links (provider_user_id, referral_code, normalized_url, total_slots, created_at)
         VALUES (?, ?, ?, 3, ?)`,
      )
      .run(
        providerUserId,
        referralCode,
        `https://claude.ai/referral/${referralCode}`,
        NOW_ISO,
      );
    return Number(info.lastInsertRowid);
  }

  function seedSlot(
    linkId: number,
    status: SlotStatus,
    track: string = "newbie",
    assignedUserId: number | null = null,
  ): number {
    const info = sqlite
      .prepare(
        `INSERT INTO invite_slots (link_id, slot_index, status, track, assigned_user_id, confirmed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        linkId,
        nextSlotIndex++,
        status,
        track,
        assignedUserId,
        status === "confirmed" ? NOW_ISO : null,
        NOW_ISO,
      );
    return Number(info.lastInsertRowid);
  }

  function seedConfirmedSlotsInBulk(linkId: number, count: number): void {
    const insert = sqlite.prepare(
      `INSERT INTO invite_slots (link_id, slot_index, status, confirmed_at, created_at)
       VALUES (?, ?, 'confirmed', ?, ?)`,
    );
    sqlite.transaction(() => {
      for (let i = 0; i < count; i += 1) {
        insert.run(linkId, nextSlotIndex++, NOW_ISO, NOW_ISO);
      }
    })();
  }

  function seedQueueEntry(
    userId: number,
    status: QueueStatus,
    options: {
      track?: QueueTrack;
      priority?: number;
      slotId?: number | null;
      createdAt?: Date;
    } = {},
  ): number {
    const info = sqlite
      .prepare(
        `INSERT INTO queue_entries
           (user_id, status, track, priority, thank_you_message, slot_id, confirmed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, '謝謝', ?, ?, ?, ?)`,
      )
      .run(
        userId,
        status,
        options.track ?? "newbie",
        options.priority ?? 0,
        options.slotId ?? null,
        status === "confirmed" ? NOW_ISO : null,
        (options.createdAt ?? NOW).toISOString(),
        NOW_ISO,
      );
    return Number(info.lastInsertRowid);
  }

  function msAfterNow(ms: number): Date {
    return new Date(NOW.getTime() + ms);
  }

  function confirmedCountStatements(): RecordedStatement[] {
    return recorded.filter(
      ({ sql, binds }) =>
        /count\(\*\)/i.test(sql) &&
        /from\W+invite_slots\b/i.test(sql) &&
        binds.includes("confirmed"),
    );
  }

  describe("看板分軌統計", () => {
    it("依軌道分別統計可領取席次與排隊人數，總數是兩軌相加", async () => {
      const provider = seedUser("provider@example.com");
      const link = seedLink(provider, "boardCounts");
      seedSlot(link, "available", "newbie");
      seedSlot(link, "available", "newbie");
      seedSlot(link, "available", "community");
      seedSlot(link, "reserved", "newbie");
      seedSlot(link, "confirmed", "community");
      seedQueueEntry(seedUser("q1@example.com"), "waiting", {
        track: "newbie",
      });
      seedQueueEntry(seedUser("q2@example.com"), "waiting", {
        track: "community",
      });
      seedQueueEntry(seedUser("q3@example.com"), "waiting", {
        track: "community",
      });
      seedQueueEntry(seedUser("q4@example.com"), "cancelled", {
        track: "community",
      });

      const board = await fetchBoardDto(db, NOW);

      expect(board).toMatchObject({
        availableSlotsCount: 3,
        newbieSlotsCount: 2,
        communitySlotsCount: 1,
        waitingQueueCount: 3,
        newbieQueueCount: 1,
        communityQueueCount: 2,
        totalConfirmedCount: 1,
      });
    });

    it("資料庫裡有未知軌道值的席次時，看板查詢拋錯而不是讓分軌數字加不起來", async () => {
      const provider = seedUser("provider@example.com");
      seedSlot(seedLink(provider, "boardBogusTrack"), "available", "bogus");

      await expect(fetchBoardDto(db, NOW)).rejects.toThrow("bogus");
    });
  });

  describe("totalConfirmedCount 的讀取成本", () => {
    it.each([1_000, 10_000])(
      "已有 %i 個 confirmed 席次時，15 秒快取過期後的重算不再掃描 confirmed 席次，數字沿用快取",
      async (confirmedSlotTotal) => {
        const link = seedLink(seedUser("provider@example.com"), "boardBulk");
        seedConfirmedSlotsInBulk(link, confirmedSlotTotal);

        const first = await fetchBoardDto(recordingDb, NOW);
        expect(first.totalConfirmedCount).toBe(confirmedSlotTotal);
        expect(confirmedCountStatements()).toHaveLength(1);

        recorded.length = 0;
        const recomputed = await fetchBoardDto(
          recordingDb,
          msAfterNow(BOARD_CACHE_TTL_MS + 1),
        );

        expect(recorded.length).toBeGreaterThan(0);
        expect(confirmedCountStatements()).toHaveLength(0);
        expect(recomputed.totalConfirmedCount).toBe(confirmedSlotTotal);
      },
    );

    it("寫入路徑讓看板快取失效後，重算仍沿用 confirmed 計數，available 數字則立刻更新", async () => {
      const link = seedLink(
        seedUser("provider@example.com"),
        "boardInvalidate",
      );
      seedConfirmedSlotsInBulk(link, 5);
      await fetchBoardDto(recordingDb, NOW);

      seedSlot(link, "available");
      seedSlot(link, "confirmed");
      invalidateBoardCache();
      recorded.length = 0;
      const board = await fetchBoardDto(recordingDb, msAfterNow(1));

      expect(confirmedCountStatements()).toHaveLength(0);
      expect(board.availableSlotsCount).toBe(1);
      expect(board.totalConfirmedCount).toBe(5);
    });

    it("confirmed 計數過了 60 秒後重新讀取，反映期間新增的 confirmed 席次", async () => {
      const link = seedLink(seedUser("provider@example.com"), "boardTtl");
      seedConfirmedSlotsInBulk(link, 5);
      await fetchBoardDto(recordingDb, NOW);
      seedSlot(link, "confirmed");

      const justBeforeSixtySeconds = await fetchBoardDto(
        recordingDb,
        msAfterNow(59_999),
      );
      invalidateBoardCache();
      const atSixtySeconds = await fetchBoardDto(recordingDb, msAfterNow(60_000));

      expect(justBeforeSixtySeconds.totalConfirmedCount).toBe(5);
      expect(atSixtySeconds.totalConfirmedCount).toBe(6);
    });

    it("席次被確認而清掉 confirmed 計數快取後，下一次讀取立刻反映新增的 confirmed 席次", async () => {
      const link = seedLink(seedUser("provider@example.com"), "boardConfirmed");
      seedConfirmedSlotsInBulk(link, 5);
      await fetchBoardDto(recordingDb, NOW);
      seedSlot(link, "confirmed");

      invalidateBoardAndTotalConfirmedCount();
      recorded.length = 0;
      const board = await fetchBoardDto(recordingDb, msAfterNow(1));

      expect(confirmedCountStatements()).toHaveLength(1);
      expect(board.totalConfirmedCount).toBe(6);
    });

    it("席次被確認時，確認前就開始數的 confirmed 計數不寫回快取", async () => {
      const link = seedLink(seedUser("provider@example.com"), "boardCountGeneration");
      seedConfirmedSlotsInBulk(link, 5);
      // 查詢在呼叫當下就讀取資料，所以這份結果是「確認前的快照」。
      const staleFetch = fetchBoardDto(db, NOW);
      seedSlot(link, "confirmed");
      invalidateBoardAndTotalConfirmedCount();

      const staleBoard = await staleFetch;
      const freshBoard = await fetchBoardDto(db, msAfterNow(1));

      expect(staleBoard.totalConfirmedCount).toBe(5);
      expect(freshBoard.totalConfirmedCount).toBe(6);
    });

    it("重算時送出的每一條看板查詢都走索引搜尋，不全表掃描席次與排隊紀錄", async () => {
      const link = seedLink(seedUser("provider@example.com"), "boardPlan");
      seedConfirmedSlotsInBulk(link, 50);
      await fetchBoardDto(recordingDb, NOW);
      recorded.length = 0;

      await fetchBoardDto(recordingDb, msAfterNow(BOARD_CACHE_TTL_MS + 1));

      expect(recorded.length).toBeGreaterThan(0);
      for (const { sql, binds } of recorded) {
        const planRows = sqlite
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...binds) as { detail: string }[];
        const fullScans = planRows
          .map((row) => row.detail)
          .filter((detail) =>
            /^SCAN (invite_slots|queue_entries)/.test(detail),
          );
        expect(fullScans, sql).toEqual([]);
      }
      expect(
        recorded.some(({ binds }) => binds.includes(THANK_YOU_WALL_LIMIT)),
      ).toBe(true);
    });
  });

  describe("看板快取失效", () => {
    it("失效前就開始查的看板結果不寫回快取，失效後的下一次請求讀到最新的資料", async () => {
      const link = seedLink(
        seedUser("provider@example.com"),
        "boardGeneration",
      );
      // 查詢在呼叫當下就讀取資料，所以這份結果是「失效前的快照」。
      const staleFetch = fetchBoardDto(db, NOW);
      seedSlot(link, "available");
      invalidateBoardCache();

      const staleBoard = await staleFetch;
      const freshBoard = await fetchBoardDto(db, msAfterNow(1));

      expect(staleBoard.availableSlotsCount).toBe(0);
      expect(freshBoard.availableSlotsCount).toBe(1);
    });
  });

  describe("個人狀態 fetchMeDto", () => {
    it("最新一筆排隊紀錄已是 confirmed 時，已確認領取沿用同一列", async () => {
      const userId = seedUser("claimer@example.com");
      const slotId = seedSlot(
        seedLink(seedUser("provider@example.com"), "meConfirmed"),
        "confirmed",
      );
      const entryId = seedQueueEntry(userId, "confirmed", { slotId });

      const me = await fetchMeDto(db, userId, SERVER_CONFIG, NOW);

      expect(me.myQueue).toMatchObject({ id: entryId, status: "confirmed" });
      expect(me.myConfirmedClaim).toMatchObject({
        id: entryId,
        status: "confirmed",
      });
      expect(me.user?.isEligibleForNewbieTrack).toBe(false);
    });

    it("再領取軌領取過又重新排隊時，目前排隊紀錄是 waiting，已確認領取仍是較早那筆 confirmed", async () => {
      const userId = seedUser("repeat@example.com");
      const slotId = seedSlot(
        seedLink(seedUser("provider@example.com"), "meRepeat"),
        "confirmed",
        "community",
      );
      const confirmedEntryId = seedQueueEntry(userId, "confirmed", {
        track: "community",
        slotId,
      });
      const waitingEntryId = seedQueueEntry(userId, "waiting", {
        track: "community",
      });

      const me = await fetchMeDto(db, userId, SERVER_CONFIG, NOW);

      expect(me.myQueue).toMatchObject({
        id: waitingEntryId,
        status: "waiting",
        queuePosition: 1,
      });
      expect(me.myConfirmedClaim).toMatchObject({
        id: confirmedEntryId,
        status: "confirmed",
      });
      expect(me.user?.isEligibleForNewbieTrack).toBe(false);
    });

    it("從未排隊過的使用者沒有排隊紀錄也沒有已確認領取，且具備新手資格", async () => {
      const userId = seedUser("fresh@example.com");

      const me = await fetchMeDto(db, userId, SERVER_CONFIG, NOW);

      expect(me.myQueue).toBeNull();
      expect(me.myConfirmedClaim).toBeNull();
      expect(me.user?.isEligibleForNewbieTrack).toBe(true);
    });

    // docs/design/dual-track-queue.md AC 9：queuePosition 是含優先權的 FIFO 順位，優先權高者在前，同優先權依建立時間。
    it("全域排隊順位把較高優先權與較早建立的 waiting 紀錄算在前面，之後才建立的不算", async () => {
      const mineUserId = seedUser("mine@example.com");
      // 資料列依序寫入，所以 id 順序與建立時間故意不同，順位不能只靠 id 或只靠優先權算出來。
      seedQueueEntry(mineUserId, "waiting", { createdAt: msAfterNow(1_000) });
      seedQueueEntry(seedUser("later@example.com"), "waiting", {
        createdAt: msAfterNow(2_000),
      });
      seedQueueEntry(seedUser("requeued@example.com"), "waiting", {
        priority: 1,
        createdAt: msAfterNow(3_000),
      });
      seedQueueEntry(seedUser("earlier@example.com"), "waiting", {
        createdAt: msAfterNow(0),
      });

      const me = await fetchMeDto(db, mineUserId, SERVER_CONFIG, NOW);

      expect(me.myQueue?.queuePosition).toBe(3);
    });

    it("排隊順位不分軌道一起算：排在前面的新手軌 waiting 紀錄，也算進再領取軌使用者的順位", async () => {
      seedQueueEntry(seedUser("newbieAhead@example.com"), "waiting", {
        track: "newbie",
      });
      const communityUserId = seedUser("communityMine@example.com");
      seedQueueEntry(communityUserId, "waiting", { track: "community" });

      const me = await fetchMeDto(db, communityUserId, SERVER_CONFIG, NOW);

      expect(me.myQueue?.queuePosition).toBe(2);
    });

    it.each([
      { priority: 0, expected: false, scenario: "預設優先權的新排隊紀錄" },
      {
        priority: 1,
        expected: true,
        scenario: "回報無效後被優先排回前面的紀錄",
      },
    ])(
      "$scenario 的 isRequeuedWithPriority 是 $expected",
      async ({ priority, expected }) => {
        const userId = seedUser("priority@example.com");
        seedQueueEntry(userId, "waiting", { priority });

        const me = await fetchMeDto(db, userId, SERVER_CONFIG, NOW);

        expect(me.myQueue?.isRequeuedWithPriority).toBe(expected);
      },
    );

    it("使用者重排過一次後再排新隊列，新的排隊紀錄 isRequeuedWithPriority 為 false 即使舊紀錄曾被提升", async () => {
      const userId = seedUser("again@example.com");
      seedQueueEntry(userId, "expired", { priority: 1 });
      seedQueueEntry(userId, "waiting", { priority: 0 });

      const me = await fetchMeDto(db, userId, SERVER_CONFIG, NOW);

      expect(me.myQueue).toMatchObject({
        status: "waiting",
        isRequeuedWithPriority: false,
      });
    });
  });
});

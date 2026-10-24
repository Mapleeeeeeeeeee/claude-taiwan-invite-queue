import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiErrorResponse,
  ApiSuccessResponse,
  MeDto,
  QueueStatus,
} from '../../src/shared/types';
import worker, { type Env, createApp, createServices } from '../../src/worker/index';
import { invalidateBoardCache } from '../../src/worker/queries/boardQuery';
import type { StoredPushSubscriptionRow } from '../../src/worker/repositories/pushSubscriptionRepository';
import {
  PushDeliveryError,
  type PushNotificationPayload,
  type PushSendResult,
} from '../../src/worker/services/webPushService';
import { type BackgroundContext, createBackgroundContext } from '../helpers/backgroundContext';
import { type RacingD1, createRacingD1 } from '../helpers/racingD1';
import {
  type AppInstance,
  type TestActor,
  fetchBoard,
  loginActor,
  parseJson,
} from '../helpers/testActor';
import { type StatementFailureInjector, createTestD1Database, dumpTables } from '../helpers/testD1';
import {
  type TestPushSubscriber,
  createTestPushSubscriber,
  readVerifiedVapidClaims,
} from '../helpers/webPushTestKeys';

const UNCOMPRESSED_P256_POINT_PREFIX = 0x04;

/** 產生一組真的 VAPID 金鑰，讓 cron 走產品碼的簽章與 fetch 送出路徑。 */
async function generateVapidEnv(): Promise<
  Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>
> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  if (!privateJwk.x || !privateJwk.y || !privateJwk.d) {
    throw new Error('exported VAPID JWK is missing x, y or d');
  }
  const uncompressedPublicKey = Buffer.concat([
    Buffer.from([UNCOMPRESSED_P256_POINT_PREFIX]),
    Buffer.from(privateJwk.x, 'base64url'),
    Buffer.from(privateJwk.y, 'base64url'),
  ]);
  return {
    VAPID_PUBLIC_KEY: uncompressedPublicKey.toString('base64url'),
    VAPID_PRIVATE_KEY: privateJwk.d,
    VAPID_SUBJECT: 'mailto:test@example.com',
  };
}

interface RecordedPush {
  userId: number;
  endpoint: string;
  payload: PushNotificationPayload;
}

describe('Invite Queue Backend Integration Flows (D1 + Service + Hono Router)', () => {
  let db: D1Database;
  let env: Env;
  let currentNow: Date;
  let recordedPushes: RecordedPush[];
  let endpointStatusOverrides: Map<string, number>;
  let endpointSenderErrors: Map<string, Error>;
  let pushGate: Promise<void> | null;
  let sqlite: Database.Database;
  let failureInjector: StatementFailureInjector;
  let app: AppInstance;

  beforeEach(() => {
    invalidateBoardCache();
    const setup = createTestD1Database();
    db = setup.db;
    sqlite = setup.sqlite;
    failureInjector = setup.failureInjector;
    currentNow = new Date('2026-03-01T10:00:00.000Z');
    recordedPushes = [];
    endpointStatusOverrides = new Map();
    endpointSenderErrors = new Map();
    pushGate = null;

    env = {
      DB: db,
      ENVIRONMENT: 'development',
      SESSION_SECRET: 'test-session-secret-key',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      VAPID_PUBLIC_KEY: 'test-vapid-public-key',
    };

    const mockPushSender = async (
      subscription: StoredPushSubscriptionRow,
      payload: PushNotificationPayload
    ): Promise<PushSendResult> => {
      await pushGate;
      const senderError = endpointSenderErrors.get(subscription.endpoint);
      if (senderError) {
        throw senderError;
      }
      const statusOverride = endpointStatusOverrides.get(subscription.endpoint);
      if (statusOverride !== undefined) {
        return { statusCode: statusOverride };
      }
      recordedPushes.push({
        userId: subscription.userId,
        endpoint: subscription.endpoint,
        payload,
      });
      return { statusCode: 201 };
    };

    app = createApp({ now: () => currentNow, pushSender: mockPushSender });
  });

  function advanceTimeMs(ms: number): void {
    currentNow = new Date(currentNow.getTime() + ms);
  }

  /** 提供者先分享名額，領取者再加入排隊，所以領取者立即獲配（reserved）。 */
  async function arrangeReservedClaim(
    slotCount: 1 | 2 | 3 = 1
  ): Promise<{ provider: TestActor; receiver: TestActor }> {
    const provider = await loginActor(app, env, 'p@example.com', '提供者P');
    const receiver = await loginActor(app, env, 'a@example.com', '使用者A');
    await provider.shareLink('https://claude.ai/referral/stateGuard01', slotCount);
    await receiver.joinQueue('感謝版友熱情分享邀請碼！');
    return { provider, receiver };
  }

  /** 直接讀資料庫，避免 `GET /api/me` 順手觸發逾時結算而改變狀態。 */
  function readQueueEntryStatus(userId: number): QueueStatus {
    const row = sqlite
      .prepare('SELECT status FROM queue_entries WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(userId) as { status: QueueStatus };
    return row.status;
  }

  /** 直接讀資料庫，依邀請代碼取得該連結底下唯一那個名額目前的狀態與持有者。 */
  function readSoleSlotOfLink(referralCode: string): {
    status: string;
    assignedUserId: number | null;
  } {
    const row = sqlite
      .prepare(
        `SELECT s.status AS status, s.assigned_user_id AS assignedUserId
         FROM invite_slots s JOIN invite_links l ON l.id = s.link_id
         WHERE l.referral_code = ?`
      )
      .get(referralCode) as { status: string; assignedUserId: number | null };
    return row;
  }

  /** 直接讀資料庫，取得使用者目前訂閱的推播網址。 */
  function readSubscribedEndpoints(userId: number): string[] {
    const rows = sqlite
      .prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY id')
      .all(userId) as { endpoint: string }[];
    return rows.map(({ endpoint }) => endpoint);
  }

  /** 讓推播 sender 卡住，直到回傳的函式被呼叫；用來確認請求沒有等推播送完。 */
  function holdPushesUntilReleased(): () => void {
    let release: () => void = () => {};
    pushGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  it('Journey 1 & 2: 排隊 → 提供者分享（自訂 2 個名額）→ 自動 FIFO 配對 → 解鎖（含冪等驗證）→ 確認啟用 → 感謝推播與上牆 (AC 1, 2, 3, 6)', async () => {
    const userA = await loginActor(app, env, 'a@example.com', '小華');
    const userB = await loginActor(app, env, 'b@example.com', '小美');
    const userC = await loginActor(app, env, 'c@example.com', '阿明');
    const providerP = await loginActor(app, env, 'p@example.com', '小張大大');

    await userA.subscribePush('https://fcm.googleapis.com/fcm/send/a');
    await userB.subscribePush('https://fcm.googleapis.com/fcm/send/b');
    await userC.subscribePush('https://fcm.googleapis.com/fcm/send/c');
    await providerP.subscribePush('https://fcm.googleapis.com/fcm/send/p');

    // A, B, C 依序加入排隊
    const joinA = await userA.joinQueue('謝謝小張大大分享邀請碼！祝你事事順心！');
    expect(joinA.status).toBe(201);

    advanceTimeMs(1000);
    await userB.joinQueue('感謝版友無私分享 Claude 邀請連結！');

    advanceTimeMs(1000);
    await userC.joinQueue('排隊等好久了，非常感謝分享！');

    // 驗證未有分享前 C 的排隊順位為第 3 位
    const meCBefore = await userC.getMe();
    expect(meCBefore.myQueue?.status).toBe('waiting');
    expect(meCBefore.myQueue?.queuePosition).toBe(3);

    // 提供者 P 分享含 2 個名額且夾帶 ?s=ios 參數的連結
    const shareRes = await providerP.shareLink(
      '這是我的邀請碼 https://claude.ai/referral/rNFlbuU0OA?s=ios 還剩兩次名額',
      2
    );
    expect(shareRes.status).toBe(201);
    const shareBody =
      await parseJson<ApiSuccessResponse<{ linkId: number; matchedCount: number }>>(shareRes);
    expect(shareBody.data.matchedCount).toBe(2);

    // 驗證 A、B 獲得保留並收到推播，C 前進至順位 1
    expect(recordedPushes).toHaveLength(2);
    expect(recordedPushes.map((p) => p.userId)).toEqual([userA.userId, userB.userId]);
    expect(recordedPushes[0]?.payload.title).toContain('輪到你領取 Claude 邀請碼');

    const meAReserved = await userA.getMe();
    expect(meAReserved.myQueue?.status).toBe('reserved');
    expect(meAReserved.myQueue?.referralUrl).toBeNull();
    expect(meAReserved.myQueue?.reserveExpiresAt).toBe('2026-03-01T16:00:02.000Z');

    const meBReserved = await userB.getMe();
    expect(meBReserved.myQueue?.status).toBe('reserved');
    expect(meBReserved.myQueue?.referralUrl).toBeNull();

    const meCWaiting = await userC.getMe();
    expect(meCWaiting.myQueue?.status).toBe('waiting');
    expect(meCWaiting.myQueue?.queuePosition).toBe(1);

    // A 點擊解鎖看碼 -> 狀態轉為 revealed，回傳正規化 URL 與 30 分鐘確認到期時間
    const revealRes = await userA.reveal();
    expect(revealRes.status).toBe(200);
    const revealBody =
      await parseJson<ApiSuccessResponse<{ referralUrl: string; confirmExpiresAt: string }>>(
        revealRes
      );
    expect(revealBody.data).toEqual({
      referralUrl: 'https://claude.ai/referral/rNFlbuU0OA',
      confirmExpiresAt: '2026-03-01T10:30:02.000Z',
    });

    // 冪等驗證：重複解鎖回傳相同資訊
    advanceTimeMs(5000);
    const secondRevealRes = await userA.reveal();
    expect(secondRevealRes.status).toBe(200);
    const secondRevealBody =
      await parseJson<ApiSuccessResponse<{ referralUrl: string; confirmExpiresAt: string }>>(
        secondRevealRes
      );
    expect(secondRevealBody.data).toEqual({
      referralUrl: 'https://claude.ai/referral/rNFlbuU0OA',
      confirmExpiresAt: '2026-03-01T10:30:02.000Z',
    });

    const meARevealed = await userA.getMe();
    expect(meARevealed.myQueue?.status).toBe('revealed');
    expect(meARevealed.myQueue?.referralUrl).toBe('https://claude.ai/referral/rNFlbuU0OA');
    expect(meARevealed.myQueue?.confirmExpiresAt).toBe('2026-03-01T10:30:02.000Z');
    expect(meARevealed.myQueue?.canReportInvalid).toBe(true);

    // A 確認啟用名額 -> 提供者 P 收到感謝推播，看板總統計與感謝牆更新
    const confirmRes = await userA.confirm();
    expect(confirmRes.status).toBe(200);

    const providerPushes = recordedPushes.filter((p) => p.userId === providerP.userId);
    expect(providerPushes).toHaveLength(1);
    expect(providerPushes[0]?.payload.title).toBe('你分享的邀請碼已成功幫助版友 小華');
    expect(providerPushes[0]?.payload.body).toContain('謝謝小張大大分享邀請碼！祝你事事順心！');

    const board = await fetchBoard(app, env);
    expect(board.totalConfirmedCount).toBe(1);
    expect(board.waitingQueueCount).toBe(1);
    expect(board.availableSlotsCount).toBe(0);
    expect(board.thankYouWall).toHaveLength(1);
    expect(board.thankYouWall[0]).toMatchObject({
      receiverNickname: '小華',
      providerNickname: '小張大大',
      thankYouMessage: '謝謝小張大大分享邀請碼！祝你事事順心！',
    });

    // 提供者 P 查看自己分享的連結清單
    const meP = await providerP.getMe();
    expect(meP.mySharedLinks).toHaveLength(1);
    expect(meP.mySharedLinks[0]?.normalizedUrl).toBe('https://claude.ai/referral/rNFlbuU0OA');
    expect(meP.mySharedLinks[0]?.slots).toHaveLength(2);
    expect(meP.mySharedLinks[0]?.slots[0]).toMatchObject({
      status: 'confirmed',
      receiverNickname: '小華',
      thankYouMessage: '謝謝小張大大分享邀請碼！祝你事事順心！',
    });
    expect(meP.mySharedLinks[0]?.slots[1]?.thankYouMessage).toBeNull();
  });

  it('提供者自己的再領取票排在前面時，同軌道的領取者仍立即獲配，提供者本人維持 waiting (AC 4)', async () => {
    const providerP = await loginActor(app, env, 'provider@example.com', '提供者小張');
    const receiverA = await loginActor(app, env, 'receiver@example.com', '領取者阿明');

    // 提供者 P 在無人排隊時分享 1 個名額（開放社群互助軌道）
    const shareRes = await providerP.shareLink(
      'https://claude.ai/referral/poolSlot01',
      1,
      'community'
    );
    expect(shareRes.status).toBe(201);

    // 提供者 P 自己加入排隊（再領取軌）-> 嚴格禁止配給自己，必須維持 waiting
    const pJoinRes = await providerP.joinQueue('我也想排隊看看會不會領到自己的', 'community');
    expect(pJoinRes.status).toBe(201);
    const pJoinBody =
      await parseJson<ApiSuccessResponse<{ queueEntryId: number; status: QueueStatus }>>(pJoinRes);
    expect(pJoinBody.data.status).toBe('waiting');

    // 領取者 A 加入同一條軌道。P 的票排在 A 前面，撮合要跳過它，A 才拿得到 P 的名額 (reserved)
    const aJoinRes = await receiverA.joinQueue('謝謝提供者小張分享邀請連結！', 'community');
    expect(aJoinRes.status).toBe(201);
    const aJoinBody =
      await parseJson<ApiSuccessResponse<{ queueEntryId: number; status: QueueStatus }>>(aJoinRes);
    expect(aJoinBody.data.status).toBe('reserved');
  });

  it('6 小時未解鎖逾時回收並自動轉配下一位 (AC 5)', async () => {
    const providerP = await loginActor(app, env, 'p@example.com', '提供者');
    const userA = await loginActor(app, env, 'a@example.com', '逾時者A');
    const userB = await loginActor(app, env, 'b@example.com', '下一位B');

    await userA.subscribePush('https://fcm.googleapis.com/fcm/send/a');
    await userB.subscribePush('https://fcm.googleapis.com/fcm/send/b');

    await userA.joinQueue('謝謝分享，這是 A 的感謝小卡');
    advanceTimeMs(1000);
    await userB.joinQueue('謝謝分享，這是 B 的感謝小卡');

    await providerP.shareLink('https://claude.ai/referral/timeoutSlot1', 1);

    expect((await userA.getMe()).myQueue?.status).toBe('reserved');
    expect((await userB.getMe()).myQueue?.status).toBe('waiting');
    recordedPushes.length = 0;

    // 快進 6 小時 + 1 分鐘
    advanceTimeMs(6 * 60 * 60 * 1000 + 60_000);

    const { inviteQueueService } = createServices(env, {
      now: () => currentNow,
      pushSender: async (subscription, payload) => {
        recordedPushes.push({
          userId: subscription.userId,
          endpoint: subscription.endpoint,
          payload,
        });
        return { statusCode: 201 };
      },
    });
    const expireStats = await inviteQueueService.processExpirations(currentNow);
    expect(expireStats).toEqual({
      expiredReservations: 1,
      autoConfirmedSlots: 0,
    });

    const meAAfterExpire = await userA.getMe();
    expect(meAAfterExpire.myQueue?.status).toBe('expired');

    // 逾時後 A 嘗試解鎖應收到 409 RESERVATION_EXPIRED
    const revealAfterExpire = await userA.reveal();
    expect(revealAfterExpire.status).toBe(409);
    const errBody = await parseJson<ApiErrorResponse>(revealAfterExpire);
    expect(errBody.error.code).toBe('RESERVATION_EXPIRED');
    expect(errBody.error.message).toBe('名額保留已逾時，若仍需要請重新加入排隊');

    // 驗證 B 自動被指派該名額並收到推播
    const meBAfterReassign = await userB.getMe();
    expect(meBAfterReassign.myQueue?.status).toBe('reserved');
    expect(recordedPushes).toHaveLength(1);
    expect(recordedPushes[0]?.userId).toBe(userB.userId);

    // A 前次登記已 expired，可重新排隊於隊尾
    const rejoinRes = await userA.joinQueue('不好意思剛剛沒看到通知，重新排隊謝謝！');
    expect(rejoinRes.status).toBe(201);
    expect((await userA.getMe()).myQueue?.status).toBe('waiting');
  });

  it('6 小時保留逾時且隊伍中無其他排隊者時，名額退回 available 狀態', async () => {
    const providerP = await loginActor(app, env, 'p@example.com', '提供者');
    const userA = await loginActor(app, env, 'a@example.com', '唯一排隊者A');

    await providerP.shareLink('https://claude.ai/referral/returnToPool1', 1);
    await userA.joinQueue('感謝提供者無私分享名額！');

    expect((await fetchBoard(app, env)).availableSlotsCount).toBe(0);

    // 快進超過 6 小時且無人排隊
    advanceTimeMs(6 * 60 * 60 * 1000 + 1000);

    const meA = await userA.getMe();
    expect(meA.myQueue?.status).toBe('expired');

    const boardAfterExpire = await fetchBoard(app, env);
    expect(boardAfterExpire.availableSlotsCount).toBe(1);
  });

  describe('累計已領取數 totalConfirmedCount 的更新時機', () => {
    const BOARD_CACHE_MS = 15_000;
    const CONFIRM_WINDOW_MS = 30 * 60 * 1000;

    /** 提供者分享一個名額、領取者獲配並解鎖，回傳尚未確認的領取者。 */
    async function arrangeRevealedClaim(): Promise<TestActor> {
      const { receiver } = await arrangeReservedClaim();
      const revealRes = await receiver.reveal();
      expect(revealRes.status).toBe(200);
      return receiver;
    }

    it('看板已顯示累計已領取 0 時，領取者按下確認啟用後，下一次讀看板就顯示 1', async () => {
      const receiver = await arrangeRevealedClaim();
      expect((await fetchBoard(app, env)).totalConfirmedCount).toBe(0);

      const confirmRes = await receiver.confirm();
      expect(confirmRes.status).toBe(200);

      expect((await fetchBoard(app, env)).totalConfirmedCount).toBe(1);
    });

    it('看板已顯示累計已領取 0 時，解鎖逾 30 分鐘由看板讀取觸發自動確認，同一次讀取就顯示 1', async () => {
      const receiver = await arrangeRevealedClaim();
      // 讀看板的時間點離確認期限很近，快取過 15 秒就過期，但離上次數 confirmed 名額還不到 60 秒。
      advanceTimeMs(CONFIRM_WINDOW_MS - BOARD_CACHE_MS);
      expect((await fetchBoard(app, env)).totalConfirmedCount).toBe(0);
      advanceTimeMs(BOARD_CACHE_MS + 1000);

      const board = await fetchBoard(app, env);

      expect(readQueueEntryStatus(receiver.userId)).toBe('confirmed');
      expect(board.totalConfirmedCount).toBe(1);
    });
  });

  it('解鎖滿 30 分鐘未操作自動確認並送出感謝，且重複觸發不重複發推播 (AC 7)', async () => {
    const providerP = await loginActor(app, env, 'p@example.com', '提供者小張');
    const userA = await loginActor(app, env, 'a@example.com', '忘記按確認的領取者');

    await providerP.subscribePush('https://fcm.googleapis.com/fcm/send/provider');
    await providerP.shareLink('https://claude.ai/referral/autoConfirm1', 1);
    await userA.joinQueue('非常感謝提供邀請碼，祝萬事如意！');

    const revealRes = await userA.reveal();
    expect(revealRes.status).toBe(200);
    expect(recordedPushes).toHaveLength(0);

    // 快進 30 分鐘 + 1 秒
    advanceTimeMs(30 * 60 * 1000 + 1000);
    invalidateBoardCache();

    // 觸發看板讀取（看板過期時會觸發延遲結算 processExpirations）
    const board = await fetchBoard(app, env);
    expect(board.totalConfirmedCount).toBe(1);
    expect(board.thankYouWall).toHaveLength(1);
    expect(board.thankYouWall[0]?.thankYouMessage).toBe('非常感謝提供邀請碼，祝萬事如意！');

    // 提供者精準收到 1 次推播通知
    expect(recordedPushes).toHaveLength(1);
    expect(recordedPushes[0]?.userId).toBe(providerP.userId);
    expect(recordedPushes[0]?.payload.title).toContain('忘記按確認的領取者');

    // 再次手動確認不得重複發送推播
    const manualConfirmRes = await userA.confirm();
    expect(manualConfirmRes.status).toBe(200);
    expect(recordedPushes).toHaveLength(1);
  });

  it('回報無效、同組剩餘名額停用、優先重排與終身 1 次重排限制 (AC 8, AC 9)', async () => {
    const providerP1 = await loginActor(app, env, 'p1@example.com', '記錯名額的提供者P1');
    const providerP2 = await loginActor(app, env, 'p2@example.com', '第二位提供者P2');
    const userA = await loginActor(app, env, 'a@example.com', '領取者A');
    const userB = await loginActor(app, env, 'b@example.com', '一般排隊者B');

    // P1 分享 3 個名額
    await providerP1.shareLink('https://claude.ai/referral/badLinkP1', 3);

    // A 加入並解鎖名額 #1，名額 #2 與 #3 仍為 available
    await userA.joinQueue('謝謝分享 Claude 邀請碼！');
    await userA.reveal();

    const reportRes = await userA.reportInvalid();
    expect(reportRes.status).toBe(200);
    const reportBody =
      await parseJson<ApiSuccessResponse<{ requeuedStatus: QueueStatus }>>(reportRes);
    expect(reportBody.data.requeuedStatus).toBe('waiting');

    // 驗證 P1 的名額狀態：#1 為 invalidated，#2 與 #3 關閉為 closed
    const meP1 = await providerP1.getMe();
    expect(meP1.mySharedLinks[0]?.slots.map((s) => s.status)).toEqual([
      'invalidated',
      'closed',
      'closed',
    ]);

    // B 隨後加入；A 擁有 priority=1，排在順位 1
    await userB.joinQueue('我是 B，也想排隊領邀請碼謝謝！');

    const meARequeued = await userA.getMe();
    expect(meARequeued.myQueue?.status).toBe('waiting');
    expect(meARequeued.myQueue?.queuePosition).toBe(1);
    expect(meARequeued.user?.invalidRetryCount).toBe(1);

    const meBWaiting = await userB.getMe();
    expect(meBWaiting.myQueue?.status).toBe('waiting');
    expect(meBWaiting.myQueue?.queuePosition).toBe(2);

    // P2 分享 1 個名額 -> 優先配對給 A
    await providerP2.shareLink('https://claude.ai/referral/goodLinkP2', 1);

    const meASecondMatch = await userA.getMe();
    expect(meASecondMatch.myQueue?.status).toBe('reserved');

    // A 解鎖第 2 個連結 -> canReportInvalid 必須為 false（終身 1 次）
    await userA.reveal();

    const meASecondRevealed = await userA.getMe();
    expect(meASecondRevealed.myQueue?.status).toBe('revealed');
    expect(meASecondRevealed.myQueue?.canReportInvalid).toBe(false);

    // 二次嘗試回報無效應收到 409 RETRY_QUOTA_EXHAUSTED
    const secondReportRes = await userA.reportInvalid();
    expect(secondReportRes.status).toBe(409);
    const secondReportErr = await parseJson<ApiErrorResponse>(secondReportRes);
    expect(secondReportErr.error.code).toBe('RETRY_QUOTA_EXHAUSTED');
    expect(secondReportErr.error.message).toBe('每個帳號僅限使用 1 次無效重排機會');

    // A 確認第 2 個名額後，禁止再次加入新手排隊 (409 NEWBIE_TRACK_ONLY)
    await userA.confirm();

    const joinAgainRes = await userA.joinQueue('想再領第二次可以嗎？', 'newbie');
    expect(joinAgainRes.status).toBe(409);
    const joinAgainErr = await parseJson<ApiErrorResponse>(joinAgainRes);
    expect(joinAgainErr.error.code).toBe('NEWBIE_TRACK_ONLY');
    expect(joinAgainErr.error.message).toBe(
      '你已成功領取過新手體驗名額囉！若欲為第二個帳號領取，請選擇「再領取」軌道'
    );

    // 但 A 可以選擇「再領取」軌道排隊
    const joinCommunityRes = await userA.joinQueue('為我的第二個工作帳號排隊！', 'community');
    expect(joinCommunityRes.status).toBe(201);
  });

  it('回報無效時同組名額隔離：只關閉 available 名額，已配對給他人的 reserved 名額不受影響；且當池中有其他可用名額時立即重配為 reserved', async () => {
    const providerP1 = await loginActor(app, env, 'p1@example.com', 'P1');
    const providerP2 = await loginActor(app, env, 'p2@example.com', 'P2');
    const userA = await loginActor(app, env, 'a@example.com', 'A');
    const userB = await loginActor(app, env, 'b@example.com', 'B');

    // P1 分享 3 個名額 (#1, #2, #3)
    await providerP1.shareLink('https://claude.ai/referral/siblingTestP1', 3);

    // P2 同時分享 1 個名額
    await providerP2.shareLink('https://claude.ai/referral/backupPoolP2', 1);

    // A 與 B 分別加入排隊，獲配 P1 的 #1 與 #2；P1 的 #3 與 P2 的 #1 處於 available
    await userA.joinQueue('感謝分享邀請碼給 A！');
    await userB.joinQueue('感謝分享邀請碼給 B！');

    // A 解鎖 P1 的名額 #1 並回報無效
    await userA.reveal();
    const reportRes = await userA.reportInvalid();
    expect(reportRes.status).toBe(200);
    const reportBody =
      await parseJson<ApiSuccessResponse<{ requeuedStatus: QueueStatus }>>(reportRes);
    // 池中有 P2 釋出的可用名額，A 立即重配為 reserved！
    expect(reportBody.data.requeuedStatus).toBe('reserved');

    // 驗證 P1 的名額狀態：#1 為 invalidated，#2 依然保留給 B (reserved)，#3 關閉 (closed)
    const meP1 = await providerP1.getMe();
    expect(meP1.mySharedLinks[0]?.slots.map((s) => s.status)).toEqual([
      'invalidated',
      'reserved',
      'closed',
    ]);

    // 驗證 B 的名額不受干擾，依然能正常解鎖看碼
    const meB = await userB.getMe();
    expect(meB.myQueue?.status).toBe('reserved');
    const revealB = await userB.reveal();
    expect(revealB.status).toBe(200);
  });

  describe('不允許的狀態轉移與重複排隊', () => {
    const DUPLICATE_JOIN_MESSAGE = '你已經在排隊或領取流程中囉';
    const CANNOT_CANCEL_MESSAGE = '目前的狀態無法取消排隊';

    async function expectJoinRejectedAsAlreadyInQueue(user: TestActor): Promise<void> {
      const res = await user.joinQueue('重複送出排隊請求測試');
      expect(res.status).toBe(409);
      const err = await parseJson<ApiErrorResponse>(res);
      expect(err.error.code).toBe('ALREADY_IN_QUEUE');
      expect(err.error.message).toBe(DUPLICATE_JOIN_MESSAGE);
    }

    it('隊列沒有名額、使用者在 waiting 狀態再次加入排隊時，被 409 ALREADY_IN_QUEUE 擋下', async () => {
      const user = await loginActor(app, env, 'a@example.com', '使用者A');
      await user.joinQueue('感謝版友熱情分享邀請碼！');
      expect((await user.getMe()).myQueue?.status).toBe('waiting');

      await expectJoinRejectedAsAlreadyInQueue(user);
    });

    it('已獲配名額、使用者在 reserved 狀態再次加入排隊時，被 409 ALREADY_IN_QUEUE 擋下', async () => {
      const { receiver } = await arrangeReservedClaim();
      expect((await receiver.getMe()).myQueue?.status).toBe('reserved');

      await expectJoinRejectedAsAlreadyInQueue(receiver);
    });

    it('已解鎖看碼、使用者在 revealed 狀態再次加入排隊時，被 409 ALREADY_IN_QUEUE 擋下', async () => {
      const { receiver } = await arrangeReservedClaim();
      await receiver.reveal();

      await expectJoinRejectedAsAlreadyInQueue(receiver);
    });

    it('使用者在 reserved 狀態取消排隊時，名額立即轉配給等候中的下一位', async () => {
      const { provider, receiver: userA } = await arrangeReservedClaim();
      const userB = await loginActor(app, env, 'b@example.com', '使用者B');
      await userB.joinQueue('我是 B，排在 A 後面等待名額！');
      expect((await userB.getMe()).myQueue?.status).toBe('waiting');

      const cancelRes = await userA.cancelQueue('POST');

      expect(cancelRes.status).toBe(200);
      expect((await userA.getMe()).myQueue?.status).toBe('cancelled');
      expect((await userB.getMe()).myQueue?.status).toBe('reserved');
      expect((await provider.getMe()).mySharedLinks[0]?.slots[0]?.status).toBe('reserved');
    });

    it('使用者在 revealed 狀態取消排隊被 409 INVALID_STATE_TRANSITION 擋下，名額不退回 available', async () => {
      const { receiver } = await arrangeReservedClaim();
      await receiver.reveal();

      const cancelRes = await receiver.cancelQueue('POST');

      expect(cancelRes.status).toBe(409);
      const err = await parseJson<ApiErrorResponse>(cancelRes);
      expect(err.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(err.error.message).toBe(CANNOT_CANCEL_MESSAGE);
      expect((await fetchBoard(app, env)).availableSlotsCount).toBe(0);
    });

    it('使用者從沒排過隊就取消排隊，被 404 QUEUE_ENTRY_NOT_FOUND 擋下', async () => {
      const user = await loginActor(app, env, 'neverQueued@example.com', '沒排過隊的使用者');

      const cancelRes = await user.cancelQueue('POST');

      expect(cancelRes.status).toBe(404);
      expect((await parseJson<ApiErrorResponse>(cancelRes)).error.code).toBe(
        'QUEUE_ENTRY_NOT_FOUND'
      );
    });

    it.each([
      {
        latestStatus: 'cancelled',
        arrange: async () => {
          const user = await loginActor(app, env, 'cancelTwice@example.com', '取消過的使用者');
          await user.joinQueue('我先排隊再取消');
          await user.cancelQueue('POST');
          return user;
        },
      },
      {
        latestStatus: 'expired',
        arrange: async () => {
          const { receiver } = await arrangeReservedClaim();
          advanceTimeMs(6 * 60 * 60 * 1000 + 1000);
          return receiver;
        },
      },
    ])(
      '最新的排隊紀錄已是 $latestStatus 時取消排隊，被 409 INVALID_STATE_TRANSITION 擋下，紀錄維持 $latestStatus',
      async ({ latestStatus, arrange }) => {
        const user = await arrange();

        const cancelRes = await user.cancelQueue('POST');

        expect(cancelRes.status).toBe(409);
        const err = await parseJson<ApiErrorResponse>(cancelRes);
        expect(err.error.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.error.message).toBe(CANNOT_CANCEL_MESSAGE);
        expect((await user.getMe()).myQueue?.status).toBe(latestStatus);
      }
    );

    it('使用者在 confirmed 狀態取消排隊被 409 INVALID_STATE_TRANSITION 擋下', async () => {
      const { receiver } = await arrangeReservedClaim();
      await receiver.reveal();
      await receiver.confirm();

      const cancelRes = await receiver.cancelQueue('POST');

      expect(cancelRes.status).toBe(409);
      expect((await parseJson<ApiErrorResponse>(cancelRes)).error.code).toBe(
        'INVALID_STATE_TRANSITION'
      );
    });

    it('使用者在 confirmed 狀態回報無效被 409 CONFIRM_WINDOW_EXPIRED 擋下，文案說明已完成啟用', async () => {
      const { receiver } = await arrangeReservedClaim();
      await receiver.reveal();
      await receiver.confirm();

      const reportRes = await receiver.reportInvalid();

      expect(reportRes.status).toBe(409);
      const err = await parseJson<ApiErrorResponse>(reportRes);
      expect(err.error.code).toBe('CONFIRM_WINDOW_EXPIRED');
      expect(err.error.message).toBe('此名額已完成啟用與感謝回饋，無法再變更狀態');
    });

    // docs/arch/invite-code-queue.md「交易與一致性」：重複回報時 invalid_retry_count 已是 1 且紀錄已回到 waiting，回 409。
    it('回報無效成功後立刻再送一次回報，被 409 RETRY_QUOTA_EXHAUSTED 擋下，排隊紀錄維持 waiting 且只扣一次重排次數', async () => {
      const { receiver } = await arrangeReservedClaim(3);
      await receiver.reveal();
      expect((await receiver.reportInvalid()).status).toBe(200);

      const duplicateRes = await receiver.reportInvalid();

      expect(duplicateRes.status).toBe(409);
      expect((await parseJson<ApiErrorResponse>(duplicateRes)).error.code).toBe(
        'RETRY_QUOTA_EXHAUSTED'
      );
      const me = await receiver.getMe();
      expect(me.myQueue).toMatchObject({ status: 'waiting', queuePosition: 1 });
      expect(me.user?.invalidRetryCount).toBe(1);
    });

    // docs/arch/invite-code-queue.md Flow 3：超過 30 分鐘時名額已自動轉為 confirmed，回報無效拋出 CONFIRM_WINDOW_EXPIRED。
    it('解鎖滿 30 分鐘後才回報無效，被 409 CONFIRM_WINDOW_EXPIRED 擋下，名額已自動確認且沒有扣重排次數', async () => {
      const { receiver } = await arrangeReservedClaim();
      await receiver.reveal();
      advanceTimeMs(30 * 60 * 1000 + 1000);

      const reportRes = await receiver.reportInvalid();

      expect(reportRes.status).toBe(409);
      expect((await parseJson<ApiErrorResponse>(reportRes)).error.code).toBe(
        'CONFIRM_WINDOW_EXPIRED'
      );
      const me = await receiver.getMe();
      expect(me.myQueue?.status).toBe('confirmed');
      expect(me.user?.invalidRetryCount).toBe(0);
    });

    it('名額已被回報為 invalidated 時，滿 30 分鐘也不會被自動確認', async () => {
      const { provider, receiver } = await arrangeReservedClaim();
      await receiver.reveal();
      await receiver.reportInvalid();

      advanceTimeMs(45 * 60 * 1000);
      const { inviteQueueService } = createServices(env, {
        now: () => currentNow,
      });
      const expireStats = await inviteQueueService.processExpirations(currentNow);

      expect(expireStats.autoConfirmedSlots).toBe(0);
      expect((await provider.getMe()).mySharedLinks[0]?.slots[0]?.status).toBe('invalidated');
    });
  });

  it('回報無效重排優先權：後加入但 priority=1 的重排者排在較早加入的 priority=0 排隊者前面', async () => {
    const providerP1 = await loginActor(app, env, 'p1@example.com', 'P1');
    const providerP2 = await loginActor(app, env, 'p2@example.com', 'P2');
    const userA = await loginActor(app, env, 'a@example.com', '先領到壞碼的A');
    const userB = await loginActor(app, env, 'b@example.com', '早就在排隊的B');

    await userA.joinQueue('感謝版友分享邀請連結 A！');
    advanceTimeMs(1000);
    await userB.joinQueue('感謝版友分享邀請連結 B！');

    // P1 分享 1 個名額 -> A 獲配、解鎖並回報無效，以 priority=1 重排
    await providerP1.shareLink('https://claude.ai/referral/p1SingleInvalid', 1);
    await userA.reveal();
    await userA.reportInvalid();

    // A 與 B 均在等候中；A 具備優先權為順位 1，B 為順位 2
    expect((await userA.getMe()).myQueue?.queuePosition).toBe(1);
    expect((await userB.getMe()).myQueue?.queuePosition).toBe(2);

    // P2 分享 1 個名額 -> 優先配給 A
    await providerP2.shareLink('https://claude.ai/referral/p2SingleGood', 1);
    expect((await userA.getMe()).myQueue?.status).toBe('reserved');
    expect((await userB.getMe()).myQueue?.status).toBe('waiting');
  });

  it('提供者好心人保護與累計 2 組完全無效連結停權 (AC 10)', async () => {
    const providerP = await loginActor(app, env, 'p@example.com', '提供者P');
    const user1 = await loginActor(app, env, 'u1@example.com', '版友1');
    const user2 = await loginActor(app, env, 'u2@example.com', '版友2');
    const user3 = await loginActor(app, env, 'u3@example.com', '版友3');
    const user4 = await loginActor(app, env, 'u4@example.com', '版友4');

    // 連結 #1 (2 個名額)：user1 啟用成功，user2 回報無效
    await user1.joinQueue('感謝分享，我成功啟用了！');
    await user2.joinQueue('感謝分享，我也來試試看！');
    await providerP.shareLink('https://claude.ai/referral/partialGoodLink1', 2);

    await user1.reveal();
    await user1.confirm();

    await user2.reveal();
    await user2.reportInvalid();

    // 連結 #1 至少有 1 個 confirmed -> 非完全無效連結！違規記點為 0
    const mePAfterLink1 = await providerP.getMe();
    expect(mePAfterLink1.user?.invalidLinkStrikeCount).toBe(0);
    expect(mePAfterLink1.user?.isProviderBlocked).toBe(false);

    // 取消 user2 重排的票券以進行後續乾淨測試
    await user2.cancelQueue('POST');

    // 連結 #2 (3 個名額)：0 個 confirmed，1 個 invalidated，2 個 closed -> 記點 1
    await user3.joinQueue('謝謝提供者分享邀請連結！');
    const link2Res = await providerP.shareLink('https://claude.ai/referral/completelyBadLink2', 3);
    expect(link2Res.status).toBe(201);

    await user3.reveal();
    await user3.reportInvalid();
    await user3.cancelQueue('POST');

    const mePAfterLink2 = await providerP.getMe();
    expect(mePAfterLink2.user?.invalidLinkStrikeCount).toBe(1);
    expect(mePAfterLink2.user?.isProviderBlocked).toBe(false);

    // 連結 #3 (2 個名額)：user4 回報無效 -> 記點 2（達到上限）
    await user4.joinQueue('謝謝提供者分享邀請連結！');
    const link3Res = await providerP.shareLink('https://claude.ai/referral/completelyBadLink3', 2);
    expect(link3Res.status).toBe(201);

    await user4.reveal();
    await user4.reportInvalid();

    const mePAfterLink3 = await providerP.getMe();
    expect(mePAfterLink3.user?.invalidLinkStrikeCount).toBe(2);
    expect(mePAfterLink3.user?.isProviderBlocked).toBe(true);

    // 提供者 P 嘗試分享第 4 組連結 -> 遭到 403 PROVIDER_BLOCKED 拒絕
    const link4Res = await providerP.shareLink('https://claude.ai/referral/blockedLink4', 1);
    expect(link4Res.status).toBe(403);
    const link4Err = await parseJson<ApiErrorResponse>(link4Res);
    expect(link4Err.error.code).toBe('PROVIDER_BLOCKED');
    expect(link4Err.error.message).toBe('由於先前提供的連結多次被回報無效，目前已暫停提供權限');
  });

  it('重複提交相同邀請代碼阻擋與格式驗證 (AC 1 交易一致性)', async () => {
    const providerP1 = await loginActor(app, env, 'p1@example.com', 'P1');
    const providerP2 = await loginActor(app, env, 'p2@example.com', 'P2');

    // P1 提交帶有 query params 的連結
    const firstRes = await providerP1.shareLink('https://claude.ai/referral/abc12345?s=ios', 3);
    expect(firstRes.status).toBe(201);

    // P2 提交相同 referral code -> 409 DUPLICATE_REFERRAL_CODE
    const duplicateRes = await providerP2.shareLink('https://claude.ai/referral/abc12345', 1);
    expect(duplicateRes.status).toBe(409);
    const dupErr = await parseJson<ApiErrorResponse>(duplicateRes);
    expect(dupErr.error.code).toBe('DUPLICATE_REFERRAL_CODE');
    expect(dupErr.error.message).toBe('這組邀請連結已經被分享過囉');

    // 提交非 Claude 格式的網址 -> 400 INVALID_REFERRAL_URL
    const invalidUrlRes = await providerP1.shareLink('https://example.com/not-claude', 3);
    expect(invalidUrlRes.status).toBe(400);
    const invalidErr = await parseJson<ApiErrorResponse>(invalidUrlRes);
    expect(invalidErr.error.code).toBe('INVALID_REFERRAL_URL');
    expect(invalidErr.error.message).toBe(
      '請貼上正確的 Claude 邀請連結（格式如 https://claude.ai/referral/...）'
    );

    const board = await fetchBoard(app, env);
    expect(board.availableSlotsCount).toBe(3);
  });

  it('Web Push 回傳 410 Gone 時自動清理失效訂閱紀錄，且不影響配對與感謝牆狀態', async () => {
    const providerP = await loginActor(app, env, 'p@example.com', '提供者');
    const receiverA = await loginActor(app, env, 'a@example.com', '領取者');

    const staleEndpoint = 'https://fcm.googleapis.com/fcm/send/stale-410';
    await receiverA.subscribePush(staleEndpoint);
    expect((await receiverA.getMe()).user?.hasPushSubscription).toBe(true);

    // 設定推播端點回傳 410 Gone
    endpointStatusOverrides.set(staleEndpoint, 410);

    await receiverA.joinQueue('謝謝版友分享 Claude 邀請碼！');
    const shareRes = await providerP.shareLink('https://claude.ai/referral/push410Test', 1);
    expect(shareRes.status).toBe(201);

    // 配對依然成功，且失效訂閱紀錄已自動被清空
    const meA = await receiverA.getMe();
    expect(meA.myQueue?.status).toBe('reserved');
    expect(meA.user?.hasPushSubscription).toBe(false);
  });

  // Regression: 同組連結已被回報無效後，其餘保留中名額逾時被放回 available，壞碼會再被配給別人 (test-review Nit，原 bug 無 ticket)
  it('同組連結已被回報無效時，其餘保留中名額逾時應轉為 closed 而非 available', async () => {
    const providerP = await loginActor(app, env, 'provider-bad@example.com', '壞連結提供者');
    const receiverA = await loginActor(app, env, 'user-a@example.com', '領取者A');
    const receiverB = await loginActor(app, env, 'user-b@example.com', '領取者B');
    const receiverC = await loginActor(app, env, 'user-c@example.com', '排隊者C');

    // 1. 提供者分享一組 3 個名額的連結
    const shareRes = await providerP.shareLink('https://claude.ai/referral/badLinkLeakTest', 3);
    expect(shareRes.status).toBe(201);

    // 2. A 與 B 加入排隊，立即獲配名額 #1 與 #2 (status = 'reserved')
    await receiverA.joinQueue('謝謝提供者！我是A');
    await receiverB.joinQueue('謝謝提供者！我是B');

    // 名額 #3 仍為 available
    let board = await fetchBoard(app, env);
    expect(board.availableSlotsCount).toBe(1);

    // 3. A 解鎖並回報無效 -> 名額 #1 為 invalidated, 名額 #3 自動轉為 closed
    await receiverA.reveal();
    const reportRes = await receiverA.reportInvalid();
    expect(reportRes.status).toBe(200);

    // 此時名額 #2 仍保留給 B。排隊者 C 加入等候
    await receiverC.joinQueue('我是排隊者C，等待下一組可用的邀請碼');
    board = await fetchBoard(app, env);
    expect(board.availableSlotsCount).toBe(0); // 壞連結名額 #3 已 closed，無可用名額

    // 4. B 超過 6 小時未解鎖，保留逾時
    const after7Hours = new Date(currentNow.getTime() + 7 * 60 * 60 * 1000);
    const { inviteQueueService } = createServices(env);
    await inviteQueueService.processExpirations(after7Hours);

    // 5. 驗證：B 的名額 #2 轉為 closed，沒有放回 available 配給 C
    const meP = await providerP.getMe();
    expect(meP.mySharedLinks[0]?.slots.map((slot) => slot.status)).toEqual([
      'invalidated',
      'closed',
      'closed',
    ]);
    expect((await receiverC.getMe()).myQueue?.status).toBe('waiting');
    expect(meP.user?.invalidLinkStrikeCount).toBe(1);
  });

  it('未登入訪客查看 GET /api/me 應回傳 user: null，且在生產環境呼叫 dev-login 應回傳 403', async () => {
    // 訪客未登入 GET /api/me 回傳 200 與 user: null
    const meRes = await app.request('/api/me', { method: 'GET' }, env);
    expect(meRes.status).toBe(200);
    const meJson = ((await meRes.json()) as ApiSuccessResponse<MeDto>).data;
    expect(meJson.user).toBeNull();
    expect(meJson.myQueue).toBeNull();

    // 生產環境禁止 dev-login
    const prodEnv: Env = {
      ...env,
      ENVIRONMENT: 'production',
    };
    const devLoginRes = await app.request(
      '/api/auth/dev-login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'hacker@example.com' }),
      },
      prodEnv
    );
    expect(devLoginRes.status).toBe(403);
    const devLoginErr = await parseJson<ApiErrorResponse>(devLoginRes);
    expect(devLoginErr.error.code).toBe('UNAUTHORIZED');
    expect(devLoginErr.error.message).toBe('正式環境不開放開發者測試登入');
  });

  describe('Cloudflare Worker 原生 scheduled Cron Trigger', () => {
    // 逾時判斷看的是 controller.scheduledTime，不是 app 的時鐘，所以這組測試不推進 currentNow。
    const RESERVE_DURATION_MS = 6 * 60 * 60 * 1000;
    const PROVIDER_PUSH_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/cron-provider';
    const WAITING_PUSH_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/cron-waiting';
    // 金鑰長度不合規，無法加密推播內容。
    const MALFORMED_KEYS = { p256dh: 'AAAA', auth: 'AAAA' };
    // RFC 8292 規定 VAPID JWT 的有效期限不得超過 24 小時。
    const MAX_VAPID_LIFETIME_SECONDS = 24 * 60 * 60;

    interface SentPushRequest {
      endpoint: string;
      headers: Record<string, string>;
      body: Uint8Array | string;
    }

    let cronEnv: Env;
    let sentRequests: SentPushRequest[];
    let providerDevice: TestPushSubscriber;
    let waitingDevice: TestPushSubscriber;

    beforeEach(async () => {
      cronEnv = { ...env, ...(await generateVapidEnv()) };
      providerDevice = await createTestPushSubscriber();
      waitingDevice = await createTestPushSubscriber();
      sentRequests = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (endpoint: string, init: RequestInit) => {
          await pushGate;
          sentRequests.push({
            endpoint,
            headers: init.headers as Record<string, string>,
            body: init.body as Uint8Array | string,
          });
          return new Response(null, { status: 201 });
        })
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** 把推播服務收到的請求用訂閱裝置的私鑰解開；內容沒有以 aes128gcm 加密就視為失敗。 */
    async function readDeliveredPushes(): Promise<
      { endpoint: string; payload: PushNotificationPayload }[]
    > {
      const devicesByEndpoint = new Map([
        [PROVIDER_PUSH_ENDPOINT, providerDevice],
        [WAITING_PUSH_ENDPOINT, waitingDevice],
      ]);
      return Promise.all(
        sentRequests.map(async ({ endpoint, headers, body }) => {
          expect(headers['Content-Encoding'], `${endpoint} 的推播應以 aes128gcm 加密`).toBe(
            'aes128gcm'
          );
          const plaintext = await devicesByEndpoint.get(endpoint)!.decrypt(body as Uint8Array);
          return {
            endpoint,
            payload: JSON.parse(plaintext) as PushNotificationPayload,
          };
        })
      );
    }

    function findSentRequest(endpoint: string): SentPushRequest {
      const request = sentRequests.find((sent) => sent.endpoint === endpoint);
      if (!request) {
        throw new Error(`沒有送往 ${endpoint} 的推播請求`);
      }
      return request;
    }

    /**
     * 一組 3 個名額的連結，三位領取者與一位排隊者的狀態在 cron 時間點分別是：
     * overdueReserved 保留已逾 6 小時、overdueRevealed 解鎖已逾 30 分鐘、
     * freshReserved 保留還剩 3 小時、waiting 仍在排隊。
     */
    async function arrangeClaimsAroundCronTime(providerKeys = providerDevice.keys) {
      const provider = await loginActor(app, env, 'cronProvider@example.com', '排程提供者');
      const overdueReserved = await loginActor(app, env, 'cronA@example.com', '保留逾時者');
      const overdueRevealed = await loginActor(app, env, 'cronB@example.com', '解鎖逾時者');
      const freshReserved = await loginActor(app, env, 'cronD@example.com', '保留未逾時者');
      const waiting = await loginActor(app, env, 'cronC@example.com', '排隊等待者');
      await provider.subscribePush(PROVIDER_PUSH_ENDPOINT, providerKeys);
      await waiting.subscribePush(WAITING_PUSH_ENDPOINT, waitingDevice.keys);
      const reservedAtMs = currentNow.getTime();

      await provider.shareLink('https://claude.ai/referral/cronScenario1', 3);
      await overdueReserved.joinQueue('我獲配後一直沒有解鎖');
      await overdueRevealed.joinQueue('我解鎖後忘記按確認');

      advanceTimeMs(3 * 60 * 60 * 1000);
      await freshReserved.joinQueue('我晚一點才獲配');
      advanceTimeMs(1000);
      await waiting.joinQueue('名額都被占住，我在排隊');

      advanceTimeMs(2 * 60 * 60 * 1000);
      await overdueRevealed.reveal();

      const overdueReservedSlotId = (await overdueReserved.getMe()).myQueue?.slotId;
      const cronTime = new Date(reservedAtMs + RESERVE_DURATION_MS + 60_000);
      return {
        provider,
        overdueReserved,
        overdueReservedSlotId,
        overdueRevealed,
        freshReserved,
        waiting,
        cronTime,
      };
    }

    /** 觸發一次排程，回傳還沒被等過的背景工作，讓測試決定何時等它們完成。 */
    async function scheduleAt(scheduledTime: Date): Promise<BackgroundContext> {
      const background = createBackgroundContext();
      const controller = {
        cron: '* * * * *',
        scheduledTime: scheduledTime.getTime(),
      } as ScheduledController;

      await worker.scheduled(controller, cronEnv, background.executionCtx);
      return background;
    }

    async function runScheduledAt(scheduledTime: Date): Promise<void> {
      const background = await scheduleAt(scheduledTime);
      await background.settle();
    }

    it('保留已逾 6 小時未解鎖時，Cron 把該排隊紀錄轉為 expired，並把釋出的名額配給排隊中的下一位', async () => {
      const claims = await arrangeClaimsAroundCronTime();
      expect((await claims.overdueReserved.getMe()).myQueue?.status).toBe('reserved');
      expect((await claims.waiting.getMe()).myQueue?.status).toBe('waiting');

      await runScheduledAt(claims.cronTime);

      expect((await claims.overdueReserved.getMe()).myQueue?.status).toBe('expired');
      const waitingAfterCron = (await claims.waiting.getMe()).myQueue;
      expect(waitingAfterCron?.status).toBe('reserved');
      expect(waitingAfterCron?.slotId).toBe(claims.overdueReservedSlotId);
      const deliveredPushes = await readDeliveredPushes();
      expect(
        deliveredPushes.filter((push) => push.endpoint === WAITING_PUSH_ENDPOINT)
      ).toMatchObject([{ payload: { title: '輪到你領取 Claude 邀請碼' } }]);
    });

    it('解鎖後已逾 30 分鐘未確認時，Cron 自動確認該名額、上感謝牆，並推播通知提供者', async () => {
      const claims = await arrangeClaimsAroundCronTime();
      expect((await claims.overdueRevealed.getMe()).myQueue?.status).toBe('revealed');

      await runScheduledAt(claims.cronTime);

      expect((await claims.overdueRevealed.getMe()).myQueue?.status).toBe('confirmed');
      const board = await fetchBoard(app, env);
      expect(board.totalConfirmedCount).toBe(1);
      expect(board.thankYouWall).toMatchObject([
        {
          receiverNickname: '解鎖逾時者',
          thankYouMessage: '我解鎖後忘記按確認',
        },
      ]);
      const providerPushes = (await readDeliveredPushes()).filter(
        (push) => push.endpoint === PROVIDER_PUSH_ENDPOINT
      );
      expect(providerPushes).toHaveLength(1);
      expect(providerPushes[0]?.payload.title).toContain('解鎖逾時者');
      expect(providerPushes[0]?.payload.body).toContain('我解鎖後忘記按確認');
    });

    it('看板已顯示累計已領取 0 時，Cron 自動確認逾時的名額後，下一次讀看板就顯示 1', async () => {
      const claims = await arrangeClaimsAroundCronTime();
      expect((await fetchBoard(app, env)).totalConfirmedCount).toBe(0);

      await runScheduledAt(claims.cronTime);

      expect((await fetchBoard(app, env)).totalConfirmedCount).toBe(1);
    });

    it('Cron 的時間點之前還沒到期的保留，維持 reserved 不被處理', async () => {
      const claims = await arrangeClaimsAroundCronTime();

      await runScheduledAt(claims.cronTime);

      expect((await claims.freshReserved.getMe()).myQueue?.status).toBe('reserved');
      expect(
        (await claims.provider.getMe()).mySharedLinks[0]?.slots.map((slot) => slot.status)
      ).toEqual(['reserved', 'confirmed', 'reserved']);
    });

    it('Cron 送出的推播帶有伺服器 VAPID 金鑰簽的授權標頭，內容用 aes128gcm 加密到只有訂閱裝置解得開', async () => {
      const claims = await arrangeClaimsAroundCronTime();
      // webPushService 簽 VAPID 的 exp 用 Date.now() 而不是注入的時鐘，所以這裡只能比對真實時間。
      const nowSecondsBeforeCron = Math.floor(Date.now() / 1000);

      await runScheduledAt(claims.cronTime);

      const providerRequest = findSentRequest(PROVIDER_PUSH_ENDPOINT);
      const vapidClaims = await readVerifiedVapidClaims(
        providerRequest.headers.Authorization!,
        cronEnv.VAPID_PUBLIC_KEY!
      );
      expect(vapidClaims).toMatchObject({
        aud: 'https://fcm.googleapis.com',
        sub: cronEnv.VAPID_SUBJECT,
      });
      expect(vapidClaims.exp).toBeGreaterThan(nowSecondsBeforeCron);
      expect(vapidClaims.exp).toBeLessThanOrEqual(
        nowSecondsBeforeCron + MAX_VAPID_LIFETIME_SECONDS
      );
      expect(providerRequest.headers['Content-Encoding']).toBe('aes128gcm');
      const decryptedBody = await providerDevice.decrypt(providerRequest.body as Uint8Array);
      expect(JSON.parse(decryptedBody)).toMatchObject({
        title: expect.stringContaining('解鎖逾時者'),
      });
    });

    // Regression: 訂閱金鑰長度不合規時，伺服器略過加密，把明文 JSON 直接 POST 給推播服務
    it('訂閱金鑰長度不合規時，Cron 不對推播服務送出任何請求，並移除這筆無法加密的訂閱', async () => {
      const claims = await arrangeClaimsAroundCronTime(MALFORMED_KEYS);

      await runScheduledAt(claims.cronTime);

      expect(sentRequests.map(({ endpoint }) => endpoint)).not.toContain(PROVIDER_PUSH_ENDPOINT);
      expect(readSubscribedEndpoints(claims.provider.userId)).toEqual([]);
    });

    it('推播送不出去而卡住時，Cron 的逾時結算與自動確認仍先完成，推播在放行後才送出', async () => {
      const claims = await arrangeClaimsAroundCronTime();
      const releasePushes = holdPushesUntilReleased();

      const background = await scheduleAt(claims.cronTime);
      await background.settleNext();

      expect((await claims.overdueRevealed.getMe()).myQueue?.status).toBe('confirmed');
      expect(sentRequests).toHaveLength(0);
      expect(background.pendingTaskCount()).toBeGreaterThan(0);

      releasePushes();
      await background.settle();

      expect(sentRequests.map(({ endpoint }) => endpoint).sort()).toEqual(
        [PROVIDER_PUSH_ENDPOINT, WAITING_PUSH_ENDPOINT].sort()
      );
    });
  });

  it('測試推播通知端點：未登入 401、未訂閱提示、已訂閱發送推播', async () => {
    // 1. 未登入請求
    const unauthRes = await app.request('/api/push/test', { method: 'POST' }, env);
    expect(unauthRes.status).toBe(401);

    // 2. 登入但尚未訂閱
    const user = await loginActor(app, env, 'tester@example.com', '推播測試員');
    const noSubRes = await user.sendTestPush();
    expect(noSubRes.status).toBe(200);
    const noSubData = (
      (await noSubRes.json()) as ApiSuccessResponse<{
        sent: boolean;
        deliveredCount: number;
        message: string;
      }>
    ).data;
    expect(noSubData.sent).toBe(false);
    expect(noSubData.deliveredCount).toBe(0);

    // 3. 訂閱推播後再發送
    await user.subscribePush('https://fcm.googleapis.com/fcm/send/tester-device');
    const subRes = await user.sendTestPush();
    expect(subRes.status).toBe(200);
    const subData = (
      (await subRes.json()) as ApiSuccessResponse<{
        sent: boolean;
        deliveredCount: number;
        message: string;
      }>
    ).data;
    expect(subData.sent).toBe(true);
    expect(subData.deliveredCount).toBe(1);
    expect(
      recordedPushes.some(
        (p) => p.userId === user.userId && p.payload.tag === 'test-push-notification'
      )
    ).toBe(true);
  });

  describe('推播的送出時機與失敗隔離', () => {
    const SENDER_FAILURES = [
      {
        failure: 'sender 回 HTTP 500',
        applyTo: (endpoint: string) => endpointStatusOverrides.set(endpoint, 500),
      },
      {
        failure: 'sender 丟 PushDeliveryError',
        applyTo: (endpoint: string) =>
          endpointSenderErrors.set(endpoint, new PushDeliveryError('推播服務無法連線')),
      },
      {
        failure: 'sender 丟 TypeError（網路層錯誤）',
        applyTo: (endpoint: string) =>
          endpointSenderErrors.set(endpoint, new TypeError('fetch failed')),
      },
      {
        failure: 'sender 丟非預期的 Error',
        applyTo: (endpoint: string) =>
          endpointSenderErrors.set(endpoint, new Error('unexpected sender bug')),
      },
    ];

    it('Workers 環境下，提供者分享連結的回應不等推播送完；排隊者的名額已保留，推播在背景工作完成後才收到', async () => {
      const provider = await loginActor(app, env, 'bgProvider@example.com', '背景提供者');
      const receiver = await loginActor(app, env, 'bgReceiver@example.com', '背景領取者');
      await receiver.subscribePush('https://fcm.googleapis.com/fcm/send/bg-receiver');
      await receiver.joinQueue('我在排隊，等推播通知我');
      const releasePushes = holdPushesUntilReleased();
      const background = createBackgroundContext();

      const shareRes = await provider
        .withExecutionContext(background.executionCtx)
        .shareLink('https://claude.ai/referral/backgroundPush1', 1);

      expect(shareRes.status).toBe(201);
      expect(recordedPushes).toHaveLength(0);
      expect(background.pendingTaskCount()).toBeGreaterThan(0);
      expect((await receiver.getMe()).myQueue?.status).toBe('reserved');

      releasePushes();
      await background.settle();

      expect(recordedPushes.map((push) => push.userId)).toEqual([receiver.userId]);
    });

    it('Workers 環境下，確認啟用的回應不等推播送完；提供者的感謝推播在背景工作完成後才收到', async () => {
      const { provider, receiver } = await arrangeReservedClaim();
      await provider.subscribePush('https://fcm.googleapis.com/fcm/send/bg-confirm-provider');
      await receiver.reveal();
      const releasePushes = holdPushesUntilReleased();
      const background = createBackgroundContext();

      const confirmRes = await receiver.withExecutionContext(background.executionCtx).confirm();

      expect(confirmRes.status).toBe(200);
      expect(recordedPushes).toHaveLength(0);
      expect(background.pendingTaskCount()).toBeGreaterThan(0);
      expect((await fetchBoard(app, env)).thankYouWall).toHaveLength(1);

      releasePushes();
      await background.settle();

      expect(recordedPushes.map((push) => push.userId)).toEqual([provider.userId]);
    });

    it.each(SENDER_FAILURES)(
      '$failure 時，訂閱存在的配對、解鎖、確認與感謝牆照常運作，訂閱也不會被移除',
      async ({ applyTo }) => {
        const provider = await loginActor(
          app,
          env,
          'pushFailProvider@example.com',
          '推播失敗提供者'
        );
        const receiver = await loginActor(
          app,
          env,
          'pushFailReceiver@example.com',
          '推播失敗領取者'
        );
        await provider.subscribePush('https://fcm.googleapis.com/fcm/send/fail-provider');
        await receiver.subscribePush('https://fcm.googleapis.com/fcm/send/fail-receiver');
        applyTo('https://fcm.googleapis.com/fcm/send/fail-provider');
        applyTo('https://fcm.googleapis.com/fcm/send/fail-receiver');

        await receiver.joinQueue('推播壞掉也要能領到邀請碼');
        const shareRes = await provider.shareLink('https://claude.ai/referral/pushFailure1', 1);
        const revealRes = await receiver.reveal();
        const confirmRes = await receiver.confirm();

        expect([shareRes.status, revealRes.status, confirmRes.status]).toEqual([201, 200, 200]);
        const board = await fetchBoard(app, env);
        expect(board.totalConfirmedCount).toBe(1);
        expect(board.thankYouWall).toMatchObject([
          {
            receiverNickname: '推播失敗領取者',
            thankYouMessage: '推播壞掉也要能領到邀請碼',
          },
        ]);
        expect(recordedPushes).toHaveLength(0);
        expect((await provider.getMe()).user?.hasPushSubscription).toBe(true);
        expect((await receiver.getMe()).user?.hasPushSubscription).toBe(true);
      }
    );

    it.each(SENDER_FAILURES.slice(0, 2))(
      '/api/push/test 在已訂閱但 $failure 時，sent 為 false 且訊息說明送出失敗',
      async ({ applyTo }) => {
        const user = await loginActor(app, env, 'pushTestFail@example.com', '推播測試失敗者');
        await user.subscribePush('https://fcm.googleapis.com/fcm/send/test-fail');
        applyTo('https://fcm.googleapis.com/fcm/send/test-fail');

        const res = await user.sendTestPush();

        expect(res.status).toBe(200);
        const data = (
          await parseJson<
            ApiSuccessResponse<{
              sent: boolean;
              deliveredCount: number;
              message: string;
            }>
          >(res)
        ).data;
        expect(data.sent).toBe(false);
        expect(data.deliveredCount).toBe(0);
        expect(data.message).toContain('送出失敗');
      }
    );

    it('/api/push/test 遇到 410 時移除失效訂閱，sent 為 false 且訊息說明沒有有效的訂閱裝置', async () => {
      const user = await loginActor(app, env, 'pushTestGone@example.com', '推播過期者');
      await user.subscribePush('https://fcm.googleapis.com/fcm/send/test-gone');
      endpointStatusOverrides.set('https://fcm.googleapis.com/fcm/send/test-gone', 410);

      const res = await user.sendTestPush();

      const data = (await parseJson<ApiSuccessResponse<{ sent: boolean; message: string }>>(res))
        .data;
      expect(data.sent).toBe(false);
      expect(data.message).toContain('尚未偵測到有效的推播訂閱裝置');
      expect((await user.getMe()).user?.hasPushSubscription).toBe(false);
    });
  });

  describe('雙軌道排隊機制 (Dual-Track Queue Flows)', () => {
    it('雙軌提供與新手專屬保障：新手席次不分配給再領取隊列，純新手優先獲配', async () => {
      const providerA = await loginActor(app, env, 'providerA@example.com', 'ProviderA');
      const receiverB = await loginActor(app, env, 'receiverB@example.com', 'ReceiverB');
      const newbieC = await loginActor(app, env, 'newbieC@example.com', 'NewbieC');

      // B 先完成一次新手領取
      await providerA.shareLink('https://claude.ai/referral/trackTestLink1', 1, 'newbie');
      await receiverB.joinQueue('感謝新手試用！', 'newbie');
      await receiverB.reveal();
      await receiverB.confirm();

      // 提供者 A 再分享 1 組新手專屬名額
      const providerA2 = await loginActor(app, env, 'providerA2@example.com', 'ProviderA2');
      await providerA2.shareLink('https://claude.ai/referral/trackTestLink2', 1, 'newbie');

      // 已領過的 B 排「再領取」軌道，由於池中只有新手名額，B 必須等待，不能分配到新手名額
      const bRes = await receiverB.joinQueue('我想為第二帳號排隊！', 'community');
      expect(bRes.status).toBe(201);
      const bMe = await receiverB.getMe();
      expect(bMe.myQueue?.status).toBe('waiting');
      expect(bMe.myQueue?.track).toBe('community');

      // 純新手 C 加入「新手」軌道，應立即獲配該新手名額
      const cRes = await newbieC.joinQueue('我是純新手！', 'newbie');
      expect(cRes.status).toBe(201);
      const cMe = await newbieC.getMe();
      expect(cMe.myQueue?.status).toBe('reserved');
      expect(cMe.myQueue?.track).toBe('newbie');

      // B 依然在等候中
      const bMeAfter = await receiverB.getMe();
      expect(bMeAfter.myQueue?.status).toBe('waiting');
    });

    it('再領取席次在沒有再領取排隊者時，向下相容分配給純新手', async () => {
      const providerP = await loginActor(app, env, 'providerP@example.com', 'ProviderP');
      const newbie = await loginActor(
        app,
        env,
        'newbieTrackFallback@example.com',
        'NewbieFallback'
      );

      // 提供者 P 分享 1 個「再領取」名額
      await providerP.shareLink('https://claude.ai/referral/communitySlotFallback', 1, 'community');

      // 隊列中無人時，純新手加入「新手」軌道，名額向下相容自動分配給該新手
      await newbie.joinQueue('新手等候中，希望能向下相容', 'newbie');
      const newbieMe = await newbie.getMe();
      expect(newbieMe.myQueue?.status).toBe('reserved');
    });

    it('多帳號排隊約束：再領取確認後可再次加入，但進行中禁止重複加入', async () => {
      const user = await loginActor(app, env, 'multiAccountUser@example.com', 'MultiUser');
      const provider = await loginActor(
        app,
        env,
        'multiAccountProvider@example.com',
        'MultiProvider'
      );

      await provider.shareLink('https://claude.ai/referral/multiAccountTest1', 2, 'community');

      // 第一次在 community 軌道排隊並確認
      await user.joinQueue('第 1 個第二帳號', 'community');
      await user.reveal();
      await user.confirm();

      // 在前一次已 confirmed 後，可再次在 community 軌道排隊
      const secondJoinRes = await user.joinQueue('第 2 個第二帳號', 'community');
      expect(secondJoinRes.status).toBe(201);

      // 但在進行中（已獲配 reserved）時再次加入，應被 409 阻擋
      const duplicateRes = await user.joinQueue('重複併發排隊', 'community');
      expect(duplicateRes.status).toBe(409);
      const duplicateErr = await parseJson<ApiErrorResponse>(duplicateRes);
      expect(duplicateErr.error.code).toBe('ALREADY_IN_QUEUE');
    });

    // Regression: 提供者分享過連結但未領取過，繞過前端直接打 API 仍能加入新手軌道 (docs/qa/archive/dual-track-queue.2026-10-24.md Finding 1)
    it('提供者曾分享過連結但未領取過時，加入新手軌道被 409 NEWBIE_TRACK_ONLY 擋下', async () => {
      const provider = await loginActor(
        app,
        env,
        'providerNoNewbie@example.com',
        'ProviderNoNewbie'
      );

      // 分享連結但自己從未領取過
      await provider.shareLink('https://claude.ai/referral/providerShareNoNewbie', 1, 'community');

      // 檢查 /api/me 中 isEligibleForNewbieTrack 應為 false
      const me = await provider.getMe();
      expect(me.user?.isEligibleForNewbieTrack).toBe(false);

      // 提供者若強制嘗試加入新手軌道，應被 409 NEWBIE_TRACK_ONLY 阻擋
      const joinRes = await provider.joinQueue('提供者想排新手軌', 'newbie');
      expect(joinRes.status).toBe(409);
      const err = await parseJson<ApiErrorResponse>(joinRes);
      expect(err.error.code).toBe('NEWBIE_TRACK_ONLY');
    });

    // Regression: 只在再領取軌道確認過領取的使用者仍通過新手資格檢查，可以再領一次新手名額 (review-correctness Blocker 1)
    it('使用者曾在再領取軌道確認領取、沒分享過連結時，加入新手軌道被 409 NEWBIE_TRACK_ONLY 擋下，且 /api/me 不再具新手資格', async () => {
      const provider = await loginActor(app, env, 'communityProvider@example.com', '互助提供者');
      const receiver = await loginActor(app, env, 'communityClaimer@example.com', '互助領取者');

      await provider.shareLink('https://claude.ai/referral/communityClaimOnly', 1, 'community');
      await receiver.joinQueue('在第二帳號軌道領取', 'community');
      await receiver.reveal();
      await receiver.confirm();

      expect((await receiver.getMe()).user?.isEligibleForNewbieTrack).toBe(false);

      const joinRes = await receiver.joinQueue('想再領一次新手名額', 'newbie');
      expect(joinRes.status).toBe(409);
      const err = await parseJson<ApiErrorResponse>(joinRes);
      expect(err.error.code).toBe('NEWBIE_TRACK_ONLY');
      expect(err.error.message).toBe(
        '你已成功領取過新手體驗名額囉！若欲為第二個帳號領取，請選擇「再領取」軌道'
      );
    });

    // Regression: 撮合只取全軌道最前面的 N 張 waiting 票，前面積壓的再領取票讓新手名額閒置 (review-correctness Blocker 2)
    it('再領取排隊者在新手前面積壓很多時，新手席次仍配給排在後面的新手', async () => {
      const COMMUNITY_TICKETS_AHEAD = 25;
      const provider = await loginActor(
        app,
        env,
        'newbieSlotProvider@example.com',
        '新手席次提供者'
      );
      for (let i = 0; i < COMMUNITY_TICKETS_AHEAD; i += 1) {
        const communityMember = await loginActor(
          app,
          env,
          `communityQueue${i}@example.com`,
          `互助排隊者${i}`
        );
        await communityMember.joinQueue('我在第二帳號軌道排隊', 'community');
      }
      const newbie = await loginActor(app, env, 'lateNewbie@example.com', '排在最後的新手');
      await newbie.joinQueue('我是新手，排在很後面', 'newbie');

      const shareRes = await provider.shareLink(
        'https://claude.ai/referral/newbieSlotBehindBacklog',
        1,
        'newbie'
      );
      const shareBody =
        await parseJson<ApiSuccessResponse<{ linkId: number; matchedCount: number }>>(shareRes);

      expect(shareBody.data.matchedCount).toBe(1);
      expect((await newbie.getMe()).myQueue?.status).toBe('reserved');
    });

    it('提供者沒指定軌道時席次預設為新手軌，只有再領取排隊者在排時領不到', async () => {
      const provider = await loginActor(
        app,
        env,
        'defaultTrackProvider@example.com',
        '預設軌道提供者'
      );
      const communityWaiter = await loginActor(
        app,
        env,
        'defaultTrackWaiter@example.com',
        '第二帳號排隊者'
      );
      await communityWaiter.joinQueue('我在第二帳號軌道排隊', 'community');

      const shareRes = await provider.shareLink('https://claude.ai/referral/defaultTrackSlot1', 1);

      expect(shareRes.status).toBe(201);
      expect((await communityWaiter.getMe()).myQueue?.status).toBe('waiting');
      const board = await fetchBoard(app, env);
      expect(board.newbieSlotsCount).toBe(1);
      expect(board.communitySlotsCount).toBe(0);
    });

    it('已在再領取軌道排隊、不具新手資格的使用者請求新手軌道時，回 ALREADY_IN_QUEUE 而不是 NEWBIE_TRACK_ONLY', async () => {
      const sharer = await loginActor(app, env, 'orderSharer@example.com', '分享過連結的排隊者');
      await sharer.shareLink('https://claude.ai/referral/orderSharerLink', 1, 'community');
      await sharer.joinQueue('我分享過連結，也在第二帳號軌道排隊', 'community');
      expect((await sharer.getMe()).myQueue?.status).toBe('waiting');
      expect((await sharer.getMe()).user?.isEligibleForNewbieTrack).toBe(false);

      const res = await sharer.joinQueue('想改排新手軌道', 'newbie');

      expect(res.status).toBe(409);
      expect((await parseJson<ApiErrorResponse>(res)).error.code).toBe('ALREADY_IN_QUEUE');
    });

    it('已領取過名額、又在再領取軌道排隊的使用者請求新手軌道時，回 ALREADY_IN_QUEUE 而不是 NEWBIE_TRACK_ONLY', async () => {
      const provider = await loginActor(app, env, 'orderClaimProvider@example.com', '提供者');
      const claimer = await loginActor(app, env, 'orderClaimer@example.com', '領過名額的排隊者');
      await provider.shareLink('https://claude.ai/referral/orderClaimLink', 1, 'newbie');
      await claimer.joinQueue('第一次領取', 'newbie');
      await claimer.reveal();
      await claimer.confirm();
      await claimer.joinQueue('為第二個帳號排隊', 'community');
      expect((await claimer.getMe()).myQueue?.status).toBe('waiting');

      const res = await claimer.joinQueue('想再排一次新手軌道', 'newbie');

      expect(res.status).toBe(409);
      expect((await parseJson<ApiErrorResponse>(res)).error.code).toBe('ALREADY_IN_QUEUE');
    });

    // docs/design/dual-track-queue.md AC 7：回報無效後排隊紀錄回到 waiting、優先權為 1，軌道與回報前相同。
    it('再領取軌的領取者回報無效後，重排的排隊紀錄仍是 community 軌且帶優先權', async () => {
      const provider = await loginActor(
        app,
        env,
        'communityReportProvider@example.com',
        '再領取軌提供者'
      );
      const receiver = await loginActor(
        app,
        env,
        'communityReportReceiver@example.com',
        '再領取軌領取者'
      );
      await provider.shareLink('https://claude.ai/referral/communityReport1', 3, 'community');
      await receiver.joinQueue('我走再領取軌，拿到失效的連結', 'community');
      await receiver.reveal();

      const reportRes = await receiver.reportInvalid();

      expect(reportRes.status).toBe(200);
      expect((await receiver.getMe()).myQueue).toMatchObject({
        status: 'waiting',
        track: 'community',
        isRequeuedWithPriority: true,
      });
    });

    describe('省略 track 時依新手資格自動分軌', () => {
      it.each([
        {
          situation: '尚未領取也沒分享過連結的純新手',
          expectedTrack: 'newbie',
          arrange: async () => loginActor(app, env, 'autoPureNewbie@example.com', '純新手'),
        },
        {
          situation: '只分享過連結、沒領取過的提供者',
          expectedTrack: 'community',
          arrange: async () => {
            const sharer = await loginActor(app, env, 'autoSharer@example.com', '只分享的提供者');
            await sharer.shareLink('https://claude.ai/referral/autoSharerLink', 1, 'community');
            return sharer;
          },
        },
        {
          situation: '已確認領取過新手名額的使用者',
          expectedTrack: 'community',
          arrange: async () => {
            const provider = await loginActor(app, env, 'autoClaimProvider@example.com', '提供者');
            const claimer = await loginActor(app, env, 'autoClaimer@example.com', '已領取者');
            await provider.shareLink('https://claude.ai/referral/autoClaimLink', 1, 'newbie');
            await claimer.joinQueue('第一次領取', 'newbie');
            await claimer.reveal();
            await claimer.confirm();
            return claimer;
          },
        },
      ] as const)(
        '$situation 省略 track 加入排隊時，排進 $expectedTrack 軌',
        async ({ arrange, expectedTrack }) => {
          const user = await arrange();
          const { inviteQueueService } = createServices(env, {
            now: () => currentNow,
          });

          await inviteQueueService.joinQueue({
            userId: user.userId,
            thankYouMessage: '省略 track 的排隊',
            track: undefined,
            now: currentNow,
          });

          expect((await user.getMe()).myQueue?.track).toBe(expectedTrack);
        }
      );

      it('POST /api/queue 的請求沒帶 track 時，分享過連結的使用者以 201 排進 community 軌', async () => {
        const sharer = await loginActor(
          app,
          env,
          'autoHttpSharer@example.com',
          '分享過連結的使用者'
        );
        await sharer.shareLink('https://claude.ai/referral/autoHttpSharerLink', 1, 'community');

        const res = await sharer.joinQueue('請求沒帶 track');

        expect(res.status).toBe(201);
        expect((await sharer.getMe()).myQueue?.track).toBe('community');
      });

      it('已在排隊中的使用者省略 track 再次加入時，回 ALREADY_IN_QUEUE', async () => {
        const user = await loginActor(app, env, 'autoAlreadyQueued@example.com', '已排隊者');
        await user.joinQueue('第一次排隊', 'newbie');
        const { inviteQueueService } = createServices(env, {
          now: () => currentNow,
        });

        await expect(
          inviteQueueService.joinQueue({
            userId: user.userId,
            thankYouMessage: '省略 track 的重複排隊',
            track: undefined,
            now: currentNow,
          })
        ).rejects.toMatchObject({ code: 'ALREADY_IN_QUEUE' });
      });
    });

    describe('NEWBIE_TRACK_ONLY 的訊息依拒絕原因而定', () => {
      const CLAIMED_MESSAGE_OPENING = '你已成功領取過新手體驗名額囉！';
      const SHARED_MESSAGE_OPENING = '感謝你熱心分享邀請碼！';

      async function joinNewbieTrackAndReadMessage(user: TestActor): Promise<string> {
        const res = await user.joinQueue('想排新手軌', 'newbie');
        expect(res.status).toBe(409);
        const err = await parseJson<ApiErrorResponse>(res);
        expect(err.error.code).toBe('NEWBIE_TRACK_ONLY');
        return err.error.message;
      }

      it('只分享過連結、沒領取過時，訊息只說明分享過連結', async () => {
        const sharer = await loginActor(app, env, 'msgSharerOnly@example.com', '只分享的提供者');
        await sharer.shareLink('https://claude.ai/referral/msgSharerOnlyLink', 1, 'community');

        const message = await joinNewbieTrackAndReadMessage(sharer);

        expect(message).toBe(
          '感謝你熱心分享邀請碼！新手名額請優先保留給首次體驗的版友，若欲領取請選擇「再領取」軌道'
        );
      });

      it('既領取過又分享過連結時，訊息合併說明兩個原因並指引改選再領取軌', async () => {
        const provider = await loginActor(app, env, 'msgBothProvider@example.com', '提供者');
        const user = await loginActor(app, env, 'msgBoth@example.com', '領過又分享過的使用者');
        await provider.shareLink('https://claude.ai/referral/msgBothClaimLink', 1, 'newbie');
        await user.joinQueue('第一次領取', 'newbie');
        await user.reveal();
        await user.confirm();
        await user.shareLink('https://claude.ai/referral/msgBothOwnLink', 1, 'community');

        const message = await joinNewbieTrackAndReadMessage(user);

        expect(message.startsWith(CLAIMED_MESSAGE_OPENING)).toBe(true);
        expect(message).toContain('分享過邀請連結');
        expect(message).toContain('「再領取」軌道');
        expect(message.startsWith(SHARED_MESSAGE_OPENING)).toBe(false);
      });
    });

    describe('新手票遇到池中同時有新手與再領取席次', () => {
      async function revealedReferralUrl(user: TestActor): Promise<string> {
        const res = await user.reveal();
        return (await parseJson<ApiSuccessResponse<{ referralUrl: string }>>(res)).data.referralUrl;
      }

      it('新手票先拿較新的新手席次，之後的再領取票仍拿得到較舊的再領取席次', async () => {
        const communityProvider = await loginActor(
          app,
          env,
          'poolCommunityProvider@example.com',
          '第二帳號席次提供者'
        );
        const newbieProvider = await loginActor(
          app,
          env,
          'poolNewbieProvider@example.com',
          '新手席次提供者'
        );
        const newbieReceiver = await loginActor(
          app,
          env,
          'poolNewbieReceiver@example.com',
          '新手領取者'
        );
        const communityReceiver = await loginActor(
          app,
          env,
          'poolCommunityReceiver@example.com',
          '第二帳號領取者'
        );
        await communityProvider.shareLink(
          'https://claude.ai/referral/poolOlderCommunitySlot',
          1,
          'community'
        );
        advanceTimeMs(60_000);
        await newbieProvider.shareLink(
          'https://claude.ai/referral/poolNewerNewbieSlot',
          1,
          'newbie'
        );

        await newbieReceiver.joinQueue('我是新手領取者', 'newbie');
        await communityReceiver.joinQueue('我是第二帳號', 'community');

        expect(await revealedReferralUrl(newbieReceiver)).toBe(
          'https://claude.ai/referral/poolNewerNewbieSlot'
        );
        expect(await revealedReferralUrl(communityReceiver)).toBe(
          'https://claude.ai/referral/poolOlderCommunitySlot'
        );
      });
    });

    describe('GET /api/me 的新手資格、分享紀錄與已確認領取（Journey 3 step 2）', () => {
      it.each([
        {
          situation: '尚未領取也沒分享過連結的純新手',
          expectedUser: {
            isEligibleForNewbieTrack: true,
            hasSharedLinks: false,
          },
          expectedClaim: null,
          arrange: async () => loginActor(app, env, 'pureNewbie@example.com', '純新手'),
        },
        {
          situation: '只分享過連結、沒領取過的提供者',
          expectedUser: {
            isEligibleForNewbieTrack: false,
            hasSharedLinks: true,
          },
          expectedClaim: null,
          arrange: async () => {
            const sharer = await loginActor(app, env, 'onlySharer@example.com', '只分享的提供者');
            await sharer.shareLink('https://claude.ai/referral/onlySharerLink', 1);
            return sharer;
          },
        },
        {
          situation: '已確認領取過新手名額的使用者',
          expectedUser: {
            isEligibleForNewbieTrack: false,
            hasSharedLinks: false,
          },
          expectedClaim: {
            status: 'confirmed',
            track: 'newbie',
            providerNickname: '提供者',
            thankYouMessage: '我領過新手名額了',
            referralUrl: 'https://claude.ai/referral/eligibilityClaimLink',
          },
          arrange: async () => {
            const provider = await loginActor(app, env, 'eligProvider@example.com', '提供者');
            const claimer = await loginActor(app, env, 'eligClaimer@example.com', '已領取者');
            await provider.shareLink('https://claude.ai/referral/eligibilityClaimLink', 1);
            await claimer.joinQueue('我領過新手名額了', 'newbie');
            await claimer.reveal();
            await claimer.confirm();
            return claimer;
          },
        },
      ])(
        '$situation 的 /api/me 帶出對應的新手資格、分享紀錄與已確認領取',
        async ({ arrange, expectedUser, expectedClaim }) => {
          const user = await arrange();

          const me = await user.getMe();

          expect(me.user).toMatchObject(expectedUser);
          expect(me.myConfirmedClaim).toEqual(
            expectedClaim && expect.objectContaining(expectedClaim)
          );
        }
      );
    });

    describe('看板分軌統計（AC4）', () => {
      it('只有可用席次、沒人排隊時，新手軌與再領取軌的席次數分別是 2 與 1，排隊數都是 0', async () => {
        const newbieProvider = await loginActor(
          app,
          env,
          'boardNewbieProvider@example.com',
          '新手席次提供者'
        );
        const communityProvider = await loginActor(
          app,
          env,
          'boardCommunityProvider@example.com',
          '第二帳號席次提供者'
        );
        await newbieProvider.shareLink('https://claude.ai/referral/boardNewbieSlots', 2, 'newbie');
        await communityProvider.shareLink(
          'https://claude.ai/referral/boardCommunitySlots',
          1,
          'community'
        );

        const board = await fetchBoard(app, env);

        expect(board).toMatchObject({
          availableSlotsCount: 3,
          newbieSlotsCount: 2,
          communitySlotsCount: 1,
          newbieQueueCount: 0,
          communityQueueCount: 0,
        });
      });

      it('沒有可用席次、只有人排隊時，新手軌與再領取軌的排隊數分別是 1 與 3，席次數都是 0', async () => {
        const newbie = await loginActor(app, env, 'boardQueueNewbie@example.com', '新手排隊者');
        await newbie.joinQueue('我在新手軌道排隊', 'newbie');
        for (let i = 0; i < 3; i += 1) {
          const communityMember = await loginActor(
            app,
            env,
            `boardQueueCommunity${i}@example.com`,
            `第二帳號排隊者${i}`
          );
          await communityMember.joinQueue('我在第二帳號軌道排隊', 'community');
        }

        const board = await fetchBoard(app, env);

        expect(board).toMatchObject({
          waitingQueueCount: 4,
          newbieSlotsCount: 0,
          communitySlotsCount: 0,
          newbieQueueCount: 1,
          communityQueueCount: 3,
        });
      });
    });
  });

  describe('重複送出由資料庫的唯一索引擋下', () => {
    function insertConfirmedQueueEntry(userId: number, track: 'newbie' | 'community'): void {
      sqlite
        .prepare(
          `INSERT INTO queue_entries (user_id, status, track, priority, thank_you_message, confirmed_at, created_at, updated_at)
           VALUES (?, 'confirmed', ?, 0, '直接寫入資料庫的紀錄', ?, ?, ?)`
        )
        .run(
          userId,
          track,
          currentNow.toISOString(),
          currentNow.toISOString(),
          currentNow.toISOString()
        );
    }

    it('同一位使用者同時送出兩次加入排隊時，一個 201、另一個 409 ALREADY_IN_QUEUE，只留下一筆排隊紀錄', async () => {
      const user = await loginActor(app, env, 'doubleJoin@example.com', '連點兩次的使用者');

      const responses = await Promise.all([
        user.joinQueue('第一次送出的感謝小卡'),
        user.joinQueue('第二次送出的感謝小卡'),
      ]);

      expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
      const rejected = responses.find((res) => res.status === 409)!;
      expect((await parseJson<ApiErrorResponse>(rejected)).error.code).toBe('ALREADY_IN_QUEUE');
      const { count } = sqlite
        .prepare('SELECT COUNT(*) AS count FROM queue_entries WHERE user_id = ?')
        .get(user.userId) as { count: number };
      expect(count).toBe(1);
    });

    it('兩位提供者同時提交同一個邀請代碼時，一個 201、另一個 409 DUPLICATE_REFERRAL_CODE，輸家不留下半套名額', async () => {
      const providerOne = await loginActor(app, env, 'raceLinkOne@example.com', '提供者一');
      const providerTwo = await loginActor(app, env, 'raceLinkTwo@example.com', '提供者二');
      const sameLink = 'https://claude.ai/referral/sameCodeAtOnce';

      const responses = await Promise.all([
        providerOne.shareLink(sameLink, 1),
        providerTwo.shareLink(sameLink, 3),
      ]);

      expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
      const rejected = responses.find((res) => res.status === 409)!;
      expect((await parseJson<ApiErrorResponse>(rejected)).error.code).toBe(
        'DUPLICATE_REFERRAL_CODE'
      );
      const links = sqlite.prepare('SELECT total_slots FROM invite_links').all() as {
        total_slots: number;
      }[];
      const { slotCount } = sqlite
        .prepare('SELECT COUNT(*) AS slotCount FROM invite_slots')
        .get() as { slotCount: number };
      expect(links).toHaveLength(1);
      expect(slotCount).toBe(links[0]?.total_slots);
    });

    it('資料庫拒絕同一位使用者的第二筆新手軌 confirmed 紀錄', async () => {
      const user = await loginActor(
        app,
        env,
        'twoNewbieClaims@example.com',
        '想領兩次新手名額的使用者'
      );
      insertConfirmedQueueEntry(user.userId, 'newbie');

      expect(() => insertConfirmedQueueEntry(user.userId, 'newbie')).toThrow(
        /UNIQUE constraint failed/
      );
    });

    it('資料庫允許同一位使用者有多筆再領取軌 confirmed 紀錄', async () => {
      const user = await loginActor(
        app,
        env,
        'twoCommunityClaims@example.com',
        '領兩個第二帳號的使用者'
      );
      insertConfirmedQueueEntry(user.userId, 'community');

      expect(() => insertConfirmedQueueEntry(user.userId, 'community')).not.toThrow();
    });
  });

  describe('批次中途失敗時整筆回滾，不留下半套狀態', () => {
    const WRITTEN_TABLES = ['users', 'invite_links', 'invite_slots', 'queue_entries'];

    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.mocked(console.error).mockRestore();
    });

    async function expectInternalError(res: Response): Promise<void> {
      expect(res.status).toBe(500);
      expect((await parseJson<ApiErrorResponse>(res)).error.code).toBe('INTERNAL_ERROR');
    }

    it('提交連結：建立名額時失敗，連結與已寫入的部分名額都被回滾，同一個邀請代碼之後仍可提交', async () => {
      const provider = await loginActor(app, env, 'rollbackLink@example.com', '提交連結提供者');
      const tablesBefore = dumpTables(sqlite, WRITTEN_TABLES);
      failureInjector.failNextWrite({
        operation: 'INSERT',
        table: 'invite_slots',
      });

      const failedRes = await provider.shareLink('https://claude.ai/referral/rollbackLink01', 3);

      await expectInternalError(failedRes);
      expect(dumpTables(sqlite, WRITTEN_TABLES)).toEqual(tablesBefore);
      const retryRes = await provider.shareLink('https://claude.ai/referral/rollbackLink01', 3);
      expect(retryRes.status).toBe(201);
    });

    it('加入排隊：寫入排隊紀錄失敗時，沒有排隊紀錄、暱稱也沒被更新，使用者之後可以重新加入', async () => {
      const user = await loginActor(app, env, 'rollbackJoin@example.com', '舊暱稱');
      const tablesBefore = dumpTables(sqlite, WRITTEN_TABLES);
      failureInjector.failNextWrite({
        operation: 'INSERT',
        table: 'queue_entries',
      });

      const failedRes = await user.request('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thankYouMessage: '這次寫入會失敗',
          nickname: '新暱稱',
        }),
      });

      await expectInternalError(failedRes);
      expect(dumpTables(sqlite, WRITTEN_TABLES)).toEqual(tablesBefore);
      expect((await user.joinQueue('第二次嘗試就成功了')).status).toBe(201);
    });

    // drizzle 包裝後的錯誤訊息帶有使用者送出的參數，所以唯一約束的判斷只能看原始錯誤（cause），不能看包裝後的 message。
    it('加入排隊：感謝小卡內容寫了 UNIQUE constraint failed，寫入因其他原因失敗時仍回 500 而不是 ALREADY_IN_QUEUE', async () => {
      const user = await loginActor(
        app,
        env,
        'rollbackJoinText@example.com',
        '內容像錯誤訊息的使用者'
      );
      failureInjector.failNextWrite({
        operation: 'INSERT',
        table: 'queue_entries',
      });

      const failedRes = await user.joinQueue('UNIQUE constraint failed');

      await expectInternalError(failedRes);
    });

    it('配對指派：更新排隊紀錄失敗時，名額維持 available、排隊紀錄維持 waiting，之後的撮合照常運作', async () => {
      const provider = await loginActor(
        app,
        env,
        'rollbackAssignProvider@example.com',
        '配對提供者'
      );
      const receiver = await loginActor(
        app,
        env,
        'rollbackAssignReceiver@example.com',
        '配對領取者'
      );
      await provider.shareLink('https://claude.ai/referral/rollbackAssign1', 1);
      const slotsBefore = dumpTables(sqlite, ['invite_slots']);
      failureInjector.failNextWrite({
        operation: 'UPDATE',
        table: 'queue_entries',
      });

      const failedRes = await receiver.joinQueue('配對這一步會失敗');

      await expectInternalError(failedRes);
      expect(dumpTables(sqlite, ['invite_slots'])).toEqual(slotsBefore);
      const meAfterFailure = await receiver.getMe();
      expect(meAfterFailure.myQueue?.status).toBe('waiting');
      expect(meAfterFailure.myQueue?.slotId).toBeNull();

      const nextProvider = await loginActor(
        app,
        env,
        'rollbackAssignNext@example.com',
        '下一位提供者'
      );
      await nextProvider.shareLink('https://claude.ai/referral/rollbackAssign2', 1);
      expect((await receiver.getMe()).myQueue?.status).toBe('reserved');
    });

    it('解鎖：更新排隊紀錄失敗時，名額與排隊紀錄都維持 reserved，使用者之後可以再解鎖', async () => {
      const { receiver } = await arrangeReservedClaim();
      const tablesBefore = dumpTables(sqlite, WRITTEN_TABLES);
      failureInjector.failNextWrite({
        operation: 'UPDATE',
        table: 'queue_entries',
      });

      const failedRes = await receiver.reveal();

      await expectInternalError(failedRes);
      expect(dumpTables(sqlite, WRITTEN_TABLES)).toEqual(tablesBefore);
      expect((await receiver.reveal()).status).toBe(200);
    });

    it('確認啟用：更新排隊紀錄失敗時，名額與排隊紀錄都維持 revealed、感謝牆沒有新卡片，使用者之後可以再確認', async () => {
      const { receiver } = await arrangeReservedClaim();
      await receiver.reveal();
      const tablesBefore = dumpTables(sqlite, WRITTEN_TABLES);
      failureInjector.failNextWrite({
        operation: 'UPDATE',
        table: 'queue_entries',
      });

      const failedRes = await receiver.confirm();

      await expectInternalError(failedRes);
      expect(dumpTables(sqlite, WRITTEN_TABLES)).toEqual(tablesBefore);
      expect((await fetchBoard(app, env)).thankYouWall).toHaveLength(0);
      expect((await receiver.confirm()).status).toBe(200);
      expect((await fetchBoard(app, env)).thankYouWall).toHaveLength(1);
    });

    it('取消保留中的排隊：釋放名額失敗時，排隊紀錄與名額都維持 reserved，使用者之後可以再取消', async () => {
      const { receiver } = await arrangeReservedClaim();
      const tablesBefore = dumpTables(sqlite, WRITTEN_TABLES);
      failureInjector.failNextWrite({
        operation: 'UPDATE',
        table: 'invite_slots',
      });

      const failedRes = await receiver.cancelQueue('POST');

      await expectInternalError(failedRes);
      expect(dumpTables(sqlite, WRITTEN_TABLES)).toEqual(tablesBefore);
      expect((await receiver.cancelQueue('POST')).status).toBe(200);
    });

    it('保留逾時結算：釋放名額失敗時，排隊紀錄與名額都維持 reserved，之後的結算照常完成', async () => {
      const { receiver } = await arrangeReservedClaim();
      advanceTimeMs(6 * 60 * 60 * 1000 + 1000);
      const tablesBefore = dumpTables(sqlite, WRITTEN_TABLES);
      failureInjector.failNextWrite({
        operation: 'UPDATE',
        table: 'invite_slots',
      });

      const failedRes = await receiver.request('/api/me');

      await expectInternalError(failedRes);
      expect(dumpTables(sqlite, WRITTEN_TABLES)).toEqual(tablesBefore);
      expect((await receiver.getMe()).myQueue?.status).toBe('expired');
      expect((await fetchBoard(app, env)).availableSlotsCount).toBe(1);
    });

    it('回報無效並重排：最後一步重排失敗時，已標記的 invalidated、關閉的同組名額、重排次數都被回滾，使用者之後可以再回報', async () => {
      const { provider, receiver } = await arrangeReservedClaim(3);
      await receiver.reveal();
      const tablesBefore = dumpTables(sqlite, WRITTEN_TABLES);
      failureInjector.failNextWrite({
        operation: 'UPDATE',
        table: 'queue_entries',
      });

      const failedRes = await receiver.reportInvalid();

      await expectInternalError(failedRes);
      expect(dumpTables(sqlite, WRITTEN_TABLES)).toEqual(tablesBefore);
      expect((await receiver.reportInvalid()).status).toBe(200);
      expect((await provider.getMe()).mySharedLinks[0]?.slots.map((slot) => slot.status)).toEqual([
        'invalidated',
        'closed',
        'closed',
      ]);
    });
  });

  describe('取消排隊遇到並發請求', () => {
    // Regression: cancelQueue 不看 repository 的回傳值，並發配對成功後仍回報已取消 (review-correctness Should Fix 2)
    it('取消 waiting 票的當下剛好被配對成 reserved 時，回 409 INVALID_STATE_TRANSITION，票仍是 reserved', async () => {
      const provider = await loginActor(app, env, 'raceProvider@example.com', '競態提供者');
      const user = await loginActor(app, env, 'raceWaiting@example.com', '競態排隊者');
      await user.joinQueue('我正在排隊，同時按了取消');

      const racing = createRacingD1(db);
      const { inviteQueueService } = createServices(
        { ...env, DB: racing.db },
        { now: () => currentNow }
      );
      racing.raceBeforeNextWrite({ operation: 'UPDATE', table: 'queue_entries' }, () =>
        provider.shareLink('https://claude.ai/referral/raceMatchBeforeCancel', 1)
      );

      await expect(inviteQueueService.cancelQueue(user.userId, currentNow)).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        statusCode: 409,
      });
      expect((await user.getMe()).myQueue?.status).toBe('reserved');
    });

    // Regression: 取消 reserved 票時 repository 回傳 false 也被忽略 (review-correctness Should Fix 2)
    it('取消 reserved 票的當下剛好被解鎖成 revealed 時，回 409 INVALID_STATE_TRANSITION，票仍是 revealed', async () => {
      const provider = await loginActor(app, env, 'raceProvider2@example.com', '競態提供者二');
      const user = await loginActor(app, env, 'raceReserved@example.com', '競態保留者');
      await user.joinQueue('我已獲配，同時按了取消');
      await provider.shareLink('https://claude.ai/referral/raceRevealBeforeCancel', 1);

      const racing = createRacingD1(db);
      const { inviteQueueService } = createServices(
        { ...env, DB: racing.db },
        { now: () => currentNow }
      );
      racing.raceBeforeNextWrite({ operation: 'UPDATE', table: 'queue_entries' }, () =>
        user.reveal()
      );

      await expect(inviteQueueService.cancelQueue(user.userId, currentNow)).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        statusCode: 409,
      });
      expect((await user.getMe()).myQueue?.status).toBe('revealed');
    });

    // Regression: 取消 reserved 票的 batch 只憑名額 id 與 reserved 狀態釋出名額，名額已被逾時結算收回並改保留給別人時，會把別人的名額放掉，之後同一組邀請代碼配給兩個人
    it('取消的 batch 執行前，自己的保留已逾時結算且名額改保留給下一位時，回 409 INVALID_STATE_TRANSITION，下一位的名額與排隊紀錄不受影響，邀請碼不會配給第二個人', async () => {
      const { receiver: cancelling } = await arrangeReservedClaim();
      const nextInLine = await loginActor(app, env, 'nextInLine@example.com', '候補者B');
      await nextInLine.joinQueue('我在排隊，等名額釋出');
      const lateJoiner = await loginActor(app, env, 'lateJoiner@example.com', '後到者C');
      const racing = createRacingD1(db);
      const { inviteQueueService } = createServices(
        { ...env, DB: racing.db },
        { now: () => currentNow }
      );
      const sweepService = createServices(env, {
        now: () => currentNow,
      }).inviteQueueService;
      racing.raceBeforeNextWrite({ operation: 'UPDATE', table: 'invite_slots' }, () =>
        sweepService.processExpirations(new Date(currentNow.getTime() + 6 * 60 * 60 * 1000 + 1000))
      );

      await expect(
        inviteQueueService.cancelQueue(cancelling.userId, currentNow)
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        statusCode: 409,
      });

      expect(readSoleSlotOfLink('stateGuard01')).toEqual({
        status: 'reserved',
        assignedUserId: nextInLine.userId,
      });
      expect(readQueueEntryStatus(nextInLine.userId)).toBe('reserved');
      await lateJoiner.joinQueue('我也想領，但名額已經有人保留');
      expect(readQueueEntryStatus(lateJoiner.userId)).toBe('waiting');
    });

    // Regression: 取消 reserved 票的 batch 只憑名額 id 與 reserved 狀態釋出名額，同一位使用者的舊保留逾時後以新排隊紀錄重新獲配同一個名額時，舊請求會把新紀錄的名額放掉
    it('取消的 batch 執行前，使用者的舊保留已逾時且以新排隊紀錄重新獲配同一個名額時，回 409 INVALID_STATE_TRANSITION，名額與新紀錄都維持 reserved', async () => {
      const { receiver } = await arrangeReservedClaim();
      const racing = createRacingD1(db);
      const { inviteQueueService } = createServices(
        { ...env, DB: racing.db },
        { now: () => currentNow }
      );
      const sweepService = createServices(env, { now: () => currentNow }).inviteQueueService;
      racing.raceBeforeNextWrite({ operation: 'UPDATE', table: 'invite_slots' }, async () => {
        await sweepService.processExpirations(
          new Date(currentNow.getTime() + 6 * 60 * 60 * 1000 + 1000)
        );
        await receiver.joinQueue('舊的保留逾時了，我重新排隊');
      });

      await expect(
        inviteQueueService.cancelQueue(receiver.userId, currentNow)
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        statusCode: 409,
      });

      expect(readSoleSlotOfLink('stateGuard01')).toEqual({
        status: 'reserved',
        assignedUserId: receiver.userId,
      });
      expect(readQueueEntryStatus(receiver.userId)).toBe('reserved');
    });
  });

  describe('配對遇到並發拒絕', () => {
    it('配對寫入的當下排在最前面的排隊者剛好取消（guard 拒絕這一組）時，同一個請求重讀後改配下一位，名額不閒置', async () => {
      const first = await loginActor(app, env, 'matchRaceFirst@example.com', '排第一的領取者');
      const second = await loginActor(app, env, 'matchRaceSecond@example.com', '排第二的領取者');
      const provider = await loginActor(app, env, 'matchRaceProvider@example.com', '分享的提供者');
      await first.joinQueue('我排第一，但分享的當下剛好取消');
      advanceTimeMs(1000);
      await second.joinQueue('我排第二，輪到我就領');
      const racing = createRacingD1(db);
      const { inviteQueueService } = createServices(
        { ...env, DB: racing.db },
        { now: () => currentNow }
      );
      racing.raceBeforeNextWrite({ operation: 'UPDATE', table: 'invite_slots' }, () =>
        first.cancelQueue()
      );

      const { matchedCount } = await inviteQueueService.submitInviteLink({
        userId: provider.userId,
        rawUrlInput: 'https://claude.ai/referral/matchRaceLink1',
        slotCount: 1,
        track: 'newbie',
        now: currentNow,
      });

      expect(matchedCount).toBe(1);
      expect(readQueueEntryStatus(first.userId)).toBe('cancelled');
      expect(readQueueEntryStatus(second.userId)).toBe('reserved');
    });

    // 資料庫一致時，被拒絕的那一組在重讀後不會再被選中，所以只有 stub 能讓 guard 每一輪都拒絕，驗證輪數上限。
    it('指派一直被 guard 拒絕時，請求在有限輪數後放棄，名額與排隊者維持原狀，下一次觸發就能配上', async () => {
      // 配對輪數失控時讓 spy 丟錯，測試才會紅而不是卡死在無限迴圈裡。
      const RUNAWAY_ASSIGN_ATTEMPTS = 100;
      const receiver = await loginActor(app, env, 'matchRaceReceiver@example.com', '等候的領取者');
      const provider = await loginActor(app, env, 'matchRaceProvider@example.com', '分享的提供者');
      await receiver.joinQueue('我在排隊，等名額出現');
      const { inviteQueueService, repo } = createServices(env, {
        now: () => currentNow,
      });
      let assignAttempts = 0;
      const assignSpy = vi.spyOn(repo, 'assignSlotToQueueEntry').mockImplementation(async () => {
        assignAttempts += 1;
        if (assignAttempts > RUNAWAY_ASSIGN_ATTEMPTS) {
          throw new Error('配對沒有在有限輪數內停止');
        }
        return false;
      });

      const { matchedCount } = await inviteQueueService.submitInviteLink({
        userId: provider.userId,
        rawUrlInput: 'https://claude.ai/referral/matchRaceLink1',
        slotCount: 1,
        track: 'newbie',
        now: currentNow,
      });

      expect(matchedCount).toBe(0);
      expect(readQueueEntryStatus(receiver.userId)).toBe('waiting');
      expect((await fetchBoard(app, env)).availableSlotsCount).toBe(1);

      assignSpy.mockRestore();
      const nextReceiver = await loginActor(app, env, 'matchRaceNext@example.com', '下一位領取者');
      await nextReceiver.joinQueue('我晚一點才排隊');
      expect((await receiver.getMe()).myQueue?.status).toBe('reserved');
    });
  });

  describe('解鎖與確認啟用遇到並發請求', () => {
    const RESERVATION_DURATION_MS = 6 * 60 * 60 * 1000;
    const CONFIRM_DURATION_MS = 30 * 60 * 1000;

    /**
     * 這組測試直接呼叫 service，並讓它的推播也記進 `recordedPushes`。
     * 傳入 `racing` 時，service 的寫入會經過它，才能在寫入之前插入競爭的請求。
     */
    function createRacingServices(racing?: RacingD1) {
      return createServices(
        { ...env, DB: racing?.db ?? env.DB },
        {
          now: () => currentNow,
          pushSender: async (subscription, payload) => {
            recordedPushes.push({
              userId: subscription.userId,
              endpoint: subscription.endpoint,
              payload,
            });
            return { statusCode: 201 };
          },
        }
      );
    }

    /** 直接寫入 `count` 筆保留已逾時、到期時間比目前所有保留都早的排隊紀錄與名額，模擬逾時結算積壓。 */
    function seedExpiredReservationBacklog(count: number): void {
      const expiredAtIso = new Date(currentNow.getTime() - RESERVATION_DURATION_MS).toISOString();
      const nowIso = currentNow.toISOString();
      const insertUser = sqlite.prepare(
        'INSERT INTO users (google_sub, email, nickname, created_at) VALUES (?, ?, ?, ?)'
      );
      const insertLink = sqlite.prepare(
        'INSERT INTO invite_links (provider_user_id, referral_code, normalized_url, total_slots, created_at) VALUES (?, ?, ?, 1, ?)'
      );
      const insertSlot = sqlite.prepare(
        "INSERT INTO invite_slots (link_id, slot_index, status, assigned_user_id, reserved_at, reserve_expires_at, created_at) VALUES (?, 1, 'reserved', ?, ?, ?, ?)"
      );
      const insertEntry = sqlite.prepare(
        "INSERT INTO queue_entries (user_id, status, thank_you_message, slot_id, reserve_expires_at, created_at, updated_at) VALUES (?, 'reserved', '積壓中的感謝小卡', ?, ?, ?, ?)"
      );
      sqlite.transaction(() => {
        const providerId = Number(
          insertUser.run(
            'sub-backlog-provider',
            'backlog-provider@example.com',
            '積壓提供者',
            nowIso
          ).lastInsertRowid
        );
        for (let index = 0; index < count; index += 1) {
          const receiverId = Number(
            insertUser.run(
              `sub-backlog-${index}`,
              `backlog-${index}@example.com`,
              '積壓領取者',
              nowIso
            ).lastInsertRowid
          );
          const referralCode = `backlogCode${index}`;
          const linkId = Number(
            insertLink.run(
              providerId,
              referralCode,
              `https://claude.ai/referral/${referralCode}`,
              nowIso
            ).lastInsertRowid
          );
          const slotId = Number(
            insertSlot.run(linkId, receiverId, nowIso, expiredAtIso, nowIso).lastInsertRowid
          );
          insertEntry.run(receiverId, slotId, expiredAtIso, nowIso, nowIso);
        }
      })();
    }

    // Regression: 同一個使用者並發重送解鎖時，後到的請求被回 RESERVATION_EXPIRED 而不是冪等回傳 (rereview-correctness Should Fix 1)
    it('解鎖的 batch 輸給同一位使用者先到的解鎖請求時，回傳已解鎖的連結與到期時間，不回 RESERVATION_EXPIRED', async () => {
      const { receiver } = await arrangeReservedClaim();
      const racing = createRacingD1(db);
      const { inviteQueueService } = createRacingServices(racing);
      racing.raceBeforeNextWrite({ operation: 'UPDATE', table: 'invite_slots' }, () =>
        receiver.reveal()
      );

      const result = await inviteQueueService.revealSlot(receiver.userId, currentNow);

      const myQueue = (await receiver.getMe()).myQueue;
      expect(myQueue?.status).toBe('revealed');
      expect(result).toEqual({
        referralUrl: 'https://claude.ai/referral/stateGuard01',
        confirmExpiresAt: myQueue?.confirmExpiresAt,
      });
    });

    it('解鎖的 batch 輸給保留逾時的結算時，回 409 RESERVATION_EXPIRED，排隊紀錄是 expired', async () => {
      const { receiver } = await arrangeReservedClaim();
      const racing = createRacingD1(db);
      const { inviteQueueService } = createRacingServices(racing);
      const sweepService = createRacingServices().inviteQueueService;
      racing.raceBeforeNextWrite({ operation: 'UPDATE', table: 'invite_slots' }, () =>
        sweepService.processExpirations(new Date(currentNow.getTime() + RESERVATION_DURATION_MS))
      );

      await expect(
        inviteQueueService.revealSlot(receiver.userId, currentNow)
      ).rejects.toMatchObject({
        code: 'RESERVATION_EXPIRED',
        statusCode: 409,
      });
      expect(readQueueEntryStatus(receiver.userId)).toBe('expired');
    });

    it('保留已過期但逾時結算還沒掃到這筆時，解鎖回 409 RESERVATION_EXPIRED，紀錄不會變成 revealed', async () => {
      const { receiver } = await arrangeReservedClaim();
      advanceTimeMs(RESERVATION_DURATION_MS + 1000);
      // 逾時結算每次依到期時間由舊到新最多處理 EXPIRATION_SCAN_LIMIT（100）筆，
      // 所以比這筆更早到期的積壓正好塞滿一輪時，這筆這次不會被掃到。
      seedExpiredReservationBacklog(100);
      const { inviteQueueService } = createRacingServices();

      await expect(
        inviteQueueService.revealSlot(receiver.userId, currentNow)
      ).rejects.toMatchObject({
        code: 'RESERVATION_EXPIRED',
        statusCode: 409,
      });
      expect(readQueueEntryStatus(receiver.userId)).toBe('reserved');
    });

    // Regression: 解鎖的 batch 沒有確認排隊紀錄就是這個名額的持有紀錄，同一位使用者的舊紀錄逾時後以新紀錄重新獲配同一個名額時，舊請求會把新紀錄的名額解鎖
    it('解鎖的 batch 執行前，使用者的舊保留已逾時且以新排隊紀錄重新獲配同一個名額時，回 409 RESERVATION_EXPIRED，名額與新紀錄都維持 reserved，之後仍能正常解鎖', async () => {
      const { receiver } = await arrangeReservedClaim();
      const racing = createRacingD1(db);
      const { inviteQueueService } = createRacingServices(racing);
      const sweepService = createRacingServices().inviteQueueService;
      racing.raceBeforeNextWrite({ operation: 'UPDATE', table: 'invite_slots' }, async () => {
        await sweepService.processExpirations(
          new Date(currentNow.getTime() + RESERVATION_DURATION_MS + 1000)
        );
        await receiver.joinQueue('舊的保留逾時了，我重新排隊');
      });

      await expect(
        inviteQueueService.revealSlot(receiver.userId, currentNow)
      ).rejects.toMatchObject({
        code: 'RESERVATION_EXPIRED',
        statusCode: 409,
      });

      expect(readSoleSlotOfLink('stateGuard01').status).toBe('reserved');
      expect(readQueueEntryStatus(receiver.userId)).toBe('reserved');
      expect((await receiver.reveal()).status).toBe(200);
    });

    // Regression: 確認啟用的 batch 沒有綁定排隊紀錄的名額，舊名額被回報無效、排隊紀錄改配新名額並解鎖後，舊請求會把新紀錄標成 confirmed 而新名額停在 revealed
    it('手動確認的 batch 執行前，使用者已回報無效並重新獲配、解鎖另一個名額時，回 409 INVALID_STATE_TRANSITION，排隊紀錄與新名額都維持 revealed', async () => {
      const { receiver } = await arrangeReservedClaim();
      const secondProvider = await loginActor(app, env, 'p2@example.com', '提供者P2');
      await secondProvider.shareLink('https://claude.ai/referral/stateGuard02', 1);
      await receiver.reveal();
      const racing = createRacingD1(db);
      const { inviteQueueService } = createRacingServices(racing);
      racing.raceBeforeNextWrite({ operation: 'UPDATE', table: 'invite_slots' }, async () => {
        await receiver.reportInvalid();
        await receiver.reveal();
      });

      await expect(
        inviteQueueService.confirmSlot(receiver.userId, currentNow)
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        statusCode: 409,
      });

      expect(readQueueEntryStatus(receiver.userId)).toBe('revealed');
      expect(readSoleSlotOfLink('stateGuard02').status).toBe('revealed');
      expect((await receiver.confirm()).status).toBe(200);
      expect(readSoleSlotOfLink('stateGuard02').status).toBe('confirmed');
    });

    it('手動確認的 batch 輸給 30 分鐘自動確認時，確認回成功，提供者只收到 1 則感謝推播', async () => {
      const { provider, receiver } = await arrangeReservedClaim();
      await provider.subscribePush('https://fcm.googleapis.com/fcm/send/confirm-race-provider');
      await receiver.reveal();
      advanceTimeMs(CONFIRM_DURATION_MS + 1000);
      const racing = createRacingD1(db);
      const { inviteQueueService } = createRacingServices(racing);
      const cronService = createRacingServices().inviteQueueService;
      racing.raceBeforeNextWrite({ operation: 'UPDATE', table: 'invite_slots' }, () =>
        cronService.processExpirations(currentNow)
      );

      await expect(
        inviteQueueService.confirmSlot(receiver.userId, currentNow)
      ).resolves.toBeUndefined();

      expect(readQueueEntryStatus(receiver.userId)).toBe('confirmed');
      expect(recordedPushes.filter((push) => push.userId === provider.userId)).toHaveLength(1);
    });

    // Regression: 確認啟用輸給回報無效時仍回成功，紀錄其實已回到 waiting (rereview-correctness Nit confirmSlot)
    it('手動確認的 batch 輸給回報無效時，回 409 INVALID_STATE_TRANSITION，紀錄是 waiting 且提供者沒有收到感謝推播', async () => {
      const { provider, receiver } = await arrangeReservedClaim();
      await provider.subscribePush(
        'https://fcm.googleapis.com/fcm/send/confirm-vs-report-provider'
      );
      await receiver.reveal();
      const racing = createRacingD1(db);
      const { inviteQueueService } = createRacingServices(racing);
      racing.raceBeforeNextWrite({ operation: 'UPDATE', table: 'invite_slots' }, () =>
        receiver.reportInvalid()
      );

      await expect(
        inviteQueueService.confirmSlot(receiver.userId, currentNow)
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        statusCode: 409,
      });
      expect(readQueueEntryStatus(receiver.userId)).toBe('waiting');
      expect(recordedPushes.filter((push) => push.userId === provider.userId)).toHaveLength(0);
    });
  });

  describe('Router 驗證是輸入規則的唯一把關', () => {
    it.each([
      {
        path: '/api/links',
        field: '名額數量不在 1～3',
        body: {
          rawUrlInput: 'https://claude.ai/referral/badSlotCount',
          slotCount: 4,
        },
      },
      {
        path: '/api/links',
        field: '軌道不是 newbie 或 community',
        body: {
          rawUrlInput: 'https://claude.ai/referral/badTrackLink',
          track: 'vip',
        },
      },
      {
        path: '/api/queue',
        field: '感謝小卡少於 5 字',
        body: { thankYouMessage: '太短' },
      },
      {
        path: '/api/queue',
        field: '軌道不是 newbie 或 community',
        body: { thankYouMessage: '軌道值不合法的感謝小卡', track: 'vip' },
      },
    ])('$path 的 $field 時回 422 VALIDATION_ERROR', async ({ path, body }) => {
      const user = await loginActor(app, env, 'validation@example.com', '驗證使用者');

      const res = await user.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(422);
      expect((await parseJson<ApiErrorResponse>(res)).error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('請求被拒絕時不改動暱稱', () => {
    const jsonHeaders = { 'Content-Type': 'application/json' };

    // Regression: 暱稱在驗證前就更新，被拒絕的請求仍改掉暱稱 (review-correctness Nit 2)
    it('分享連結格式錯誤被 400 拒絕時，暱稱維持原值', async () => {
      const user = await loginActor(app, env, 'nicknameShare@example.com', '舊暱稱');

      const res = await user.request('/api/links', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          rawUrlInput: 'https://example.com/not-claude',
          nickname: '新暱稱',
        }),
      });

      expect(res.status).toBe(400);
      expect((await user.getMe()).user?.nickname).toBe('舊暱稱');
    });

    // Regression: 暱稱在驗證前就更新，被 NEWBIE_TRACK_ONLY 拒絕的請求仍改掉暱稱 (review-correctness Nit 2)
    it('分享過連結的使用者加入新手軌道被 409 拒絕時，暱稱維持原值', async () => {
      const user = await loginActor(app, env, 'nicknameJoin@example.com', '舊暱稱');
      await user.shareLink('https://claude.ai/referral/nicknameJoinShared', 1, 'community');

      const res = await user.request('/api/queue', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          thankYouMessage: '想排新手軌',
          track: 'newbie',
          nickname: '新暱稱',
        }),
      });

      expect(res.status).toBe(409);
      expect((await user.getMe()).user?.nickname).toBe('舊暱稱');
    });

    it('請求通過所有檢查後，暱稱更新為請求帶的新值', async () => {
      const user = await loginActor(app, env, 'nicknameOk@example.com', '舊暱稱');

      const res = await user.request('/api/queue', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          thankYouMessage: '正常排隊的感謝小卡',
          nickname: '新暱稱',
        }),
      });

      expect(res.status).toBe(201);
      expect((await user.getMe()).user?.nickname).toBe('新暱稱');
    });
  });

  describe('開發登入入口只在 development 環境開放', () => {
    const productionEnv = (): Env => ({
      ...env,
      ENVIRONMENT: 'production',
      SESSION_SECRET: 'production-session-secret',
      GOOGLE_CLIENT_ID: 'production-google-client-id',
    });

    // 模擬 Google tokeninfo 拒絕憑證，避免測試真的連外
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{}', { status: 400 }))
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each([
      { environment: 'development', expectedDevLoginEnabled: true },
      { environment: 'production', expectedDevLoginEnabled: false },
    ])(
      '匿名請求 GET /api/me 在 $environment 環境回傳 devLoginEnabled=$expectedDevLoginEnabled',
      async ({ environment, expectedDevLoginEnabled }) => {
        const requestEnv = environment === 'production' ? productionEnv() : env;

        const res = await app.request('/api/me', { method: 'GET' }, requestEnv);

        const me = ((await res.json()) as ApiSuccessResponse<MeDto>).data;
        expect(me.devLoginEnabled).toBe(expectedDevLoginEnabled);
      }
    );

    it('登入後的 GET /api/me 在 development 環境同樣回傳 devLoginEnabled=true', async () => {
      const user = await loginActor(app, env, 'devFlag@example.com', '開發旗標');

      expect((await user.getMe()).devLoginEnabled).toBe(true);
    });

    // Regression: dev-login 只擋 ENVIRONMENT === 'production'，其他值（含漏設）都放行 (review-correctness Should Fix 3)
    it('ENVIRONMENT 不是 development 時，dev-login 回 403', async () => {
      const staging: Env = { ...productionEnv(), ENVIRONMENT: 'staging' };

      const res = await app.request(
        '/api/auth/dev-login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'x@example.com' }),
        },
        staging
      );

      expect(res.status).toBe(403);
    });

    // Regression: google-demo-* token 在預設 Client ID 下繞過 Google 驗證 (review-correctness Should Fix 3)
    it.each([
      { environment: 'development', expectedStatus: 200 },
      { environment: 'production', expectedStatus: 401 },
    ])(
      '$environment 環境用 google-demo token 登入得到 HTTP $expectedStatus',
      async ({ environment, expectedStatus }) => {
        const requestEnv = environment === 'production' ? productionEnv() : env;
        const appWithRealVerifier = createApp({ now: () => currentNow });

        const res = await appWithRealVerifier.request(
          '/api/auth/google',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: 'google-demo-tester' }),
          },
          requestEnv
        );

        expect(res.status).toBe(expectedStatus);
      }
    );

    // Regression: 正式環境漏設 SESSION_SECRET 時用公開的預設值簽 session，等於認證繞過 (review-correctness Should Fix 3)
    it.each([
      { missing: 'SESSION_SECRET', override: { SESSION_SECRET: undefined } },
      {
        missing: 'GOOGLE_CLIENT_ID',
        override: { GOOGLE_CLIENT_ID: undefined },
      },
    ])('正式環境沒有設定 $missing 時，所有 API 請求回 500', async ({ override }) => {
      const misconfigured: Env = { ...productionEnv(), ...override };

      const res = await app.request('/api/me', { method: 'GET' }, misconfigured);

      expect(res.status).toBe(500);
    });
  });
});

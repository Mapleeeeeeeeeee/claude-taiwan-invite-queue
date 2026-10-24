import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorResponse } from '../../src/shared/types';
import { type Env, createApp } from '../../src/worker/index';
import { invalidateBoardCache } from '../../src/worker/queries/boardQuery';
import { PushSubscriptionRepository } from '../../src/worker/repositories/pushSubscriptionRepository';
import { UserRepository } from '../../src/worker/repositories/userRepository';
import {
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  WebPushService,
} from '../../src/worker/services/webPushService';
import { type AppInstance, type TestActor, loginActor } from '../helpers/testActor';
import { type StatementFailureInjector, createTestD1Database } from '../helpers/testD1';
import { createTestPushSubscriber } from '../helpers/webPushTestKeys';

// 形狀取自正式環境目前實際出現的訂閱網址（token 為虛構）。
const ANDROID_CHROME_ENDPOINT =
  'https://fcm.googleapis.com/fcm/send/eX4mPlE0aBc:APA91bGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz012345678';
const IPHONE_SAFARI_ENDPOINT =
  'https://web.push.apple.com/QGv3hJk9LmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';

describe('推播訂閱', () => {
  let env: Env;
  let sqlite: Database.Database;
  let failureInjector: StatementFailureInjector;
  let app: AppInstance;
  let currentNow: Date;

  beforeEach(() => {
    invalidateBoardCache();
    const setup = createTestD1Database();
    sqlite = setup.sqlite;
    failureInjector = setup.failureInjector;
    env = {
      DB: setup.db,
      ENVIRONMENT: 'development',
      SESSION_SECRET: 'test-session-secret-key',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      VAPID_PUBLIC_KEY: 'test-vapid-public-key',
    };
    currentNow = new Date('2026-03-01T10:00:00.000Z');
    app = createApp({ now: () => currentNow });
  });

  function readEndpointsOf(userId: number): string[] {
    const rows = sqlite
      .prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY id')
      .all(userId) as { endpoint: string }[];
    return rows.map(({ endpoint }) => endpoint);
  }

  function endpointOfDevice(deviceNumber: number): string {
    return `https://fcm.googleapis.com/fcm/send/device-${deviceNumber}`;
  }

  describe('訂閱網址只收瀏覽器的推播服務', () => {
    it.each([
      { name: 'Android Chrome 的 FCM', endpoint: ANDROID_CHROME_ENDPOINT },
      { name: 'iPhone Safari 的 Apple 推播', endpoint: IPHONE_SAFARI_ENDPOINT },
      { name: 'Chrome 的 FCM Web Push 路徑', endpoint: 'https://fcm.googleapis.com/wp/abc123' },
      { name: 'Firefox', endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc123' },
      {
        name: '桌面 Chromium 的 jmt17.google.com',
        endpoint:
          'https://jmt17.google.com/fcm/send/fX9kLmN2oPq:APA91bHrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWx',
      },
      {
        name: 'Edge 的 WNS 子網域',
        endpoint: 'https://wns2-par02p.notify.windows.com/w/?token=abc',
      },
    ])('$name 的網址回 200 並寫入訂閱', async ({ endpoint }) => {
      const subscriber = await loginActor(app, env, 'allowed@example.com', '訂閱者');

      const res = await subscriber.subscribePush(endpoint);

      expect(res.status).toBe(200);
      expect(readEndpointsOf(subscriber.userId)).toEqual([endpoint]);
    });

    // Regression: 推播訂閱只驗證是 https 網址，Worker 會對使用者指定的任意主機發 POST
    it.each([
      { name: '任意主機', endpoint: 'https://attacker.example/steal' },
      {
        name: '主機名稱以推播服務開頭的偽造網域',
        endpoint: 'https://fcm.googleapis.com.evil.example/fcm/send/x',
      },
      {
        name: '主機名稱以 jmt17.google.com 開頭的偽造網域',
        endpoint: 'https://jmt17.google.com.evil.example/fcm/send/x',
      },
      {
        name: '主機名稱含 jmt17.google.com 但不是它的偽造網域',
        endpoint: 'https://evil-jmt17.google.com.example/fcm/send/x',
      },
      {
        name: '以 jmt17.google.com 結尾的其他子網域',
        endpoint: 'https://evil.jmt17.google.com/fcm/send/x',
      },
      { name: '推播服務出現在路徑裡', endpoint: 'https://evil.example/fcm.googleapis.com' },
      {
        name: '推播服務寫在帳密欄位',
        endpoint: 'https://fcm.googleapis.com@evil.example/fcm/send/x',
      },
      { name: '以推播服務結尾但不是子網域的主機', endpoint: 'https://evilpush.apple.com/x' },
      { name: '非預設連接埠', endpoint: 'https://fcm.googleapis.com:8443/fcm/send/x' },
      { name: '帶帳密', endpoint: 'https://user:pass@fcm.googleapis.com/fcm/send/x' },
      { name: 'http 協定', endpoint: 'http://fcm.googleapis.com/fcm/send/x' },
    ])('$name 的網址回 422 VALIDATION_ERROR 且不寫入資料庫', async ({ endpoint }) => {
      const subscriber = await loginActor(app, env, 'rejected@example.com', '訂閱者');

      const res = await subscriber.subscribePush(endpoint);

      expect(res.status).toBe(422);
      expect(((await res.json()) as ApiErrorResponse).error.code).toBe('VALIDATION_ERROR');
      expect(readEndpointsOf(subscriber.userId)).toEqual([]);
    });
  });

  describe('每位使用者的訂閱數量上限', () => {
    async function subscribeDevices(subscriber: TestActor, deviceNumbers: number[]): Promise<void> {
      for (const deviceNumber of deviceNumbers) {
        currentNow = new Date(currentNow.getTime() + 1000);
        expect((await subscriber.subscribePush(endpointOfDevice(deviceNumber))).status).toBe(200);
      }
    }

    function deviceNumbersInRange(first: number, last: number): number[] {
      return Array.from({ length: last - first + 1 }, (_, index) => first + index);
    }

    it('已達上限時再訂閱新裝置，回 200 並刪掉最舊的訂閱，數量維持上限', async () => {
      const subscriber = await loginActor(app, env, 'cap@example.com', '多裝置使用者');
      await subscribeDevices(subscriber, deviceNumbersInRange(1, MAX_PUSH_SUBSCRIPTIONS_PER_USER));

      await subscribeDevices(subscriber, [MAX_PUSH_SUBSCRIPTIONS_PER_USER + 1]);

      expect(readEndpointsOf(subscriber.userId)).toEqual(
        deviceNumbersInRange(2, MAX_PUSH_SUBSCRIPTIONS_PER_USER + 1).map(endpointOfDevice)
      );
    });

    it('已達上限時重新送出已有的訂閱，不會刪掉任何訂閱，且它變成最新的一筆', async () => {
      const subscriber = await loginActor(app, env, 'refresh@example.com', '多裝置使用者');
      await subscribeDevices(subscriber, deviceNumbersInRange(1, MAX_PUSH_SUBSCRIPTIONS_PER_USER));

      await subscribeDevices(subscriber, [1]);
      await subscribeDevices(subscriber, [MAX_PUSH_SUBSCRIPTIONS_PER_USER + 1]);

      expect(readEndpointsOf(subscriber.userId)).toEqual(
        [1, ...deviceNumbersInRange(3, MAX_PUSH_SUBSCRIPTIONS_PER_USER + 1)].map(endpointOfDevice)
      );
    });

    it('上限只算在同一位使用者身上，不會刪到別人的訂閱', async () => {
      const heavyUser = await loginActor(app, env, 'heavy@example.com', '多裝置使用者');
      const otherUser = await loginActor(app, env, 'other@example.com', '另一位使用者');
      await otherUser.subscribePush(IPHONE_SAFARI_ENDPOINT);

      await subscribeDevices(
        heavyUser,
        deviceNumbersInRange(1, MAX_PUSH_SUBSCRIPTIONS_PER_USER + 1)
      );

      expect(readEndpointsOf(otherUser.userId)).toEqual([IPHONE_SAFARI_ENDPOINT]);
    });
  });

  describe('登出時移除這台裝置的推播訂閱', () => {
    const JSON_HEADERS = { 'Content-Type': 'application/json' };

    async function postLogout(
      cookie: string | undefined,
      body?: BodyInit,
      executionCtx?: ExecutionContext
    ): Promise<Response> {
      return app.request(
        '/api/auth/logout',
        {
          method: 'POST',
          headers: cookie ? { ...JSON_HEADERS, Cookie: cookie } : JSON_HEADERS,
          body,
        },
        env,
        executionCtx
      );
    }

    function expectLoggedOut(res: Response): void {
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toMatch(/session=;|Max-Age=0/i);
    }

    it('帶自己的 endpoint 登出時，刪掉那筆訂閱、保留同一位使用者的其他裝置，並清除 cookie', async () => {
      const user = await loginActor(app, env, 'logout@example.com', '登出者');
      await user.subscribePush(ANDROID_CHROME_ENDPOINT);
      await user.subscribePush(IPHONE_SAFARI_ENDPOINT);

      const res = await postLogout(
        user.cookie,
        JSON.stringify({ endpoint: ANDROID_CHROME_ENDPOINT })
      );

      expectLoggedOut(res);
      expect(readEndpointsOf(user.userId)).toEqual([IPHONE_SAFARI_ENDPOINT]);
    });

    it('不帶 body 登出時，訂閱原封不動並清除 cookie', async () => {
      const user = await loginActor(app, env, 'logoutNoBody@example.com', '登出者');
      await user.subscribePush(ANDROID_CHROME_ENDPOINT);

      const res = await postLogout(user.cookie);

      expectLoggedOut(res);
      expect(readEndpointsOf(user.userId)).toEqual([ANDROID_CHROME_ENDPOINT]);
    });

    it('帶別人的 endpoint 登出時，別人的訂閱保留，自己仍成功登出', async () => {
      const user = await loginActor(app, env, 'logoutThief@example.com', '登出者');
      const victim = await loginActor(app, env, 'logoutVictim@example.com', '被指名者');
      await victim.subscribePush(IPHONE_SAFARI_ENDPOINT);

      const res = await postLogout(
        user.cookie,
        JSON.stringify({ endpoint: IPHONE_SAFARI_ENDPOINT })
      );

      expectLoggedOut(res);
      expect(readEndpointsOf(victim.userId)).toEqual([IPHONE_SAFARI_ENDPOINT]);
    });

    it.each([
      { name: '不是 JSON', body: '{bad json' },
      { name: 'endpoint 不是字串', body: JSON.stringify({ endpoint: 123 }) },
      { name: '沒有 endpoint 欄位', body: JSON.stringify({ other: 'x' }) },
    ])('body $name 時，仍成功登出且訂閱原封不動', async ({ body }) => {
      const user = await loginActor(app, env, 'logoutMalformed@example.com', '登出者');
      await user.subscribePush(ANDROID_CHROME_ENDPOINT);

      const res = await postLogout(user.cookie, body);

      expectLoggedOut(res);
      expect(readEndpointsOf(user.userId)).toEqual([ANDROID_CHROME_ENDPOINT]);
    });

    it.each([
      { name: '自己的 endpoint', ownsEndpoint: true, expectedLogged: true },
      { name: '別人的 endpoint', ownsEndpoint: false, expectedLogged: false },
    ])(
      '帶 $name 登出時，只有真的刪掉訂閱才記 push.subscription_removed_by_user',
      async (scenario) => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
          const user = await loginActor(app, env, 'logoutLog@example.com', '登出者');
          const other = await loginActor(app, env, 'logoutLogOther@example.com', '別人');
          await (scenario.ownsEndpoint ? user : other).subscribePush(ANDROID_CHROME_ENDPOINT);
          infoSpy.mockClear();

          await postLogout(user.cookie, JSON.stringify({ endpoint: ANDROID_CHROME_ENDPOINT }));

          const loggedEvents = infoSpy.mock.calls.map(([line]) => JSON.parse(line as string).event);
          expect(loggedEvents.includes('push.subscription_removed_by_user')).toBe(
            scenario.expectedLogged
          );
        } finally {
          infoSpy.mockRestore();
        }
      }
    );

    // Regression: 登出時移除訂閱的 D1 刪除失敗，回應變 500 且 session cookie 沒被清掉，使用者登不出去
    it('移除訂閱的 D1 刪除失敗時，仍回 200 並清除 cookie，失敗交給 waitUntil 留在 log', async () => {
      const user = await loginActor(app, env, 'logoutD1Down@example.com', '登出者');
      await user.subscribePush(ANDROID_CHROME_ENDPOINT);
      const backgroundFailures: unknown[] = [];
      const executionCtx = {
        waitUntil: (task: Promise<unknown>) => {
          void task.catch((error: unknown) => backgroundFailures.push(error));
        },
        passThroughOnException() {},
      } as unknown as ExecutionContext;
      failureInjector.failNextWrite({ operation: 'DELETE', table: 'push_subscriptions' });

      const res = await postLogout(
        user.cookie,
        JSON.stringify({ endpoint: ANDROID_CHROME_ENDPOINT }),
        executionCtx
      );
      await vi.waitFor(() => expect(backgroundFailures).toHaveLength(1));

      expectLoggedOut(res);
      expect(await res.json()).toEqual({ data: { loggedOut: true } });
      expect((backgroundFailures[0] as Error).cause).toMatchObject({
        message: expect.stringContaining('injected D1 failure'),
      });
    });

    it('沒登入時帶 endpoint 登出，回 200 且不刪任何訂閱', async () => {
      const owner = await loginActor(app, env, 'logoutOwner@example.com', '訂閱者');
      await owner.subscribePush(ANDROID_CHROME_ENDPOINT);

      const res = await postLogout(
        undefined,
        JSON.stringify({ endpoint: ANDROID_CHROME_ENDPOINT })
      );

      expectLoggedOut(res);
      expect(readEndpointsOf(owner.userId)).toEqual([ANDROID_CHROME_ENDPOINT]);
    });
  });
  describe('金鑰不合規的訂閱', () => {
    const NOW_ISO = '2026-03-01T10:00:00.000Z';
    const UNCOMPRESSED_P256_POINT_PREFIX = 0x04;

    async function generateVapidConfig() {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
      );
      const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
      const uncompressedPublicKey = Buffer.concat([
        Buffer.from([UNCOMPRESSED_P256_POINT_PREFIX]),
        Buffer.from(privateJwk.x!, 'base64url'),
        Buffer.from(privateJwk.y!, 'base64url'),
      ]);
      return {
        publicKey: uncompressedPublicKey.toString('base64url'),
        privateKey: privateJwk.d!,
        subject: 'mailto:test@example.com',
      };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // 長度與 0x04 前綴都對，但 (x, y) 不在 P-256 曲線上。
    const OFF_CURVE_P256_POINT = Buffer.concat([
      Buffer.from([UNCOMPRESSED_P256_POINT_PREFIX]),
      Buffer.alloc(64, 0x01),
    ]);
    const WELL_FORMED_AUTH_SECRET = Buffer.alloc(16, 0x02);

    // Regression: 訂閱金鑰長度不合規時，伺服器略過加密，把明文 JSON 直接 POST 給推播服務
    // Regression: 公鑰不在 P-256 曲線上時，加密丟 DOMException 被當成暫時失敗，這筆訂閱永遠不被移除
    it.each([
      { name: '公鑰與驗證密鑰長度都不對', p256dh: 'AAAA', auth: 'AAAA' },
      { name: '不是 base64url 字元', p256dh: '!!!!', auth: '!!!!' },
      {
        name: '公鑰長度與前綴都對但不在 P-256 曲線上',
        p256dh: OFF_CURVE_P256_POINT.toString('base64url'),
        auth: WELL_FORMED_AUTH_SECRET.toString('base64url'),
      },
    ])('$name 時，不對推播服務送出任何請求，並移除這筆訂閱', async ({ p256dh, auth }) => {
      const fetchSpy = vi.fn(async (_endpoint: string) => new Response(null, { status: 201 }));
      vi.stubGlobal('fetch', fetchSpy);
      const { db, sqlite } = createTestD1Database();
      const pushRepo = new PushSubscriptionRepository(db);
      const user = await new UserRepository(db).upsertUserByGoogleProfile({
        googleSub: 'sub-malformed',
        email: 'malformed@example.com',
        defaultNickname: '壞金鑰使用者',
        nowIso: NOW_ISO,
      });
      await pushRepo.upsertPushSubscription({
        userId: user.id,
        endpoint: ANDROID_CHROME_ENDPOINT,
        p256dh,
        auth,
        nowIso: NOW_ISO,
      });
      const goodDevice = await createTestPushSubscriber();
      await pushRepo.upsertPushSubscription({
        userId: user.id,
        endpoint: IPHONE_SAFARI_ENDPOINT,
        ...goodDevice.keys,
        nowIso: NOW_ISO,
      });
      const service = new WebPushService(pushRepo, { vapidConfig: await generateVapidConfig() });

      const result = await service.sendNotificationToUser(user.id, { title: 't', body: 'b' });

      expect(fetchSpy.mock.calls.map(([endpoint]) => endpoint)).toEqual([IPHONE_SAFARI_ENDPOINT]);
      expect(result).toEqual({ deliveredCount: 1, removedExpiredCount: 1, failedCount: 0 });
      const remaining = sqlite.prepare('SELECT endpoint FROM push_subscriptions').all();
      expect(remaining).toEqual([{ endpoint: IPHONE_SAFARI_ENDPOINT }]);
    });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorResponse } from '../../src/shared/types';
import { type Env, createApp } from '../../src/worker/index';
import { invalidateBoardCache } from '../../src/worker/queries/boardQuery';
import { type AppInstance, loginActor } from '../helpers/testActor';
import { createTestD1Database } from '../helpers/testD1';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const VALID_BODY_BY_PATH: Record<string, unknown> = {
  '/api/links': { rawUrlInput: 'https://claude.ai/referral/rateLimit01', slotCount: 1 },
  '/api/queue': { thankYouMessage: '謝謝你的邀請連結' },
  '/api/queue/reveal': undefined,
  '/api/queue/confirm': undefined,
  '/api/queue/cancel': undefined,
  '/api/queue/report-invalid': undefined,
  '/api/push/subscribe': {
    endpoint: 'https://fcm.googleapis.com/fcm/send/rate-limit',
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
  },
  '/api/push/test': undefined,
};

/** 每個 key 最多放行 `allowedPerKey` 次，之後都擋下，用來取代 Workers 的 `RateLimit` binding。 */
function createFakeRateLimiter(allowedPerKey: number) {
  const countsByKey = new Map<string, number>();
  const limiter: RateLimit = {
    async limit({ key }) {
      const count = (countsByKey.get(key) ?? 0) + 1;
      countsByKey.set(key, count);
      return { success: count <= allowedPerKey };
    },
  };
  return { limiter, countsByKey };
}

describe('寫入 API 的請求頻率限制', () => {
  let env: Env;
  let app: AppInstance;

  beforeEach(() => {
    invalidateBoardCache();
    env = {
      DB: createTestD1Database().db,
      ENVIRONMENT: 'development',
      SESSION_SECRET: 'test-session-secret-key',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      VAPID_PUBLIC_KEY: 'test-vapid-public-key',
    };
    app = createApp();
  });

  function postJson(path: string, cookie: string | null, requestEnv: Env): Promise<Response> {
    const body = VALID_BODY_BY_PATH[path];
    return Promise.resolve(
      app.request(
        path,
        {
          method: 'POST',
          headers: cookie ? { ...JSON_HEADERS, Cookie: cookie } : JSON_HEADERS,
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        requestEnv
      )
    );
  }

  it.each(Object.keys(VALID_BODY_BY_PATH))(
    'Given_已登入使用者超過上限_When_POST %s_Then_回 429 與標準錯誤格式',
    async (path) => {
      const user = await loginActor(app, env, 'limited@example.com', '被限流者');
      const limitedEnv: Env = { ...env, WRITE_RATE_LIMITER: createFakeRateLimiter(0).limiter };

      const res = await postJson(path, user.cookie, limitedEnv);

      expect(res.status).toBe(429);
      const body = (await res.json()) as ApiErrorResponse;
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.message).toBe('操作太頻繁，請稍後再試');
    }
  );

  it('Given_已登入使用者未超過上限_When_連續寫入_Then_照常處理，超過第 N 次才回 429', async () => {
    const user = await loginActor(app, env, 'within@example.com', '未超限者');
    const limitedEnv: Env = { ...env, WRITE_RATE_LIMITER: createFakeRateLimiter(2).limiter };

    const first = await postJson('/api/queue', user.cookie, limitedEnv);
    const second = await postJson('/api/queue/cancel', user.cookie, limitedEnv);
    const third = await postJson('/api/queue/cancel', user.cookie, limitedEnv);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it('Given_請求被限流_When_檢查使用者狀態_Then_寫入沒有發生', async () => {
    const user = await loginActor(app, env, 'blocked@example.com', '被擋下者');
    const limitedEnv: Env = { ...env, WRITE_RATE_LIMITER: createFakeRateLimiter(0).limiter };

    await postJson('/api/queue', user.cookie, limitedEnv);

    expect((await user.getMe()).myQueue).toBeNull();
  });

  it('Given_兩位使用者_When_其中一位用完額度_Then_另一位不受影響', async () => {
    const heavyUser = await loginActor(app, env, 'heavy@example.com', '大量請求者');
    const lightUser = await loginActor(app, env, 'light@example.com', '一般使用者');
    const limitedEnv: Env = { ...env, WRITE_RATE_LIMITER: createFakeRateLimiter(1).limiter };

    await postJson('/api/queue/cancel', heavyUser.cookie, limitedEnv);
    const heavyUserSecond = await postJson('/api/queue/cancel', heavyUser.cookie, limitedEnv);
    const lightUserFirst = await postJson('/api/queue/cancel', lightUser.cookie, limitedEnv);

    expect(heavyUserSecond.status).toBe(429);
    expect(lightUserFirst.status).toBe(404);
  });

  it('Given_限流器全部擋下_When_登入與讀取_Then_不受限流影響', async () => {
    const { limiter, countsByKey } = createFakeRateLimiter(0);
    const limitedEnv: Env = { ...env, WRITE_RATE_LIMITER: limiter };

    const user = await loginActor(app, limitedEnv, 'reader@example.com', '讀取者');
    const me = await app.request('/api/me', { method: 'GET', headers: { Cookie: user.cookie } }, limitedEnv);
    const board = await app.request('/api/board', { method: 'GET' }, limitedEnv);
    const logout = await app.request('/api/auth/logout', { method: 'POST' }, limitedEnv);

    expect([me.status, board.status, logout.status]).toEqual([200, 200, 200]);
    expect(countsByKey.size).toBe(0);
  });

  it('Given_限流器全部擋下_When_匿名請求寫入_Then_仍回 401 且不消耗額度', async () => {
    const { limiter, countsByKey } = createFakeRateLimiter(0);
    const limitedEnv: Env = { ...env, WRITE_RATE_LIMITER: limiter };

    const res = await postJson('/api/queue', null, limitedEnv);

    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErrorResponse).error.code).toBe('UNAUTHORIZED');
    expect(countsByKey.size).toBe(0);
  });

  describe('非 development 環境', () => {
    // session cookie 用同一把密鑰簽發，所以可以拿開發環境登入的 cookie 打正式環境設定。
    const productionEnv = (): Env => ({
      ...env,
      ENVIRONMENT: 'production',
      GOOGLE_CLIENT_ID: 'production-google-client-id',
    });

    it('Given_正式環境沒有綁定限流器_When_已登入使用者寫入_Then_回 500 而不是放行', async () => {
      const user = await loginActor(app, env, 'unbound@example.com', '未綁定');

      const res = await postJson('/api/queue/cancel', user.cookie, productionEnv());

      expect(res.status).toBe(500);
      expect(((await res.json()) as ApiErrorResponse).error.code).toBe('INTERNAL_ERROR');
    });

    it('Given_正式環境有綁定限流器_When_已登入使用者寫入_Then_照常處理', async () => {
      const user = await loginActor(app, env, 'bound@example.com', '已綁定');
      const boundEnv: Env = { ...productionEnv(), WRITE_RATE_LIMITER: createFakeRateLimiter(5).limiter };

      const res = await postJson('/api/queue', user.cookie, boundEnv);

      expect(res.status).toBe(201);
    });
  });
});

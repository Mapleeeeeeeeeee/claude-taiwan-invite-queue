import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PUSH_ENDPOINT_LENGTH,
  MAX_RAW_URL_INPUT_LENGTH,
  MAX_REFERRAL_CODE_LENGTH,
  type ApiErrorResponse,
} from '../../src/shared/types';
import { type Env, createApp } from '../../src/worker/index';
import { invalidateBoardCache } from '../../src/worker/queries/boardQuery';
import { type AppInstance, loginActor } from '../helpers/testActor';
import { createTestD1Database } from '../helpers/testD1';

const REFERRAL_URL_PREFIX = 'https://claude.ai/referral/';
const PUSH_ENDPOINT_PREFIX = 'https://fcm.googleapis.com/fcm/send/';

describe('邀請連結與推播訂閱的輸入長度上限', () => {
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

  async function countRows(table: 'invite_links' | 'push_subscriptions'): Promise<number> {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first<{
      total: number;
    }>();
    return row?.total ?? 0;
  }

  describe('POST /api/links', () => {
    // Regression: 邀請代碼與 rawUrlInput 沒有長度上限，3 MB 代碼被存入資料庫 (QA F-5)
    it.each([
      {
        name: 'rawUrlInput 超過上限',
        rawUrlInput: `${REFERRAL_URL_PREFIX}abc ${'x'.repeat(MAX_RAW_URL_INPUT_LENGTH)}`,
      },
      {
        name: '邀請代碼比上限多 1 字',
        rawUrlInput: `${REFERRAL_URL_PREFIX}${'b'.repeat(MAX_REFERRAL_CODE_LENGTH + 1)}`,
      },
    ])('$name 時回 422 VALIDATION_ERROR 且不寫入資料庫', async ({ rawUrlInput }) => {
      const provider = await loginActor(app, env, 'toolong-link@example.com', '長輸入提供者');

      const res = await provider.shareLink(rawUrlInput);

      expect(res.status).toBe(422);
      expect(((await res.json()) as ApiErrorResponse).error.code).toBe('VALIDATION_ERROR');
      expect(await countRows('invite_links')).toBe(0);
    });

    // Regression: 10 MB 的 rawUrlInput 回 500 (QA F-5)，應由 bodyLimit 在驗證前回 413
    it('10 MB 的 rawUrlInput 回 413 且不寫入資料庫', async () => {
      const provider = await loginActor(app, env, 'huge-link@example.com', '超大輸入提供者');

      const res = await provider.shareLink(`${REFERRAL_URL_PREFIX}${'c'.repeat(10_000_000)}`);

      expect(res.status).toBe(413);
      expect(((await res.json()) as ApiErrorResponse).error.code).toBe('INVALID_INPUT');
      expect(await countRows('invite_links')).toBe(0);
    });

    it.each([
      {
        name: '邀請代碼剛好等於上限',
        rawUrlInput: `${REFERRAL_URL_PREFIX}${'b'.repeat(MAX_REFERRAL_CODE_LENGTH)}`,
      },
      {
        name: 'rawUrlInput 剛好等於上限',
        rawUrlInput: `${REFERRAL_URL_PREFIX}abc ${' '.repeat(MAX_RAW_URL_INPUT_LENGTH - REFERRAL_URL_PREFIX.length - 4)}`,
      },
    ])('$name 時回 201 並建立連結', async ({ rawUrlInput }) => {
      const provider = await loginActor(app, env, 'maxlen-link@example.com', '上限提供者');

      const res = await provider.shareLink(rawUrlInput);

      expect(res.status).toBe(201);
      expect(await countRows('invite_links')).toBe(1);
    });
  });

  describe('POST /api/push/subscribe', () => {
    // Regression: 推播訂閱 endpoint 沒有長度上限 (QA F-5)
    it('endpoint 比上限多 1 字時回 422 VALIDATION_ERROR 且不寫入資料庫', async () => {
      const subscriber = await loginActor(app, env, 'toolong-push@example.com', '長輸入訂閱者');

      const res = await subscriber.subscribePush(
        `${PUSH_ENDPOINT_PREFIX}${'d'.repeat(MAX_PUSH_ENDPOINT_LENGTH)}`
      );

      expect(res.status).toBe(422);
      expect(((await res.json()) as ApiErrorResponse).error.code).toBe('VALIDATION_ERROR');
      expect(await countRows('push_subscriptions')).toBe(0);
    });

    // Regression: 10 MB 的 endpoint 回 500 (QA F-5)，應由 bodyLimit 在驗證前回 413
    it('10 MB 的 endpoint 回 413 且不寫入資料庫', async () => {
      const subscriber = await loginActor(app, env, 'huge-push@example.com', '超大輸入訂閱者');

      const res = await subscriber.subscribePush(`${PUSH_ENDPOINT_PREFIX}${'d'.repeat(10_000_000)}`);

      expect(res.status).toBe(413);
      expect(((await res.json()) as ApiErrorResponse).error.code).toBe('INVALID_INPUT');
      expect(await countRows('push_subscriptions')).toBe(0);
    });

    it('endpoint 剛好等於上限時回 200 並寫入訂閱', async () => {
      const subscriber = await loginActor(app, env, 'maxlen-push@example.com', '上限訂閱者');
      const endpoint = PUSH_ENDPOINT_PREFIX.padEnd(MAX_PUSH_ENDPOINT_LENGTH, 'd');

      const res = await subscriber.subscribePush(endpoint);

      expect(res.status).toBe(200);
      expect(await countRows('push_subscriptions')).toBe(1);
    });
  });
});

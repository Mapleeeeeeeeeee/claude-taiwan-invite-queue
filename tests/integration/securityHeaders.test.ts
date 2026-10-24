import { beforeEach, describe, expect, it } from 'vitest';
import { type Env, createApp } from '../../src/worker/index';
import { invalidateBoardCache } from '../../src/worker/queries/boardQuery';
import { type AppInstance } from '../helpers/testActor';
import { createTestD1Database } from '../helpers/testD1';

describe('API 回應的安全標頭', () => {
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

  // 與 public/_headers 對靜態資源設定的值相同，讓 API 與頁面的標頭一致。
  it('Given_任何訪客_When_讀取 API_Then_禁止被嵌入 frame 且只對跨站送出來源', async () => {
    const res = await app.request('/api/board', { method: 'GET' }, env);

    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

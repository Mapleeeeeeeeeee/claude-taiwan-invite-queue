import { beforeEach, describe, expect, it } from 'vitest';
import { type Env, createApp } from '../../src/worker/index';
import { invalidateBoardCache } from '../../src/worker/queries/boardQuery';
import { type AppInstance, loginActor } from '../helpers/testActor';
import { createTestD1Database } from '../helpers/testD1';

describe('API 回應的 Cache-Control', () => {
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

  it('Given_已登入使用者_When_讀取個人狀態_Then_回應禁止共享快取與儲存', async () => {
    const user = await loginActor(app, env, 'cache-me@example.com', '快取使用者');

    const res = await user.request('/api/me');

    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('Given_未登入訪客_When_讀取個人狀態_Then_回應同樣禁止共享快取與儲存', async () => {
    const res = await app.request('/api/me', { method: 'GET' }, env);

    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('Given_任何訪客_When_讀取看板_Then_只快取 15 秒且過期後不先給舊資料', async () => {
    const res = await app.request('/api/board', { method: 'GET' }, env);

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=15');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_RAW_URL_INPUT_LENGTH,
  type ApiErrorResponse,
} from '../../src/shared/types';
import { type Env, createApp } from '../../src/worker/index';
import { invalidateBoardCache } from '../../src/worker/queries/boardQuery';
import { type AppInstance, loginActor } from '../helpers/testActor';
import { createTestD1Database } from '../helpers/testD1';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const REFERRAL_URL_PREFIX = 'https://claude.ai/referral/';
const OVERSIZED_BODY_BYTES = 64 * 1024;
const OVERSIZED_BODY = JSON.stringify({ rawUrlInput: 'x'.repeat(OVERSIZED_BODY_BYTES) });

describe('API 請求本文大小上限', () => {
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

  async function expectPayloadTooLarge(res: Response): Promise<void> {
    expect(res.status).toBe(413);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = (await res.json()) as ApiErrorResponse;
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.message).not.toBe('');
  }

  // Regression: 沒有請求本文大小上限，10 MB 的 body 會整個被讀進記憶體再驗證 (QA F-5)
  it('Given_已登入使用者_When_送出超過上限的本文_Then_回 413 與標準錯誤格式', async () => {
    const provider = await loginActor(app, env, 'bigbody@example.com', '大本文提供者');

    const res = await app.request(
      '/api/links',
      { method: 'POST', headers: { ...JSON_HEADERS, Cookie: provider.cookie }, body: OVERSIZED_BODY },
      env
    );

    await expectPayloadTooLarge(res);
  });

  it('Given_未登入訪客_When_送出超過上限的本文_Then_先回 413 而不是 401', async () => {
    const res = await app.request(
      '/api/links',
      { method: 'POST', headers: JSON_HEADERS, body: OVERSIZED_BODY },
      env
    );

    await expectPayloadTooLarge(res);
  });

  it('Given_沒有 Content-Length 的分塊請求_When_累計超過上限_Then_回 413', async () => {
    const provider = await loginActor(app, env, 'chunked@example.com', '分塊提供者');
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(OVERSIZED_BODY.slice(0, OVERSIZED_BODY_BYTES / 2)));
        controller.enqueue(encoder.encode(OVERSIZED_BODY.slice(OVERSIZED_BODY_BYTES / 2)));
        controller.close();
      },
    });

    const res = await app.request(
      '/api/links',
      {
        method: 'POST',
        headers: { ...JSON_HEADERS, Cookie: provider.cookie },
        body,
        duplex: 'half',
      } as RequestInit,
      env
    );

    await expectPayloadTooLarge(res);
  });

  it('Given_每字三位元組的最大長度 rawUrlInput_When_分享連結_Then_不被本文上限擋下', async () => {
    const provider = await loginActor(app, env, 'cjkmax@example.com', '最大本文提供者');
    const padding = '字'.repeat(MAX_RAW_URL_INPUT_LENGTH - REFERRAL_URL_PREFIX.length - 4);

    const res = await provider.shareLink(`${REFERRAL_URL_PREFIX}abc ${padding}`);

    expect(res.status).toBe(201);
  });
});

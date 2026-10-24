import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorResponse, ApiSuccessResponse } from '../../src/shared/types';
import { type Env, createApp } from '../../src/worker/index';
import { invalidateBoardCache } from '../../src/worker/queries/boardQuery';
import { createGoogleTokenVerifier } from '../../src/worker/services/googleTokenVerifier';
import { createTestD1Database } from '../helpers/testD1';

const CLIENT_ID = 'test-google-client-id';
// 比 jose 重抓 JWKS 的冷卻時間（30 秒）長，才會在遇到未知 kid 時真的重抓。
const PAST_JWKS_REFETCH_COOLDOWN_MS = 60_000;
const NOW = new Date('2026-10-25T00:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

interface TestSigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey & { kid: string };
}

async function createSigningKey(kid: string): Promise<TestSigningKey> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const exported = await crypto.subtle.exportKey('jwk', publicKey);
  return { kid, privateKey, publicJwk: { ...exported, kid, alg: 'RS256', use: 'sig' } };
}

function toBase64Url(input: string | ArrayBuffer): string {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  return Buffer.from(bytes).toString('base64url');
}

type Claims = Record<string, unknown>;

function buildValidClaims(overrides: Claims = {}): Claims {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: 'google-sub-1',
    email: 'verified@example.com',
    email_verified: true,
    name: 'Google 使用者',
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 3600,
    ...overrides,
  };
}

async function signToken(
  key: TestSigningKey,
  claims: Claims,
  header: Claims = { alg: 'RS256', typ: 'JWT', kid: key.kid }
): Promise<string> {
  const signingInput = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${toBase64Url(signature)}`;
}

describe('POST /api/auth/google 的 Google ID Token 驗證', () => {
  let googleKey: TestSigningKey;
  let otherKey: TestSigningKey;
  let env: Env;
  let app: ReturnType<typeof createApp>;
  let fetchJwks: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>;
  let publishedKeys: TestSigningKey[];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    invalidateBoardCache();
    googleKey ??= await createSigningKey('google-key-1');
    otherKey ??= await createSigningKey('google-key-2');
    env = {
      DB: createTestD1Database().db,
      ENVIRONMENT: 'development',
      SESSION_SECRET: 'test-session-secret-key',
      GOOGLE_CLIENT_ID: CLIENT_ID,
      VAPID_PUBLIC_KEY: 'test-vapid-public-key',
    };
    publishedKeys = [googleKey];
    fetchJwks = vi.fn(
      async () =>
        Response.json({ keys: publishedKeys.map((key) => key.publicJwk) })
    );
    // 同一個測試內的多次登入共用同一個 verifier，也就是同一份 JWKS 快取。
    app = createApp({ googleTokenVerifier: createGoogleTokenVerifier(fetchJwks) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loginWithGoogle(idToken: string): Promise<Response> {
    return app.request(
      '/api/auth/google',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
      env
    );
  }

  async function readErrorCode(res: Response): Promise<string> {
    return ((await res.json()) as ApiErrorResponse).error.code;
  }

  describe('有效的 token', () => {
    it('簽章、aud、iss、exp 與 email_verified 都通過時登入成功，暱稱取自 name', async () => {
      const res = await loginWithGoogle(await signToken(googleKey, buildValidClaims()));

      expect(res.status).toBe(200);
      const { user } = ((await res.json()) as ApiSuccessResponse<{ user: Record<string, unknown> }>)
        .data;
      expect(user).toMatchObject({ email: 'verified@example.com', nickname: 'Google 使用者' });
    });

    it.each([{ iss: 'accounts.google.com' }, { iss: 'https://accounts.google.com' }])(
      'iss 為 $iss 時登入成功',
      async ({ iss }) => {
        const res = await loginWithGoogle(await signToken(googleKey, buildValidClaims({ iss })));

        expect(res.status).toBe(200);
      }
    );

    it('token 沒有 name 時，暱稱退回 email 的 @ 前綴', async () => {
      const res = await loginWithGoogle(
        await signToken(googleKey, buildValidClaims({ name: undefined }))
      );

      const { user } = ((await res.json()) as ApiSuccessResponse<{ user: { nickname: string } }>)
        .data;
      expect(user.nickname).toBe('verified');
    });
  });

  describe('無效的 token 一律回 401 INVALID_GOOGLE_TOKEN', () => {
    const invalidClaims = [
      { reason: 'aud 不是本站的 Client ID', overrides: { aud: 'another-app-client-id' } },
      { reason: 'iss 不是 Google', overrides: { iss: 'https://evil.example.com' } },
      { reason: '已過期', overrides: { exp: NOW_SECONDS - 1 } },
      { reason: '沒有 exp', overrides: { exp: undefined } },
      { reason: 'email_verified 為 false', overrides: { email_verified: false } },
      { reason: '沒有 email_verified', overrides: { email_verified: undefined } },
      { reason: '沒有 email', overrides: { email: undefined } },
      { reason: '沒有 sub', overrides: { sub: undefined } },
    ];

    it.each(invalidClaims)('$reason', async ({ overrides }) => {
      const res = await loginWithGoogle(
        await signToken(googleKey, buildValidClaims(overrides))
      );

      expect(res.status).toBe(401);
      expect(await readErrorCode(res)).toBe('INVALID_GOOGLE_TOKEN');
    });

    it('簽章後 payload 被竄改', async () => {
      const [header, , signature] = (await signToken(googleKey, buildValidClaims())).split('.');
      const forgedPayload = toBase64Url(
        JSON.stringify(buildValidClaims({ email: 'victim@example.com' }))
      );

      const res = await loginWithGoogle(`${header}.${forgedPayload}.${signature}`);

      expect(res.status).toBe(401);
      expect(await readErrorCode(res)).toBe('INVALID_GOOGLE_TOKEN');
    });

    it('用另一把私鑰簽、卻宣稱 Google 的 kid', async () => {
      const forged = await signToken(otherKey, buildValidClaims(), {
        alg: 'RS256',
        typ: 'JWT',
        kid: googleKey.kid,
      });

      const res = await loginWithGoogle(forged);

      expect(res.status).toBe(401);
      expect(await readErrorCode(res)).toBe('INVALID_GOOGLE_TOKEN');
    });

    it('標頭宣告對稱演算法 HS256', async () => {
      const res = await loginWithGoogle(
        await signToken(googleKey, buildValidClaims(), {
          alg: 'HS256',
          typ: 'JWT',
          kid: googleKey.kid,
        })
      );

      expect(res.status).toBe(401);
      expect(await readErrorCode(res)).toBe('INVALID_GOOGLE_TOKEN');
    });

    it('根本不是 JWT 格式', async () => {
      const res = await loginWithGoogle('not-a-jwt');

      expect(res.status).toBe(401);
      expect(await readErrorCode(res)).toBe('INVALID_GOOGLE_TOKEN');
      expect(fetchJwks).not.toHaveBeenCalled();
    });
  });

  describe('Google 金鑰輪替', () => {
    it('token 的 kid 不在已快取的金鑰裡時，重抓 JWKS 後用新金鑰驗證成功', async () => {
      await loginWithGoogle(await signToken(googleKey, buildValidClaims()));
      publishedKeys = [googleKey, otherKey];
      vi.setSystemTime(NOW.getTime() + PAST_JWKS_REFETCH_COOLDOWN_MS);

      const res = await loginWithGoogle(
        await signToken(otherKey, buildValidClaims({ exp: NOW_SECONDS + 7200 }))
      );

      expect(res.status).toBe(200);
      expect(fetchJwks).toHaveBeenCalledTimes(2);
    });

    it('重抓後仍找不到 kid 時回 401，且只重抓一次', async () => {
      await loginWithGoogle(await signToken(googleKey, buildValidClaims()));
      vi.setSystemTime(NOW.getTime() + PAST_JWKS_REFETCH_COOLDOWN_MS);

      const res = await loginWithGoogle(
        await signToken(otherKey, buildValidClaims({ exp: NOW_SECONDS + 7200 }))
      );

      expect(res.status).toBe(401);
      expect(await readErrorCode(res)).toBe('INVALID_GOOGLE_TOKEN');
      expect(fetchJwks).toHaveBeenCalledTimes(2);
    });
  });

  describe('JWKS 抓取失敗', () => {
    it('把錯誤向上傳播成 500，而不是當成 token 無效', async () => {
      fetchJwks.mockRejectedValue(new Error('JWKS endpoint unreachable'));

      const res = await loginWithGoogle(await signToken(googleKey, buildValidClaims()));

      expect(res.status).toBe(500);
      expect(await readErrorCode(res)).toBe('INTERNAL_ERROR');
    });
  });
});

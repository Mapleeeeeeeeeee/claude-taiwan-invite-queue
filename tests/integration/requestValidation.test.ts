import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_NICKNAME_LENGTH, type ApiErrorResponse } from '../../src/shared/types';
import { type Env, createApp } from '../../src/worker/index';
import { invalidateBoardCache } from '../../src/worker/queries/boardQuery';
import { type AppInstance, loginActor } from '../helpers/testActor';
import { createTestD1Database } from '../helpers/testD1';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const EMOJI = '😀';

describe('寫入路由的請求驗證', () => {
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

  async function readErrorCode(res: Response): Promise<string> {
    return ((await res.json()) as ApiErrorResponse).error.code;
  }

  describe('壞 JSON 與空 body', () => {
    // Regression: Hono zValidator 對壞 JSON／空 body 丟 HTTPException，被全域 onError 當未預期錯誤回 500 (QA smoke)
    it.each([
      { path: '/api/auth/google', needsLogin: false },
      { path: '/api/auth/dev-login', needsLogin: false },
      { path: '/api/links', needsLogin: true },
      { path: '/api/queue', needsLogin: true },
      { path: '/api/push/subscribe', needsLogin: true },
    ])('$path 收到壞 JSON 或空 body 時回 400 INVALID_INPUT', async ({ path, needsLogin }) => {
      const user = needsLogin
        ? await loginActor(app, env, 'badjson@example.com', '壞 JSON 使用者')
        : null;
      const cookieHeaders = user ? { ...JSON_HEADERS, Cookie: user.cookie } : JSON_HEADERS;

      for (const body of ['{bad json', '']) {
        const res = await app.request(path, { method: 'POST', headers: cookieHeaders, body }, env);

        expect(res.status).toBe(400);
        expect(await readErrorCode(res)).toBe('INVALID_INPUT');
      }
    });

    it('壞 JSON 的錯誤訊息指出請求內容格式錯誤，不叫使用者重試', async () => {
      const user = await loginActor(app, env, 'badjsonmsg@example.com', '壞 JSON 使用者');

      const res = await user.request('/api/queue', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{bad json',
      });

      const message = ((await res.json()) as ApiErrorResponse).error.message;
      expect(message).toContain('請求內容格式錯誤');
      expect(message).not.toContain('重試');
      expect(message).not.toContain('稍後');
    });
  });

  describe('未登入的寫入', () => {
    // Regression: 匿名 POST /api/queue 帶不合法 body 先回 422，帶合法 body 才回 401 (QA smoke)
    it.each([
      { path: '/api/links', body: '{}' },
      { path: '/api/links', body: '{bad json' },
      { path: '/api/queue', body: JSON.stringify({ thankYouMessage: 'x' }) },
      { path: '/api/queue', body: '{bad json' },
      { path: '/api/queue', body: JSON.stringify({ thankYouMessage: '合法的感謝小卡內容' }) },
      { path: '/api/queue/reveal', body: '' },
      { path: '/api/queue/confirm', body: '' },
      { path: '/api/queue/report-invalid', body: '' },
      { path: '/api/queue/cancel', body: '' },
      { path: '/api/push/subscribe', body: '{}' },
      { path: '/api/push/subscribe', body: '{bad json' },
      { path: '/api/push/test', body: '' },
    ])('匿名 POST $path 帶 $body 一律回 401 UNAUTHORIZED', async ({ path, body }) => {
      const res = await app.request(path, { method: 'POST', headers: JSON_HEADERS, body }, env);

      expect(res.status).toBe(401);
      expect(await readErrorCode(res)).toBe('UNAUTHORIZED');
    });
  });

  describe('排隊時省略 track', () => {
    it('新手資格的使用者省略 track 仍可加入排隊，由伺服器決定軌道', async () => {
      const user = await loginActor(app, env, 'omittrack@example.com', '省略軌道使用者');

      const res = await user.request('/api/queue', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ thankYouMessage: '合法的感謝小卡內容' }),
      });

      expect(res.status).toBe(201);
      expect((await user.getMe()).myQueue?.track).toBe('newbie');
    });
  });

  describe('感謝小卡字數以 Unicode 碼點計算', () => {
    it.each([
      { name: '200 個 emoji', message: EMOJI.repeat(200), status: 201 },
      { name: '201 個 emoji', message: EMOJI.repeat(201), status: 422 },
      { name: '5 個 emoji', message: EMOJI.repeat(5), status: 201 },
      { name: '4 個 emoji', message: EMOJI.repeat(4), status: 422 },
      { name: '前後空白加 5 個中文字', message: '  謝謝你分享  ', status: 201 },
      { name: '前後空白加 4 個中文字', message: '  謝謝你分  ', status: 422 },
      { name: '200 個中文字', message: '謝'.repeat(200), status: 201 },
      { name: '201 個中文字', message: '謝'.repeat(201), status: 422 },
    ])('$name 回 $status', async ({ message, status }) => {
      const user = await loginActor(app, env, 'codepoint@example.com', '字數使用者');

      const res = await user.request('/api/queue', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ thankYouMessage: message, track: 'newbie' }),
      });

      expect(res.status).toBe(status);
      if (status === 422) {
        expect(await readErrorCode(res)).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('感謝小卡必須含可見字元', () => {
    // Regression: 5 個零寬空白或全是空白格式字元的小卡通過 5 字下限並上牆顯示成空白 (QA O-20)
    it.each([
      { name: '5 個零寬空白', message: '\u200B'.repeat(5), status: 422 },
      { name: '零寬連接符與零寬非連接符', message: '\u200D\u200C\u200D\u200C\u200D', status: 422 },
      { name: '空白與零寬字元混合', message: ' \u200B \u200B\n\uFEFF\u200B', status: 422 },
      { name: '4 個零寬空白夾 1 個可見字', message: '\u200B\u200B謝\u200B\u200B', status: 201 },
      { name: '5 個 emoji', message: EMOJI.repeat(5), status: 201 },
    ])('$name 回 $status', async ({ message, status }) => {
      const user = await loginActor(app, env, 'invisible@example.com', '不可見字元使用者');

      const res = await user.joinQueue(message, 'newbie');

      expect(res.status).toBe(status);
      if (status === 422) {
        expect(await readErrorCode(res)).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('暱稱必須含可見字元且長度合法', () => {
    const NICKNAME_ROUTES = [
      {
        name: 'dev-login',
        path: '/api/auth/dev-login',
        needsLogin: false,
        body: { email: 'nickname-dev@example.com' },
        failure: { status: 400, code: 'INVALID_INPUT' },
        successStatus: 200,
      },
      {
        name: 'Google 登入',
        path: '/api/auth/google',
        needsLogin: false,
        body: { idToken: 'nickname-google' },
        failure: { status: 400, code: 'INVALID_INPUT' },
        successStatus: 200,
      },
      {
        name: '分享連結',
        path: '/api/links',
        needsLogin: true,
        body: { rawUrlInput: 'https://claude.ai/referral/NICKNAMECODE', slotCount: 1 },
        failure: { status: 422, code: 'VALIDATION_ERROR' },
        successStatus: 201,
      },
      {
        name: '加入排隊',
        path: '/api/queue',
        needsLogin: true,
        body: { thankYouMessage: '合法的感謝小卡內容', track: 'newbie' },
        failure: { status: 422, code: 'VALIDATION_ERROR' },
        successStatus: 201,
      },
    ];

    const REJECTED_NICKNAMES = [
      { name: '4 個零寬空白', nickname: '​'.repeat(4), message: '暱稱需包含可見的文字' },
      { name: '零寬連接符與雙向控制字元', nickname: '‍‮‌', message: '暱稱需包含可見的文字' },
      { name: 'Hangul Filler（U+3164）', nickname: '\u3164', message: '暱稱需包含可見的文字' },
      { name: 'Braille Pattern Blank（U+2800）', nickname: '\u2800\u2800', message: '暱稱需包含可見的文字' },
      { name: '空字串', nickname: '', message: '暱稱不可為空' },
      { name: '全是空白', nickname: '   ', message: '暱稱不可為空' },
      {
        name: `${MAX_NICKNAME_LENGTH + 1} 個字`,
        nickname: '名'.repeat(MAX_NICKNAME_LENGTH + 1),
        message: `暱稱不可超過 ${MAX_NICKNAME_LENGTH} 字`,
      },
    ];

    const ACCEPTED_NICKNAMES = [
      { name: '零寬空白夾一個可見字', nickname: '​​小​​' },
      { name: '剛好上限字數', nickname: '名'.repeat(MAX_NICKNAME_LENGTH) },
    ];

    let nicknameApp: AppInstance;

    beforeEach(() => {
      nicknameApp = createApp({
        googleTokenVerifier: async (idToken: string) => ({
          sub: `google-${idToken}`,
          email: `${idToken}@example.com`,
          name: 'Google 顯示名稱',
        }),
      });
    });

    async function postWithNickname(
      route: (typeof NICKNAME_ROUTES)[number],
      nickname: string
    ): Promise<Response> {
      const headers: Record<string, string> = { ...JSON_HEADERS };
      if (route.needsLogin) {
        const user = await loginActor(nicknameApp, env, 'nickname-writer@example.com', '既有暱稱');
        headers.Cookie = user.cookie;
      }
      return nicknameApp.request(
        route.path,
        { method: 'POST', headers, body: JSON.stringify({ ...route.body, nickname }) },
        env
      );
    }

    // Regression: 暱稱全是零寬空白也通過驗證，感謝牆顯示空白名字；空與超長暱稱回英文 Zod 訊息 (QA)
    describe.each(NICKNAME_ROUTES)('$name', (route) => {
      it.each(REJECTED_NICKNAMES)(
        '暱稱為 $name 時回該路由的驗證失敗狀態與中文訊息',
        async ({ nickname, message }) => {
          const res = await postWithNickname(route, nickname);

          expect(res.status).toBe(route.failure.status);
          const { error } = (await res.json()) as ApiErrorResponse;
          expect(error.code).toBe(route.failure.code);
          expect(error.message).toBe(message);
        }
      );

      it.each(ACCEPTED_NICKNAMES)('暱稱為 $name 時仍通過驗證', async ({ nickname }) => {
        const res = await postWithNickname(route, nickname);

        expect(res.status).toBe(route.successStatus);
      });
    });
  });
});

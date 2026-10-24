import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import {
  type AppEnv,
  type CreateAppOptions,
  type Env,
  createServices,
  isDevelopment,
  resolveWriteRateLimiter,
} from './appServices';
import {
  buildErrorBody,
  createRateLimitedError,
  createUnauthorizedError,
  handleError,
} from './errorHandler';
import { logInfo } from './logger';
import { BOARD_CACHE_TTL_MS, fetchBoardDto, isBoardCacheFresh } from './queries/boardQuery';
import { fetchMeDto } from './queries/meQuery';
import {
  AUTH_VALIDATION_FAILURE,
  devLoginSchema,
  googleLoginSchema,
  joinQueueSchema,
  limitRequestBody,
  logoutSchema,
  pushSubscribeSchema,
  submitLinkSchema,
  validateJson,
} from './requestSchemas';
import { AppError } from './errors';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from './services/authService';
import type { RunInBackground } from './services/inviteQueueService';

export { createServices } from './appServices';
export type { Env } from './appServices';

const HONO_NO_EXECUTION_CONTEXT_MESSAGE = 'This context has no ExecutionContext';
const BOARD_CACHE_MAX_AGE_SECONDS = BOARD_CACHE_TTL_MS / 1000;

const TEST_PUSH_DELIVERED_MESSAGE = '測試通知已成功送出！請檢查手機或瀏覽器推播通知。';
const TEST_PUSH_DELIVERY_FAILED_MESSAGE =
  '已偵測到推播訂閱裝置，但通知送出失敗，請稍後再試；若持續失敗，請聯絡管理員檢查推播金鑰設定。';
const TEST_PUSH_NO_DEVICE_MESSAGE =
  '目前尚未偵測到有效的推播訂閱裝置，請先點擊開啟推播並允許權限。';

function describeTestPushResult(result: {
  deliveredCount: number;
  failedCount: number;
}): string {
  if (result.deliveredCount > 0) {
    return TEST_PUSH_DELIVERED_MESSAGE;
  }
  return result.failedCount > 0 ? TEST_PUSH_DELIVERY_FAILED_MESSAGE : TEST_PUSH_NO_DEVICE_MESSAGE;
}

/**
 * 取得 Workers 的 `waitUntil`；在 Workers 之外（整合測試直接呼叫 `app.request`）沒有 ExecutionContext，回傳 undefined。
 * Hono 的 `c.executionCtx` 在這種情況會丟錯，且沒有不丟錯的檢查方式，所以只在這裡接住。
 */
function getRunInBackground(c: Context): RunInBackground | undefined {
  try {
    const executionCtx = c.executionCtx;
    return (task) => executionCtx.waitUntil(task);
  } catch (error) {
    if (error instanceof Error && error.message === HONO_NO_EXECUTION_CONTEXT_MESSAGE) {
      return undefined;
    }
    throw error;
  }
}

/** 讀取 JSON body；沒有 body 或不是合法 JSON 時回傳 `null`。 */
async function readJsonBodyOrNull(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export function createApp(options?: CreateAppOptions) {
  const getNow = options?.now ?? (() => new Date());
  const app = new Hono<AppEnv>();

  // 與 public/_headers 對靜態資源設定的值一致。
  app.use(
    '/api/*',
    secureHeaders({ xFrameOptions: 'DENY', referrerPolicy: 'strict-origin-when-cross-origin' })
  );
  app.use('/api/*', logger());
  app.use('/api/*', limitRequestBody);

  app.use('/api/*', async (c, next) => {
    const services = createServices(c.env, options, getRunInBackground(c));
    c.set('services', services);
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (!token) {
      c.set('userId', null);
      await next();
      return;
    }

    const session = await services.authService.verifySessionToken(token, getNow());
    c.set('userId', session ? session.userId : null);
    await next();
  });

  const setSessionCookie = (
    c: Context<AppEnv>,
    sessionToken: string
  ): void => {
    setCookie(c, SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      path: '/',
      sameSite: 'Lax',
      secure: !isDevelopment(c.env),
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  };

  const requireUserId = (c: { get: (key: 'userId') => number | null }): number => {
    const userId = c.get('userId');
    if (userId === null) {
      throw createUnauthorizedError();
    }
    return userId;
  };

  // 在 zValidator 之前先擋下匿名請求與超過頻率的請求：未登入的人不論 body 是否合法都先拿到 401，
  // 限流以使用者 id 計數，所以排在登入檢查之後，匿名請求不會消耗任何人的額度。
  // `/api/queue/*` 也會比對到 `/api/queue`，再列一次會讓同一個請求被計兩次。
  app.on(
    'POST',
    ['/api/links', '/api/queue/*', '/api/push/*'],
    async (c, next) => {
      const userId = requireUserId(c);
      const rateLimiter = resolveWriteRateLimiter(c.env);
      if (rateLimiter) {
        const { success } = await rateLimiter.limit({ key: String(userId) });
        if (!success) {
          throw createRateLimitedError();
        }
      }
      await next();
    }
  );

  app.get('/api/board', async (c) => {
    const now = getNow();
    if (!isBoardCacheFresh(now)) {
      await c.get('services').inviteQueueService.processExpirations(now);
    }
    const board = await fetchBoardDto(c.env.DB, now);
    c.header('Cache-Control', `public, max-age=${BOARD_CACHE_MAX_AGE_SECONDS}`);
    return c.json({ data: board }, 200);
  });

  app.get('/api/me', async (c) => {
    const now = getNow();
    const userId = c.get('userId');
    const { vapidPublicKey, googleClientId } = c.get('services');
    const serverConfig = {
      vapidPublicKey,
      devLoginEnabled: isDevelopment(c.env),
      googleClientId,
    };
    if (userId !== null) {
      await c.get('services').inviteQueueService.processExpirations(now);
    }
    const me = await fetchMeDto(c.env.DB, userId, serverConfig, now);
    // 回應含電子郵件與解鎖後的邀請網址，不可被共享快取存放。
    c.header('Cache-Control', 'private, no-store');
    return c.json({ data: me }, 200);
  });

  app.post(
    '/api/auth/google',
    validateJson(googleLoginSchema, AUTH_VALIDATION_FAILURE),
    async (c) => {
      const now = getNow();
      const body = c.req.valid('json');
      const { authService } = c.get('services');
      const { user, sessionToken } = await authService.loginWithGoogle({
        idToken: body.idToken,
        nickname: body.nickname,
        now,
      });

      logInfo('auth.google_login', { userId: user.id });

      setSessionCookie(c, sessionToken);

      return c.json({ data: { user } }, 200);
    }
  );

  app.post(
    '/api/auth/dev-login',
    validateJson(devLoginSchema, AUTH_VALIDATION_FAILURE),
    async (c) => {
      if (!isDevelopment(c.env)) {
        throw new AppError('UNAUTHORIZED', '正式環境不開放開發者測試登入', 403);
      }

      const now = getNow();
      const body = c.req.valid('json');
      const { authService } = c.get('services');
      const { user, sessionToken } = await authService.loginWithDevAccount({
        email: body.email,
        nickname: body.nickname,
        googleSub: body.googleSub,
        now,
      });

      logInfo('auth.dev_login', { userId: user.id });

      setSessionCookie(c, sessionToken);

      return c.json({ data: { user } }, 200);
    }
  );

  // body 是選填的，壞掉或不合規格都當作沒帶，登出不能因此失敗。
  app.post('/api/auth/logout', async (c) => {
    const userId = c.get('userId');
    const body = logoutSchema.safeParse(await readJsonBodyOrNull(c));
    if (userId !== null && body.success) {
      // 清訂閱只是順手的善後，D1 暫時出錯時使用者仍要登出得了（共用裝置上不能留著登入狀態）。
      // 交給 waitUntil 後，失敗不影響這個回應，Workers 會把拒絕的 promise 記進 log；
      // 沒有 ExecutionContext（Workers 之外）時才就地 await，讓失敗不被吞掉。
      const cleanup = c.get('services').pushService.removeSubscription(userId, body.data.endpoint);
      const runInBackground = getRunInBackground(c);
      if (runInBackground) {
        runInBackground(cleanup);
      } else {
        await cleanup;
      }
    }
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    return c.json({ data: { loggedOut: true } }, 200);
  });

  app.post(
    '/api/links',
    validateJson(submitLinkSchema),
    async (c) => {
      const userId = requireUserId(c);
      const now = getNow();
      const body = c.req.valid('json');
      const { inviteQueueService } = c.get('services');
      const result = await inviteQueueService.submitInviteLink({
        userId,
        rawUrlInput: body.rawUrlInput,
        slotCount: body.slotCount,
        track: body.track,
        nickname: body.nickname,
        now,
      });

      return c.json({ data: result }, 201);
    }
  );

  app.post(
    '/api/queue',
    validateJson(joinQueueSchema),
    async (c) => {
      const userId = requireUserId(c);
      const now = getNow();
      const body = c.req.valid('json');
      const { inviteQueueService } = c.get('services');
      const result = await inviteQueueService.joinQueue({
        userId,
        thankYouMessage: body.thankYouMessage,
        track: body.track,
        nickname: body.nickname,
        now,
      });

      return c.json({ data: result }, 201);
    }
  );

  app.post('/api/queue/reveal', async (c) => {
    const userId = requireUserId(c);
    const now = getNow();
    const { inviteQueueService } = c.get('services');
    const result = await inviteQueueService.revealSlot(userId, now);
    return c.json({ data: result }, 200);
  });

  app.post('/api/queue/confirm', async (c) => {
    const userId = requireUserId(c);
    const now = getNow();
    const { inviteQueueService } = c.get('services');
    await inviteQueueService.confirmSlot(userId, now);
    return c.json({ data: { confirmed: true } }, 200);
  });

  app.post('/api/queue/report-invalid', async (c) => {
    const userId = requireUserId(c);
    const now = getNow();
    const { inviteQueueService } = c.get('services');
    const result = await inviteQueueService.reportSlotInvalid(userId, now);
    return c.json({ data: result }, 200);
  });

  app.post('/api/queue/cancel', async (c) => {
    const userId = requireUserId(c);
    const now = getNow();
    const { inviteQueueService } = c.get('services');
    await inviteQueueService.cancelQueue(userId, now);
    return c.json({ data: { cancelled: true } }, 200);
  });

  app.post(
    '/api/push/subscribe',
    validateJson(pushSubscribeSchema),
    async (c) => {
      const userId = requireUserId(c);
      const now = getNow();
      const body = c.req.valid('json');
      const { pushService } = c.get('services');
      await pushService.saveSubscription(userId, body, now);
      return c.json({ data: { subscribed: true } }, 200);
    }
  );

  app.post('/api/push/test', async (c) => {
    const userId = requireUserId(c);
    const { pushService } = c.get('services');
    const result = await pushService.sendNotificationToUser(userId, {
      title: 'Claude 邀請碼排隊系統',
      body: '這是一則測試通知！你的推播設定已啟用，輪到你領取或有人啟用你的分享時將收到通知。',
      url: '/',
      tag: 'test-push-notification',
    });

    return c.json(
      {
        data: {
          sent: result.deliveredCount > 0,
          deliveredCount: result.deliveredCount,
          message: describeTestPushResult(result),
        },
      },
      200
    );
  });

  app.all('*', async (c) => {
    if (!c.req.path.startsWith('/api/') && c.env.ASSETS) {
      return c.env.ASSETS.fetch(c.req.raw);
    }
    return c.json(buildErrorBody('NOT_FOUND', '找不到請求的 API 路徑'), 404);
  });

  app.onError(handleError);

  return app;
}

const defaultApp = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return defaultApp.fetch(request, env, ctx);
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const { inviteQueueService } = createServices(env, undefined, (task) => ctx.waitUntil(task));
    const scheduledDate = new Date(controller.scheduledTime);
    ctx.waitUntil(
      inviteQueueService.processExpirations(scheduledDate).then((summary) => {
        logInfo('cron.process_expirations', {
          scheduledTime: scheduledDate.toISOString(),
          expiredReservations: summary.expiredReservations,
          autoConfirmedSlots: summary.autoConfirmedSlots,
        });
      })
    );
  },
};

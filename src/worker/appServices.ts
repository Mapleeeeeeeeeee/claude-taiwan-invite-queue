import { DEFAULT_GOOGLE_CLIENT_ID } from '../shared/types';
import { invalidateBoardAndTotalConfirmedCount, invalidateBoardCache } from './queries/boardQuery';
import { InviteQueueRepository } from './repositories/inviteQueueRepository';
import { PushSubscriptionRepository } from './repositories/pushSubscriptionRepository';
import { UserRepository } from './repositories/userRepository';
import { AuthService } from './services/authService';
import type { GoogleTokenVerifier } from './services/googleTokenVerifier';
import { InviteQueueService, type RunInBackground } from './services/inviteQueueService';
import { type PushSender, WebPushService } from './services/webPushService';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** 寫入 API 的請求頻率限制；視窗與次數設定在 wrangler.toml 的 `[[ratelimits]]`。 */
  WRITE_RATE_LIMITER?: RateLimit;
  ENVIRONMENT?: string;
  SESSION_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

type Services = ReturnType<typeof createServices>;

interface AppVariables {
  userId: number | null;
  services: Services;
}

/** Hono 應用程式的 Bindings 與 Variables 型別。 */
export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}

export interface CreateAppOptions {
  now?: () => Date;
  pushSender?: PushSender;
  googleTokenVerifier?: GoogleTokenVerifier;
}

const DEFAULT_SESSION_SECRET = 'dev-session-secret-change-in-production';
// 與 .dev.vars.example 的開發用 VAPID 公鑰相同（web-push 文件的範例金鑰），只供本機開發，正式環境必須自行設定。
const DEVELOPMENT_VAPID_PUBLIC_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

export function isDevelopment(env: Env): boolean {
  return env.ENVIRONMENT === 'development';
}

/**
 * 取得寫入 API 的限流器。
 * development 環境沒綁定時不限流；其他環境沒綁定就丟出錯誤，避免部署設定漏掉 binding 時悄悄失去保護。
 */
export function resolveWriteRateLimiter(env: Env): RateLimit | undefined {
  if (env.WRITE_RATE_LIMITER) {
    return env.WRITE_RATE_LIMITER;
  }
  if (!isDevelopment(env)) {
    throw new Error('非 development 環境必須綁定 WRITE_RATE_LIMITER，不可略過寫入限流');
  }
  return undefined;
}

/**
 * 解析驗證用的密鑰設定。
 * 非 development 環境若仍在使用 repo 內公開的預設值，任何人都能偽造 session 或用展示 token 登入，
 * 所以直接丟出錯誤讓請求失敗，不退回預設值。
 */
function resolveAuthSecrets(env: Env): { sessionSecret: string; googleClientId: string } {
  const sessionSecret = env.SESSION_SECRET || DEFAULT_SESSION_SECRET;
  const googleClientId = env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
  const isUsingDefaults =
    sessionSecret === DEFAULT_SESSION_SECRET || googleClientId === DEFAULT_GOOGLE_CLIENT_ID;
  if (!isDevelopment(env) && isUsingDefaults) {
    throw new Error('非 development 環境必須設定 SESSION_SECRET 與 GOOGLE_CLIENT_ID，不可使用預設值');
  }
  return { sessionSecret, googleClientId };
}

/**
 * 解析前端訂閱推播要用的 VAPID 公鑰。
 * 非 development 環境沒設定時直接丟出錯誤，不退回公開的範例公鑰，否則使用者訂閱的推播永遠送不出去。
 */
function resolveVapidPublicKey(env: Env): string {
  if (env.VAPID_PUBLIC_KEY) {
    return env.VAPID_PUBLIC_KEY;
  }
  if (!isDevelopment(env)) {
    throw new Error('非 development 環境必須設定 VAPID_PUBLIC_KEY，不可使用範例公鑰');
  }
  return DEVELOPMENT_VAPID_PUBLIC_KEY;
}

/**
 * 組出一次請求（或一次排程）要用的所有 service。
 * @param runInBackground 推播的送出方式，通常是 `ctx.waitUntil`；不傳時推播就地 await。
 */
export function createServices(
  env: Env,
  options?: CreateAppOptions,
  runInBackground?: RunInBackground
) {
  const userRepo = new UserRepository(env.DB);
  const pushRepo = new PushSubscriptionRepository(env.DB);
  const repo = new InviteQueueRepository(env.DB);
  const pushService = new WebPushService(pushRepo, {
    sender: options?.pushSender,
    vapidConfig:
      !options?.pushSender &&
      env.VAPID_PUBLIC_KEY &&
      env.VAPID_PRIVATE_KEY &&
      env.VAPID_SUBJECT
        ? {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT,
          }
        : undefined,
  });
  const { sessionSecret, googleClientId } = resolveAuthSecrets(env);
  const vapidPublicKey = resolveVapidPublicKey(env);
  const authService = new AuthService(
    userRepo,
    sessionSecret,
    googleClientId,
    isDevelopment(env),
    options?.googleTokenVerifier
  );
  const inviteQueueService = new InviteQueueService(
    repo,
    userRepo,
    pushService,
    invalidateBoardCache,
    invalidateBoardAndTotalConfirmedCount,
    runInBackground
  );

  return {
    userRepo,
    pushRepo,
    repo,
    pushService,
    authService,
    inviteQueueService,
    vapidPublicKey,
    googleClientId,
  };
}

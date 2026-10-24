import { zValidator } from '@hono/zod-validator';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  DEFAULT_QUEUE_TRACK,
  DEFAULT_SLOT_COUNT,
  MAX_NICKNAME_LENGTH,
  MAX_PUSH_ENDPOINT_LENGTH,
  MAX_RAW_URL_INPUT_LENGTH,
  MAX_REFERRAL_CODE_LENGTH,
  MAX_THANK_YOU_MESSAGE_LENGTH,
  MIN_THANK_YOU_MESSAGE_LENGTH,
  QUEUE_TRACKS,
  VALID_SLOT_COUNTS,
  type ErrorCode,
} from '../shared/types';
import { countThankYouMessageChars } from '../shared/thankYouMessage';
import { hasVisibleText } from '../shared/visibleText';
import { isKnownPushServiceEndpoint } from './domain/pushEndpoint';
import { extractAndNormalizeReferralLink } from './domain/rules';
import { buildErrorBody } from './errorHandler';
import { AppError } from './errors';

const nicknameSchema = z
  .string()
  .trim()
  .min(1, '暱稱不可為空')
  .max(MAX_NICKNAME_LENGTH, `暱稱不可超過 ${MAX_NICKNAME_LENGTH} 字`)
  .refine(hasVisibleText, '暱稱需包含可見的文字')
  .optional();
const queueTrackSchema = z.enum(QUEUE_TRACKS);

export const googleLoginSchema = z.object({
  idToken: z.string().min(1, '請提供 Google ID Token'),
  nickname: nicknameSchema,
});

export const devLoginSchema = z.object({
  email: z.string().trim().email('請輸入有效的 Email'),
  nickname: nicknameSchema,
  googleSub: z.string().trim().min(1).optional(),
});

const REFERRAL_INPUT_TOO_LONG_ERROR = `貼上的內容不可超過 ${MAX_RAW_URL_INPUT_LENGTH} 字`;
const REFERRAL_CODE_TOO_LONG_ERROR = `邀請代碼不可超過 ${MAX_REFERRAL_CODE_LENGTH} 字`;

export const submitLinkSchema = z.object({
  // 先擋總長度，再解析代碼，避免對超大字串跑網址比對。
  rawUrlInput: z
    .string()
    .max(MAX_RAW_URL_INPUT_LENGTH, REFERRAL_INPUT_TOO_LONG_ERROR)
    .pipe(
      z.string().refine((rawInput) => {
        const referralCode = extractAndNormalizeReferralLink(rawInput)?.referralCode;
        return referralCode === undefined || referralCode.length <= MAX_REFERRAL_CODE_LENGTH;
      }, REFERRAL_CODE_TOO_LONG_ERROR)
    ),
  slotCount: z.literal(VALID_SLOT_COUNTS).default(DEFAULT_SLOT_COUNT),
  track: queueTrackSchema.default(DEFAULT_QUEUE_TRACK),
  nickname: nicknameSchema,
});

const THANK_YOU_MESSAGE_LENGTH_ERROR = `感謝小卡需為 ${MIN_THANK_YOU_MESSAGE_LENGTH}～${MAX_THANK_YOU_MESSAGE_LENGTH} 字`;
const THANK_YOU_MESSAGE_INVISIBLE_ERROR = '感謝小卡需包含可見的文字';

export const joinQueueSchema = z.object({
  thankYouMessage: z
    .string()
    .trim()
    .refine((message) => {
      const length = countThankYouMessageChars(message);
      return length >= MIN_THANK_YOU_MESSAGE_LENGTH && length <= MAX_THANK_YOU_MESSAGE_LENGTH;
    }, THANK_YOU_MESSAGE_LENGTH_ERROR)
    .refine(hasVisibleText, THANK_YOU_MESSAGE_INVISIBLE_ERROR),
  // 沒帶 track 時不補預設值，由 service 依新手資格自動決定。
  track: queueTrackSchema.optional(),
  nickname: nicknameSchema,
});

export const pushSubscribeSchema = z.object({
  // 先擋長度再解析網址，10 MB 的字串不該進到網址解析。
  endpoint: z
    .string()
    .max(MAX_PUSH_ENDPOINT_LENGTH, `推播訂閱網址不可超過 ${MAX_PUSH_ENDPOINT_LENGTH} 字`)
    .pipe(z.url({ protocol: /^https$/, error: '推播訂閱網址必須是 https 網址' }))
    .refine(isKnownPushServiceEndpoint, '推播訂閱網址必須來自瀏覽器的推播服務'),
  keys: z.object({
    p256dh: z.string().min(1, '缺少 p256dh 金鑰'),
    auth: z.string().min(1, '缺少 auth 金鑰'),
  }),
});

/** 登出時可以帶這台裝置的推播訂閱網址，伺服器會順便移除那筆訂閱。 */
export const logoutSchema = z.object({
  endpoint: z.string().max(MAX_PUSH_ENDPOINT_LENGTH),
});

interface ValidationFailure {
  code: ErrorCode;
  statusCode: number;
}

/** 登入路由的欄位驗證失敗：與壞 JSON 同為 400 `INVALID_INPUT`。 */
export const AUTH_VALIDATION_FAILURE: ValidationFailure = {
  code: 'INVALID_INPUT',
  statusCode: 400,
};
/** 寫入路由（連結、排隊、推播訂閱）的欄位驗證失敗：422 `VALIDATION_ERROR`。 */
export const WRITE_VALIDATION_FAILURE: ValidationFailure = {
  code: 'VALIDATION_ERROR',
  statusCode: 422,
};

/**
 * 以 Zod schema 驗證 JSON body；驗證失敗時丟出 `AppError`，訊息取第一個欄位錯誤。
 * 預設用寫入路由的失敗格式，登入路由請傳 `AUTH_VALIDATION_FAILURE`。
 */
export function validateJson<TSchema extends z.ZodType>(
  schema: TSchema,
  failure: ValidationFailure = WRITE_VALIDATION_FAILURE
) {
  return zValidator('json', schema, (result) => {
    if (!result.success) {
      const firstMessage = result.error.issues[0]?.message ?? '欄位驗證失敗';
      throw new AppError(failure.code, firstMessage, failure.statusCode);
    }
  });
}

// 最大的合法本文是 2000 字且每字 3 位元組的 rawUrlInput，約 6 KB；其餘欄位（推播訂閱、Google ID Token）都在 3 KB 內。
const MAX_REQUEST_BODY_BYTES = 8 * 1024;
const REQUEST_BODY_TOO_LARGE_MESSAGE = '送出的內容太大，請縮短後再試一次';

/**
 * 限制 `/api/*` 的請求本文大小，超過時回 413 與標準錯誤格式。
 * 要掛在登入檢查與 `validateJson` 之前，否則超大本文會先被讀進記憶體。
 */
export const limitRequestBody = bodyLimit({
  maxSize: MAX_REQUEST_BODY_BYTES,
  onError: (c) => c.json(buildErrorBody('INVALID_INPUT', REQUEST_BODY_TOO_LARGE_MESSAGE), 413),
});

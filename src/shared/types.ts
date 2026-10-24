export type SlotStatus = 'available' | 'reserved' | 'revealed' | 'confirmed' | 'invalidated' | 'closed';
export type QueueStatus = 'waiting' | 'reserved' | 'revealed' | 'confirmed' | 'expired' | 'cancelled';
export const QUEUE_TRACKS = ['newbie', 'community'] as const;
export type QueueTrack = (typeof QUEUE_TRACKS)[number];
export const DEFAULT_QUEUE_TRACK: QueueTrack = 'newbie';

export const MIN_THANK_YOU_MESSAGE_LENGTH = 5;
export const MAX_THANK_YOU_MESSAGE_LENGTH = 200;
export const MAX_NICKNAME_LENGTH = 50;
// 使用者可能貼上「一整段訊息夾一個連結」，所以輸入框上限遠大於連結本身的長度。
export const MAX_RAW_URL_INPUT_LENGTH = 2000;
// 真實的邀請代碼約 10 到 20 字元。
export const MAX_REFERRAL_CODE_LENGTH = 64;
// 瀏覽器推播服務（FCM、APNs、Mozilla autopush）的 endpoint 通常不到 1 KB。
export const MAX_PUSH_ENDPOINT_LENGTH = 2048;
export const VALID_SLOT_COUNTS = [1, 2, 3] as const;
export type SlotCount = (typeof VALID_SLOT_COUNTS)[number];
export const DEFAULT_SLOT_COUNT: SlotCount = 3;
export const MAX_INVALID_RETRY_COUNT = 1;

/** 帳號還剩幾次無效重排機會；`invalidRetryCount` 是已經用掉的次數。 */
export function getRemainingRetryCount(invalidRetryCount: number): number {
  return Math.max(0, MAX_INVALID_RETRY_COUNT - invalidRetryCount);
}
export const THANK_YOU_WALL_LIMIT = 30;

// 小時與分鐘數獨立成常數，是為了讓畫面文字與後端通知用同一份數字組字串。
export const RESERVATION_DURATION_HOURS = 6;
export const CONFIRM_DURATION_MINUTES = 30;
export const RESERVATION_DURATION_MS = RESERVATION_DURATION_HOURS * 60 * 60 * 1000;
export const CONFIRM_DURATION_MS = CONFIRM_DURATION_MINUTES * 60 * 1000;

// Client ID 為預設值時（本機展示登入），後端接受 `google-demo-<暱稱>` 形式的 token。
export const DEFAULT_GOOGLE_CLIENT_ID = 'dev-google-client-id';
export const DEMO_TOKEN_PREFIX = 'google-demo-';
export const DEMO_DEFAULT_NICKNAME = '社團版友';

// 排隊紀錄的 `providerNickname` 為 `null` 時，畫面改用這個稱呼。
export const FALLBACK_PROVIDER_NICKNAME = '好心版友';
// 感謝小卡的收件人暱稱為 `null` 時，畫面改用這個稱呼。
export const FALLBACK_THANK_YOU_RECIPIENT = '提供者';

export const ERROR_CODES = [
  'UNAUTHORIZED',
  'INVALID_INPUT',
  'INVALID_GOOGLE_TOKEN',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'INVALID_REFERRAL_URL',
  'DUPLICATE_REFERRAL_CODE',
  'PROVIDER_BLOCKED',
  'ALREADY_IN_QUEUE',
  'NEWBIE_TRACK_ONLY',
  'QUEUE_ENTRY_NOT_FOUND',
  'RESERVATION_EXPIRED',
  'CONFIRM_WINDOW_EXPIRED',
  'RETRY_QUOTA_EXHAUSTED',
  'INVALID_STATE_TRANSITION',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return ERROR_CODES.some((code) => code === value);
}

export interface ApiErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export interface ApiSuccessResponse<T> {
  data: T;
}

/** `POST /api/auth/google` 與 `POST /api/auth/dev-login` 回傳的登入使用者。 */
export interface LoggedInUserDto {
  id: number;
  email: string;
  nickname: string;
}

export interface ThankYouWallItemDto {
  slotId: number;
  receiverNickname: string;
  providerNickname: string;
  thankYouMessage: string;
  /** 確認啟用的時間（ISO 8601 字串）。 */
  confirmedAt: string;
}

export interface BoardDto {
  availableSlotsCount: number;
  waitingQueueCount: number;
  totalConfirmedCount: number;
  newbieSlotsCount: number;
  communitySlotsCount: number;
  newbieQueueCount: number;
  communityQueueCount: number;
  thankYouWall: ThankYouWallItemDto[];
}

export interface MyQueueEntryDto {
  id: number;
  status: QueueStatus;
  track: QueueTrack;
  /** 當排隊狀態為 `'waiting'` 時代表目前排隊順位（從 1 開始起算），其餘狀態為 `null`。 */
  queuePosition: number | null;
  thankYouMessage: string;
  slotId: number | null;
  providerNickname: string | null;
  /** 僅在狀態為 `'revealed'` 或 `'confirmed'` 時回傳完整邀請網址，狀態為 `'reserved'` 時固定為 `null`。 */
  referralUrl: string | null;
  reserveExpiresAt: string | null;
  confirmExpiresAt: string | null;
  /** 代表使用者目前是否可點擊回報無效（需處於 `'revealed'` 狀態、未超過 30 分鐘且尚未使用過重排機會）。 */
  canReportInvalid: boolean;
  /** 這筆排隊紀錄是否因回報無效而被優先排回隊伍最前面（優先權高於預設值）。 */
  isRequeuedWithPriority: boolean;
}

export interface MySharedLinkDto {
  id: number;
  referralCode: string;
  normalizedUrl: string;
  totalSlots: number;
  createdAt: string;
  slots: Array<{
    id: number;
    status: SlotStatus;
    track: QueueTrack;
    receiverNickname: string | null;
    /** 僅在名額狀態為 `'confirmed'` 時回傳領取者預寫的感謝小卡內容，其餘狀態為 `null`。 */
    thankYouMessage: string | null;
    confirmedAt: string | null;
  }>;
}

export interface MeDto {
  user: {
    id: number;
    email: string;
    nickname: string;
    invalidRetryCount: number;
    invalidLinkStrikeCount: number;
    isProviderBlocked: boolean;
    hasPushSubscription: boolean;
    isEligibleForNewbieTrack: boolean;
    hasSharedLinks: boolean;
  } | null;
  myQueue: MyQueueEntryDto | null;
  /** 使用者歷史上最近一次已確認啟用的試用領取紀錄（不受後續取消或逾時影響）。 */
  myConfirmedClaim: MyQueueEntryDto | null;
  mySharedLinks: MySharedLinkDto[];
  vapidPublicKey: string;
  /** 伺服器是否開放開發登入入口（匿名請求也會回傳），前端據此決定是否顯示 DevDock。 */
  devLoginEnabled: boolean;
  /** Google 登入用的 OAuth Client ID（公開值，匿名請求也會回傳），前端用它初始化 Google Identity Services。 */
  googleClientId: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** 各 API 成功回應的 `data` 形狀，worker 回傳與前端 `apiClient` 解析共用。 */
export interface LoginResult {
  user: LoggedInUserDto;
}

export interface LogoutResult {
  loggedOut: boolean;
}

export interface ConfirmSlotResult {
  confirmed: boolean;
}

export interface CancelQueueResult {
  cancelled: boolean;
}

export interface SubscribePushResult {
  subscribed: boolean;
}

export interface SubmitLinkResult {
  linkId: number;
  matchedCount: number;
}

export interface JoinQueueResult {
  queueEntryId: number;
  status: QueueStatus;
}

export interface RevealSlotResult {
  referralUrl: string;
  confirmExpiresAt: string;
}

export interface ReportSlotInvalidResult {
  requeuedStatus: QueueStatus;
}

export interface TestPushResult {
  sent: boolean;
  message: string;
  deliveredCount: number;
}

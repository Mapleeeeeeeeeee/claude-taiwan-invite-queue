# Architecture: Claude Taiwan 邀請連結排隊與感謝回饋平台（invite-code-queue）

## 概述
本專案採用單一 Cloudflare Worker（搭配 Static Assets 與 D1 SQLite 資料庫）承載後端 Hono API、Cron 排程任務與前端 React + TypeScript PWA。寫入端（分享邀請連結、FIFO 排隊配對、6 小時保留解鎖、30 分鐘確認與無效重排）透過 `Router (Zod) → Service + Domain → Repository (D1 batch)` 確保狀態機與交易一致性；讀取端（首頁看板與公開感謝牆、個人狀態）直接以唯讀查詢回傳 DTO，並對公開看板加上短快取以確保高流量下穩居 Cloudflare 免費方案額度內。

## 架構決策

| 模組 | 結構 | 依據 | 替代方案與不選的原因 |
|------|------|------|------|
| 後端寫入與配對狀態機（分享連結、排隊、解鎖、確認、回報無效、逾時處理） | `Hono Router (Zod)` → `InviteQueueService` + `domain/rules.ts` → `InviteQueueRepository (D1 batch)` | 配對、無效重排、同組剩餘名額停用與提供者違規計算橫跨 `invite_links`、`invite_slots`、`queue_entries`、`users` 四張表，拆出純函數 Domain 與 D1 Batch Repository 才能隔離業務規則並確保原子寫入 | 1. 邏輯全寫在 Route handler：多處觸發 FIFO 配對（新增連結、加入排隊、逾時釋出、回報無效重排）會重複寫配對邏輯<br>2. 手寫原生 Worker `fetch` 路由：缺少框架內建的驗證、Cookie 與錯誤處理支援 |
| 後端唯讀查詢（首頁看板與感謝牆 `GET /api/board`、個人狀態 `GET /api/me`） | `Hono Router` → `boardQuery.ts`／`meQuery.ts` 用 drizzle 直接查詢 D1 回傳 DTO，其中 `/api/board` 結合記憶體/Cache 快取（TTL 15 秒，寫入變更時主動失效；`totalConfirmedCount` 另有 TTL 60 秒的獨立快取，只在席次被確認時清除，其他 Worker isolate 最多晚 60 秒追上），回應標頭為 `Cache-Control: public, max-age=15`，不用 `stale-while-revalidate`，所以瀏覽器看到的資料最多落後 15 秒；前端在使用者自己的動作成功後用 `cache: 'reload'` 重抓看板。`GET /api/me` 含 email 與邀請網址，回 `Cache-Control: private, no-store` | 讀取畫面無業務規則，直接查詢回傳 DTO 最簡潔；快取可防止社團貼文爆紅時大量訪客重刷首頁打爆 D1 讀取額度 | 1. 也走 Service + Repository：純轉發無隔離效益<br>2. 前端高頻輪詢（Polling）：數百人同時開啟會迅速耗盡 Worker 每日 10 萬次免費請求上限 |
| 逾時與自動確認排程（6 小時未解鎖回收、30 分鐘自動送出感謝） | Cloudflare Worker `scheduled` Cron Trigger（每 5 分鐘）＋ API 操作時惰性觸發 `processExpirations()`，底層以帶狀態條件的 SQL 更新防重 | 同時具備背景定時推進與使用者打開畫面即時生效的體驗，且完全跑在 Worker + D1 免費額度內 | 使用 Cloudflare Durable Objects Alarm：免費方案有額外計費門檻與配置複雜度，對分鐘級逾時規則屬過度設計 |
| Web Push 推播通知 | `webPushService.ts` 使用 Worker 原生 Web Crypto API 實作 VAPID JWT 簽章與推播發送（支援可注入 sender 替身供測試） | Cloudflare Worker 為 V8 Isolate 環境，使用原生 Web Crypto API 零外部 Node 相容問題，支援 iOS 16.4+ PWA 與 Android/Desktop 推播 | 傳統 Node `web-push` 套件：依賴 Node `crypto`/`https`/`stream` polyfill，在 Worker 環境易出相容性問題且打包體積大 |
| 身分驗證（Google 一鍵登入） | 前端用 `@react-oauth/google` 載入 Google Identity Services 並渲染官方登入按鈕（彈窗模式、`locale` 為 `zh-TW`，只在 `devLoginEnabled` 為 false 時掛載）；後端用 `jose` 的 `createRemoteJWKSet` + `jwtVerify` 驗證 ID Token 的 RS256 簽章與 `aud`、`iss`、`exp`，再自己檢查 `email_verified`，JWKS 快取 1 小時、遇到未知 `kid` 會重抓；驗證通過後簽發 HMAC-SHA256 簽章之 HttpOnly Session Cookie。Client ID 來自 secret `GOOGLE_CLIENT_ID`，由 `GET /api/me` 的 `googleClientId` 交給前端（非正式環境 `ENVIRONMENT=development` 額外開放 `/api/auth/dev-login` 供本地 curl 與自動化測試切換多角色） | 符合「點一下即完成登入」與「嚴格限制一帳號領一次」，且不依賴外部收費 Auth SaaS；開發端點讓本地 curl 與 QA 能完整模擬提供者與多位排隊者互動。Google 的 ID Token 彈窗只能由 Google 渲染的按鈕觸發，所以不需要 redirect URI 或 client secret；兩段都用現成套件，是因為框架與套件已有的能力先用，手寫 script 載入、JWKS 快取與換金鑰重抓都要自己維護 | 1. 引入第三方 Auth SaaS（Clerk/Auth0）：免費額度受限且多一層外部服務設定依賴<br>2. Hono 內建 `verifyWithJwks`：沒有 JWKS 快取，快取、換金鑰重抓、缺少 `exp` 的防護都要自己寫<br>3. Google `tokeninfo` 端點：官方標為除錯用，且每次登入多一次對外請求<br>4. 手寫 GIS 載入器（約 70 行）：`@react-oauth/google` 最後發布在 2026-04-08，更新慢但沒有封存，使用者接受這個風險；日後 Google API 變動時可改回手寫 |
| 資料存取層 | 全部使用 drizzle 查詢建構器（`repositories/`、`queries/` 都是），整個 `src/worker` 沒有 `db.prepare` 原生 SQL；建構器表達不了的地方才用 `sql` 片段，全專案上限 7 個，目前 repository 用了 5 個（以子查詢取連結 id、`row_number() over`、欄位自增、兩個 `CASE WHEN EXISTS`），每個旁邊用一句話說明原因，`queries/` 為 0 個 | 使用者拍板「全部 drizzle，允許 7 個 `sql` 片段」；寫入端的狀態轉移 guard、`db.batch` 原子交易與 `meta.changes` 樂觀檢查都保留（drizzle 的 D1 `batch` 對沒有 `.returning()` 的寫入仍回傳原始 `D1Result`）；單句查詢的錯誤會被包成 `DrizzleQueryError`，`UNIQUE` 衝突偵測改看 `.cause`，batch 路徑則是原始錯誤 | 「全部原生 SQL」：使用者否決；Kysely 零原生 SQL 但 D1 batch 需另行驗證；Prisma、MikroORM 在 D1 沒有原子 batch。drizzle-kit 無法拿 wrangler 的 migrations 當 baseline（inline UNIQUE 與未命名 CHECK 會被視為要重建），所以不另設第二套 migration，改用 `schemaDrift.test.ts` 驗證 `schema.ts` 與資料庫一致；故障注入改用暫時的 SQLite trigger（依資料表與操作類型），不依賴 SQL 文字 |
| 寫入 API 請求頻率限制 | 登入後的 `POST /api/links`、`/api/queue`、`/api/queue/*`、`/api/push/*` 在登入檢查之後呼叫 Workers Rate Limiting binding `WRITE_RATE_LIMITER`，以使用者 id 為 key，每 60 秒最多 20 次（設定在 `wrangler.toml` 的 `[[ratelimits]]`），超過回 429 `RATE_LIMITED`；匿名請求先回 401 不進限流，登入端點與 `GET` 不限流。binding 放在 `Env` 供測試注入假的 `RateLimit`，非 development 環境沒綁定時請求直接失敗 | Cloudflare 的計數是各資料中心各自近似、最終一致，本機 `wrangler dev` 卻是精確的固定視窗，所以這個限流只用來擋失控的重複請求（例如前端重送迴圈或腳本），不是嚴格配額，也不能拿本機行為推論正式環境的放行次數 | 1. 自己在 D1 記請求次數：每個請求多一次寫入，會吃掉 D1 免費額度，也讓限流與業務資料搶同一個資料庫<br>2. 用 Durable Objects 做精確計數：對「擋失控請求」過度設計，且有額外計費與配置成本 |
| 前端 PWA 架構 | React 19 + TypeScript + Vite + 原生 CSS（CSS Variables，`src/client/styles.css`），`View Components`（純 UI）+ `useInviteApp` ViewModel Hook + `apiClient.ts` + 原生 Service Worker (`public/sw.js`) | 前端包含多種狀態卡片（未排隊、排隊中、6hr 解鎖倒數、30min 確認倒數、二次確認對話框、iOS 加入主畫面指引），以 ViewModel Hook 收納狀態能保持元件乾淨且易於測試；使用原生 CSS 不引入 Tailwind CSS | 1. 在元件內直接 `fetch`：狀態與 UI 耦合難以測試<br>2. 前後端拆成兩個 repo：部署與型別共享成本高，不如單一 Worker Assets 整合 |

## Files to Create / Modify

### 新建
| File | Purpose |
|------|---------|
| `package.json` | 專案依賴、開發啟動、建置與測試指令定義 |
| `tsconfig.json` | TypeScript 嚴格模式設定（前後端型別檢查） |
| `vite.config.ts` | Vite 前端打包與開發伺服器代理設定 |
| `wrangler.toml` | Cloudflare Worker、D1 綁定、Static Assets 與 Cron Trigger 設定。不放 `[vars]`，所以沒設正式 secret 的部署，第一個請求就會因 `resolveAuthSecrets` 丟錯，不會放行 dev-login |
| `.dev.vars` | 本機 `wrangler dev` 自動載入的開發值（`ENVIRONMENT=development`、開發用 `SESSION_SECRET`、`GOOGLE_CLIENT_ID`、VAPID 範例金鑰）；範本是 `.dev.vars.example`，正式部署不使用 |
| `migrations/0001_init.sql` | D1 資料庫初始資料表與索引（`users`、`invite_links`、`invite_slots`、`queue_entries`、`push_subscriptions`） |
| `src/shared/types.ts` | 前後端共用的 DTO、狀態列舉、錯誤碼與 API 介面型別 |
| `src/worker/errors.ts` | `AppError` 自定義異常類與錯誤碼定義 |
| `src/worker/domain/rules.ts` | 純函數業務規則（邀請連結擷取與正規化、提供者違規計算、無效重排資格判斷） |
| `src/worker/repositories/inviteQueueRepository.ts` | D1 資料庫讀寫與原子批次交易封裝，用 drizzle 查詢建構器寫成，只在建構器表達不了的地方用 `sql` 片段 |
| `src/worker/db/schema.ts` | drizzle 資料表定義（5 張表，含 CHECK 與 partial unique index），由 `tests/integration/schemaDrift.test.ts` 對照 migrations 建出的資料庫逐項驗證沒有漂移 |
| `src/worker/services/webPushService.ts` | VAPID Web Push 訂閱管理、通知發送與失效憑證清理 |
| `src/worker/services/authService.ts` | Google 登入流程（交給 verifier 驗證 ID Token）、Session Cookie 簽發與解析 |
| `src/worker/services/googleTokenVerifier.ts` | 用 `jose` 驗證 Google ID Token（簽章、`aud`、`iss`、`exp`、`email_verified`）；token 無效丟 401 `INVALID_GOOGLE_TOKEN`，JWKS 抓取失敗向上傳播成 500；測試經 `createApp({ googleTokenVerifier })` 注入假的 JWKS fetch |
| `src/worker/services/inviteQueueService.ts` | 核心業務流程（提交連結、加入排隊、FIFO 配對、解鎖看碼、確認啟用、回報無效、逾時處理） |
| `src/worker/queries/boardQuery.ts` | 首頁看板與公開感謝牆唯讀查詢（含 15 秒看板快取與 `totalConfirmedCount` 獨立快取：TTL 60 秒，席次被確認時清除） |
| `src/worker/queries/meQuery.ts` | 使用者個人狀態（`GET /api/me`）唯讀查詢 |
| `src/worker/index.ts` | Hono 應用程式入口、路由註冊、body 大小限制、寫入限流 middleware 與 Worker `fetch`/`scheduled` 匯出 |
| `src/worker/requestSchemas.ts` | 所有 Zod request schema、驗證訊息與 `validateJson` helper |
| `src/worker/appServices.ts` | `Env` 型別、secrets 與 binding 解析、`createServices` 依賴組裝 |
| `src/worker/errorHandler.ts` | 全域 `onError`、`buildErrorBody`（錯誤回應單一組裝點）與 `UNAUTHORIZED` 錯誤 factory |
| `src/client/api/apiClient.ts` | 前端強型別 API 呼叫與錯誤解析封裝 |
| `src/client/hooks/useInviteApp.ts` | 前端核心 ViewModel Hook（整合看板、個人排隊/分享狀態、操作動作與倒數計時） |
| `src/client/components/BoardStats.tsx` | 首頁即時看板元件（可用名額、排隊人數、累計成功分享數） |
| `src/client/components/ThankYouWall.tsx`、`ViewAllModal.tsx`、`Spotlight.tsx` | 首頁公開感謝牆（純 CSS 跑馬燈）、「查看全部」彈窗與單張卡詳細內容，兩個彈窗用原生 `<dialog>`（`useModalDialog` hook） |
| `src/client/components/PushToggleButton.tsx`、`InAppBrowserAlert.tsx`、`PwaInstallBanner.tsx`、`DevDock.tsx` | 推播開關、內建瀏覽器提示、PWA 安裝與 iOS「加入主畫面」引導、本機開發登入面板 |
| `src/client/components/ReceiverPanel.tsx`、`ReceiverRevealedCard.tsx`、`ClaimHistoryCard.tsx`、`JoinQueueForm.tsx` | 領取者主操作區：父元件分派狀態，子元件各自負責 revealed 卡（含回報無效二次確認 `<dialog>`）、領取歷史卡、排隊表單 |
| `src/client/components/ProviderPanel.tsx` | 提供者主操作區（分享連結表單、剩餘次數 1/2/3 選擇、個人分享紀錄與收到的感謝小卡） |
| `src/client/App.tsx` | 前端應用主框架、Google 登入列與分頁切換；`me` 載入後若不是本機開發就用 `GoogleSignInProvider` 包住內容 |
| `src/client/components/GoogleSignInProvider.tsx`、`GoogleSignInButton.tsx` | 包裝 `@react-oauth/google`：Provider 負責載入 script、script 載入失敗的重試與共用的 credential handler；Button 渲染官方按鈕，沒有 Provider 時（本機開發）退回自訂按鈕 |
| `src/client/styles.css` | 原生 CSS 樣式表（CSS Variables 主題變數、響應式卡片與按鈕排版，不使用 Tailwind CSS） |
| `src/client/main.tsx` | React 掛載入口與 Service Worker 註冊 |
| `index.html` | PWA HTML 入口（含 Apple PWA meta 標籤与 manifest 連結） |
| `public/manifest.webmanifest` | PWA 安裝設定檔（`display: standalone`、圖示與主題色） |
| `public/icon.svg`、`apple-touch-icon.png`、`icon-192.png`、`icon-512.png`、`icon-maskable-512.png`、`favicon-32.png` | 吉祥物圖示：`icon.svg` 是方形、米白底（`#faf7f2`）的來源，其餘 PNG 由它點陣化而來，沒有透明像素（iOS 會把透明處填黑）；`pwaManifestIcons.test.ts` 檢查 manifest 列出的檔案都存在且尺寸與宣告相同。重新產生圖示沒有放進 repo 的腳本 |
| `public/og-image.png`、`public/robots.txt`，以及 `index.html` 的 `og:*`／`twitter:*` 標籤 | Facebook 社團貼連結時的預覽卡（1200×630，米白底加吉祥物與站名）。爬蟲只讀靜態 HTML，所以標籤寫在 `index.html`，`og:url` 與 `og:image` 要絕對網址，由 `vite.config.ts` 的 `siteOrigin` 在建置時填入 `%SITE_ORIGIN%`；換自訂網域時只改這個常數。`robots.txt` 允許所有爬蟲，沒有它時 SPA 的 fallback 會把 `/robots.txt` 回成首頁 HTML |
| `public/sw.js` | Service Worker（監聽 `push` 事件顯示通知、點擊通知喚醒或聚焦視窗） |
| `tests/unit/rules.test.ts` | 純函數業務規則單元測試 |
| `tests/unit/useInviteApp.test.ts` | 前端 ViewModel 狀態流轉單元測試 |
| `tests/integration/inviteQueueFlow.test.ts` | 後端完整 User Journey、交易一致性與邊界條件整合測試（使用真實 SQLite/D1） |

### 修改
| File | Change |
|------|--------|
| 無（全新專案） | - |

## Responsibility Map

| 元件 | 層級 | 負責 | 不碰 |
|------|------|------|------|
| `src/worker/index.ts` | Router / Controller | HTTP 路由、Zod request schema 驗證、Session middleware、呼叫 Service 或 Query、將 `AppError` 轉為對應 HTTP 狀態碼 | SQL 語句、業務規則判斷、直接操作 D1 |
| `src/worker/domain/rules.ts` | Domain (Pure) | 擷取並正規化 `https://claude.ai/referral/<code_id>`、判斷提供者是否達 2 組完全無效連結、判斷無效重排資格与到期時間計算 | 資料庫 I/O、HTTP Request/Response、Web Push 網路呼叫 |
| `src/worker/services/inviteQueueService.ts` | Service | 編排業務流程（提交連結→配對→推播、排隊→配對、解鎖、確認啟用、回報無效→停用同組剩餘名額→優先重排、逾時回收与 30 分鐘自動確認） | HTTP 狀態碼與 Header、前端狀態、手寫底層 SQL 字串 |
| `src/worker/repositories/inviteQueueRepository.ts` | Repository | 用 drizzle 封裝所有寫入與狀態轉移查詢、`db.batch()` 原子寫入與 `meta.changes` 樂觀檢查、資料列與內部型別轉換 | 業務規則決策、Web Push 發送、HTTP 層物件 |
| `src/worker/queries/boardQuery.ts` | Read Query | 查詢首頁統計數據、最新公開感謝牆清單、當前登入者的排隊與分享 DTO、管理看板快取 | 寫入或修改任何資料表狀態 |
| `src/worker/services/webPushService.ts` | Infrastructure Service | 儲存/刪除 Web Push 訂閱、使用 VAPID 發送推播通知、自動清除 404/410 失效訂閱 | 排隊或名額配對邏輯 |
| `src/client/api/apiClient.ts` | API Client | 發送 HTTP 請求、處理 JSON 解析與將後端錯誤轉為結構化前端錯誤 | DOM 操作、React state |
| `src/client/hooks/useInviteApp.ts` | ViewModel Hook | 管理前端畫面狀態（board、me、loading、error）、封裝登入/排隊/解鎖/確認/回報無效/分享動作、計算剩餘倒數秒數 | 直接寫 HTML/JSX 結構、直接呼叫 `window.fetch` |
| `src/client/components/*.tsx` | View | 根據 props 渲染畫面、表單輸入綁定、觸發 ViewModel callback、顯示二次確認對話框 | 直接呼叫 API、自行計算業務規則 |

## Interface Design

```typescript
// src/shared/types.ts
export type SlotStatus = 'available' | 'reserved' | 'revealed' | 'confirmed' | 'invalidated' | 'closed';
export type QueueStatus = 'waiting' | 'reserved' | 'revealed' | 'confirmed' | 'expired' | 'cancelled';

export interface ThankYouWallItemDto {
  slotId: number;
  receiverNickname: string;
  providerNickname: string;
  thankYouMessage: string;
  confirmedAt: string; // ISO8601
}

export interface BoardDto {
  availableSlotsCount: number;
  waitingQueueCount: number;
  totalConfirmedCount: number;
  thankYouWall: ThankYouWallItemDto[];
}

export interface MyQueueEntryDto {
  id: number;
  status: QueueStatus;
  queuePosition: number | null; // status === 'waiting' 時的順位（1-based）
  thankYouMessage: string;
  slotId: number | null;
  providerNickname: string | null;
  referralUrl: string | null; // 僅當 status === 'revealed' || status === 'confirmed' 時有值，'reserved' 時為 null
  reserveExpiresAt: string | null;
  confirmExpiresAt: string | null;
  canReportInvalid: boolean; // status === 'revealed' && 未逾 30 分鐘 && invalidRetryCount === 0
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
    receiverNickname: string | null;
    thankYouMessage: string | null; // 僅當 status === 'confirmed' 時顯示
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
  } | null;
  myQueue: MyQueueEntryDto | null;
  mySharedLinks: MySharedLinkDto[];
  vapidPublicKey: string;
}

// src/worker/domain/rules.ts
export interface NormalizedReferralLink {
  referralCode: string;
  normalizedUrl: string;
}

export function extractAndNormalizeReferralLink(rawInput: string): NormalizedReferralLink | null;
export function isCompletelyInvalidLink(slotStatuses: SlotStatus[]): boolean;
export function isProviderBlocked(completelyInvalidLinkCount: number): boolean;
export function canUserReportInvalid(params: {
  slotStatus: SlotStatus;
  invalidRetryCount: number;
  confirmExpiresAtIso: string | null;
  nowIso: string;
}): boolean;

// src/worker/services/inviteQueueService.ts
export interface SubmitLinkInput {
  userId: number;
  nickname?: string;
  rawUrlInput: string;
  slotCount: 1 | 2 | 3;
  now?: Date;
}

export interface JoinQueueInput {
  userId: number;
  nickname?: string;
  thankYouMessage: string;
  now?: Date;
}

export class InviteQueueService {
  constructor(
    private readonly repo: InviteQueueRepository,
    private readonly pushService: WebPushService,
    private readonly onBoardChanged?: () => void
  ) {}

  submitInviteLink(input: SubmitLinkInput): Promise<{ linkId: number; matchedCount: number }>;
  joinQueue(input: JoinQueueInput): Promise<{ queueEntryId: number; status: QueueStatus }>;
  cancelQueue(userId: number, now?: Date): Promise<void>;
  revealSlot(userId: number, now?: Date): Promise<{ referralUrl: string; confirmExpiresAt: string }>;
  confirmSlot(userId: number, now?: Date): Promise<void>;
  reportSlotInvalid(userId: number, now?: Date): Promise<{ requeuedStatus: QueueStatus }>;
  processExpirations(now?: Date): Promise<{ expiredReservations: number; autoConfirmedSlots: number }>;
}
```

## Data Flow

### Flow 1：提供者提交邀請連結並自動依 FIFO 配對（對應 Journey 2）
```
POST /api/links { rawUrlInput, slotCount: 1|2|3, nickname? }
  → Router: requireAuth middleware + Zod schema validation
  → InviteQueueService.submitInviteLink()
    → InviteQueueService.processExpirations() (惰性清理已逾時保留/待確認名額)
    → Domain: extractAndNormalizeReferralLink(rawUrlInput) → 驗證並取得 { referralCode, normalizedUrl }
    → Repository: 檢查該提供者是否累計 >= 2 組完全無效連結（若是則拋出 PROVIDER_BLOCKED）
    → Repository: 檢查 referralCode 是否已存在（若是則拋出 DUPLICATE_REFERRAL_CODE）
    → Repository: 建立 invite_links 與 N 筆 invite_slots (status='available')
    → InviteQueueService.matchAvailableSlotsToQueue():
      → Repository: 查詢依 (priority DESC, created_at ASC) 排序的 waiting 排隊者（排除提供者本人）
      → Repository (D1 batch): 將前 min(N, M) 個名額與排隊紀錄原子更新為 status='reserved', reserve_expires_at = now + 6h
      → WebPushService: 對獲配的領取者發送「輪到你領取 Claude 邀請碼囉！」推播通知
    → BoardQuery: invalidateBoardCache()
← 201 { data: { linkId, matchedCount } }
```

### Flow 2：領取者排隊、解鎖看碼、確認啟用並推播感謝（對應 Journey 1）
```
1. 加入排隊：
POST /api/queue { thankYouMessage, nickname? }
  → Router: requireAuth + Zod validation (thankYouMessage 5~200 字)
  → InviteQueueService.joinQueue()
    → InviteQueueService.processExpirations()
    → Repository: 檢查該使用者是否已有 waiting / reserved / revealed / confirmed 紀錄（若有進行中紀錄則拋出 ALREADY_IN_QUEUE；`ALREADY_CLAIMED` 已被 dual-track-queue 的 `NEWBIE_TRACK_ONLY` 取代）
    → Repository: 新增 queue_entries (status='waiting', priority=0)
    → InviteQueueService.matchAvailableSlotsToQueue() (若池中有非本人提供的可用名額，立即轉為 status='reserved')
    → BoardQuery: invalidateBoardCache()
← 201 { data: { queueEntryId, status } }

2. 6 小時內點擊解鎖看碼：
POST /api/queue/reveal
  → Router: requireAuth
  → InviteQueueService.revealSlot(userId)
    → InviteQueueService.processExpirations() (若已超過 6 小時，先轉為 expired 並拋出 RESERVATION_EXPIRED)
    → Repository (D1 batch): 驗證 status='reserved'，原子更新 invite_slots 與 queue_entries 為 status='revealed', revealed_at=now, confirm_expires_at=now+30m
← 200 { data: { referralUrl, confirmExpiresAt } }

3. 點擊成功啟用（或滿 30 分鐘由 Cron/Lazy 自動觸發）：
POST /api/queue/confirm
  → Router: requireAuth
  → InviteQueueService.confirmSlot(userId)
    → Repository (D1 batch): 更新 invite_slots 與 queue_entries 為 status='confirmed', confirmed_at=now
    → WebPushService: 查詢該名額提供者的推播訂閱，發送包含 thankYouMessage 與領取者暱稱的感謝推播
    → BoardQuery: invalidateBoardAndTotalConfirmedCount()（同時清掉 `totalConfirmedCount` 的快取）
← 200 { data: { confirmed: true } }
```

### Flow 3：領取者回報無效、連動關閉同組剩餘名額並優先重排（對應替代流程）
```
POST /api/queue/report-invalid
  → Router: requireAuth
  → InviteQueueService.reportSlotInvalid(userId)
    → InviteQueueService.processExpirations() (若已超過 30 分鐘，該名額已自動轉為 confirmed，拋出 CONFIRM_WINDOW_EXPIRED)
    → Domain: canUserReportInvalid() (檢查 status==='revealed' 且 invalidRetryCount === 0)
    → Repository (D1 batch):
      1. 將當前 invite_slot 更新為 status='invalidated'
      2. 將同一 link_id 底下所有 status='available' 的剩餘名額更新為 status='closed'
      3. 將使用者 users.invalid_retry_count + 1
      4. 將該領取者的 queue_entry 更新回 status='waiting', priority=1 (排在所有一般排隊者最前面), slot_id=NULL
      5. 重新計算提供者是否新增「完全無效連結」
    → InviteQueueService.matchAvailableSlotsToQueue() (若池中有其他提供者的可用名額，立即為這位 priority=1 的領取者配對新名額)
    → BoardQuery: invalidateBoardCache()
← 200 { data: { requeuedStatus } }
```

## 資料邊界

| 來源 | 在哪一層轉換 | 轉成什麼 | 不符合時 |
|------|------------|---------|---------|
| `POST /api/auth/google` body（`idToken`，選填 `nickname`） | Router（Zod schema） + `AuthService` | 已驗證之 Google Profile `{ sub, email, name }`；回應 `data.user` 為 `{ id, email, nickname }` | 400 `INVALID_INPUT` 或 401 `INVALID_GOOGLE_TOKEN` |
| `POST /api/links` body (`rawUrlInput`, `slotCount`, `nickname`) | Router（Zod schema） + `extractAndNormalizeReferralLink` | `SubmitLinkInput` 與 `NormalizedReferralLink` | 400 `INVALID_REFERRAL_URL`（提示正確格式 `https://claude.ai/referral/...`）或 422 欄位錯誤 |
| `POST /api/queue` body (`thankYouMessage`, `nickname`) | Router（Zod schema：去除前後空白後 5～200 字，以 Unicode 碼點計，前後端共用同一個計數 helper） | `JoinQueueInput` | 422 `VALIDATION_ERROR`（提示感謝小卡需為 5～200 字） |
| `POST /api/push/subscribe` body | Router（Zod schema：`endpoint` 必須是 `https:` URL，`keys.p256dh`、`keys.auth` 非空字串） | `PushSubscriptionInput` | 422 `VALIDATION_ERROR` |
| 後端 API JSON 回應 | 前端 `apiClient.ts` | `BoardDto` / `MeDto` 等強型別物件 | 拋出 `ApiClientError(code, message, status)` 由 `useInviteApp` 轉為畫面錯誤訊息 |

帶 JSON body 的 POST 路由遇到壞 JSON 或空 body 回 400 `INVALID_INPUT`，不是 500。需要登入的寫入路由先檢查登入狀態，未登入一律回 401 `UNAUTHORIZED`，再做 body 驗證。

輸入長度上限定義在 `src/shared/types.ts`：`rawUrlInput` 最多 `MAX_RAW_URL_INPUT_LENGTH`（2000 字）、解析出的邀請代碼最多 `MAX_REFERRAL_CODE_LENGTH`（64 字）、推播訂閱 `endpoint` 最多 `MAX_PUSH_ENDPOINT_LENGTH`（2048 字），超過在 Router 的 Zod 驗證回 422 `VALIDATION_ERROR`，不會進到 Service。感謝小卡與暱稱都要在去掉空白與不可見字元（`\s`、`\p{Cf}`、`\p{Default_Ignorable_Code_Point}`，另外明確列出 U+2800）後至少剩一個字元，規則是 `src/shared/visibleText.ts` 的 `hasVisibleText`，前端與 Router 共用。

## 交易與一致性

| 操作 | 必須一起成功的寫入 | 交易邊界 | 併發處理 | 重複送出 |
|------|------------------|---------|---------|---------|
| 提交邀請連結並建立名額 | 新增 `invite_links` + 新增 1～3 筆 `invite_slots` | `InviteQueueRepository.createLinkWithSlots`（`db.batch`） | `invite_links.referral_code` 設 `UNIQUE` 約束，重複提交回 409 `DUPLICATE_REFERRAL_CODE` | 以 `referral_code` 唯一索引擋重複 |
| FIFO 配對名額給排隊者 | 更新 `invite_slots(status='reserved', assigned_user_id)` + 更新 `queue_entries(status='reserved', slot_id)` | `InviteQueueRepository.assignSlotToQueueEntry`（`db.batch`） | UPDATE 語句帶 `WHERE status = 'available'` 與 `WHERE status = 'waiting'` 條件，並檢查 `meta.changes === 1`；若已被其他請求配走則回滾重試 | 單一排隊紀錄狀態已非 `waiting` 時不會二次配對 |
| 解鎖查看邀請連結 | 更新 `invite_slots(status='revealed', confirm_expires_at)` + 更新 `queue_entries(status='revealed')` | `InviteQueueRepository.revealReservedSlot`（`db.batch`） | UPDATE 帶 `WHERE status = 'reserved' AND reserve_expires_at > ?` | 若狀態已為 `revealed`，直接冪等回傳該名額的連結與到期時間 |
| 確認啟用（手動或滿 30 分鐘自動） | 更新 `invite_slots(status='confirmed')` + 更新 `queue_entries(status='confirmed')` | `InviteQueueRepository.confirmRevealedSlot`（`db.batch`）；Web Push 在 DB commit 成功後發送 | UPDATE 帶 `WHERE status = 'revealed'` 且檢查 `changes === 1`，保證手動點擊與 Cron 自動確認同時發生時只會發送 1 次感謝推播 | 已是 `confirmed` 時回傳成功且不重複發推播 |
| 回報連結無效並優先重排 | 更新當前 `invite_slots(status='invalidated')` + 更新同組 `invite_slots(status='closed' WHERE status='available')` + 更新 `users(invalid_retry_count + 1)` + 更新 `queue_entries(status='waiting', priority=1, slot_id=NULL)` | `InviteQueueRepository.reportInvalidAndRequeue`（`db.batch`） | UPDATE 帶 `WHERE status = 'revealed' AND confirm_expires_at > ?` 與 `WHERE invalid_retry_count = 0` | `invalid_retry_count` 已變成 1 且狀態已回到 `waiting`，重複請求回 409 |

並發與重複送出的補充：
- 解鎖看碼的 batch 回傳未更新時，Service 會重讀該筆排隊紀錄。已是 `revealed` 且 `slotId` 相同就冪等回傳，只有確實逾時或不再是 `reserved` 才回 409 `RESERVATION_EXPIRED`。
- 手動確認啟用的 batch 回傳未更新時同樣重讀。紀錄已是 `confirmed`（例如被自動確認搶先）回成功且不重複推播；已被回報無效退回 `waiting` 則回 409 `INVALID_STATE_TRANSITION`。
- 逾時處理（保留逾時釋出、30 分鐘自動確認）對每一筆各用一個 `db.batch`，各筆獨立原子，一筆失敗不拖垮其他筆。兩個掃描互不相依，以 `Promise.all` 同時送出。
- 提供者違規計數 `syncProviderStrikeCount` 是先讀名額狀態、再寫計數，沒有包交易。把它改成單一 SQL 需要把「完全無效連結」判定（`isCompletelyInvalidLink`）複製進 SQL，會讓這條不變量有兩份定義；兩個名額同時被回報無效時計數可能暫時偏低，下一次名額狀態變動時會被重算修正，因此維持現狀。

跨外部系統補償說明：Web Push 推播通知在 D1 `db.batch()` 成功後執行；若推播服務連線失敗，名額配對與感謝牆狀態仍保持成功（使用者打開 App 即可看到最新狀態）；若推播伺服器回傳 `404` 或 `410 Gone`，自動刪除該筆失效訂閱。

## Build Sequence

### Phase 1：專案骨架、D1 Schema、共用型別與純函數業務規則（additive）
- **目標**：建立專案設定、D1 資料表遷移檔、共用型別與零外部依賴的純函數業務規則（網址正規化、完全無效連結判定、無效重排資格判定），並通過單元測試。
- **依賴**：無
- **限制**：`src/worker/domain/rules.ts` 不得依賴任何資料庫或網路 I/O。
- **Checklist**：
  - 建立 `package.json`、`tsconfig.json`、`vite.config.ts`、`wrangler.toml`
  - 建立 `migrations/0001_init.sql`（含 `users`、`invite_links`、`invite_slots`、`queue_entries`、`push_subscriptions` 資料表與索引）
  - 建立 `src/shared/types.ts` 與 `src/worker/errors.ts`
  - 實作 `src/worker/domain/rules.ts`（`extractAndNormalizeReferralLink`、`isCompletelyInvalidLink`、`isProviderBlocked`、`canUserReportInvalid`）
  - 撰寫並通過 `tests/unit/rules.test.ts`
- **AC**：執行 `npm test -- tests/unit/rules.test.ts` 全數通過，涵蓋 AC 1（含 `?s=ios` 與句子夾帶連結之擷取正規化）、AC 8～10 的純邏輯邊界。

### Phase 2：後端 Repository、Service、Web Push、Query 與 Hono API 路由（additive）
- **目標**：完成 D1 資料存取層、FIFO 配對與狀態機 Service、Web Push 推播服務、看板與個人狀態唯讀查詢、Hono API 路由與 Cron 排程處理，並通過真實 SQLite/D1 整合測試。
- **依賴**：Phase 1
- **限制**：遵循 `CLAUDE.md` 分層規則（寫入走 Service + Repository `db.batch`，唯讀走 `boardQuery.ts`），不得在 Route handler 內直接寫 SQL。
- **Checklist**：
  - 實作 `src/worker/repositories/inviteQueueRepository.ts`
  - 實作 `src/worker/services/webPushService.ts` 與 `src/worker/services/authService.ts`
  - 實作 `src/worker/services/inviteQueueService.ts`
  - 實作 `src/worker/queries/boardQuery.ts`
  - 實作 `src/worker/index.ts`（含 `/api/board`、`/api/me`、`/api/auth/google`、`/api/auth/dev-login`、`/api/auth/logout`、`/api/links`、`/api/queue`、`/api/queue/reveal`、`/api/queue/confirm`、`/api/queue/report-invalid`、`/api/queue/cancel`、`/api/push/subscribe` 與 `scheduled` handler）
  - 撰寫並通過 `tests/integration/inviteQueueFlow.test.ts`
- **AC**：執行 `npm test -- tests/integration/inviteQueueFlow.test.ts` 全數通過，完整驗證設計文件 AC 1～AC 10 及「交易與一致性」表所有場景。

### Phase 3：前端 React PWA、Service Worker 推播與端對端串接驗收（additive）
- **目標**：完成前端 API Client、`useInviteApp` ViewModel Hook、所有畫面元件、原生 CSS 樣式（不使用 Tailwind CSS）、PWA Manifest 與 Service Worker，通過前端單元測試，並啟動本地開發伺服器以 curl 及真實環境走完 User Journey。
- **依賴**：Phase 2
- **限制**：React View 元件不得直接呼叫 `fetch`，所有 API 互動必須透過 `useInviteApp` 與 `apiClient.ts`；禁止背景高頻輪詢（Polling）；禁止使用 Tailwind CSS。
- **Checklist**：
  - 實作 `src/client/api/apiClient.ts` 與 `src/client/hooks/useInviteApp.ts`
  - 實作 `src/client/components/BoardStats.tsx`、`ThankYouWall.tsx`、`PushToggleButton.tsx`、`PwaInstallBanner.tsx`、`ReceiverPanel.tsx`、`ProviderPanel.tsx`
  - 實作 `src/client/App.tsx`、`src/client/styles.css`、`src/client/main.tsx`、`index.html`、`public/manifest.webmanifest`、`public/sw.js`
  - 撰寫並通過 `tests/unit/useInviteApp.test.ts`
- **AC**：
  - `npm test`（含前後端 UT 與 IT）全數通過，`npm run build` 成功編譯前端資產。
  - 啟動本地 Worker 伺服器，使用 `curl` 走完設計文件的 Journey 1、Journey 2 與無效重排流程確認正常運作。

## Infra Reuse
- 全新專案，無既有檔案；專案規範定義於根目錄 `CLAUDE.md`。

## Test Strategy

### Unit Test

| 目標 | 測試行為 |
|------|---------|
| `extractAndNormalizeReferralLink` | 輸入帶 `?s=ios` 或夾在中文句子裡的 `https://claude.ai/referral/rNFlbuU0OA?s=ios` → 回傳 `{ referralCode: 'rNFlbuU0OA', normalizedUrl: 'https://claude.ai/referral/rNFlbuU0OA' }` |
| `extractAndNormalizeReferralLink` | 輸入非 `claude.ai/referral/` 網址或空白字串 → 回傳 `null` |
| `isCompletelyInvalidLink` & `isProviderBlocked` | 3 個名額中 2 個 `confirmed`、1 個 `invalidated` → `isCompletelyInvalidLink` 為 `false`（不計違規）；0 個 `confirmed`、1 個 `invalidated`、2 個 `closed` → `isCompletelyInvalidLink` 為 `true`；累計 2 組時 `isProviderBlocked` 為 `true` |
| `canUserReportInvalid` | `status === 'revealed'`、未逾 30 分鐘且 `invalidRetryCount === 0` → `true`；若 `invalidRetryCount === 1` 或已逾 30 分鐘或狀態非 `revealed` → `false` |
| `useInviteApp` hook | 呼叫 `joinQueue`、`revealSlot`、`confirmSlot`、`reportInvalid` 時，正確更新 `me` 與 `board` 狀態，並在 API 回傳 `AppError` 時設定 `error` 訊息且保留表單狀態 |

### Integration Test

| Journey 步驟 / 一致性場景 | Test Chain |
|-------------|-----------|
| Journey 1 & 2：排隊 → 提供者分享（自訂 2 個名額）→ 自動 FIFO 配對 → 解鎖 → 確認啟用 → 感謝推播與上牆（AC 1, 2, 3, 6） | 領取者 A、B、C 依序 `POST /api/queue` → 提供者 P `POST /api/links` (slotCount=2, 帶 `?s=ios`) → 驗證 A、B 轉為 `reserved`（此時 `GET /api/me` 的 `referralUrl` 為 `null`）且收到推播、C 維持 `waiting` → A `POST /api/queue/reveal` 取得正規化網址 → A `POST /api/queue/confirm` → 驗證 P 收到含 A 感謝小卡的推播且 `GET /api/board` 感謝牆出現 A 的小卡 |
| 池中有碼時排隊即刻獲配 & 禁止自己配給自己（AC 4） | 提供者 P 先 `POST /api/links` (slotCount=1) → P 自己 `POST /api/queue` 維持 `waiting`（不配給自己） → 領取者 A `POST /api/queue` → A 立即成為 `reserved` |
| 6 小時未解鎖逾時回收並轉配下一位（AC 5） | A 為 `reserved`、B 為 `waiting` → 時間快轉超過 6 小時觸發 `processExpirations` → 驗證 A 轉為 `expired`、該名額自動轉配給 B（B 轉為 `reserved` 並收到推播） |
| 解鎖滿 30 分鐘未操作自動確認並送出感謝（AC 7） | A `POST /api/queue/reveal` 後不按確認 → 時間快轉超過 30 分鐘觸發 `processExpirations` → 驗證名額與 A 的紀錄自動轉為 `confirmed`，P 收到感謝推播且感謝牆新增紀錄（再次觸發不會重複發推播） |
| 回報無效、同組剩餘名額停用、優先重排與終身 1 次重排限制（AC 8, 9） | P1 分享 3 個名額連結 → A 獲配名額 #1 並解鎖，名額 #2、#3 為 `available`，且 B 剛加入 `waiting` → A 在 30 分鐘內 `POST /api/queue/report-invalid` → 驗證 P1 的名額 #1 為 `invalidated`、#2 與 #3 立即變為 `closed`（不會配給 B），且 A 排在 B 前面（priority=1） → P2 分享新連結時優先配給 A → A 解鎖第 2 組後 `canReportInvalid` 為 `false`，再次呼叫 `report-invalid` 回 409 `RETRY_QUOTA_EXHAUSTED` |
| 提供者好心人保護與累計 2 組完全無效停權（AC 10） | P 分享連結 #1（A 成功 `confirmed`，B 回報 `invalidated`）→ P 仍可分享連結 #2 與 #3；若 P 分享的兩組連結皆為 0 人 `confirmed` 且被回報 `invalidated` → P 嘗試分享第 3 組時回 403 `PROVIDER_BLOCKED` |
| 重複提交相同邀請代碼阻擋（AC 1 交易一致性） | P1 提交 `https://claude.ai/referral/abc12345?s=ios` 成功 → P2 提交 `https://claude.ai/referral/abc12345` 回 409 `DUPLICATE_REFERRAL_CODE`，資料庫僅有 1 組連結 |

### Mock 決策

| 項目 | Mock / Real | 原因 |
|------|------------|------|
| D1 / SQLite 資料庫 | Real | 整合測試使用真實 SQLite / D1 引擎執行 `migrations/0001_init.sql`，驗證 SQL 查詢、`UNIQUE` 約束與 `batch` 條件更新正確性 |
| Web Push 網路發送與 Google OAuth 外部連線 | Mock（注入式 Sender / Verifier） | 測試環境無法向真實 Apple/Google Push 伺服器與 Google OAuth 發送外部網路請求，透過注入替身驗證推播收件人、標題與內文，同時測試當推播回傳 410 時自動清理 DB 訂閱紀錄 |

## 開放問題
無

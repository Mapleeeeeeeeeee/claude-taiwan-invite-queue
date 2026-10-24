# claude-tw-invite Project Guidelines

Claude Taiwan 邀請連結排隊與感謝回饋 PWA 平台（Cloudflare Workers + D1 + React + TypeScript）。

## 統一語言（Ubiquitous Language）

程式碼與資料庫命名對齊 `docs/design/invite-code-queue.md`：

| 領域詞彙 | 程式碼命名 | 定義 |
|---------|-----------|------|
| 邀請連結 | `inviteLinks` / `invite_links` | 提供者提交的 `https://claude.ai/referral/<referralCode>` 連結 |
| 邀請代碼 | `referralCode` / `referral_code` | `/referral/` 後方的唯一代碼（去除 `?s=ios` 等參數），用於防重複 |
| 邀請名額 | `inviteSlots` / `invite_slots` | 一組邀請連結底下的獨立領取席次（預設 3 個，可選 1、2、3） |
| 排隊紀錄 | `queueEntries` / `queue_entries`（列型別 `QueueEntryRow`） | 領取者加入 FIFO 佇列的紀錄（含預寫感謝小卡與優先重排權重） |
| 感謝小卡 | `thankYouMessage` / `thank_you_message`（看板 DTO 為 `ThankYouWallItemDto`） | 領取者排隊時預寫、名額確認啟用後推播給提供者並刊登於感謝牆的回饋 |
| 完全無效連結 | `isCompletelyInvalidLink` | 該連結所有名額已結束，且 `confirmed` 數為 0、`invalidated` 數 >= 1 |
| 排隊軌道 | `QueueTrack` / `track` | `newbie`（新手首發軌，一人限領一次）或 `community`（再領取軌），附加在 `invite_slots` 與 `queue_entries` 上 |
| 新手資格 | `isEligibleForNewbieTrack` | 任一軌道都沒有 `confirmed` 排隊紀錄、也沒分享過邀請連結；規則只在 `src/worker/domain/rules.ts` 定義 |
| 票券 | `WaitingTicket` | 撮合引擎中的排隊紀錄（`queueEntries` 的一列） |

## 架構分層判準

- **寫入與狀態機模組（後端 `src/worker/services/` + `src/worker/repositories/`）**：
  涉及業務規則與多表狀態連動（提交連結、加入排隊、FIFO 配對、解鎖看碼、確認啟用、回報無效、逾時處理），採用 `Router (Zod 驗證) → Service (業務規則) → Repository (drizzle + D1 batch)`。純運算規則（如網址正規化、違規判定）放在 `src/worker/domain/`，不依賴 I/O，直接以 Unit Test 驗證。
- **唯讀查詢模組（後端 `src/worker/queries/`）**：
  無業務規則的畫面資料讀取（首頁看板與感謝牆 `GET /api/board`、使用者個人狀態 `GET /api/me`），不經過 Service 與 Repository 轉發，由 Query 函數查詢 D1 並回傳 DTO。唯一例外是路由在查詢前先呼叫 `inviteQueueService.processExpirations()` 結算逾時（看板快取過期時，以及已登入的 `GET /api/me`）。
- **前端模組（`src/client/`）**：
  採用 `View Components (純渲染)` + `Custom Hooks / ViewModel (API 呼叫與狀態管理)` + `API Client (封裝 fetch 與型別驗證)`。禁止在 React 元件內直接呼叫 `fetch`。樣式使用原生 CSS（`src/client/styles.css` 與 CSS Variables），禁止引入或使用 Tailwind CSS。

## 錯誤處理機制

- 後端統一使用 `AppError(code, message, statusCode)` 表達預期業務錯誤（如 `DUPLICATE_REFERRAL_CODE`、`PROVIDER_BLOCKED`、`INVALID_REFERRAL_URL`、`ALREADY_IN_QUEUE`、`RETRY_QUOTA_EXHAUSTED`、`INVALID_STATE_TRANSITION`），由 Hono 全域 `onError` middleware 轉成標準 JSON `{ error: { code, message } }` 回應。
- 禁止使用寬泛吞錯的 `catch (e) {}`；僅針對預期例外（如 D1 `UNIQUE constraint failed` 或 Web Push 失效 `404/410`）捕獲處理，未預期錯誤向上傳播。

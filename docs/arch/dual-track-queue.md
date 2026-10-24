# Architecture: 雙軌道排隊機制（dual-track-queue）

## 概述
本功能在既有 Cloudflare Worker + Hono + D1 + React 19 架構下，引入「雙軌道（Dual-Track：新手專屬 `newbie` vs 再領取 `community`）」分流機制。提供者發布邀請連結時可指定名額受眾偏好（限新手 vs 開放再領取軌）；領取者的排隊表單不提供軌道選項，前端依 `GET /api/me` 的 `isEligibleForNewbieTrack` 自動送出軌道，已領取過或分享過連結的使用者會自動以再領取軌排隊，後端不再以 `409 ALREADY_CLAIMED` 阻擋。撮合引擎採用「高容納度包含式 FIFO 配對」，維持 D1 Batch 原子交易邊界，並確保既有 API 與畫面向後相容。

---

## 架構決策

| 模組 | 結構 | 依據 | 替代方案與不選的原因 |
|------|------|------|------|
| **資料庫約束與模型演進** | 新增 `migrations/0002_dual_track.sql`：在 `invite_slots` 與 `queue_entries` 新增 `track` 欄位；重構 Partial Unique Index 為 `UNIQUE(user_id) WHERE status IN ('waiting', 'reserved', 'revealed')` 與 `UNIQUE(user_id) WHERE track = 'newbie' AND status = 'confirmed'` | 原先 `idx_queue_entries_active_user` 將 `confirmed` 與進行中狀態綁在同一個 unique index，導致使用者終身無法建立第二筆排隊；拆分為「進行中唯一」與「新手 confirmed 唯一」可在資料庫層級保證新手一生一次、且互助軌可多次結案 | 1. 僅在 Service 邏輯檢查、資料庫不設約束：併發請求時易穿透造成同時排兩條隊<br>2. 另外開新表 `community_queue_entries`：資料表結構與流轉 95% 相同，分表會造成程式碼重複與報表統計複雜化 |
| **撮合分配演算法** | 擴充純領域函數 `domain/matchingEngine.ts`：接收帶 `track` 屬性之 Slots 與 Tickets，新手席次嚴格專屬，互助席次優先互助、無人時向下支援新手 | 撮合核心為純計算，不涉及 I/O；將雙軌包含規則收納在純函數中可獲致 100% 快速單元測試防護，避免業務邏輯散落於 SQL 或 Service | 在 SQL 裡寫複雜的 `CASE WHEN ... ORDER BY`：難以跨 SQLite / D1 保證相同的自定義排序行為與單元測試模擬 |
| **排隊資格動態判定** | 資格規則是 `domain/rules.ts` 的純函式 `isEligibleForNewbieTrack`（任一軌道有 `confirmed`，或分享過連結，即不具資格），`inviteQueueService.ts` 的 `joinQueue` 與 `meQuery.ts` 的 `GET /api/me` 都呼叫它；`newbie` 軌道維持一生一次，`community` 軌道僅阻擋當前進行中之排隊 | 資格規則是必須處處一致的 invariant，收成單一定義，避免 API 拒絕與畫面提示不一致；Service 負責依規則阻擋非法請求，並在通過檢查後更新使用者暱稱 | 依賴前端自行過濾：不安全，惡意使用者直接打 API 即可繞過限制 |
| **唯讀看板與身分查詢** | 擴充 `boardQuery.ts`：既有總數欄位維持不變（向下相容），新增 `newbie` 與 `community` 分組統計；`meQuery.ts` 的 `GET /api/me` 新增 `isEligibleForNewbieTrack` 與 `hasSharedLinks` | 讀取端無業務規則，直接查詢回傳 DTO 最簡潔；前端 ViewModel 可直接依據 `isEligibleForNewbieTrack` 進行單一表單的自動軌道選定與提示 | 前端每次呼叫 API 自行計算：多耗費網路與計算資源 |
| **前端單一表單自動分軌** | 排隊表單（`JoinQueueForm.tsx`）不提供軌道選項，不具新手資格時顯示「已自動切換為再領取排隊」提示；`ProviderPanel.tsx` 增加受眾單選 Radio | 沿用現有專案 CLAUDE.md 與單頁式卡片體驗，使用者不需要理解軌道概念；少一個可操作的選項，也少一個需要在後端防守的輸入 | 1. 在排隊表單加軌道下拉選單：使用者決定移除，純新手也不必面對選擇<br>2. 將整站切成「新手版」與「老手版」雙頁籤：造成名額看板與感謝牆碎裂，版面資訊分散 |

---

## Files to Create / Modify

### 新建
| File | Purpose |
|------|---------|
| `migrations/0002_dual_track.sql` | D1 資料庫遷移腳本：為 `invite_slots` 與 `queue_entries` 增加 `track` 欄位並更新索引約束 |
| `tests/unit/matchingEngineDualTrack.test.ts` | 撮合引擎雙軌包含式優先序與向下相容純單元測試 |

### 修改
| File | Change |
|------|--------|
| `src/shared/types.ts` | 新增 `QueueTrack` 列舉（`'newbie' \| 'community'`），新增 `QUEUE_TRACKS`、`DEFAULT_QUEUE_TRACK`，擴充 `BoardDto`、`MeDto`（`JoinQueueInput`、`SubmitLinkInput` 在 `inviteQueueService.ts`） |
| `src/worker/domain/matchingEngine.ts` | 擴充 `AvailableSlot` 與 `WaitingTicket` 介面，實作雙軌撮合優先序與防自我配對 |
| `src/worker/repositories/inviteQueueRepository.ts` | 調整 SQL 查詢與寫入：支援 `track` 欄位、更新查詢條件與分組席次統計 |
| `src/worker/services/inviteQueueService.ts` | 實作雙軌排隊資格檢查、建立含 `track` 之席次與票券、觸發雙軌撮合 |
| `src/worker/queries/boardQuery.ts` | 查詢看板細部數據（新手席次 vs 互助席次） |
| `src/worker/queries/meQuery.ts` | 在 `GET /api/me` 補上 `isEligibleForNewbieTrack` 與 `hasSharedLinks` |
| `src/worker/requestSchemas.ts` | Zod schema 驗證增加 `track` 選項支援（`POST /api/links` 預設為 `newbie`；`POST /api/queue` 可省略） |
| `src/client/api/apiClient.ts` | 介面型別更新（支援 `track` 參數） |
| `src/client/hooks/useInviteApp.ts` | 狀態管理增加 `providerTrackInput`；排隊軌道由 `isEligibleForNewbieTrack` 推得，不另存狀態 |
| `src/client/components/ProviderPanel.tsx` | 新增「名額適用對象」單選 Radio（限新手首次體驗 vs 開放再領取軌） |
| `src/client/components/JoinQueueForm.tsx` | 依 `isEligibleForNewbieTrack` 自動導向再領取軌，並顯示第二帳號啟用注意事項提示 |
| `src/client/components/ReceiverPanel.tsx` | 把 `isEligibleForNewbieTrack` 傳給排隊表單 |
| `src/client/components/BoardStats.tsx` | 看板展示新手與再領取的席次數、排隊數 |
| `src/client/styles.css` | 說明標籤與提示卡片樣式 |
| `tests/integration/inviteQueueFlow.test.ts` | 新增雙軌 User Journey 測試（新手配對、老手排互助軌、互助席次向下相容新手） |
| `tests/helpers/testD1.ts` | 支援載入並執行所有遷移腳本 |

---

## Responsibility Map

| 元件 | 層級 | 負責 | 不碰 |
|------|------|------|------|
| `src/worker/domain/matchingEngine.ts` | Domain (Pure) | 雙軌撮合計算、優先級排序、向下相容配對、自我配對過濾 | 資料庫查詢、HTTP 物件 |
| `src/worker/services/inviteQueueService.ts` | Service | 雙軌資格判定、排隊防刷邏輯、協調 Repository 與撮合引擎 | 具體 SQL 字串、前端狀態 |
| `src/worker/repositories/inviteQueueRepository.ts` | Repository | 執行帶 `track` 之資料庫查詢與 D1 Batch 原子寫入 | 業務決策、HTTP 狀態 |
| `src/worker/queries/boardQuery.ts` | Read Query | 彙整雙軌統計數據 | 修改任何資料表 |
| `src/worker/queries/meQuery.ts` | Read Query | 查詢登入者身分與歷史資格旗標 | 修改任何資料表 |
| `src/client/hooks/useInviteApp.ts` | ViewModel Hook | 管理受眾表單狀態、根據 `isEligibleForNewbieTrack` 決定送出的排隊軌道 | 直接寫 HTML / CSS |
| `src/client/components/JoinQueueForm.tsx` | View | 動態顯示第二帳號注意事項 | API 呼叫、SQL |
| `src/client/components/ReceiverPanel.tsx` | View | 組合領取者畫面，把資格旗標傳給排隊表單 | API 呼叫、SQL |
| `src/client/components/ProviderPanel.tsx` | View | 渲染受眾選擇 Radio、綁定提交狀態 | API 呼叫、撮合演算法 |

---

## Interface Design

```typescript
// src/shared/types.ts

export const QUEUE_TRACKS = ['newbie', 'community'] as const;
export type QueueTrack = (typeof QUEUE_TRACKS)[number];
export const DEFAULT_QUEUE_TRACK: QueueTrack = 'newbie'; // 只在 POST /api/links 的 Zod schema 補預設；POST /api/queue 省略 track 時由 service 依新手資格決定

export interface BoardDto {
  availableSlotsCount: number;  // 既有總席次（相容）
  waitingQueueCount: number;    // 既有總排隊數（相容）
  totalConfirmedCount: number;  // 既有總領取數（相容）
  newbieSlotsCount: number;     // 新增：新手專屬席次
  communitySlotsCount: number;  // 新增：再領取席次
  newbieQueueCount: number;     // 新增：新手排隊中人數
  communityQueueCount: number;  // 新增：再領取排隊中人數
  thankYouWall: ThankYouWallItemDto[];
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
    isEligibleForNewbieTrack: boolean; // 新增：是否具備新手首發軌資格（規則見 domain/rules.ts）
    hasSharedLinks: boolean;           // 新增：是否曾分享過邀請連結
  } | null;
  myQueue: MyQueueEntryDto | null;
  myConfirmedClaim: MyQueueEntryDto | null;
  vapidPublicKey: string;
  devLoginEnabled: boolean; // 新增：伺服器是否開放開發者登入（ENVIRONMENT === 'development'），前端據此決定是否顯示 DevDock
  googleClientId: string;   // 新增：Google OAuth Client ID，前端據此初始化官方登入按鈕
}

// MyQueueEntryDto 新增 track: QueueTrack；MySharedLinkDto.slots 的每一筆也新增 track: QueueTrack。

// MyQueueEntryDto 新增 isRequeuedWithPriority: boolean
// 這筆排隊紀錄目前是否帶著回報無效後的優先權（priority > DEFAULT_QUEUE_PRIORITY）。
// 前端用它決定要不要顯示「已為你優先排回隊伍最前面」，不能用使用者終身的 invalidRetryCount 判斷。

// 登入回應 data.user 為 LoggedInUserDto { id, email, nickname }，不回 users 資料列。

// src/worker/domain/rules.ts

export function isEligibleForNewbieTrack(params: {
  hasConfirmedClaim: boolean; // 任一軌道有 confirmed 排隊紀錄
  hasSharedLinks: boolean;
}): boolean;

// src/worker/services/inviteQueueService.ts

export interface JoinQueueInput {
  userId: number;
  nickname?: string;
  thankYouMessage: string;
  track?: QueueTrack; // 省略時由 service 依新手資格決定
  now?: Date;
}

export interface SubmitLinkInput {
  userId: number;
  nickname?: string;
  rawUrlInput: string;
  slotCount: 1 | 2 | 3;
  track: QueueTrack;
  now?: Date;
}
```

`POST /api/queue` 回應中的 `status` 是該請求結束時觀察到的狀態。並發時排隊紀錄可能被別的請求那一輪配對走，所以最終狀態以 `GET /api/me` 為準；前端送出後會重新讀取 `GET /api/me`。

---

## Data Flow

### Flow 1：提供者發布「開放再領取軌」邀請連結
```
POST /api/links { rawUrlInput, slotCount: 3, track: "community" }
  → Router: Zod validation (slotCount IN 1,2,3, track optional enum)
  → Service: extractAndNormalizeReferralLink()
  → Repository: db.batch() 建立 link 與 3 個 track='community' slots
  → Service: matchAvailableSlotsToQueue()
    → Repository: fetchTracksWithWaitingEntries()
    → Domain: slotTracksMatchableBy() 篩出有人排隊的軌道所能配的席次軌道
    → Repository: fetchAvailableSlotsForMatching(席次軌道)
    → Repository: fetchWaitingQueueEntriesForMatching(席次數 × MATCHING_CANDIDATES_PER_SLOT)
    → Domain: matchTicketsToAvailableSlots(availableSlots, waitingTickets)
      * 優先撮合給 track='community' 的 ticket
      * 若無，撮合給 track='newbie' 的 ticket
    → Service: 逐組呼叫 assignSlotToQueueEntry，每組一個 db.batch() 把該席次與該票券更新為 reserved (6hr)
  → Service: WebPushService.sendNotificationToUser()
← 201 { data: { linkId, matchedCount } }
```

### Flow 2：已領過者選擇「再領取」排隊
```
POST /api/queue { thankYouMessage, track: "community" }
  → Router: Zod validation (message 5~200, track: "community")
  → Service: findActiveQueueEntryByUser(userId)
    * 若有 waiting/reserved/revealed → 409 ALREADY_IN_QUEUE
    * 若選 newbie 且（任一軌道有 confirmed 紀錄，或分享過連結）→ 409 NEWBIE_TRACK_ONLY
    * 選 community → 放行；`ALREADY_IN_QUEUE` 的檢查先於 `NEWBIE_TRACK_ONLY`
  → Repository: createQueueEntry({ userId, track: 'community', thankYouMessage })
  → Service: matchAvailableSlotsToQueue()
← 201 { data: { queueEntryId, status: 'waiting' | 'reserved' } }
```

---

## 資料邊界

| 來源 | 在哪一層轉換 | 轉成什麼 | 不符合時 |
|------|------------|---------|---------|
| `POST /api/links` body | Router (Zod schema) | `SubmitLinkDto` (含 `track`) | 422 驗證錯誤 |
| `POST /api/queue` body | Router (Zod schema) | `JoinQueueDto` (含 `track`) | 422 驗證錯誤 |
| D1 `invite_slots` 列 | Repository | `AvailableSlot` domain model（`track` 以 `parseQueueTrack` 驗證） | 未知軌道值拋錯，不補預設 |
| D1 `queue_entries` 列 | Repository | `WaitingTicket` domain model（`track` 以 `parseQueueTrack` 驗證） | 未知軌道值拋錯，不補預設 |

---

## 交易與一致性

| 操作 | 必須一起成功的寫入 | 交易邊界 | 併發處理 | 重複送出 |
|------|------------------|---------|---------|---------|
| **建立雙軌連結** | `invite_links` 與 N 個 `invite_slots` (帶指定 `track`) | `InviteQueueRepository.createLinkWithSlots` (D1 batch) | 唯一邀請代碼約束 | 409 DUPLICATE_REFERRAL_CODE |
| **加入排隊** | `queue_entries` 新增列 (帶指定 `track`) | `InviteQueueRepository.createQueueEntry` | `idx_queue_entries_active_user` 唯一索引阻擋併發多開 | 409 ALREADY_IN_QUEUE |
| **雙軌撮合指派** | 更新 `invite_slots` 為 `reserved` 並更新 `queue_entries` 綁定 | `InviteQueueRepository.assignSlotToQueueEntry` (每組席次與票券一個 D1 batch) | 帶 `status = 'available'` 與 `status = 'waiting'` 條件更新 | 狀態已轉移者跳過 |

---

## Build Sequence

### Phase 1：後端資料模型、撮合引擎、Service 與 API（additive / non-breaking）
- **目標**：完成雙軌資料庫欄位與索引遷移，擴充撮合引擎純領域邏輯，更新後端路由與 Service 支援雙軌排隊與身分查詢。
- **依賴**：無。
- **限制**：既有端點 `/api/board`、`/api/me`、`/api/queue`、`/api/links` 保持向後相容（`POST /api/links` 未帶 `track` 時預設為 `newbie`；`POST /api/queue` 未帶 `track` 時由 service 依新手資格決定）。
- **Checklist**：
  - [x] 撰寫 `migrations/0002_dual_track.sql` 並更新 `tests/helpers/testD1.ts` 載入全量遷移。
  - [x] 更新 `src/shared/types.ts` 定義 `QueueTrack` 與相關 DTO。
  - [x] 擴充 `src/worker/domain/matchingEngine.ts` 支援雙軌撮合與 downward fallback。
  - [x] 撰寫 `tests/unit/matchingEngineDualTrack.test.ts` 純單元測試。
  - [x] 更新 `src/worker/repositories/inviteQueueRepository.ts` 讀寫 `track` 欄位與索引。
  - [x] 更新 `src/worker/services/inviteQueueService.ts` 實作雙軌資格與排隊邏輯。
  - [x] 更新 `src/worker/queries/boardQuery.ts` 輸出雙軌細部統計，`src/worker/queries/meQuery.ts` 輸出 `isEligibleForNewbieTrack`。
  - [x] 更新 `tests/integration/inviteQueueFlow.test.ts` 覆蓋雙軌配對與邊界情境。
- **AC**：
  - `pnpm test` 通過所有既有測試與新增之雙軌整合測試。
  - 歷史 `confirmed` 使用者排 `newbie` 遭 409 拒絕；排 `community` 成功建立並能順利配對 `community` 席次。

### Phase 2：前端 ViewModel、雙軌介面、防呆引導與端對端驗收
- **目標**：在前端排隊表單與分享表單實作雙軌切換、動態身分引導與第二帳號提示。
- **依賴**：Phase 1。
- **限制**：保持簡潔單頁卡片佈局，不破壞既有 PWA 與推播機制。
- **Checklist**：
  - [x] 更新 `src/client/api/apiClient.ts` 支援雙軌參數。
  - [x] 更新 `src/client/hooks/useInviteApp.ts` 管理軌道狀態並連動使用者資格。
  - [x] 更新 `src/client/components/ProviderPanel.tsx` 新增名額受眾單選控制。
  - [x] 更新 `src/client/components/JoinQueueForm.tsx` 顯示第二帳號啟用注意事項提示。
  - [x] 更新 `src/client/components/BoardStats.tsx` 呈現新手 vs 再領取席次與排隊統計。
  - [x] 更新 `src/client/styles.css` 樣式。
  - [x] 以真實 Chrome（Chrome for Testing 加 puppeteer-core）驗證畫面、原生 `<dialog>` 與響應式排版（2026-10-24 至 25，三輪 smoke）。
- **AC**：
  - 前端單元測試全數通過（`pnpm test` 100% green）。
  - 未登入/純新手登入時以新手首發軌排隊，表單沒有軌道選項；已領過/提供者登入時自動以「再領取」排隊並顯示第二帳號警示。

---

## Test Strategy

### Unit Test
| 目標 | 測試行為 |
|------|---------|
| `matchingEngine.ts` | `newbie` 席次不分配給 `community` 票券 |
| `matchingEngine.ts` | `community` 席次優先撮合 `community` 票券；無人時分配給 `newbie` 票券 |
| `matchingEngine.ts` | 嚴格防自我配對（`ticket.userId !== slot.providerUserId`） |

### Integration Test
| Journey 步驟 | Test Chain |
|-------------|-----------|
| 雙軌提供與新手專屬保障 | 提供者 A 提交 2 個 `newbie` 席次 → 領取者 B（已領過）排 `community`（等待中）→ 純新手 C 排 `newbie`（立即配對 A）→ 驗證 B 依然等待、C 成功保留 |
| 互助席次優先互助與向下相容 | 提供者 D 提交 1 個 `community` 席次 → 純新手 E 排 `newbie` → 席次自動向下相容分配給 E |
| 多次排隊約束 | 使用者在 `community` 成功確認後，再次加入排隊成功（允許第二帳號）；但在進行中（`waiting`/`reserved`）重複加入排隊遭 409 阻擋 |
| 新手軌資格 | 歷史已領過者或曾分享過連結者排 `newbie` 回 409 `NEWBIE_TRACK_ONLY`；排 `community` 成功；純新手可加入 `newbie` 與 `community` 隊列。服務層規則需要真實 D1，所以放在這裡驗證（`tests/integration/inviteQueueFlow.test.ts`） |

### Mock 決策
| 項目 | Mock / Real | 原因 |
|------|------------|------|
| D1 SQLite | Real (`better-sqlite3` 記憶體資料庫) | 驗證 Partial Unique Index 與 Batch 交易原子性 |
| Web Push | In-memory Mock（測試以 `createApp({ pushSender })` 注入替身，見 `tests/integration/inviteQueueFlow.test.ts`） | 避免向外部推播伺服器發送真實網路請求 |

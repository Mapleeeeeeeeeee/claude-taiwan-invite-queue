# Claude Taiwan 邀請連結排隊與感謝回饋平台 QA 驗證報告（invite-code-queue）

## 驗證結論：10 項 Acceptance Criteria 與 2 條核心 User Journey 全數通過

本次黑盒測試（Black-Box QA）依據設計文件 `docs/design/invite-code-queue.md`，針對本地 Cloudflare Workers + D1 環境（`http://127.0.0.1:8787`）執行 Web UI（`agent-browser`）與 HTTP API（`curl`）端到端驗證，未讀取 `src/` 或 `tests/` 原始碼。

- **Acceptance Criteria 通過率**：**10 / 10（100%）**
- **User Journey 與替代流程通過率**：**6 / 6（100%）**
- **L1～L4 分層測試結果**：共執行 **46 項**黑盒檢查，**46 項 PASS、0 項 FAIL**
- **發現問題（Defects）**：**0 件**

---

## Acceptance Criteria 驗證結果

| AC | 驗證項目 | 驗證方式 | 結果 | 實測行為摘要 |
|----|---------|---------|------|-------------|
| **AC 1** | 提供者提交連結與自動正規化 | `agent-browser` + `curl` | **PASS** | 貼上整段含中文與 `?s=ios` 的文字 `這是我的邀請碼 https://claude.ai/referral/rNFlbuU0OA?s=ios 拿去用吧`（預設 3 次），系統正規化為 `https://claude.ai/referral/rNFlbuU0OA` 並建立 3 個名額；再次提交無 `?s=ios` 的同代碼網址時回傳 `409`，畫面顯示「這組邀請連結已經被分享過囉」。 |
| **AC 2** | 提供者自訂剩餘可用次數 | `agent-browser` + `curl` | **PASS** | 在「我要分享邀請碼」切換為 `2 次` 並提交 `https://claude.ai/referral/secondLink22`，系統僅建立 2 個名額（`totalSlots: 2`）；調整為 `1 次` 時僅建立 1 個名額。 |
| **AC 3** | FIFO 自動配對與即時推播 | `agent-browser` | **PASS** | 小華（第 1 順位）與小美（第 2 順位）依序排隊後，小張提交 3 個名額的連結，名額 #1 與 #2 立即轉為 `reserved`（保留 6 小時）分別配給小華與小美，名額 #3 維持 `available` 留在池中（看板可用名額顯示 `1`、排隊人數顯示 `0`）。 |
| **AC 4** | 池中有碼時排隊即刻獲配 | `agent-browser` + `curl` | **PASS** | 當池中有非本人提供的 `available` 名額時，領取者送出感謝小卡加入排隊，不經過等待直接進入 `reserved` 狀態，畫面立即顯示「🎉 輪到你囉！請於 6 小時內點擊解鎖查看邀請連結」。 |
| **AC 5** | 6 小時未解鎖逾時安全回收 | `curl` + D1 時間模擬 | **PASS** | 原領取者處於 `reserved`（尚未看到完整網址）超過 6 小時後，排隊紀錄自動轉為 `expired`，該名額自動轉配給隊伍下一位排隊者（狀態轉為 `reserved`）；逾時者可重新加入排隊排至隊尾。 |
| **AC 6** | 解鎖後手動確認啟用與感謝推播 | `agent-browser` | **PASS** | 小華於 6 小時內點擊「🔓 解鎖查看邀請連結」看到完整網址，再點擊「成功啟用，送出感謝 ❤️」，名額與排隊紀錄轉為 `confirmed`，首頁公開感謝牆立即刊登小華寫給小張的感謝小卡，看板累計成功分享數 +1，小張的「我的分享紀錄」亦同步顯示該張感謝小卡。 |
| **AC 7** | 解鎖滿 30 分鐘未操作自動確認 | `agent-browser` + `curl` | **PASS** | 小美點擊解鎖後未按任何按鈕，模擬解鎖滿 30 分鐘後讀取看板／個人狀態，系統自動將名額與排隊紀錄轉為 `confirmed`，並將小美預寫的感謝小卡刊登於公開感謝牆。 |
| **AC 8** | 無效連結回報、優先重排與連動停用剩餘名額 | `agent-browser` | **PASS** | 點擊「邀請連結無效／已額滿 ⚠️」會先彈出二次確認對話框；確認送出後，該名額轉為 `invalidated`，同組連結尚未配出的 `available` 名額立即轉為 `closed`（「因同組無效而停用」），且領取者排回隊伍第 1 順位（`priority` 提升，剩餘重排機會變為 0 次）。 |
| **AC 9** | 每帳號終身限 1 次無效重排與 1 次成功領取 | `agent-browser` + `curl` | **PASS** | 已用過 1 次無效重排的小美獲配第 2 組名額並解鎖時，畫面按鈕顯示「已用完無效重排額度（限 1 次）」且為 `disabled`，直接呼叫 `POST /api/queue/report-invalid` 亦回傳 `409`；名額轉為 `confirmed` 後再次呼叫 `POST /api/queue` 回傳 `409`（「你已經成功領取過邀請連結囉」）。 |
| **AC 10** | 提供者違規門檻與好心人保護 | `agent-browser` + `curl` | **PASS** | 小張的第 1 組連結有 1 人成功啟用、1 人回報無效、1 個名額連動停用，系統判定 `invalidLinkStrikeCount = 0`（好心人保護生效，可繼續分享）；另一名提供者連續 2 組連結皆為「0 人成功啟用且被回報無效」後，`invalidLinkStrikeCount = 2` 且 `isProviderBlocked = true`，第 3 次提交連結時回傳 `403`（「由於先前提供的連結多次被回報無效，目前已暫停提供權限」）。 |

---

## Step 2：BBT 黑盒測試設計（Phase 1a Scenario Exhaustion）

### 1. 等價分割（Equivalence Partitioning）

```text
欄位：邀請連結輸入（rawUrlInput）
├ 有效類 1：標準邀請網址 → 代表值："https://claude.ai/referral/secondLink22"
├ 有效類 2：帶查詢參數網址 → 代表值："https://claude.ai/referral/rNFlbuU0OA?s=ios"
├ 有效類 3：夾帶中文前後說明文字 → 代表值："這是我的邀請碼 https://claude.ai/referral/rNFlbuU0OA?s=ios 拿去用吧"
├ 無效類 1：非 claude.ai/referral 網域或路徑 → 代表值："https://example.com/referral/abc123"
├ 無效類 2：缺少邀請代碼 → 代表值："https://claude.ai/referral/"
└ 無效類 3：已存在於系統的重複邀請代碼 → 代表值："https://claude.ai/referral/rNFlbuU0OA"

欄位：提供名額數（slotCount）
├ 有效類：1、2、3（預設 3）
├ 無效類 1：小於 1 → 代表值：0
└ 無效類 2：大於 3 → 代表值：4

欄位：感謝小卡內容（thankYouMessage）
├ 有效類：5～200 字含中英數與 Emoji → 代表值："謝謝小張大大無私分享 Claude 邀請碼！祝寫 code 順心！"
├ 無效類 1：少於 5 字 → 代表值："謝謝大大"（4 字）
└ 無效類 2：超過 200 字 → 代表值："謝" × 201（201 字）
```

### 2. 邊界值分析（Boundary Value Analysis）

| 參數 | 邊界值 | 期望結果 | 實測結果 |
|------|--------|---------|---------|
| `thankYouMessage` 長度 | `4` 字（`謝謝大大` / `1234`） | 拒絕提交（`422`），前端保留已輸入文字並提示「感謝小卡需為 5～200 字」 | **PASS**（`422`，前端保留 `謝謝大大`） |
| `thankYouMessage` 長度 | `5` 字（`謝謝好心人`） | 成功加入排隊（`201`） | **PASS**（`201`） |
| `thankYouMessage` 長度 | `200` 字（`謝` × 200） | 成功加入排隊（`201`） | **PASS**（`201`） |
| `thankYouMessage` 長度 | `201` 字（`謝` × 201） | 拒絕提交（`422`） | **PASS**（`422`） |
| `slotCount` 名額數 | `0` | 拒絕提交（`422`） | **PASS**（`422`） |
| `slotCount` 名額數 | `1` | 成功建立 1 個名額（`201`） | **PASS**（`201`） |
| `slotCount` 名額數 | `2` | 成功建立 2 個名額（`201`） | **PASS**（`201`） |
| `slotCount` 名額數 | `3` | 成功建立 3 個名額（`201`） | **PASS**（`201`） |
| `slotCount` 名額數 | `4` | 拒絕提交（`422`） | **PASS**（`422`） |
| 保留期限（`reserve_expires_at`） | 6 小時內 / 超過 6 小時 | 6 小時內可解鎖；超過 6 小時轉 `expired` 並釋出名額轉配下一位 | **PASS** |
| 確認期限（`confirm_expires_at`） | 30 分鐘內 / 滿 30 分鐘 | 30 分鐘內可手動確認或回報無效；滿 30 分鐘自動轉 `confirmed` | **PASS** |
| 無效重排次數（`invalidRetryCount`） | `0` 次 / `1` 次 | `0` 次可回報無效並優先重排；達 `1` 次後按鈕 `disabled` 且 API 回傳 `409` | **PASS** |
| 完全無效連結數（`invalidLinkStrikeCount`） | `0`、`1`、`2` 組 | 0～1 組可提交；達 2 組（0 人啟用且被回報無效）回傳 `403` 停權 | **PASS** |

### 3. 決策表（Decision Table）

| 編號 | 條件組合 | 期望結果 | 實測結果 |
|------|---------|---------|---------|
| DT-1 | 代碼未重複 + 違規 < 2 + 網址合法 + 名額 1～3 | 建立連結與名額，依 FIFO 配對非本人排隊者 | **PASS** |
| DT-2 | 代碼已存在（不論有無 `?s=ios`） | 拒絕提交（`409`），提示「這組邀請連結已經被分享過囉」 | **PASS** |
| DT-3 | 提供者累計完全無效連結達 2 組 | 拒絕提交（`403`），提示「由於先前提供的連結多次被回報無效，目前已暫停提供權限」 | **PASS** |
| DT-4 | 網址格式不符 `https://claude.ai/referral/<代碼>` | 拒絕提交（`400`），提示「請貼上正確的 Claude 邀請連結（格式如 https://claude.ai/referral/...）」 | **PASS** |
| DT-5 | 提供者也在排隊中 + 池中僅有該提供者本人的可用名額 | 跳過本人不自我配對，提供者排隊紀錄維持 `waiting` | **PASS** |
| DT-6 | 解鎖後 30 分鐘內 + 重排次數 = 0 + 回報無效 | 該名額 `invalidated`，同連結未配出 `available` 名額轉 `closed`，領取者優先排回第 1 順位 | **PASS** |
| DT-7 | 一組連結含 >= 1 個 `confirmed` 名額 + 其餘名額被回報無效 | 好心人保護生效，不計入提供者完全無效連結（`invalidLinkStrikeCount` 不增加） | **PASS** |

### 4. 狀態轉移（State Transition）

```text
合法轉換（全數實測通過）：
  [Slot: available]  →(配對非本人排隊者)→ [Slot: reserved]
  [Slot: available]  →(同連結另一名額被回報無效)→ [Slot: closed]
  [Slot: reserved]   →(6h 內點擊解鎖)→ [Slot: revealed]
  [Slot: reserved]   →(主動放棄取消排隊 / 6h 逾時)→ [Slot: available / 轉配下一位 reserved]
  [Slot: revealed]   →(點擊成功啟用 / 滿 30m 自動確認)→ [Slot: confirmed]
  [Slot: revealed]   →(30m 內且重排次數=0 回報無效)→ [Slot: invalidated]

非法轉換（全數確認以 409 攔截）：
  [Queue: waiting]   →✕→ [revealed]（尚未獲配名額不可解鎖，回傳 409）
  [Queue: reserved]  →✕→ [confirmed]（尚未解鎖看碼不可直接確認啟用，回傳 409）
  [Queue: revealed]  →✕→ [cancelled / available]（已曝光邀請連結網址不可退回或取消，UI 無取消按鈕且 API 回傳 409）
  [Queue: confirmed] →✕→ [invalidated]（已確認啟用不可反悔回報無效，回傳 409「此名額已完成啟用與感謝回饋，無法再變更狀態」）
  [Queue: confirmed] →✕→ [waiting]（已成功領取不可再次排隊，回傳 409「你已經成功領取過邀請連結囉」）
```

---

## L1～L4 分層執行摘要

### L1：User Journey 與替代流程驗證
1. **Journey 1（領取者排隊 → 獲配保留 → 解鎖看碼 → 手動確認感謝上牆）**：**PASS**。未解鎖前 DOM 與 `/api/me` 回應皆不包含 `referralUrl`（確保逾時回收安全）；解鎖後才回傳完整連結與 30 分鐘倒數；點擊確認後感謝小卡立即顯示於首頁公開感謝牆。
2. **Journey 2（提供者分享含 `?s=ios` 連結 → 自動正規化與配對 → 查看分享紀錄與感謝小卡）**：**PASS**。提供者可在「我的分享紀錄」即時看到每個名額處於「等待排隊者中」、「已保留給版友（6hr 解鎖中）」、「已成功啟用 ❤️（含感謝小卡內容）」、「被回報無效 ⚠️」或「因同組無效而停用」。
3. **替代流程（30 分鐘未操作自動確認、無效連結優先重排、6 小時逾時回收轉配、略過推播仍可操作）**：**PASS**。

### L2：Exploratory Tours（真實使用者行為探索）
1. **Money Tour**：完整走通多位領取者排隊、提供者分享、解鎖、感謝牆更新與看板計數器同步。
2. **Rained-Out Tour（中途放棄與恢復）**：
   - 在 `waiting` 狀態點擊「取消排隊」→ 狀態轉為 `cancelled`，看板排隊人數 -1，表單自動保留先前填寫的感謝小卡文字供隨時重排（**PASS**）。
   - 在 `reserved`（尚未解鎖）狀態點擊「放棄名額並取消排隊」→ 名額安全退回池中（看板可用名額 +1），使用者可重新排隊（**PASS**）。
3. **Antisocial Tour（誤操作與防呆）**：
   - 排隊表單輸入 4 字感謝小卡送出 → 顯示錯誤提示且輸入框文字不清空（**PASS**）。
   - 點擊「邀請連結無效／已額滿 ⚠️」→ 彈出二次確認對話框，點擊「返回再試一次」可安全關閉對話框不誤觸重排（**PASS**）。

### L3：Boundary（邊界值與非法狀態轉換）
- 驗證感謝小卡 `4 / 5 / 200 / 201` 字邊界、名額數 `0 / 1 / 2 / 3 / 4` 邊界、網址夾帶中文與查詢參數，以及所有非法狀態轉換，全數符合規格。

### L4：Adversarial（安全性、防濫用與冪等性）
1. **未認證存取保護**：未帶 Cookie 呼叫 `POST /api/queue`、`POST /api/links`、`POST /api/queue/reveal`、`POST /api/queue/confirm`、`POST /api/queue/report-invalid`、`POST /api/queue/cancel`、`POST /api/push/subscribe`，全數回傳 `401 Unauthorized`（`請先使用 Google 帳號登入`）。
2. **重複提交與冪等性（Double-Submit & Idempotency）**：
   - 已在 `waiting`、`reserved`、`revealed`、`confirmed` 時重複呼叫 `POST /api/queue` 全數以 `409` 阻擋。
   - 已在 `revealed` 時重複呼叫 `POST /api/queue/reveal` 具備嚴格冪等性：回傳相同網址且 **`confirmExpiresAt` 時間戳完全不延長**（維持原本的 `2026-10-22T04:27:54.540Z`），防止惡意無限延展 30 分鐘確認期。
3. **防止自我配對（Self-Matching Protection）**：提供者小張在池中有自己提供的可用名額時加入排隊，系統跳過本人名額，將小張排入 `waiting` 第 1 順位，可用名額維持留給其他版友。
4. **提供者惡意假連結封鎖 vs. 好心人保護**：累計 2 組完全無效連結後自動停權（`403`），而曾有至少 1 人成功啟用的連結不計入違規。

---

<details>
<summary>查證細節：Web UI 快照與自動化 API 驗證腳本輸出</summary>

### 1. PWA Manifest 與 Service Worker 檢查

```bash
curl -s -i http://127.0.0.1:8787/manifest.webmanifest
curl -s -i http://127.0.0.1:8787/sw.js | head -n 20
```

實測回應 `200 OK`，`Content-Type: application/manifest+json` 與 `application/javascript`，Service Worker 註冊 `push` 與 `notificationclick` 事件處理。

### 2. Web UI 關鍵互動快照（`agent-browser`）

- **表單驗證失敗保留輸入文字**：輸入 4 字 `謝謝大大` 送出後，顯示 `alert "感謝小卡需為 5～200 字"`，且 `textbox "預寫給提供者的感謝小卡（必填，5～200 字）"` 值維持為 `謝謝大大`。
- **回報無效二次確認對話框**：點擊 `邀請連結無效／已額滿 ⚠️` 後出現 `dialog "確認回報無效"`，內含標題 `確定這組邀請連結無法使用嗎？` 與按鈕 `返回再試一次`、`確定回報無效並優先重排`。
- **已用完 1 次重排機會後停用按鈕（AC 9）**：小美第 2 次獲配名額並解鎖後，畫面顯示 `button "已用完無效重排額度（限 1 次）" [disabled]`。

### 3. API 腳本執行輸出（L1～L4 共 31 項斷言全數通過）

```text
=== 1. L4 Adversarial: Unauthenticated Access to Protected Endpoints ===
✅ PASS: Unauth POST /api/queue returns 401 (got '401')
✅ PASS: Unauth POST /api/links returns 401 (got '401')
✅ PASS: Unauth POST /api/push/subscribe returns 401 (got '401')
✅ PASS: Unauth POST /api/queue/reveal returns 401 (got '401')
✅ PASS: Unauth POST /api/queue/confirm returns 401 (got '401')
✅ PASS: Unauth POST /api/queue/report-invalid returns 401 (got '401')
✅ PASS: Unauth POST /api/queue/cancel returns 401 (got '401')
=== 2. AC 5: 6-Hour Reservation Expiry & Auto-Reassignment + Disallowed Transitions ===
✅ PASS: ExpA2 immediately gets reserved slot (got 'reserved')
✅ PASS: Disallowed transition: Reserved -> Confirmed without reveal rejected (got '409')
✅ PASS: Double-submit queue while Reserved rejected (got '409')
✅ PASS: ExpB2 enters waiting (got 'waiting')
✅ PASS: Disallowed transition: Waiting -> Revealed rejected (got '409')
✅ PASS: Double-submit queue while Waiting rejected (got '409')
✅ PASS: AC 5: ExpA2 status becomes expired after 6h (got 'expired')
✅ PASS: AC 5: ExpB2 automatically receives reserved slot (got 'reserved')
✅ PASS: AC 5: ExpB2 assigned same slotId (got '7')
✅ PASS: AC 5: Expired user can re-join queue (got 'waiting')
✅ PASS: L4 Double-Reveal idempotent (does not extend confirmExpiresAt) (got '2026-10-22T04:27:54.540Z')
=== 3. L3 Boundary Value Analysis (BVA): Thank-You Message (4, 5, 200, 201 chars) & Slot Counts (0, 1, 2, 3, 4) ===
✅ PASS: BVA: Thank-you message 4 chars rejected (422) (got '422')
✅ PASS: BVA: Thank-you message 201 chars rejected (422) (got '422')
✅ PASS: BVA: Thank-you message 5 chars accepted (201) (got '201')
✅ PASS: BVA: Thank-you message 200 chars accepted (201) (got '201')
✅ PASS: BVA: slotCount 0 rejected (422) (got '422')
✅ PASS: BVA: slotCount 4 rejected (422) (got '422')
✅ PASS: BVA: slotCount 1 accepted (201) (got '201')
=== 4. AC 10 & L4 Adversarial: Provider Blocked After 2 Completely Invalid Links ===
✅ PASS: AC 10: After 1st completely invalid link, strike count is 1 (got '1')
✅ PASS: AC 10: After 1st completely invalid link, isProviderBlocked is false (got 'false')
✅ PASS: AC 10: After 2nd completely invalid link, strike count is 2 (got '2')
✅ PASS: AC 10: After 2nd completely invalid link, isProviderBlocked is true (got 'true')
✅ PASS: AC 10: Blocked provider POST /api/links returns 403 (got '403')
✅ PASS: AC 10: Blocked provider error message matches spec R1-3 (contains '由於先前提供的連結多次被回報無效，目前已暫停提供權限')

==========================================
SUMMARY: PASS=31, FAIL=0
==========================================
```

</details>

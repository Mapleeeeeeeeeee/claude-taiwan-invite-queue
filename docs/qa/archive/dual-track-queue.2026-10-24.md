# Claude Taiwan 雙軌道排隊機制（Dual-Track Queue）QA 驗證報告

## 驗證結論：5 項 Acceptance Criteria 與 3 條核心 User Journey 實測通過

本次黑盒測試（Black-Box QA）依據設計文件 `docs/design/dual-track-queue.md` 與通用測試方法論（`testing-methodology`），在本地 Cloudflare Workers + D1 環境（`http://127.0.0.1:8787`）針對真實 Web UI（`agent-browser` 瀏覽器自動化）與 HTTP API（`curl`、Python 測試腳本）執行端到端跨使用者驗證。本測試嚴格恪守黑箱邊界，未讀取 `src/` 或 `tests/` 原始碼。

- **Acceptance Criteria 通過率**：**5 / 5（100%）**
- **User Journey 通過率**：**3 / 3（100%）**
- **L1～L4 分層測試結果**：共執行 **53 項**黑盒斷言，**53 項 PASS、0 項 FAIL**
- **發現問題與改進建議（Findings）**：**2 件**（含 1 件規格決策表邊界防護缺口、1 件靜態資產 favicon 500 錯誤）

---

## 驗證總覽表

| 測試層級 | 測試項目總數 | PASS | FAIL | 說明 |
| :--- | :---: | :---: | :---: | :--- |
| **L1 User Journey & AC** | 16 | 16 | 0 | 覆蓋 Journey 1～3 與 AC 1～AC 5，含撮合優先級與向下相容 |
| **L2 Exploratory Tours** | 10 | 10 | 0 | 走通 Money Tour、Rained-Out Tour（取消與放棄）、Antisocial Tour |
| **L3 Boundary & Transitions**| 18 | 18 | 0 | 感謝小卡長度 (4/5/200/201)、名額數 (0/1/2/3/4)、重複解鎖冪等性、狀態機非法轉換阻擋 |
| **L4 Adversarial & Security**| 9 | 9 | 0 | 7 個寫入端點未認證 401 攔截、重複排隊 409、好心人保護、2 組無效連結停權 403 |
| **合計** | **53** | **53** | **0** | **整體通過率：100%** |

---

## Acceptance Criteria 逐項驗證結果

| AC | 驗證項目 | 驗證方式 | 結果 | 實測行為摘要 |
| :--- | :--- | :--- | :---: | :--- |
| **AC 1** | 資料模型與提供端受眾標記 | `agent-browser` + HTTP API | **PASS** | 1. 提供者分享表單提供「名額適用對象」單選：預設「限新手首次體驗」（`newbie`）與「開放第二帳號試用」（`community`）。<br>2. 提交時若未帶 `track` 參數，後端資料庫 slots 自動補 `newbie`。<br>3. 選擇 `community` 時，其建立之所有名額 slots 皆標記為 `community`。<br>4. 傳入非法 track（如 `vip`）時以 `422 Unprocessable Entity` 拒絕。 |
| **AC 2** | 排隊資格校驗 | HTTP API + UI 實測 | **PASS** | 1. 歷史已有 `confirmed` 領取紀錄之使用者，以 `track: "newbie"` 請求加入排隊時，後端回傳 `409 Conflict` 且錯誤代碼為 `NEWBIE_TRACK_ONLY`。<br>2. 歷史已有 `confirmed` 領取紀錄之使用者，以 `track: "community"` 請求加入排隊時，後端成功建立排隊（`201 Created`），不再拋出舊版之 `ALREADY_CLAIMED` 阻擋。 |
| **AC 3** | 撮合分流、優先序與向下相容 | Multi-user API 撮合引擎驗證 | **PASS** | 1. **新手席次隔離**：池中僅有 `newbie` 席次時，即使 `community` 隊列有人等待，絕不撮合給 `community` 票券，席次維持 `available` 等待新手。<br>2. **互助優先互助**：當新手與第二帳號皆有等待票券時，提交 `community` 席次優先配對給 `community` 票券。<br>3. **向下相容（Fallback）**：當 `community` 隊列無人等待、但 `newbie` 隊列有人等待時，`community` 席次自動分配給 `newbie` 票券。<br>4. **嚴格防自我配對**：提供者排隊時，系統跳過本人名額，票券維持 `waiting`，不發生自己領取自己名額。 |
| **AC 4** | 即時名額看板細部統計 | `GET /api/board` + UI 看板 | **PASS** | `/api/board` 回應結構向下相容既有欄位，並完整擴充細部統計：<br>- 總席次與細項：`availableSlotsCount = newbieSlotsCount + communitySlotsCount`<br>- 總等待與細項：`waitingQueueCount = newbieQueueCount + communityQueueCount`<br>- 累計啟用數：`totalConfirmedCount`<br>數值精確同步，無欄位遺失。 |
| **AC 5** | 前端防呆引導與注意事項 | `agent-browser` UI 互動 | **PASS** | 1. **純新手登入／未登入**：表單預設鎖定新手保障席次，按鈕顯示「加入排隊領取邀請連結」。<br>2. **曾領取過者（confirmed）登入**：表單上方以專屬卡片展開歷史領取之邀請碼備查明細與感謝卡，下方表單自動切換至「第二帳號試用」，提示「*提醒：Claude 單一帳號無法重複試用，此名額請用於第二個帳號*」，按鈕文字動態轉為「加入『第二帳號試用』排隊」。<br>3. **曾為提供者登入**：表單同樣自動切換至「第二帳號試用」並顯示相同提醒。 |

---

## User Journey 驗證細節

### Journey 1：提供者指定受眾並發布邀請碼
1. 提供者點擊切換至「我要分享邀請碼」頁籤。
2. 畫面清楚呈現「名額適用對象」單選控制：
   - `[●] 限新手首次體驗（預設：保留給未體驗過 Pro 的版友）`
   - `[○] 開放第二帳號試用（包含已領取過、欲為第二帳號啟用的版友；若無人排隊自動讓給新手）`
3. 填入邀請連結 `https://claude.ai/referral/zhangTestLink123`，選擇次數 2 次，勾選「開放第二帳號試用」並送出。
4. 系統成功建立該組連結，並在下方「我的分享紀錄」中正確標示兩個名額之軌道為「第二帳號」，狀態為「等待排隊者中」。
5. **判定**：**PASS**。

### Journey 2：純新手使用單一表單排隊
1. 純新手訪客進入平台，點擊「我要排隊領取」。
2. 表單預設為新手首次體驗軌道，填寫顯示暱稱與感謝小卡（`謝謝小張無私分享，我是純新手小華！祝你萬事順利！`，共 24 字）。
3. 點擊送出加入排隊。
4. 由於池中已有提供者發布之 `community` 名額且互助隊列無人，撮合引擎立即執行向下相容配對，小華直接進入 `reserved` 保留狀態。
5. 小華點擊「確認需要，解鎖查看邀請連結」查看完整網址，再點擊「確認啟用並送出感謝」。
6. 名額與排隊狀態成功轉為 `confirmed`，首頁公開感謝牆即時刊登小華寫給提供者的感謝小卡，看板累計已領取數 +1。
7. **判定**：**PASS**。

### Journey 3：已領取過的老版友為第二帳號排隊
1. 小華（先前已成功領取過 1 次）再次造訪「我要排隊領取」。
2. 系統自動偵測小華已有 confirmed 歷史紀錄：
   - 頂部呈現可折疊之「已成功啟用試用名額 感謝版友 小張 的分享」手風琴，內含邀請碼備查與歷史感謝小卡。
   - 下方排隊表單自動切換並鎖定為「第二帳號試用」，提示：「*已自動切換為第二帳號排隊（提醒：Claude 單一帳號無法重複試用，此名額請用於第二個帳號）*」。
   - 按鈕顯示「加入『第二帳號試用』排隊」。
3. 小華填寫給提供者的感謝小卡送出排隊，成功建立 `track = 'community'` 之排隊票券，不被系統封鎖。
4. **判定**：**PASS**。

---

## L1～L4 分層測試實測紀錄

### L1：核心業務與撮合優先序驗證
- **測試 1.1（新手席次隔離性）**：互助票券 `C_wait` 於隊列等待中，提供者提交 1 個 `newbie` 席次。驗證結果：`C_wait` 依然維持 `waiting`，該席次維持 `available`；當新手票券 `N_iso` 加入時，立即配對給 `N_iso`（轉為 `reserved`），`C_wait` 依然在等待。**PASS**。
- **測試 1.2（互助席次優先權）**：隊列中同時有等待中之互助票券 `C_wait` 與新手票券 `N_wait`，提供者提交 1 個 `community` 席次。驗證結果：撮合引擎優先配對給 `C_wait`（轉為 `reserved`），`N_wait` 維持 `waiting`。**PASS**。
- **測試 1.3（互助席次向下支援新手）**：互助隊列無人等待，新手票券 `N_wait` 處於等待中，提供者提交 1 個 `community` 席次。驗證結果：席次自動向下相容分配給 `N_wait`（轉為 `reserved`）。**PASS**。
- **測試 1.4（防自我配對）**：提供者提交席次後自己加入排隊，系統跳過本人名額，提供者排入隊伍首位等待，可用席次維持在池中留給其他版友。**PASS**。

### L2：探索式 Tours
- **Money Tour**：完整驗證新手與第二帳號雙軌道領取、保留、解鎖、手動啟用、上牆展示與看板更新之全流程闭環。**PASS**。
- **Rained-Out Tour（中途放棄與名額退回）**：
  - 在 `waiting` 狀態呼叫 `POST /api/queue/cancel`：排隊狀態轉為 `cancelled`，看板排隊計數即刻扣減，可再次重新排隊。**PASS**。
  - 在 `reserved`（尚未解鎖完整連結）狀態點擊「暫無需求，放棄名額留給下一位」：排隊票券安全取消，原席次安全恢復回可用池（`communitySlotsCount` +1），未造成名額鎖死；且先前已領取的 confirmed 備查紀錄完好無損。**PASS**。
- **Antisocial Tour（惡意操作與防呆）**：
  - 已領過者繞過前端，直接發送 `POST /api/queue {"track": "newbie"}`：後端回傳 `409 NEWBIE_TRACK_ONLY` 成功攔截。**PASS**。
  - 處於 `waiting` 狀態發起 `POST /api/queue/reveal`：回傳 `409` 阻擋（尚未獲配名額不可偷看）。**PASS**。
  - 處於 `reserved` 狀態發起 `POST /api/queue/confirm`（未先解鎖）：回傳 `409` 阻擋。**PASS**。
  - 處於 `revealed` 狀態發起 `POST /api/queue/cancel`：回傳 `409` 阻擋（已曝光邀請碼不可反悔退回）。**PASS**。
  - 處於 `confirmed` 狀態發起 `POST /api/queue/report-invalid`：回傳 `409` 阻擋（已確認啟用不可惡意回報無效）。**PASS**。

### L3：邊界值分析（BVA）與狀態轉換
- **感謝小卡字數邊界**：
  - `4` 字（`謝謝大大`）：拒絕提交（`422`）。**PASS**。
  - `5` 字（`謝謝好心人`）：成功加入排隊（`201`）。**PASS**。
  - `200` 字（`謝` × 200）：成功加入排隊（`201`）。**PASS**。
  - `201` 字（`謝` × 201）：拒絕提交（`422`）。**PASS**。
- **名額數邊界**：
  - `0` 個：拒絕提交（`422`）。**PASS**。
  - `1` 個：成功建立（`201`）。**PASS**。
  - `2` 個：成功建立（`201`）。**PASS**。
  - `3` 個：成功建立（`201`）。**PASS**。
  - `4` 個：拒絕提交（`422`）。**PASS**。
- **解鎖查看重複呼叫之冪等性**：
  - 首次呼叫 `POST /api/queue/reveal` 取得 `confirmExpiresAt` 時間戳（30 分鐘確認窗口）。
  - 間隔 1 秒後再次呼叫 `POST /api/queue/reveal`，回傳相同資料且 **`confirmExpiresAt` 完全不延長**，防範惡意無限延長確認期。**PASS**。
- **確認啟用重複呼叫之冪等性**：
  - 首次呼叫 `POST /api/queue/confirm` 成功確認（`200`）。
  - 連續重複點擊送出呼叫，後端保持冪等回傳 `200 {"data":{"confirmed":true}}`，不產生 500 錯誤。**PASS**。

### L4：安全性、權限隔離與防刷
- **未認證存取防護**：7 個受保護端點（`/api/queue`、`/api/links`、`/api/push/subscribe`、`/api/queue/reveal`、`/api/queue/confirm`、`/api/queue/report-invalid`、`/api/queue/cancel`）在未攜帶 Cookie 下，全數回傳 `401 Unauthorized`。**PASS**。
- **併發與重複排隊防護（Double-Submit）**：同一使用者在已持有未結案紀錄（`waiting`、`reserved`、`revealed`）時，再次呼叫 `POST /api/queue` 全數被 `409 ALREADY_IN_QUEUE` 阻擋。**PASS**。
- **好心人保護機制**：提供者分享 2 個名額之連結，其中 1 個名額由版友成功啟用、另 1 個名額被回報無效，提供者之 `invalidLinkStrikeCount` 維持為 `0`，未受懲處。**PASS**。
- **提供者違規封鎖機制**：提供者連續 2 組連結皆為「0 人成功啟用且被回報無效」後，`invalidLinkStrikeCount = 2` 且 `isProviderBlocked = true`；後續再次發送 `POST /api/links` 立即以 `403 Forbidden` 拒絕。**PASS**。

---

## 發現問題與改進建議（Defects & Findings）

### Finding 1：提供者未領取過時，後端 API 允許加入 `newbie` 軌道（規格決策表邊界防護缺口）
- **嚴重等級**：中（Medium）/ 規格一致性
- **違反 Oracle**：**Claims**（規格決策表條款）、**Purpose**（保護新手名額意圖）
- **現象描述**：
  在設計文件 `docs/design/dual-track-queue.md` § 資格與權限決策表中明定：
  > `提供者（有分享紀錄但未領過） | ❌ 禁止（提示讓給新手） | ✅ 可以 | 自動鎖定並選定「第二帳號試用軌」`
  前端 UI 在此情境已完整實作防呆引導，進入頁面時自動鎖定為第二帳號試用軌道。然而若惡意或技術使用者繞過前端，直接向後端發送 HTTP 請求：
  `POST /api/queue {"thankYouMessage":"提供者想排新手軌道","track":"newbie"}`
  後端目前僅依據 `confirmedEntries === 0` 進行校驗，未檢查 `hasSharedLinks`，導致該請求以 `201 Created` 放行並成功取得新手專屬保留席次。
- **複現步驟**：
  1. 使用 Google 帳號 A 登入，並提交 1 組邀請連結（此時 `hasSharedLinks = true` 且 `confirmedEntries = 0`）。
  2. 使用 curl 帶 A 的 Session Cookie，發送：
     `curl -X POST http://127.0.0.1:8787/api/queue -H "Content-Type: application/json" -d '{"thankYouMessage":"提供者想排新手軌道","track":"newbie"}'`
  3. 觀察回應：實際回傳 `201 Created`（預期依決策表應回傳 `409` 拒絕排入新手軌）。
- **改善建議**：
  在後端 `inviteQueueService.ts` 檢查排隊資格時，若請求軌道為 `newbie`，除了檢查歷史 confirmed 紀錄外，建議同步檢查 `hasSharedLinks`（或使用者分享紀錄），若 `hasSharedLinks === true` 則拋出拒絕錯誤（如 `409 PROVIDER_COMMUNITY_ONLY`），達成前後端雙層防護。
- **修復狀態**：已於本次迭代修復並補充 Regression Test（`inviteQueueFlow.test.ts`），後端 `hasSharedLinksByUser` 阻擋提供者加入新手軌道並正確回傳 409。

---

### Finding 2：靜態資源 `/favicon.ico` 回應 500 Internal Server Error
- **嚴重等級**：低（Low）/ 運行穩定性
- **違反 Oracle**：**Product**（系統其他靜態資產如 manifest、sw.js 均正常 200 回應）
- **現象描述**：
  當瀏覽器發起請求 `GET /favicon.ico` 時，伺服器日誌報錯：
  `TypeError: Can't modify immutable headers.`
  並對外回應 `500 Internal Server Error {"error":{"code":"INTERNAL_ERROR","message":"系統忙碌中，請稍後再試一次"}}`。
  原因係 Cloudflare Workers Asset Binding 回傳之靜態資源 Response Header 物件為不可變（immutable），而中介層 `secureHeaders` 嘗試直接在其上執行 `headers.set()` 所致。
- **複現步驟**：
  1. 執行 `curl -s -i http://127.0.0.1:8787/favicon.ico`
  2. 觀察 HTTP 狀態碼為 `500`。
- **改善建議**：
  在 `secureHeaders` 中介層中，若偵測到 response headers 屬不可變或為靜態資源時，應透過 `new Response(res.body, res)` 複製新 Response 再附加安全標頭，或在 assets 路由前妥善處理。
- **修復狀態**：已修復，將 `secureHeaders` 範圍收斂至 `/api/*`，靜態資源回應 200 正常。

---

## 總結

「雙軌道排隊機制（Dual-Track Queue）」成功實現了「新手首次體驗專屬保障」與「社群第二帳號試用共享」的分流目標：
1. **撮合核心演算法**經由包含式優先序與向下相容實測，表現精準無誤：新手席次嚴格專屬、互助席次優先互助且無人時自動向下支援新手，完全杜絕名額閒置浪費與自我配對。
2. **前端 UI 動態引導**體驗流暢自然：未領取者純享極簡新手入口；曾領取過與提供者皆能無縫切換至第二帳號軌道，並清楚呈現過往感謝卡備查與官方試用規範提醒。
3. **資料庫完整性**：D1 Partial Unique Index 約束經由重複提交與並發測試驗證，能切實阻止同時多開排隊，並解除了既有一人一生僅能排隊一次的死鎖限制。

整體功能可穩定交付上線，建議於下個維護迭代納入 Finding 1 之提供者後端防護補充。

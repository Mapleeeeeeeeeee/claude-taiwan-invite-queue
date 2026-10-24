# QA Report: dual-track-queue

- 測試日期：2026-10-24（本輪執行時間 UTC 09:24 到 10:15，資料庫重置之後）
- 設計文件：`docs/design/dual-track-queue.md`（與母文件衝突時以它為準）、`docs/design/invite-code-queue.md`
- 測試方式：黑箱。API 契約由 Explore agent 掃描取得，我沒有直接讀 `src/`、`tests/`、`docs/arch/`，也沒有讀 `docs/qa/archive/`。
- 測試範圍：L1 到 L4。API 層用 Node 腳本，瀏覽器層用 Chrome。
- 選用 Tours：Money、Antisocial、Rained-Out、Round-Trip、Bad-Neighborhood，另加自由探索（先排隊後分享、雙分頁、`stale-while-revalidate` 量測）。
- 用語：席次（slot，介面稱名額）、排隊紀錄（entry，PM 稱票券）、新手軌（`newbie`）、第二帳號軌（`community`）。檢查點指腳本裡的一次斷言，不等於一個獨立測試案例。

## 1. 結論

- 沒有 P0、P1。有 2 個 FAIL（都是 P2）、3 個 WARN（P3，都標「需確認」）、35 個 INFO 檢查點（第 10 節另有 1 個一次性探測的觀察，O-20）。
- 檢查點共 1028 個通過，其中 API 層 1002 個、瀏覽器層 26 個；另有 2 個 FAIL、3 個 WARN。
- 使用者拍板的 Q1 到 Q7 都驗證過，結果與決定一致（第 3 節）。
- 協調者要求複驗的兩個舊候選問題都已修復：壞 JSON 與空 body 現在回 400 `INVALID_INPUT`，匿名寫入不論 body 一律回 401（第 9 節）。
- 第一個 FAIL 是提供者被封鎖時重複提交已存在的邀請代碼，回 403 `PROVIDER_BLOCKED`，母文件規則 R1-2 要求 409（F-1）。
- 第二個 FAIL 是邀請代碼與推播訂閱端點沒有長度上限，10 MB 的值回 500，3 MB 的代碼被存入資料庫（F-5）。這是母文件舊功能的輸入界線，不在雙軌範圍，但 `POST /api/links` 是雙軌新增 `track` 欄位的端點。
- 全庫 17 項不變式在收尾時全部成立，席次池為空（第 13 節）。
- 本機測不到的部分是正式環境設定、真實推播、Google 登入，這三項的信心是低（第 11 節）。

## 2. Pre-Test Model

- **Roles/Permissions**
  - 訪客：可讀 `GET /api/board`；`GET /api/me` 回 `user:null`；所有寫入回 401。
  - 登入使用者依歷史決定 `isEligibleForNewbieTrack`：H1 純新手、H2 已領過（任一軌道有 `confirmed`）、H3 提供者未領過、H4 提供者且已領過、H5 只有 `cancelled` 或 `expired`、H6 用過 1 次無效重排、H7 只有失敗的提交、H8 連結已是完全無效連結。
  - 被封鎖的提供者：累計 2 組完全無效連結。
  - 沒有管理員角色。端點不帶 id，受保護資源只有自己的排隊紀錄與連結，沒有竄改 id 的攻擊面；跨角色測試用兩個 cookie 各看各的資料。
- **Entities + State Transitions**
  - 席次：`available → reserved(6h) → revealed(30m) → confirmed`；`revealed → invalidated`；`reserved → available`（逾時、取消、放棄）；`available` 或 `reserved → closed`（同連結已有席次被回報無效）。
  - 排隊紀錄：`waiting → reserved → revealed → confirmed`；`waiting` 或 `reserved → cancelled`；`reserved → expired`；`revealed → waiting`（回報無效，優先權 1，軌道不變，終身 1 次）。
  - 本功能讓已領過者能再排隊，同一使用者會有多筆歷史紀錄。
- **Data Variants**：席次軌道乘排隊紀錄軌道；使用者歷史 H1 到 H8；請求 `track`（`newbie`、`community`、省略、非法值）；`slotCount`；感謝小卡（CJK、emoji、ZWJ 序列、前後空白、HTML、SQL 片段）；邀請網址（純連結、`?s=ios`、夾在句子裡、非法網域）。
- **External Dependencies**：Google OAuth（本機以開發登入取代）、Web Push（本機實送，payload 看不到）、D1、Cron（每 5 分鐘，本機手動觸發）、看板記憶體快取 15 秒、`totalConfirmedCount` 獨立快取 10 分鐘、瀏覽器 HTTP 快取。
- **Invariants**
  - I1：同一使用者同時最多 1 筆進行中紀錄，不論軌道。
  - I2：新手席次從不分給第二帳號軌的排隊紀錄。
  - I3：席次從不分給它的提供者本人。
  - I4：一個席次最多被 1 筆紀錄持有。
  - I5：排隊紀錄的 `track` 建立後不變。
  - I6：有 `confirmed` 紀錄或分享過連結的人，`isEligibleForNewbieTrack` 為 false。
  - I7：`invalidRetryCount` 不超過 1，且跨軌道終身計算。
  - I8：邀請網址在 `revealed` 之前不出現在任何回應。
  - I9：`newbieSlotsCount + communitySlotsCount = availableSlotsCount`，`newbieQueueCount + communityQueueCount = waitingQueueCount`。
  - I10：同連結有席次被回報無效後，其餘席次不再發出，包括之後才釋出的席次。
- **Top Risks**：撮合引擎（兩軌乘降級、防自我配對、優先權）；資格判定與同一使用者多筆紀錄；席次連動（逾時不對稱、sibling closure、違規計數時機）；並發；順位與看板一致性；UI 防呆；壞輸入與安全。
- **Chosen Tours**：見上方。
- **Coverage Gaps（Phase 1b）**：結案狀態見第 9 節。
- **Anchoring 警示**：斷言只用 HTTP 狀態碼與使用者可見語意。只有 PM 點名的 code 才斷言字串：`NEWBIE_TRACK_ONLY`、`ALREADY_IN_QUEUE`、`INVALID_STATE_TRANSITION`、`QUEUE_ENTRY_NOT_FOUND`，以及協調者指定的 `INVALID_INPUT`。Explore 的狀態表與檢查順序一律當假設，不當 expected。

## 3. 使用者拍板決定（PM 補充）與驗證結果

| 項目 | 決定 | 驗證證據 | 結果 |
|---|---|---|---|
| Q1 | 省略 `track` 時依新手資格自動分軌；帶 `newbie` 但不具資格仍 409 | E-03b（具資格排 newbie）、E-06b（已領過排 community）、E-10b（提供者排 community）、E-12d（H4 排 community）；E-04b、E-08a、E-11b（明確帶 newbie 仍 409） | 符合 |
| Q2 | 同時領過又分享過：409 `NEWBIE_TRACK_ONLY`，一句合併訊息，起首沿用領取過的句子；單一原因訊息不變 | E-11c、E-11d、E-11e、E-13e、UI-17；E-04c 到 E-04e、E-08b、E-08c（單一原因） | 符合 |
| Q3 | 新手票先拿新手席次，沒有才降級拿第二帳號席次，同軌取最舊 | J-05a 到 J-05g、M-07、J-02、UI-21 | 符合 |
| Q4 | 先排新手隊、之後才分享連結者，新手票仍可被配對 | F-01a、F-01b | 符合，記為 INFO |
| Q5 | `queuePosition` 是跨軌合併順位 | P-01（`[1,2,3,4]`）、P-05a（`[2,1,3]`）、P-05b | 符合，記為 INFO |
| Q6 | 感謝小卡以 Unicode 碼點計、trim 後計算，200 個 emoji 可送、201 個回 422，前端與 API 一致 | B2-card（31 個檢查點）、28 與 29 個 ZWJ 家庭 emoji、UI-09 | 符合 |
| Q7 | `revealed` 時再解鎖、`confirmed` 時再確認，冪等 200，不重複推播或重複上牆 | ST-reveal@revealed-Q7、ST-confirm@confirmed-Q7a/Q7b、X-16、X-17、UI-16 | 符合 |

## 4. BBT 設計產物與結果

下表的 N 代表新手軌排隊紀錄，C 代表第二帳號軌排隊紀錄，依加入順序列出。`(own)` 表示提供者本人的紀錄，P1 表示優先權 1，ITS 表示 `INVALID_STATE_TRANSITION`。結果欄的 ID 是腳本裡的檢查點編號。

### 4.1 資格決策表（AC2，決策表）

| 歷史＼請求 track | newbie | community | 省略（Q1） |
|---|---|---|---|
| H1 純新手 | 201，軌道 newbie（E-01b、E-01c） | 201，軌道 community（E-02a、E-02b） | 201，newbie（E-03a、E-03b） |
| H2 已領過 | 409 `NEWBIE_TRACK_ONLY`，訊息起首「你已成功領取過新手體驗名額囉！」（E-04b 到 E-04e） | 201，可重複多輪，沒有 `ALREADY_CLAIMED`（E-05a、F-02a、F-02b） | 201，community（E-06a、E-06b） |
| H3 提供者未領過 | 409，訊息起首「感謝你熱心分享邀請碼！」（E-08a 到 E-08c） | 201，自己的席次不配給自己（E-09a、E-09b） | 201，community（E-10a、E-10b） |
| H4 提供者且已領過 | 409，合併訊息（E-11b 到 E-11e、E-13d、E-13e） | 201（E-12a、E-12b） | 201，community（E-12d） |
| H5 只有 cancelled 或 expired | 201，資格保留（E-14b、E-14e、T-09a） | 201 | 201 |
| H6 用過無效重排、現無進行中 | 201（E-17f） | 201 | 201 |
| H7 只有失敗的提交 | 201（E-18e） | 201 | 201 |
| H8 連結是完全無效連結 | 409（E-19c） | 201 | 201 |

補充格：

| ID | 情境 | 結果 |
|---|---|---|
| E-15、E-16 | 進行中紀錄為 waiting、reserved、revealed，請求 newbie、community、省略 | 全部 409 `ALREADY_IN_QUEUE`，且先於新手資格檢查（E-16 系列，PM 第 58 行） |
| E-04f、E-04g | 只在 community 軌確認過的使用者請求 newbie | 資格消失，409 |
| E-20 | 純新手解鎖滿 30 分鐘被自動確認 | `isEligibleForNewbieTrack` 變 false，再排 newbie 回 409（E-20b、E-20c） |
| E-21 | 純新手分享連結 | 資格變 false，`hasSharedLinks` 為 true |
| E-22 | confirmed、cancelled、expired 各一，加 1 筆進行中 | `myQueue`、`queuePosition`、取消都對準進行中那筆，`myConfirmedClaim` 仍在（E-22a 到 E-22d） |
| E-23 | 進行中或已領過，加不合格小卡 | 422 先於 409（INFO，PM 沒寫） |

### 4.2 撮合決策表（AC3，決策表）

| ID | 新增席次 | 等候中（加入順序） | 預期 | 結果 |
|---|---|---|---|---|
| M-01 | newbie×1 | N1, N2 | N1 得到 | PASS |
| M-02 | newbie×1 | C1 | 無人得到，席次維持 available | PASS |
| M-03 | newbie×1 | C1, N1 | N1 得到 | PASS |
| M-04 | newbie×1 | N1(own) | 無人得到 | PASS |
| M-05 | newbie×1 | N1(own), N2 | N2 得到 | PASS |
| M-06 | community×1 | C1, C2 | C1 得到 | PASS |
| M-07 | community×1 | N1 | N1 降級得到，軌道仍是 newbie | PASS |
| M-08 | community×1 | N1, C1 | C1 得到，N1 雖然較早 | PASS |
| M-09 | community×1 | N1(P1), C1 | C1 得到，優先權只在同軌道生效 | PASS |
| M-10 | community×1 | C1(own) | 無人得到 | PASS |
| M-11 | community×1 | C1(own), N1 | N1 降級得到 | PASS |
| M-12 | community×1 | C1(own), C2, N1 | C2 得到 | PASS |
| M-13 | community×3 | N1, C1 | 兩人各得 1 個，剩 1 個 available | PASS |
| M-14 | newbie×3 | N1, C1, N2, C2 | N1、N2 得到，C1、C2 等候，剩 1 個 | PASS |
| M-15 | community×2 | N1, N2, C1 | C1 與 N1 得到，N2 等候 | PASS |
| M-16 | community×1 | C1, C2(P1) | C2(P1) 得到 | PASS |
| M-17 | newbie×1 | N1, N2(P1) | N2(P1) 得到 | PASS |
| M-18 | community×1 | N1(own) | 無人得到，降級路徑也排除自己 | PASS |
| M-19 | community×2 | N1(own), N2 | N2 得到，剩 1 個 | PASS |

排隊時池中已有席次（J）與釋出後重新撮合（R）：

| ID | 情境 | 結果 |
|---|---|---|
| J-01 | 池有 newbie，newbie 加入 | 201 `reserved` |
| J-02 | 池只有 community，newbie 加入 | 201 `reserved`，降級，軌道仍是 newbie |
| J-03 | 池只有 newbie，community 加入 | 201 `waiting`，newbie 席次不動 |
| J-04 | 池有兩種，community 加入 | 拿 community 席次，newbie 席次不動 |
| J-05 | 較舊的 community 與較新的 newbie，newbie 加入（Q3） | N 拿較新的 newbie 席次，之後 C 拿較舊的 community 席次；同軌取最舊；兩個 newbie 席次依序先舊後新；沒有 newbie 席次才降級 |
| J-06 | 只有自己提供的席次 | 201 `waiting`，自己的席次維持 available；其他提供者的席次可以拿 |
| J-07 | 池有 community，community 加入 | 201 `reserved` |
| R-01 | community 席次釋出，等候 N1, C2 | C2 得到 |
| R-02 | newbie 席次釋出，等候 C1, N2 | N2 得到 |
| R-03 | 回報無效後重排 | 池有相容席次就立即 `reserved`，沒有就 `waiting`；community 重排不拿 newbie 席次 |

### 4.3 狀態轉移（狀態轉移圖，合法與非法）

動作乘排隊紀錄狀態，每格都執行並確認「被拒絕的動作不改變狀態」：

| 動作＼狀態 | 無 | waiting | reserved | revealed | confirmed | expired | cancelled |
|---|---|---|---|---|---|---|---|
| cancel | 404 `QUEUE_ENTRY_NOT_FOUND` | 200 | 200，席次釋出 | 409 ITS | 409 ITS | 409 ITS | 409 ITS |
| reveal | 404 | 409 | 200，回網址，期限 1800 秒 | 200，同網址同期限（Q7） | 409 ITS（PM 沒寫） | 409 `RESERVATION_EXPIRED` | 409 |
| confirm | 404 | 409 | 409 | 200，感謝牆恰好 1 張，提供者看到 confirmed | 200，時間不變，牆上不重複（Q7） | 409 | 409 |
| report-invalid | 404 | 409 | 409 | 200，回 waiting、優先權 1、原軌道、重排用掉 1 次、席次 invalidated | 409 | 409 | 409 |
| POST queue | 201 | 409 `ALREADY_IN_QUEUE` | 409 | 409 | newbie 409、community 201 | 201 | 201 |

席次的非法轉移用間接方式確認：`revealed` 時取消得 409 且席次維持 `revealed`（C-03）；`confirmed` 時回報無效得 409；`closed` 與 `invalidated` 的席次從未被重新配對（L-02c、P-02b1、全庫不變式）。

### 4.4 連結連動與提供者違規（決策表加狀態圖）

| ID | 情境 | 結果 |
|---|---|---|
| L-01 | 3 席次，A 解鎖後回報無效，B 持有 s2，s3 available | s1 invalidated、s3 closed、s2 仍 reserved，B 還能解鎖；A 回到 waiting，優先權 1，原軌道（newbie 與 community 各跑一次）；strike 此時仍是 0 |
| L-02 | 接 L-01，B 取消 | s2 變 closed，不是 available；等候的 A 沒有拿到它；最後一個席次結束後 strike 變 1（L-05a） |
| L-03 | 接 L-01，B 的保留逾時 | 另一位使用者的 `GET /api/me` 觸發逾時，s2 變 closed；strike 變 1（L-05b） |
| L-04 | 接 L-01，B 解鎖並確認 | 連結有 1 筆確認，不算完全無效，strike 維持 0 |
| L-07 | 接 L-01，B 也回報無效 | B 的重排額度還沒用過，200；strike 變 1 |
| L-08 | 沒有 invalidated 的連結，B 取消 | 席次回 available |
| L-09 | 只有 A 在排，3 席次配出 1 個；A 回報無效 | #2、#3 closed；下一個提供者的席次先給重排的 A，不給較早加入的旁人；第二組席次的重排額度已用完 |
| AC10 | 2 人成功、第 3 人回報無效 | 不算完全無效連結，提供者仍能提交（201） |
| L-06 | 累計 2 組完全無效連結後再提交 | 403 `PROVIDER_BLOCKED`（newbie、community、省略 track 各一），訊息與 R1-3 逐字相同；被封鎖者仍可當領取者排隊（201，community）；**但被封鎖者送出已存在的代碼回 403，PM 要求 409（FAIL，見 F-1）**；被封鎖者送非法網址回 400，符合 R1-4 |

### 4.5 逾時（AC6，邊界值分析，±1 分鐘）

| ID | 情境 | 結果 |
|---|---|---|
| AC6-6h | 保留期限 | 配對後 6.0000 小時 |
| T-01 | 到期前 1 分鐘解鎖 | 200，有網址 |
| T-02 | 到期後 1 分鐘解鎖 | 409 `RESERVATION_EXPIRED`，回應沒有網址；A 變 expired，較舊的 B 拿到席次，C 仍在等 |
| T-03 | 逾時處理的 8 種觸發 | cron、登入的 `GET /api/me`、快取過期的 `GET /api/board`、寫入 API（加入排隊、分享、取消、解鎖、回報無效）都會讓逾時的 A 變 expired 並把席次轉給 B（用 SQL SELECT 確認觸發前尚未處理） |
| T-04 | 解鎖滿 30 分鐘前 1 分鐘回報無效 | 200 |
| T-05 | 滿 30 分鐘後 1 分鐘回報無效 | 409，紀錄已被自動確認，重排額度沒動，提供者看到 confirmed |
| T-06 | 滿 30 分鐘後、尚未被掃描時呼叫 confirm | 200（PM 第 99 行：confirm 不先處理逾時），牆上 1 張卡，再確認一次仍是 200 |
| T-07 | 自動確認的 8 種觸發 | 全部轉 confirmed，感謝牆數毫秒內出現卡片，提供者看到領取者暱稱與小卡 |
| T-09 | expired 後重排 | 201，排在隊尾 |
| T-10 | cron 在 +5h55m、+6h01m、+29m、+31m | 5h55m 不動，6h01m 逾時並轉配，29m 不動，31m 自動確認 |

### 4.6 回報無效、取消、順位

| ID | 情境 | 結果 |
|---|---|---|
| I-01、I-02 | newbie 與 community 紀錄回報無效 | 回 waiting（或立即 reserved），優先權旗標為 true，軌道不變 |
| I-03 | 降級配到 community 席次的 newbie 紀錄回報無效 | 軌道仍是 newbie；席次 invalidated，同連結其餘席次 closed |
| I-04 | 同帳號第二次回報 | 409；紀錄、額度、席次都不變；第二次解鎖時按鈕停用 |
| I-05 | 在 newbie 軌用掉重排，之後 community 紀錄回報 | 409（終身，跨軌） |
| C-01 到 C-06 | 取消 waiting、reserved、revealed；有 confirmed 又有新 waiting 時取消；平行取消 | 取消的是進行中那筆；revealed 取消 409；平行取消恰好 1 個 200 |
| P-01 | 依序加入 N1, C1, N2, C2 | `queuePosition` 為 1、2、3、4（AC9，跨軌合併） |
| P-02 | 優先權 1 的紀錄 | 順位 1（不論軌道） |
| P-03、P-04 | 非 waiting 的紀錄；隊首或中間取消 | 順位為 null；其餘各前移 1 |
| P-05 | 新手隊首、community 紀錄拿走 community 席次 | 新手維持順位 1 且仍 waiting（Q5，INFO） |

### 4.7 等價分割與邊界值（EP、BVA）

| 欄位 | 取值 | 結果 |
|---|---|---|
| `thankYouMessage`，CJK | 4、5、200、201 字 | 422、201、201、422 |
| 同上，空白 | 5 個空白、空白加 4 字、空白加 5 字、200 字加空白、201 字加空白 | 422、422、201、201、422；儲存的是 trim 後的值 |
| 同上，emoji | 4、5、100、101、200、201 個；100 CJK 加 100 或 101 個 emoji | 422、201、201、201、201、422；201（共 200）、422（共 201） |
| 同上，ZWJ 家庭 emoji | 28 組（196 碼點）、29 組（203 碼點） | 201、422，與碼點計數一致 |
| 同上，其他 | 缺欄位、null、數字、陣列、物件；1 萬、10 萬、100 萬字；HTML、SQL 片段 | 422（100 萬字 43 毫秒）；HTML、SQL 以純文字保存 |
| `slotCount` | 0、1、2、3、4、-1、`"3"`、2.5、null、10 億、省略 | 422、201、201、201、422、422、422、422、422、422、201（3 個） |
| `track` | `""`、`NEWBIE`、`Community`、`foo`、null、1、陣列、物件、true、` newbie`、SQL 片段（links 與 queue 各一） | 全部 422，且沒有建立連結或紀錄、資格不變 |
| `nickname` | 1、50、51 字、空、全空白、emoji、HTML | 201、201、422、422、422、201、201；失敗的請求不改暱稱，成功的分享才更新 |
| `rawUrlInput` | 純連結、`?s=ios`、夾在句子、大小寫、`http://`、`www.`、子網域 | 201，正規化為 `https://claude.ai/referral/<code>` |
| 同上，非法 | `claude.com`、`evilclaude.ai`、userinfo 手法、錯誤路徑、空代碼、純 CJK 代碼、空字串、無網址 | 400，訊息逐字符合 R1-4；沒有建立任何東西 |
| 同上，重複 | 同代碼換 track、換提供者、帶或不帶參數 | 409，訊息「這組邀請連結已經被分享過囉」 |
| 同上，過大 | 代碼 1.5 MB、3 MB、10 MB；10 MB 文字後接正常連結；小卡與暱稱各 10 MB；推播訂閱的 endpoint 10 MB | 201、201、500；201；422；500（見 F-5） |
| 小卡，特殊字元 | 孤立代理字元、NUL、雙向覆寫字元、結尾 ZWJ、5 個零寬空白、5 個組合記號、含 tab 與換行 | 全部 201，沒有 5xx；孤立代理字元被替換成 U+FFFD；5 個零寬空白與 5 個組合記號通過 5 字下限（O-20） |
| 壞 body | 壞 JSON、空 body、截斷 JSON（兩支寫入 API 各一） | 400 `INVALID_INPUT` |
| 其他 body 形狀 | JSON null、陣列、字串、數字；`text/plain`、表單、無 content-type | 4xx，不是 5xx；帶 charset 的合法 JSON 照常處理 |
| 匿名寫入 | 以上 11 種 body 加合法與不合法 body，兩支寫入 API 各一；4 支動作端點；2 支推播端點 | 全部 401 `UNAUTHORIZED` |

### 4.8 看板（AC4）

| ID | 情境 | 結果 |
|---|---|---|
| B-01 | 回傳的欄位與型別 | 7 個計數加感謝牆；皆為非負整數；牆最多 30 張，新到舊 |
| B-02 到 B-04 | 分享 community×3、newbie×2；排隊；取消；回報無效後 sibling 關閉 | 計數隨狀態變動；reserved 不計入 available 或 waiting；每次讀取都滿足 I9 的兩個加總 |
| B-05 | 確認後 `totalConfirmedCount` | 感謝牆立即有卡（B-05a）；累計數在確認後 441 秒追上資料庫（B-05b，上限 600 秒） |
| B-06 | 感謝牆內容 | 領取者暱稱、提供者暱稱、感謝內容、確認時間；確認後立即出現且是最新一張 |
| BOARD-TTL | 以 SQL 改資料（不經過 API，不清快取）後，看板多久才反映 | 15.4 秒與 15.5 秒（兩輪），與 PM 的 15 秒一致 |

### 4.9 瀏覽器（AC5 與 Journey）

見第 7 節的表。

### 4.10 安全與並發（L3、L4）

| ID | 情境 | 結果 |
|---|---|---|
| X-01 | 匿名呼叫 | `GET /api/me` 回 200，無使用者、無排隊、無領取、無分享；寫入回 401 |
| X-02、X-03 | 夾帶 `priority`、`status`、`userId`、`slotId`、`totalSlots`、`providerUserId` | 欄位被忽略；紀錄屬於呼叫者；連結只有 1 個席次且狀態正常 |
| X-04 | 邀請網址曝光面 | 解鎖前不出現在看板、訪客的 me、他人的 me、自己的 me；解鎖後只在自己的 `myQueue.referralUrl`（21 個檢查點） |
| X-05、X-07 | 兩個 cookie 互不影響；亂碼 cookie | 提供者看不到領取者的小卡直到確認；亂碼 cookie 視為訪客，寫入 401 |
| X-08、X-09 | 同一使用者平行送 5 次、混合軌道送 6 次 | 恰好 1 個 201，其餘 409，資料庫只有 1 筆進行中紀錄 |
| X-10 | 20 位領取者搶 3 個席次 | 3 位得到；沒有 newbie 紀錄在較早的 community 紀錄還在等時拿走 community 席次 |
| X-11 | 5 位提供者送同一代碼 | 1 個 201、4 個 409，沒有 5xx，連結只有 1 筆 |
| X-16 到 X-19 | 平行解鎖、確認、回報無效、取消各 5 次 | 解鎖與確認全部 200（Q7）；回報恰好 1 個 200；取消恰好 1 個 200 |
| X-20 到 X-24 | 取消對解鎖、解鎖對逾時掃描、確認對掃描 | 40 次中沒有一次讓取消與解鎖都成功（取消贏 39 次，解鎖贏 1 次）；逾時的解鎖不會回網址；確認對掃描總是 confirmed 且牆上 1 張 |
| X-27 | 40 筆寫入同時讀看板 470 次 | 看板內部一致 |
| X-15 | 登出 | cookie 被清除；但舊 cookie 值在到期前仍有效（INFO） |
| B4 | 標頭 | session cookie 為 HttpOnly、SameSite=Lax、Path=/；跨來源預檢未被允許；`x-content-type-options` 存在；`GET /api/me` 沒有 `Cache-Control`（WARN，F-2） |
| PUSH | 訂閱驗證；推播送不出去時 | 訂閱端點對缺欄位、http 端點回 422；推播失敗不影響配對、確認、感謝牆，訂閱不被刪除（暫時性失敗） |

### 4.11 自由探索

| ID | 情境 | 結果 |
|---|---|---|
| F-01 | 新手先排隊，再分享連結 | 資格變 false，原本的新手票仍被配到他人的新手席次（Q4，INFO） |
| F-02 | Round-Trip：領取、第二帳號排隊、取消、再排隊、再領取 | `myQueue`、`myConfirmedClaim`、`mySharedLinks` 一致 |
| F-03 | 降級配到 community 席次的新手紀錄回報無效後，下一個 community 席次出現 | 在等的 C 得到，新手紀錄維持 waiting |
| X-25、X-26 | 60 組加入與取消；提供者排 community | 全部成功；提供者不拿自己的席次 |
| G9 | 瀏覽器看板落後量測 | 見 F-3 |

## 5. 風險排序（Step 3）

| 排序 | 區域 | 機率 | 影響 | 層級 | 結果 |
|---|---|---|---|---|---|
| 1 | 撮合引擎（M、J、R） | 高 | 高，錯一格就破壞新手保護 | L1 到 L3 | 全 PASS |
| 2 | 資格判定與多筆歷史（E） | 高 | 高 | L1 到 L3 | 全 PASS |
| 3 | 連結連動、逾時不對稱、狀態矩陣（L、T、ST） | 高 | 高，資料與名額損失 | L1 到 L3 | 1 個 FAIL（F-1） |
| 4 | 並發（X-08 到 X-27） | 中 | 高 | L3、L4 | 全 PASS |
| 5 | 順位與看板一致性（P、B） | 中 | 中 | L1、L2 | PASS，1 個 WARN（F-3） |
| 6 | UI 防呆與提示（AC5） | 中 | 中 | L1、L2 | PASS，1 個 WARN（F-4） |
| 7 | 壞輸入與安全（EP、BVA、X） | 中 | 中 | L1 到 L4 | PASS，1 個 FAIL（F-5），1 個 WARN（F-2） |

高風險項目（1 到 4）都跑了 L1 加 L2 加 L3；低風險項目只跑 L1 或 L2。

## 6. AC 驗收

### 6.1 雙軌道文件 `dual-track-queue.md`

| AC | 狀態 | 證據 |
|---|---|---|
| AC1：未指定 track 時預設 `newbie`；指定 `community` 時席次皆為 `community` | PASS | A-01b（省略時 2 個席次皆 newbie）、A-01c（省略 `slotCount` 為 3 個）、A-03（slotCount 1、2、3 乘兩軌共 6 格，席次數與軌道都對）、UI-12 |
| AC2：已領過或分享過者請求 newbie 回 409 `NEWBIE_TRACK_ONLY`；請求 community 回 201，不再有 `ALREADY_CLAIMED`；純新手可直接呼叫 community；進行中者回 409 `ALREADY_IN_QUEUE` | PASS | 第 4.1 節整張表 |
| AC3：newbie 席次不給 community；community 席次先給 community、沒有才給 newbie；兩軌防自我配對 | PASS | 第 4.2 節 M-01 到 M-19、J、R；全庫不變式 I2、I3 無違反列 |
| AC4：看板七個計數、兩軌拆分、15 秒快取、`totalConfirmedCount` 10 分鐘快取、感謝牆立即更新 | PASS（附 WARN） | 計數與拆分 B-01 到 B-04、UI-19；伺服器 15 秒 BOARD-TTL；10 分鐘 B-05b（441 秒）；牆立即更新 B-05a、B-06。瀏覽器可見的落後超過 15 秒，見 F-3 |
| AC5：已領過者與提供者的表單自動切第二帳號並顯示提示；純新手沒有軌道選項 | PASS | UI-01a（純新手：無橫幅、無單選）、UI-08（已領過）、UI-14（提供者未領過）、UI-17（同時兩者，雙分頁） |
| AC6：reserved 滿 6 小時變 expired；revealed 滿 30 分鐘變 confirmed；不必等使用者操作 | PASS | 第 4.5 節；T-03 與 T-07 各 8 種觸發 |
| AC7：回報無效後回 waiting、優先權 1、軌道不變；同帳號第二次 409 | PASS | ST-report-invalid@revealed-more、I-01 到 I-05、UI-06、UI-07 |
| AC8：waiting 與 reserved 可取消，取消 reserved 釋出席次並重新撮合；其他狀態 409 `INVALID_STATE_TRANSITION` | PASS | 第 4.3 節；R-01、R-02、UI-10、UI-18 |
| AC9：`queuePosition` 是跨軌合併的 FIFO 順位，含優先權 | PASS | P-01（`[1,2,3,4]`）、P-02、P-05a（`[2,1,3]`）、UI-02a |

### 6.2 母文件 `invite-code-queue.md`（回歸）

| AC | 狀態 | 證據 |
|---|---|---|
| AC1：貼上含 `?s=ios` 的文字，正規化、3 個名額、重複代碼被拒 | PASS | A-04a 到 A-04d、A-01c、UI-12（`?s=ios` 與前後文字被去除，只留代碼 `QAuiShareA1`） |
| AC2：自訂剩餘次數 | PASS | A-03、UI-12（選 1 次得 1 個席次） |
| AC3：2 人排隊，提供者提交 3 個名額，A、B 依序獲配，第 3 個維持可用，並發推播 | PASS（推播未驗） | 3 席次配出 2 個、剩 1 個 available（L-01 前置、M-13）。推播 payload 本機看不到；只驗證了推播失敗不影響流程（PUSH-3） |
| AC4：池中有碼時排隊即刻獲配（非本人提供） | PASS | J-01、J-02、J-07、J-06、UI-17、UI-21 |
| AC5：6 小時未解鎖逾時回收並轉配 | PASS | T-02、T-03 |
| AC6：解鎖後確認啟用，感謝牆顯示小卡，提供者收到小卡 | PASS（推播未驗） | ST-confirm@revealed（牆上恰好 1 張，提供者看到領取者暱稱與小卡）、UI-08、UI-16 |
| AC7：解鎖滿 30 分鐘自動確認並上牆 | PASS | T-07 的 8 種觸發 |
| AC8：回報無效、優先重排、連動停用剩餘席次 | PASS | L-01、L-09、I-03、UI-05、UI-06 |
| AC9：終身 1 次無效重排，按鈕停用 | PASS | I-04c、UI-07（按鈕「已用完無效重排額度（限 1 次）」停用）。第二句「確認啟用後不能再排隊」已被雙軌文件取代：newbie 軌 409、community 軌可排（E-04b、E-05a） |
| AC10：提供者違規門檻與好心人保護 | PASS | AC10a 到 AC10d、L-06 |
| 規則 R1-1（正常提交） | PASS | A-04a |
| 規則 R1-2（代碼已存在：409 重複） | FAIL（被封鎖者） | 未被封鎖者 PASS（A-04c、A-04d）；被封鎖者回 403，見 F-1 |
| 規則 R1-3（被封鎖：拒絕並提示暫停） | PASS | L-06b、L-06c、UI-20 |
| 規則 R1-4（格式錯誤：提示格式） | PASS | A-04e0 到 A-04e4、L-06e |

## 7. Journey 驗證與瀏覽器結果

| Journey | 狀態 | 證據 |
|---|---|---|
| 雙軌 Journey 1：提供者指定受眾並發布 | PASS | UI-12（兩個受眾選項、預設限新手、次數 3 預設、提交後新連結帶「第二帳號試用」標籤、表單重置）、UI-13、A 系列 |
| 雙軌 Journey 2：純新手單一表單排隊 | PASS | UI-01a、UI-02a、UI-03、UI-04、UI-08（排隊、配對、解鎖、確認的完整流程） |
| 雙軌 Journey 3：已領過者為第二帳號排隊 | PASS | UI-08（確認後表單自動切換並顯示 PM 橫幅）、UI-09、UI-10、UI-17、F-02 |
| 母文件：領取、無效重排、再領取 | PASS | UI-05、UI-06、UI-07、UI-08（回報無效、優先重排、第二組席次按鈕停用、確認） |
| 母文件：保留逾時、重新排隊 | PASS | UI-21 |
| 雙分頁與狀態衝突 | PASS | UI-17、UI-25 |
| 被封鎖提供者 | PASS | UI-20 |

瀏覽器檢查點（Chrome 桌面，真實點擊為主；填字用頁面內 JS 設值並觸發 input 事件，手機寬度在同源 iframe 內以 JS 點擊）：

| ID | 驗證內容 | 結果 |
|---|---|---|
| UI-01a | 純新手表單：無橫幅、無軌道單選、按鈕「加入排隊領取邀請連結」，看板總數與 API 相同 | PASS |
| UI-02a | 輸入小卡、計數「12 / 200」、送出後顯示「排隊成功！你目前在第 1 順位」 | PASS |
| UI-03 | reserved 卡片：6 小時倒數、解鎖前沒有網址、兩個按鈕 | PASS |
| UI-04 | 解鎖：toast「已解鎖邀請連結！請於 30 分鐘內前往使用並確認啟用」、顯示網址、30 分鐘倒數 | PASS |
| UI-05 | 回報無效的確認對話框，「返回再試一次」關閉且狀態不變 | PASS |
| UI-05b | 對話框文字比 PM 第 176 行長，但涵蓋 PM 的句子 | INFO |
| UI-06 | 確認回報：toast「已為你優先排回隊伍最前面（剩餘重排機會 0 次），將優先為你配對下一組」，小卡保留 | PASS |
| UI-07 | 第二組席次的回報按鈕停用，文字「已用完無效重排額度（限 1 次）」 | PASS |
| UI-08 | 確認：toast「感謝小卡已送達提供者！」；之後表單自動切第二帳號並顯示 PM 橫幅 | PASS |
| UI-09 | 計數器以碼點計：200 個 emoji 顯示 200 / 200 可送；201 個顯示「201 / 200（已超過 1 字）」並停用送出；4 個 emoji 被擋、5 個 emoji 通過；trim 後計數 | PASS |
| UI-10 | 取消排隊：toast「已取消排隊」，回到表單 | PASS |
| UI-11 | 暱稱 `<img onerror>` 與小卡 `<script>` 以純文字顯示，`window.__xss` 為 undefined，輪播的重複節點是 aria-hidden | PASS |
| UI-12 | 提供者表單與分享紀錄 | PASS |
| UI-13 | 重複連結與非 Claude 連結的訊息逐字符合 PM，沒有建立任何東西 | PASS |
| UI-14 | 分享過但沒領過的使用者看到第二帳號橫幅與按鈕（AC5 第 2 點） | PASS |
| UI-15 | 看板在瀏覽器可能比 15 秒更舊 | WARN（F-3） |
| UI-16 | 連點解鎖與確認各只送 1 個請求，沒有錯誤；解鎖後重新整理倒數續算（29:45）；啟用連結為 `target=_blank` 加 `rel="noopener noreferrer"` | PASS |
| UI-17 | 過期的新手表單送出：內嵌訊息為 Q2 的合併句；表單切到第二帳號並保留已輸入的小卡；再送出配到別的提供者的席次，不是自己的連結 | PASS |
| UI-18 | 放棄保留：toast「已取消排隊」，席次回到池中 | PASS |
| UI-19 | 看板顯示「可用席次 N 席：新手 a · 第二帳號試用 b」與「排隊中 M 人：新手 c · 第二帳號試用 d」，與 API 相同 | PASS |
| UI-20 | 被封鎖的提供者看到 R1-3 的句子，沒有分享表單，歷史紀錄仍列出 | PASS |
| UI-21 | 保留逾時提示「名額保留已逾時，已讓給下一位版友。可重新填寫小卡加入排隊！」；重新排隊；新手紀錄在有 newbie 席次時拿 newbie 席次，只有 community 席次時拿最舊的那個 | PASS |
| UI-22 | 390 px 寬（同源 iframe）：看板、reserved 卡、revealed 卡、分享分頁都沒有橫向捲動；173 字元的網址換行不超出卡片 | PASS |
| UI-23 | 登出：toast「已登出帳號」，顯示 Google 登入按鈕，看板與感謝牆仍可見 | PASS |
| UI-24 | service worker 已註冊但 Cache Storage 為空，沒有快取 API 資料；manifest 回 200 | PASS |
| UI-25 | 雙分頁：另一個 session 取消保留後，過期分頁按解鎖，顯示「目前沒有可解鎖的保留名額」，畫面回到表單並保留小卡 | PASS |
| UI-26 | 兩個說明浮窗都沒有說明兩條軌道 | INFO |
| UI-27 | 連點加入排隊只送 1 個 POST；重新載入、加入、放棄的過程中主控台沒有訊息 | PASS |
| UI-28 | 分享表單的錯誤提示位置與母文件不同 | WARN（F-4） |
| UI-29 | 訪客在分享分頁：表單可見，送出鈕「使用 Google 帳號登入並分享」，空狀態提示符合 PM | PASS |
| UI-30 | 推播區塊的文案與母文件不同 | INFO |

## 8. 發現的問題

### F-1（P2，FAIL）提供者被封鎖時，重複提交已存在的邀請代碼回 403，PM 要求 409

重現步驟（API，已在兩個獨立腳本重現，最後一次是 2026-10-24 10:05Z）：

1. 提供者 P 登入，連續兩次分享單名額連結；每次都由另一位領取者排隊、解鎖、回報無效、取消。結束後 `GET /api/me` 顯示 `invalidLinkStrikeCount: 2`、`isProviderBlocked: true`。
2. 另一位提供者 O 分享代碼 OTH，回 `201 {"data":{"linkId":345,"matchedCount":0}}`。
3. P 呼叫 `POST /api/links`，`rawUrlInput` 帶 O 的代碼，或 P 自己先前分享過的代碼。

預期行為是 `409 DUPLICATE_REFERRAL_CODE`，訊息「這組邀請連結已經被分享過囉」，依據是母文件規則 R1-2（代碼已存在、是否被封鎖任意、格式正確）。

實際行為如下。

```
POST /api/links  (P 帶 O 的代碼)
-> HTTP 403 {"error":{"code":"PROVIDER_BLOCKED","message":"由於先前提供的連結多次被回報無效，目前已暫停提供權限"}}
POST /api/links  (P 帶自己先前分享過的代碼)
-> HTTP 403，同上
POST /api/links  (未被封鎖的使用者，帶 O 的代碼，對照組)
-> HTTP 409 {"error":{"code":"DUPLICATE_REFERRAL_CODE","message":"這組邀請連結已經被分享過囉"}}
```

被封鎖者帶全新代碼回 403（R1-3），帶非法網址回 400（R1-4），這兩格符合 PM。從回應推斷，實作的檢查順序是格式、封鎖、重複，PM 的順序是格式、重複、封鎖。

違反的 oracle 是 Claims，條件欄是母文件規則 R1-2 與 R1-3。

影響範圍很小。只有被封鎖的提供者直接呼叫 API 時看得到，送出仍被拒絕，沒有資料被寫入；介面對被封鎖者直接隱藏表單（UI-20），一般使用者碰不到。現行順序還有一個副作用，就是被封鎖者無法用重複提交探測哪些代碼已存在。建議由 PM 決定要改實作順序，還是把母文件的 R1 表改成封鎖先於重複。

### F-2（P3，WARN，需確認）`GET /api/me` 沒有 `Cache-Control`

`GET /api/me` 的回應沒有 `Cache-Control` 標頭（B4-me-cache）。這個回應含電子郵件、排隊狀態，以及解鎖後的邀請網址（`referralUrl`）。同一個伺服器的 `GET /api/board` 標頭是 `public, max-age=15, stale-while-revalidate=30`。

預期行為是含個人資料的回應標 `private` 或 `no-store`，違反的 oracle 是 Standards。

我沒有實測任何中間快取（CDN、公司代理）是否會存放這個回應，所以標 WARN，請團隊確認。依一般行為推斷，瀏覽器在沒有驗證標頭時不會自行快取，Cloudflare 預設也不快取這種動態 JSON，影響應該很小，這個推斷未實測。

### F-3（P3，WARN，需確認）看板在瀏覽器上看到的資料可能比 PM 寫的 15 秒更舊

重現過程如下（UI-15 與 BOARD-TTL，同一天）。

| 時間（UTC） | 動作 | 看板顯示 |
|---|---|---|
| 09:54:51 | 載入頁面 | 可用席次 0 |
| 09:54:53 | 另一位提供者分享 1 個 community 席次（寫入會清伺服器快取） | |
| 09:55:14 | 重新載入（距變動 21 秒） | 可用席次 0（舊值），以 `cache: no-store` 讀到的真值是 1 |
| 09:55:21 | 再重新載入 | 可用席次 1 |

伺服器端的快取符合 PM。用 SQL 在快取背後改資料，看板在 15.4 秒與 15.5 秒後反映（BOARD-TTL）。多出來的落後來自回應標頭 `Cache-Control: public, max-age=15, stale-while-revalidate=30`。瀏覽器在 15 秒到 45 秒之間會先給舊的副本，再於背景更新，所以使用者看到的舊資料最多約 45 秒。他人造成的變動再疊上伺服器的 15 秒，理論上限約 60 秒，這個疊加值是推算，沒有端對端量測。

使用者自己的動作也不會立刻反映在看板上。09:54:16 自己加入排隊並配到席次後，看板仍顯示「可用席次 1」，直到下次重新載入。

預期行為是 PM AC4 所寫的「看板資料有 15 秒快取，期間內的數字可能落後實際狀態」，違反的 oracle 是 Claims。影響是數字顯示落後，沒有造成錯誤配對。需確認 `stale-while-revalidate=30` 是否是有意的設計，PM 沒有提到這 30 秒。

### F-4（P3，WARN，需確認）分享表單的錯誤提示不在輸入框下方

貼上非連結文字送出後，紅字（`rgb(192, 57, 43)`）出現在表單欄位上方，元素也在 `<form>` 之外（UI-28）。量測值是提示的頂端比文字框的頂端高 171 px（提示 top -135，文字框 top 36）。母文件第 128 行寫「連結格式錯誤或重複時在輸入框下方紅字提示原因」。

在 390 x 800 的視窗內，送出後提示仍在可視範圍（top 44、bottom 111），使用者看得到，所以只是位置偏差。違反的 oracle 是 Claims，依據是母文件而不是雙軌文件。領取表單的錯誤提示沒有位置規則，不在此項。需確認位置要不要照母文件。

### F-5（P2，FAIL）邀請代碼與推播訂閱端點沒有長度上限，過大的值回 500

這是母文件舊功能的輸入界線，不在雙軌範圍。我列在這裡，是因為 `POST /api/links` 是雙軌新增 `track` 欄位的端點，而且協調者要求壞輸入一律回 4xx。

重現步驟（API，登入的提供者）：

1. `POST /api/links`，`rawUrlInput` 為 `https://claude.ai/referral/` 加 1,500,000 個 `b`，`slotCount: 1`，`track: community`。
2. 同上，改成 3,000,000 個 `b`。
3. 同上，改成 10,000,000 個 `c`，連送兩次。
4. 對照：`POST /api/queue` 的 `thankYouMessage` 與 `nickname`、`POST /api/links` 的 `nickname`，各帶 10,000,000 字元。
5. `POST /api/push/subscribe`，`endpoint` 為 `https://push.invalid/` 加 10,000,000 個 `d`，`keys` 為合法的短字串。

預期行為是過大的輸入回 4xx，不寫入資料。小卡與暱稱已經是這樣，例如 1,000,000 字的小卡回 422（43 毫秒）。

實際行為如下。

| 請求 | 回應 |
|---|---|
| 代碼 1,500,000 字元 | 201（37 毫秒），連結被建立 |
| 代碼 3,000,000 字元 | 201（136 毫秒），連結被建立 |
| 代碼 10,000,000 字元 | 500 `INTERNAL_ERROR`「系統忙碌中，請稍後再試一次」，連送兩次都是；沒有建立連結，使用者的新手資格與違規計數不變，之後正常分享仍回 201 |
| 小卡、暱稱 10,000,000 字元 | 422 `VALIDATION_ERROR` |
| 10 MB 文字後面接一個正常的連結 | 201（只存正規化後的連結） |
| 推播訂閱 `endpoint` 10,000,000 字元 | 500 `INTERNAL_ERROR`（1476 毫秒） |

本輪較早的 B2-url 測試送過 200,000 字元的代碼，`invite_links` 的 id 169 現在存著長度 200000 的 `referral_code`，也是這個缺口的證據。

違反的 oracle 是 Standards（用戶端造成的錯誤不該回 5xx）與 Product（同一支 API 的小卡與暱稱有上限，代碼沒有）。

影響範圍是直接呼叫 API 的情況，一般使用者從介面碰不到。登入的使用者可以存入數 MB 的代碼，這些字串會出現在他的 `GET /api/me`，也會出現在配到的領取者看到的網址裡；10 MB 的值會讓伺服器回 500，可能污染錯誤監控。本機的 D1 沒有擋住 3 MB 的值，正式環境的上限可能不同，我沒有在正式環境測。真實的邀請代碼約 10 個字元，建議對代碼與推播端點設上限。

### 8.1 處置結果（2026-10-24）

| 項目 | 處置 |
|---|---|
| F-1 | 維持實作（封鎖先於重複，回 403），母文件規則 1 的 R1-2、R1-3 已改成同樣順序 |
| F-2 | `GET /api/me` 加 `Cache-Control: private, no-store`，已用 curl 在本機確認 |
| F-3 | 看板標頭改為 `public, max-age=15`，使用者自己的動作成功後前端以 `cache: 'reload'` 重抓看板 |
| F-4 | 分享表單的錯誤提示移到輸入框下方 |
| F-5 | 加 `MAX_RAW_URL_INPUT_LENGTH`（2000）、`MAX_REFERRAL_CODE_LENGTH`（64）、`MAX_PUSH_ENDPOINT_LENGTH`（2048），超過回 422；已用 curl 確認 3000 字的代碼回 422 |
| O-20 | 感謝小卡去掉空白與不可見格式字元後至少要剩一個字元，否則回 422 |

## 9. 先前候選問題複驗（Phase 1b gap 結案）

| 項目 | 結果 | 證據 |
|---|---|---|
| 壞 JSON、空 body 回 500 | 已修復 | `POST /api/queue` 與 `POST /api/links` 的壞 JSON、空 body、截斷 JSON 都回 400 `INVALID_INPUT`（B2-body 各 3 個檢查點）；其他壞形狀回 422，沒有 5xx |
| 匿名先被驗證擋成 422 | 已修復 | 匿名呼叫兩支寫入 API，11 種 body 形狀加合法與不合法 body 全回 401 `UNAUTHORIZED`；4 支動作端點與 2 支推播端點也回 401（B2-anon） |
| G1：省略 `track` 的 API 行為（Q1） | 已修復 | 第 3 節 Q1 |
| G7：UI 與 API 字數算法不同 | 不成立 | UI 與 API 都以碼點計；UI 有 5 字下限（UI-09） |
| G8：錯誤提示位置 | 成立 | F-4 |
| G9：看板快取超過 15 秒 | 成立 | F-3 |
| G4、G5、G6：PM 缺口 | 已由 Q4、Q3、Q5 補上 | 第 3 節 |
| 第一輪觀察：感謝牆只有 1 張卡時輪播並排出現相同卡片 | 未重新驗證 | 資料庫重置後牆上超過 30 張卡，無法重現；屬母文件舊功能，不在雙軌範圍 |

## 10. 觀察項目（INFO，PM 沒寫或屬設計決定）

| 編號 | 觀察 | 證據 |
|---|---|---|
| O-1 | Q5：新手排在順位 1，community 紀錄拿走 community 席次後，新手仍是第 1 順位並繼續等 | P-05a、P-05b |
| O-2 | Q4：先排新手隊、之後才分享連結的人，仍可被配到他人的新手席次；等於先排隊再分享可以繞過「提供者不排新手軌」，PM 已決定接受 | F-01b、F-01c |
| O-3 | 登出只清掉瀏覽器的 cookie，舊 cookie 值在 30 天到期前仍有效（無狀態 token） | X-15b |
| O-4 | `rawUrlInput` 的文字部分沒有長度限制：100 萬字的文字夾一個連結回 201（6 毫秒），10 MB 文字後接正常連結也回 201。代碼本身的長度缺口列在 F-5 | B2-url、F-5 |
| O-5 | 匿名 `GET /api/me` 帶 `devLoginEnabled: true`，開發登入端點可用；這是開發設定，正式環境的旗標沒有測 | X-01b |
| O-6 | session cookie 在本機沒有 `Secure` 旗標（http://localhost 下合理），正式環境沒有測 | B4-cookie-secure |
| O-7 | 帶外來 `Origin` 加有效 cookie 的 JSON POST 回 201，伺服器不檢查 Origin；瀏覽器端靠 SameSite=Lax 與缺少 CORS 預檢擋下 | B4-csrf |
| O-8 | 小卡驗證（422）先於資格檢查（409）：進行中或已領過、同時小卡只有 4 字，回 422 | E-23a、E-23c |
| O-9 | 對 `confirmed` 的紀錄呼叫 reveal 回 409 ITS；解鎖滿 30 分鐘後 1 分鐘呼叫 reveal 回 409（紀錄已自動確認） | ST-reveal@confirmed、T-06f |
| O-10 | 取消與解鎖的競態：40 次中取消贏 39 次，沒有兩者都成功的情形 | X-20d |
| O-11 | `http://` 與 `www.` 的連結被正規化為 `https://claude.ai/...` 並接受 | B2-url |
| O-12 | 直接呼叫 API 送錯誤形狀（例如 JSON null）時，422 的訊息是英文的 schema 驗證文字，介面不會送出這種請求 | B2-body |
| O-13 | 回報無效的對話框文字比 PM 第 176 行多一句「立即停用這組連結尚未發出的剩餘名額」，並用「終身」取代「每個帳號僅限」 | UI-05b |
| O-14 | 兩個說明浮窗沒有解釋新手軌與第二帳號軌 | UI-26 |
| O-15 | 推播區塊只有按鈕「開啟手機推播通知」，母文件的說明句只出現在 tooltip，用字不同 | UI-30 |
| O-16 | 推播裝置送不出去時，`POST /api/push/test` 回 200 加 `sent=false`，訊息「已偵測到推播訂閱裝置，但通知送出失敗，請稍後再試；若持續失敗，請聯絡管理員檢查推播金鑰設定。」；沒有裝置時訊息為「目前尚未偵測到有效的推播訂閱裝置，請先點擊開啟推播並允許權限。」 | PUSH-2a、PUSH-2c |
| O-17 | 提供者的分享紀錄把所有 `closed` 席次都標「因同組無效而停用」；本資料庫裡很多 `closed` 是我的測試收尾關閉的，正常流程只有同組無效會產生 | UI-20 |
| O-18 | `totalConfirmedCount` 在確認當下是 15，資料庫是 40，之後追上；收尾時看板 94 等於資料庫的 94 筆 confirmed | B-05c |
| O-19 | 開發登入對既有帳號再登入時，不會用新的暱稱覆蓋已儲存的暱稱 | E-24a |
| O-20 | 小卡只由 5 個零寬空白（U+200B）或 5 個組合記號組成時，通過 5 字下限並被儲存。`trim()` 不會去掉這些字元，依儲存值推斷，這張卡上牆後會顯示成空白，我沒有讓它上牆。母文件沒有規定可見字元數 | 一次性探測（`c_weird_strings.mjs`），未列入檢查點統計 |

## 11. 未測試項目與剩餘風險

| 項目 | 原因 | 剩餘風險 |
|---|---|---|
| Web Push 的實際送達、payload 內容、404 與 410 的訂閱清理 | 本機看不到 payload | 推播文案與送達在正式環境可能不同。只驗證了推播失敗不影響配對、確認與感謝牆（PUSH-3），暫時性失敗不刪訂閱 |
| Google OAuth 正式登入與錯誤情境 | 本機用開發登入取代，不能連 Google | 首次登入的暱稱預設值、token 錯誤處理在正式環境可能不同 |
| 正式環境設定 | 只有本機環境 | 開發登入旗標（`devLoginEnabled`）、session 密鑰、`Secure` cookie、多個 isolate 各自的看板快取（同時間不同使用者可能看到不同數字，`totalConfirmedCount` 最久 10 分鐘）、正式 D1 對單一值的大小上限（影響 F-5 的實際門檻）無法在本機重現，需要部署檢查 |
| D1 每日讀取列數額度（AC4 設計 10 分鐘快取的原因） | 本機無法量測 | 額度是否守得住沒有驗證 |
| 其他瀏覽器與真機 | 只有 Chrome 桌面；視窗縮放沒有生效（視窗寬度仍是 1458 px），390 px 以同源 iframe 模擬 | iOS Safari 的 PWA 安裝與推播、Firefox 沒有測 |
| 無障礙 | 只確認 aria 屬性存在 | 鍵盤操作與螢幕閱讀器沒有測 |
| 看板載入失敗狀態與感謝牆空狀態文案 | 需要中斷網路或清空資料，我不刪測試資料也不停 dev server | 這兩段文案沒有驗證 |
| 推播權限按鈕、複製邀請連結按鈕 | 前者會觸發瀏覽器原生權限提示（權限目前是 default），後者需要剪貼簿權限 | 權限被封鎖時的提示、複製成功的回饋沒有驗證 |
| 部分寫入的故障注入 | 黑箱無法讓 D1 批次寫入中途失敗 | 以「失敗的請求不改變資料」間接覆蓋（B2-nick/partial1 到 partial3、ST 矩陣的狀態不變）；真正的交易失敗路徑沒有測 |
| 真實等待 6 小時與 30 分鐘 | 以 SQL 回溯與 cron `time=` 取代 | 真實時鐘與時區行為沒有驗證 |
| 舊資料遷移 | 資料庫起始為空 | 有舊資料的升級路徑沒有測 |
| 寫入 API 頻率限制 | 母文件第 3 行寫明未實作 | 不判為缺陷 |

## 12. Coverage 與自我檢查

Minimum Coverage：

- 每個寫入操作的四條路徑都有：正常（E、M、A）、無效輸入（4.7 與壞 body）、中斷或取消（C、T）、重複提交（X-08 到 X-11、UI-16、UI-27）。
- 受保護資源的三種角色（擁有者、其他使用者、未認證）分別由 X-01、X-04、X-05、X-07 覆蓋。
- 非同步操作有逾時處理 8 種觸發（T）、完成前重新整理（UI-16）、重試行為（T-09、I-04）。
- 未達標處是正式環境的 Platform 維度，列在第 11 節。

Step 7 自我檢查：

- Pre-Test Model 的高風險項目（Top Risks 前 4 項）都跑到 L3。
- 決策表每一行都執行了：資格表 8 個歷史乘 3 種請求、撮合 M-01 到 M-19、J-01 到 J-07、R-01 到 R-03。狀態矩陣 5 個動作乘 7 個狀態每格都測，包含非法格。
- 每個寫入操作都有 negative case，並確認被拒絕時資料沒變。
- 每個受保護資源都做了跨角色測試。端點不帶 id，沒有竄改 id 的測法。
- SFDPOT 沒碰到的維度有 Platform（其他瀏覽器、真機、正式環境）與 Data 的量（只有 352 組連結，沒有效能測試）。
- 每個 PASS 的 expected 值來自 PM 文件、AC、使用者拍板的 Q1 到 Q7，或 domain knowledge（例如 6 小時等於 6.0000 小時）。PM 沒寫的格記為 INFO，沒有拿來判 PASS。
- 殺蟲劑悖論：這是這個專案的第一輪 QA，沒有上次的組合可比。本輪的切入角度記在 agent memory，下次要換。

Step 6 模糊情境：

- P-05：用 Explainability 與 Users oracle 看，新手看到「第 1 順位」卻可能一直沒輪到 community 席次。Q5 已定為設計，所以只記 INFO。
- F-01：用 Purpose oracle（保護新手資源池）看，先排隊後分享可以繞過規則。Q4 已定為接受，記 INFO。
- 小卡 422 先於 409：用 Product oracle 看，兩種錯誤都合理，PM 沒寫順序，記 INFO。

違反次數最多的 oracle 是 Claims（F-1、F-3、F-4），其次是 Standards（F-2、F-5）。

## 13. 資料與環境副作用

- 測試資料沒有刪除。資料庫在本輪開始前被協調者重置，所以現有的每一列都是本輪建立。id 範圍是 `users` 1 到 906、`invite_links` 1 到 352、`invite_slots` 1 到 425、`queue_entries` 1 到 662。帳號 email 為 `*@qa.test`，建立時間 2026-10-24T09:24:56Z 到 10:14:42Z。
- `invite_links` 的 id 169（代碼長度 200000）與兩個 F-5 重現產生的連結（代碼長度 1,500,000 與 3,000,000）各存著一個超大字串，`GET /api/me` 對這些提供者會回傳很大的內容。
- 收尾時席次池為空：沒有 `waiting`、`reserved`、`revealed` 的紀錄，沒有 `available` 的席次。最後一次清理關閉了 1 個殘留席次（id 425）。
- 全庫 17 項不變式在最終狀態全部成立（見 `inv_global`）。席次狀態是 closed 288（community 67、newbie 221）、confirmed 94（community 6、newbie 88）、invalidated 43（community 5、newbie 38）。排隊紀錄狀態是 cancelled 518、confirmed 94、expired 50。
- 我用 SQL 改過的資料：
  - 回溯 `reserve_expires_at` 與 `confirm_expires_at`（`queue_entries` 與 `invite_slots` 兩張表），每次都先用相同的 WHERE 跑 SELECT，確認恰好 1 筆再 UPDATE。
  - 每個情境結束時把殘留的 `available`、`reserved`、`revealed` 席次改成 `closed`，同樣先 SELECT。所以資料庫裡很多 `closed` 席次來自我的收尾，不是產品行為。
  - BOARD-TTL 量測用 SQL 把 2 個 `available` 席次改成 `closed`。
- cron 的 `time=` 快轉（T-10）曾寫入一張 `confirmed_at` 在未來（10:01:48Z）的感謝小卡，排在牆的最前面。時間過了之後已無未來時間的列（10:10Z 的 SELECT 為空）。
- 看板的 `totalConfirmedCount` 目前是 94，等於資料庫的 confirmed 筆數。
- dev server 沒有重啟。
- 瀏覽器：Chrome 原本沒有在執行，我啟動了它並已關掉我開的分頁；Chrome 本身還開著。分頁最後一次的登入狀態是訪客。
- 腳本與結果在 scratchpad：`/private/tmp/claude-501/-Users-maple-Desktop-claude-tw-invite/943cb489-c204-46c2-95cf-7b60a9a4e6a7/scratchpad/`（`qa-lib.mjs`、`a1` 到 `a6`、`b1` 到 `b8`、`c_*`、`inv_global.mjs`、`repro_l06d2.mjs`、`results/*.json`、`merge.mjs` 可重印統計）。

## 14. 整體測試信心

高，範圍限於本機開發環境的功能行為。

1028 個檢查點通過，覆蓋雙軌道的資格、撮合、狀態、逾時、連動、並發與使用者介面。所有使用者拍板的決定都有驗證，先前候選的 5xx 與驗證順序問題已修復，全庫不變式在收尾時成立。兩個 FAIL 都是 P2：一個是影響很小的檢查順序偏差（F-1），一個是母文件舊功能的輸入長度缺口（F-5）。

正式環境設定、真實推播與 Google 登入沒有測到，這三項的信心是低，需要部署前另外檢查。

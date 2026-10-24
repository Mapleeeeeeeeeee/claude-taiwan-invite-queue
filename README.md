# Claude Taiwan 邀請連結排隊平台

Claude Taiwan 社團用的邀請連結排隊與感謝回饋 PWA：提供者貼上自己的 Claude 邀請連結，領取者按先到先得排隊，輪到時收到手機推播，領取後送出一張感謝小卡，公開刊登在感謝牆上。

目前的線上版本在 <https://claude-tw-invite.mapleee723.workers.dev>。

## 功能

- 雙軌排隊：新手首發軌每人限領一次，再領取軌給已經領過或分享過邀請連結的人；新手也可以領再領取軌的名額。
- 提供者一次分享 1 到 3 個名額。領取者回報無效後，在同一軌道的排隊中優先被配對，每個帳號限用一次。
- 輪到時用 Web Push 推播通知，保留 6 小時；解鎖後 30 分鐘內確認啟用，逾時自動確認。
- 感謝牆與看板（伺服器快取 15 秒），Google 帳號登入。
- 可安裝的 PWA：Android 和桌面的 Chrome 會顯示安裝按鈕，iPhone 用瀏覽器的「加入主畫面」。

## 技術

Cloudflare Workers、Hono、Zod、D1（drizzle-orm）、React 19、Vite、Vitest。後端分層與前端結構的取捨寫在 `CLAUDE.md` 和 `docs/arch/`。

## 本機執行

需要 Node.js 和 pnpm。

1. 執行 `pnpm install`
2. 複製 `.dev.vars.example` 成 `.dev.vars`
3. 執行 `pnpm db:migrate:local` 建立本機 D1 資料表；Windows 的 shell 不支援這支指令裡的 `CI=true` 寫法，改執行 `npx wrangler d1 migrations apply claude-tw-invite-db --local`
4. 執行 `pnpm build`，Worker 會從 `dist/` 提供前端檔案
5. 執行 `pnpm dev:worker`，打開 <http://localhost:8787>

`.dev.vars` 裡的 `ENVIRONMENT=development` 會在頁面底部顯示開發登入面板，不需要 Google 帳號就能切換多個測試使用者。沒有這個變數時，Worker 一律當成正式環境，不接受開發登入。

改前端時另外執行 `pnpm dev`，Vite 在 5173 埠，`/api` 轉給 8787 的 Worker。

## 測試

- `pnpm typecheck` 做型別檢查
- `pnpm test` 執行所有測試；整合測試每個案例自己建一個記憶體內的 D1，不需要啟動 server

## 部署到 Cloudflare

網站網址要等第一次部署才會知道，所以部署分兩輪：第一輪取得網址，第二輪把網址填進設定。

1. 執行 `npx wrangler login`，再執行 `npx wrangler whoami` 確認顯示的是自己的 Cloudflare 帳號
2. 執行 `npx wrangler d1 create claude-tw-invite-db`，把輸出的 `database_id` 填進 `wrangler.toml`
3. 執行 `npx wrangler d1 migrations apply claude-tw-invite-db --remote`
4. 執行 `pnpm build`，再執行 `npx wrangler deploy`，輸出的 `https://….workers.dev` 就是你的網站網址
5. 在 Google Cloud Console 建立「網頁應用程式」類型的 OAuth 用戶端 ID，「已授權的 JavaScript 來源」填上一步的網站網址；OAuth 同意畫面維持測試狀態時，只有測試使用者清單內的帳號能登入，要開放所有人須發布應用程式
6. 用 `npx wrangler secret put` 設定五個值：`SESSION_SECRET`、`GOOGLE_CLIENT_ID`、`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`；VAPID 金鑰可用 `npx --yes web-push generate-vapid-keys` 產生，`web-push` 不在本專案依賴中，這個指令會臨時下載
7. 把 `vite.config.ts` 的 `siteOrigin` 改成你的網站網址，分享預覽卡的圖片網址從這裡來
8. 再執行一次 `pnpm build` 和 `npx wrangler deploy`

非 development 環境缺少 `SESSION_SECRET`、`GOOGLE_CLIENT_ID` 或 `VAPID_PUBLIC_KEY` 時，所有 `/api/` 請求都回 500，不會退回開發預設值。缺少 `VAPID_PRIVATE_KEY` 或 `VAPID_SUBJECT` 時 API 仍正常回應，但推播送不出去。

## 文件

- `docs/design/`：需求與使用者流程；`invite-code-queue.md` 是基礎文件，`dual-track-queue.md` 取代其中三條規則
- `docs/arch/`：架構決策、資料邊界、交易與一致性
- `docs/qa/`：QA 報告

## 授權

Apache License 2.0，全文在 `LICENSE`。Copyright 2026 Maple Kuo。

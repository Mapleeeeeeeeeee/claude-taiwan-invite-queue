import { beforeEach, describe, expect, it } from "vitest";
import type {
  ApiErrorResponse,
  ApiSuccessResponse,
  MeDto,
} from "../../src/shared/types";
import { type Env, createApp } from "../../src/worker/index";
import { invalidateBoardCache } from "../../src/worker/queries/boardQuery";
import { type AppInstance, loginActor } from "../helpers/testActor";
import { createTestD1Database } from "../helpers/testD1";

const GOOGLE_PROFILE_NAME = "Google 顯示名稱";
const JSON_HEADERS = { "Content-Type": "application/json" };

describe("登入、session cookie 與入口設定", () => {
  let env: Env;
  let app: AppInstance;

  beforeEach(() => {
    invalidateBoardCache();
    env = {
      DB: createTestD1Database().db,
      ENVIRONMENT: "development",
      SESSION_SECRET: "test-session-secret-key",
      GOOGLE_CLIENT_ID: "test-google-client-id",
      VAPID_PUBLIC_KEY: "test-vapid-public-key",
    };
    app = createApp({
      googleTokenVerifier: async (idToken: string) => ({
        sub: `google-${idToken}`,
        email: `${idToken}@example.com`,
        name: GOOGLE_PROFILE_NAME,
      }),
    });
  });

  async function postJson(
    path: string,
    body: unknown,
    cookie?: string,
  ): Promise<Response> {
    return app.request(
      path,
      {
        method: "POST",
        headers: cookie ? { ...JSON_HEADERS, Cookie: cookie } : JSON_HEADERS,
        body: JSON.stringify(body),
      },
      env,
    );
  }

  async function fetchMe(cookie: string): Promise<MeDto> {
    const res = await app.request(
      "/api/me",
      { headers: { Cookie: cookie } },
      env,
    );
    return ((await res.json()) as ApiSuccessResponse<MeDto>).data;
  }

  function cookieOf(res: Response): string {
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }

  describe("重新登入時的暱稱", () => {
    const loginRoutes = [
      {
        route: "dev-login",
        path: "/api/auth/dev-login",
        credentials: { email: "returning@example.com" },
        defaultNickname: "returning",
      },
      {
        route: "Google 登入",
        path: "/api/auth/google",
        credentials: { idToken: "returning" },
        defaultNickname: GOOGLE_PROFILE_NAME,
      },
    ];

    it.each(loginRoutes)(
      "$route 第一次登入沒帶暱稱時，用預設暱稱 $defaultNickname 建立帳號",
      async ({ path, credentials, defaultNickname }) => {
        const res = await postJson(path, credentials);

        expect(
          (
            (await res.json()) as ApiSuccessResponse<{
              user: { nickname: string };
            }>
          ).data.user.nickname,
        ).toBe(defaultNickname);
      },
    );

    // Regression: 重新登入會用 Google 顯示名稱 / email 前綴覆蓋使用者自訂的暱稱 (rereview-correctness Should Fix 2)
    it.each(loginRoutes)(
      "$route 已自訂暱稱的使用者再次登入且沒帶暱稱，暱稱維持自訂值",
      async ({ path, credentials }) => {
        await postJson(path, { ...credentials, nickname: "自訂暱稱" });

        const secondLogin = await postJson(path, credentials);

        expect(await fetchMe(cookieOf(secondLogin))).toMatchObject({
          user: { nickname: "自訂暱稱" },
        });
      },
    );

    it.each(loginRoutes)(
      "$route 再次登入時明確帶了新暱稱，暱稱改成新值",
      async ({ path, credentials }) => {
        await postJson(path, { ...credentials, nickname: "舊暱稱" });

        const secondLogin = await postJson(path, {
          ...credentials,
          nickname: "新暱稱",
        });

        expect(await fetchMe(cookieOf(secondLogin))).toMatchObject({
          user: { nickname: "新暱稱" },
        });
      },
    );
  });

  describe("登入回應", () => {
    it.each([
      {
        route: "dev-login",
        path: "/api/auth/dev-login",
        body: { email: "dto@example.com", nickname: "小明" },
      },
      {
        route: "Google 登入",
        path: "/api/auth/google",
        body: { idToken: "dto", nickname: "小明" },
      },
    ])("$route 的 user 只包含 id、email、nickname", async ({ path, body }) => {
      const res = await postJson(path, body);

      expect(res.status).toBe(200);
      const { user } = (
        (await res.json()) as ApiSuccessResponse<{ user: unknown }>
      ).data;
      expect(user).toEqual({
        id: expect.any(Number),
        email: expect.stringMatching(/^dto/),
        nickname: "小明",
      });
    });
  });

  describe("登入到登出", () => {
    it("Google 登入後帶著回應的 cookie 查 /api/me 看到自己的暱稱，登出後的 cookie 查 /api/me 回 user: null", async () => {
      const loginRes = await postJson("/api/auth/google", {
        idToken: "journey",
        nickname: "旅程使用者",
      });
      expect(loginRes.status).toBe(200);
      const sessionCookie = cookieOf(loginRes);
      expect(await fetchMe(sessionCookie)).toMatchObject({
        user: { email: "journey@example.com", nickname: "旅程使用者" },
      });

      const logoutRes = await postJson("/api/auth/logout", {}, sessionCookie);

      expect(logoutRes.status).toBe(200);
      const clearedCookie = logoutRes.headers.get("set-cookie");
      expect(clearedCookie).not.toBeNull();
      expect((await fetchMe(clearedCookie!.split(";")[0]!)).user).toBeNull();
    });
  });

  describe("提供給前端的 Google Client ID", () => {
    it("匿名與已登入的 GET /api/me 都回傳伺服器設定的 GOOGLE_CLIENT_ID", async () => {
      const anonymousRes = await app.request("/api/me", {}, env);
      const actor = await loginActor(app, env, "clientid@example.com", "登入者");

      expect(
        ((await anonymousRes.json()) as ApiSuccessResponse<MeDto>).data
          .googleClientId,
      ).toBe("test-google-client-id");
      expect((await actor.getMe()).googleClientId).toBe("test-google-client-id");
    });
  });

  describe("session cookie 驗證", () => {
    const encodeSegment = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const forgeCookie = (header: object): string =>
      `claude_tw_session=${encodeSegment(header)}.${encodeSegment({ userId: 1 })}.signature`;

    // Regression: JWT header 缺 alg 或 alg 不符的 cookie 讓每個請求回 500 (rereview-correctness Nit)
    it.each([
      { case: "header 沒有 alg", header: { typ: "JWT" } },
      { case: "alg 不是 HS256", header: { typ: "JWT", alg: "HS512" } },
    ])("cookie 的 $case 時，視為未登入而不是回 500", async ({ header }) => {
      const res = await app.request(
        "/api/me",
        { headers: { Cookie: forgeCookie(header) } },
        env,
      );

      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as ApiSuccessResponse<MeDto>).data.user,
      ).toBeNull();
    });

    it("登入後帶著 cookie 的 GET /api/me 回傳該使用者", async () => {
      const actor = await loginActor(app, env, "session@example.com", "登入者");

      expect((await actor.getMe()).user).toMatchObject({
        email: "session@example.com",
      });
    });
  });

  describe("推播訂閱網址", () => {
    const keys = { p256dh: "p256dh-key", auth: "auth-key" };

    // Regression: endpoint 只驗是網址，http: 也能訂閱，Worker 會對它發 POST (rereview-correctness Nit)
    it("endpoint 不是 https 時回 422 VALIDATION_ERROR", async () => {
      const actor = await loginActor(app, env, "push@example.com", "推播者");

      const res = await postJson(
        "/api/push/subscribe",
        { endpoint: "http://push.example.com/a", keys },
        actor.cookie,
      );

      expect(res.status).toBe(422);
      expect(((await res.json()) as ApiErrorResponse).error.code).toBe(
        "VALIDATION_ERROR",
      );
    });

    it("endpoint 是 https 時訂閱成功", async () => {
      const actor = await loginActor(app, env, "push2@example.com", "推播者二");

      const res = await postJson(
        "/api/push/subscribe",
        { endpoint: "https://push.example.com/a", keys },
        actor.cookie,
      );

      expect(res.status).toBe(200);
    });
  });

  describe("找不到的路徑與預設設定", () => {
    it("未知的 /api 路徑回 404 NOT_FOUND", async () => {
      const res = await app.request("/api/does-not-exist", {}, env);

      expect(res.status).toBe(404);
      expect(((await res.json()) as ApiErrorResponse).error.code).toBe(
        "NOT_FOUND",
      );
    });

    // wrangler.toml 不放任何 vars，沒有 .dev.vars 的部署就是這個 env
    it("沒有任何環境變數時，第一個請求就失敗，dev-login 不會放行", async () => {
      const bareEnv: Env = { DB: env.DB };

      const res = await app.request(
        "/api/auth/dev-login",
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ email: "x@example.com" }),
        },
        bareEnv,
      );

      expect(res.status).toBe(500);
    });
  });
});

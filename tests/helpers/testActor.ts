import type {
  ApiSuccessResponse,
  BoardDto,
  MeDto,
  QueueTrack,
} from '../../src/shared/types';
import type { Env, createApp } from '../../src/worker/index';

export type AppInstance = ReturnType<typeof createApp>;

/**
 * 測試參與者 (Test Actor)
 *
 * 封裝使用者在系統中的語意化操作（加入排隊、看碼、確認、回報無效、分享連結），
 * 消除測試案例中繁瑣重複的 app.request 底層 HTTP 呼叫與 Cookie 傳遞。
 */
export class TestActor {
  constructor(
    public readonly app: AppInstance,
    public readonly env: Env,
    public readonly userId: number,
    public readonly email: string,
    public readonly nickname: string,
    public readonly cookie: string,
    private readonly executionCtx?: ExecutionContext
  ) {}

  /**
   * 回傳同一位使用者、但請求都帶上指定 ExecutionContext 的 actor，
   * 用來驗證 `ctx.waitUntil` 背景工作（例如推播）在回應之後才完成。
   */
  withExecutionContext(executionCtx: ExecutionContext): TestActor {
    return new TestActor(
      this.app,
      this.env,
      this.userId,
      this.email,
      this.nickname,
      this.cookie,
      executionCtx
    );
  }

  /**
   * 取得使用者的個人狀態 (/api/me)
   */
  async getMe(): Promise<MeDto> {
    const res = await this.app.request(
      '/api/me',
      {
        method: 'GET',
        headers: { Cookie: this.cookie },
      },
      this.env,
      this.executionCtx
    );
    const json = (await res.json()) as ApiSuccessResponse<MeDto>;
    return json.data;
  }

  /**
   * 訂閱 Web Push 通知 (/api/push/subscribe)
   */
  async subscribePush(
    endpoint: string,
    keys: { p256dh: string; auth: string } = {
      p256dh: 'test-p256dh-key',
      auth: 'test-auth-key',
    }
  ): Promise<Response> {
    return this.app.request(
      '/api/push/subscribe',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: this.cookie,
        },
        body: JSON.stringify({ endpoint, keys }),
      },
      this.env,
      this.executionCtx
    );
  }

  /**
   * 發送測試推播 (/api/push/test)
   */
  async sendTestPush(): Promise<Response> {
    return this.app.request(
      '/api/push/test',
      {
        method: 'POST',
        headers: { Cookie: this.cookie },
      },
      this.env,
      this.executionCtx
    );
  }

  /**
   * 加入排隊 (/api/queue)
   */
  async joinQueue(thankYouMessage?: string, track?: QueueTrack): Promise<Response> {
    const payload: Record<string, unknown> = {};
    if (thankYouMessage !== undefined) {
      payload.thankYouMessage = thankYouMessage;
    }
    if (track !== undefined) {
      payload.track = track;
    }
    return this.app.request(
      '/api/queue',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: this.cookie,
        },
        body: JSON.stringify(payload),
      },
      this.env,
      this.executionCtx
    );
  }

  /**
   * 取消排隊 (POST /api/queue/cancel 或 DELETE /api/queue)
   */
  async cancelQueue(method: 'POST' | 'DELETE' = 'POST'): Promise<Response> {
    const path = method === 'POST' ? '/api/queue/cancel' : '/api/queue';
    return this.app.request(
      path,
      {
        method,
        headers: { Cookie: this.cookie },
      },
      this.env,
      this.executionCtx
    );
  }

  /**
   * 解鎖領取邀請碼 (/api/queue/reveal)
   */
  async reveal(): Promise<Response> {
    return this.app.request(
      '/api/queue/reveal',
      {
        method: 'POST',
        headers: { Cookie: this.cookie },
      },
      this.env,
      this.executionCtx
    );
  }

  /**
   * 確認啟用邀請碼並送出感謝留言 (/api/queue/confirm)
   */
  async confirm(thankYouMessage?: string): Promise<Response> {
    return this.app.request(
      '/api/queue/confirm',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: this.cookie,
        },
        body: thankYouMessage !== undefined ? JSON.stringify({ thankYouMessage }) : undefined,
      },
      this.env,
      this.executionCtx
    );
  }

  /**
   * 回報邀請碼無效 (/api/queue/report-invalid)
   */
  async reportInvalid(reason?: string): Promise<Response> {
    return this.app.request(
      '/api/queue/report-invalid',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: this.cookie,
        },
        body: reason !== undefined ? JSON.stringify({ reason }) : undefined,
      },
      this.env,
      this.executionCtx
    );
  }

  /**
   * 提供者分享邀請連結 (/api/links)
   */
  async shareLink(
    rawUrlInput: string,
    slotCount: number = 1,
    track?: QueueTrack
  ): Promise<Response> {
    return this.app.request(
      '/api/links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: this.cookie,
        },
        body: JSON.stringify({ rawUrlInput, slotCount, track }),
      },
      this.env,
      this.executionCtx
    );
  }

  /**
   * 底層請求逃生艙（用於測試非規範 Payload、損毀 Header 或非標準 Method）
   */
  async request(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (!headers.has('Cookie')) {
      headers.set('Cookie', this.cookie);
    }
    return this.app.request(path, { ...init, headers }, this.env, this.executionCtx);
  }
}

/**
 * 模擬開發登入並建立 TestActor
 */
export async function loginActor(
  app: AppInstance,
  env: Env,
  email: string,
  nickname: string
): Promise<TestActor> {
  const res = await app.request(
    '/api/auth/dev-login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nickname }),
    },
    env
  );
  if (res.status !== 200) {
    throw new Error(`Failed to login test actor ${email}: HTTP ${res.status}`);
  }

  const setCookieHeader = res.headers.get('set-cookie');
  if (!setCookieHeader) {
    throw new Error(`Missing Set-Cookie header for test actor ${email}`);
  }

  const cookiePair = setCookieHeader.split(';')[0]!;
  const body = (await res.json()) as ApiSuccessResponse<{ user: { id: number } }>;

  return new TestActor(app, env, body.data.user.id, email, nickname, cookiePair);
}

/**
 * 讀取公開看板資料 (/api/board)
 */
export async function fetchBoard(app: AppInstance, env: Env): Promise<BoardDto> {
  const res = await app.request('/api/board', { method: 'GET' }, env);
  if (res.status !== 200) {
    throw new Error(`Failed to fetch board: HTTP ${res.status}`);
  }
  const json = (await res.json()) as ApiSuccessResponse<BoardDto>;
  return json.data;
}

/**
 * 解析 API 回傳之 JSON 資料的型別輔助函式
 */
export async function parseJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

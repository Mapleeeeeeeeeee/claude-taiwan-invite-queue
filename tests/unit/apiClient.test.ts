import { describe, expect, it } from 'vitest';
import { ApiClientError, createApiClient } from '../../src/client/api/apiClient';

function fetchReturningError(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

async function captureRejection(promise: Promise<unknown>): Promise<ApiClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiClientError) {
      return error;
    }
    throw error;
  }
  throw new Error('預期 API 呼叫失敗，但它成功了');
}

describe('apiClient 錯誤回應解析', () => {
  it('伺服器回報已知錯誤碼時，ApiClientError 帶著該錯誤碼、訊息與狀態碼', async () => {
    const client = createApiClient(
      fetchReturningError(409, { error: { code: 'ALREADY_IN_QUEUE', message: '你已經在排隊佇列中' } })
    );

    const error = await captureRejection(client.cancelQueue());

    expect(error.code).toBe('ALREADY_IN_QUEUE');
    expect(error.message).toBe('你已經在排隊佇列中');
    expect(error.statusCode).toBe(409);
  });

  it('伺服器回報不認得的錯誤碼時，視為 INTERNAL_ERROR 並顯示通用錯誤訊息', async () => {
    const client = createApiClient(
      fetchReturningError(400, { error: { code: 'SOMETHING_NEW', message: '內部細節' } })
    );

    const error = await captureRejection(client.cancelQueue());

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('系統忙碌中，請稍後再試一次');
    expect(error.statusCode).toBe(400);
  });
});

describe('apiClient 看板請求的瀏覽器快取', () => {
  function captureBoardRequestInit(
    fetchBoard: (client: ReturnType<typeof createApiClient>) => Promise<unknown>
  ): Promise<RequestInit | undefined> {
    let capturedInit: RequestInit | undefined;
    const fetchStub: typeof fetch = async (_path, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };
    return fetchBoard(createApiClient(fetchStub)).then(() => capturedInit);
  }

  it.each([
    { scenario: '一般載入', options: undefined, expectedCache: undefined },
    { scenario: '明確不繞過快取', options: { bypassBrowserCache: false }, expectedCache: undefined },
    { scenario: '使用者動作後要看到最新數字', options: { bypassBrowserCache: true }, expectedCache: 'reload' },
  ])('$scenario 時，看板請求的 cache 選項為 $expectedCache', async ({ options, expectedCache }) => {
    const init = await captureBoardRequestInit((client) => client.fetchBoard(options));

    expect(init?.cache).toBe(expectedCache);
  });
});

describe('apiClient 登出請求', () => {
  function captureLogoutRequestBody(endpoint?: string): Promise<BodyInit | null | undefined> {
    let capturedBody: BodyInit | null | undefined;
    const fetchStub: typeof fetch = async (_path, init) => {
      capturedBody = init?.body;
      return new Response(JSON.stringify({ data: { loggedOut: true } }), { status: 200 });
    };
    return createApiClient(fetchStub)
      .logout(endpoint)
      .then(() => capturedBody);
  }

  it('帶推播端點時，請求本文是只含該端點的 JSON', async () => {
    const body = await captureLogoutRequestBody('https://push.example.test/sub/abc');

    expect(JSON.parse(body as string)).toEqual({ endpoint: 'https://push.example.test/sub/abc' });
  });

  it('沒有推播端點時，請求不帶本文', async () => {
    const body = await captureLogoutRequestBody();

    expect(body).toBeUndefined();
  });
});

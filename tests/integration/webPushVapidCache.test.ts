import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushSubscriptionRepository } from '../../src/worker/repositories/pushSubscriptionRepository';
import { UserRepository } from '../../src/worker/repositories/userRepository';
import { WebPushService } from '../../src/worker/services/webPushService';
import { createTestD1Database } from '../helpers/testD1';
import { type TestPushSubscriber, createTestPushSubscriber } from '../helpers/webPushTestKeys';

const UNCOMPRESSED_P256_POINT_PREFIX = 0x04;
const NOW_ISO = '2026-03-01T10:00:00.000Z';
// 遠大於任何合理的快取上限，用來證明快取不會隨不同主機名無限成長。
const MANY_DISTINCT_HOSTS = 1000;

async function generateVapidConfig(): Promise<{
  publicKey: string;
  privateKey: string;
  subject: string;
}> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const uncompressedPublicKey = Buffer.concat([
    Buffer.from([UNCOMPRESSED_P256_POINT_PREFIX]),
    Buffer.from(privateJwk.x!, 'base64url'),
    Buffer.from(privateJwk.y!, 'base64url'),
  ]);
  return {
    publicKey: uncompressedPublicKey.toString('base64url'),
    privateKey: privateJwk.d!,
    subject: 'mailto:test@example.com',
  };
}

describe('VAPID JWT 快取', () => {
  let service: WebPushService;
  let pushRepo: PushSubscriptionRepository;
  let userRepo: UserRepository;
  let signSpy: ReturnType<typeof vi.spyOn>;
  // 金鑰不合規的訂閱會在簽章前就被移除，所以這組測試的訂閱都要帶合規的金鑰。
  let device: TestPushSubscriber;

  beforeEach(async () => {
    device = await createTestPushSubscriber();
    const { db } = createTestD1Database();
    pushRepo = new PushSubscriptionRepository(db);
    userRepo = new UserRepository(db);
    // 快取是模組層級的 Map；每個測試用獨一無二的 VAPID 金鑰，快取 key 才不會互相汙染。
    service = new WebPushService(pushRepo, { vapidConfig: await generateVapidConfig() });
    signSpy = vi.spyOn(crypto.subtle, 'sign');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 201 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function createUserWithSubscriptions(email: string, endpoints: string[]): Promise<number> {
    const user = await userRepo.upsertUserByGoogleProfile({
      googleSub: `sub-${email}`,
      email,
      defaultNickname: email,
      nowIso: NOW_ISO,
    });
    for (const endpoint of endpoints) {
      await pushRepo.upsertPushSubscription({
        userId: user.id,
        endpoint,
        ...device.keys,
        nowIso: NOW_ISO,
      });
    }
    return user.id;
  }

  const payload = { title: 't', body: 'b' };

  it('同一個推播服務連續送兩次，只簽一次 JWT', async () => {
    const userId = await createUserWithSubscriptions('a@example.com', ['https://push.a.example/1']);

    await service.sendNotificationToUser(userId, payload);
    await service.sendNotificationToUser(userId, payload);

    expect(signSpy).toHaveBeenCalledTimes(1);
  });

  it('不同主機名的數量超過上限後，最早的主機要重簽，快取不會無限成長', async () => {
    const firstUserId = await createUserWithSubscriptions('first@example.com', [
      'https://first.example/1',
    ]);
    const manyHosts = Array.from(
      { length: MANY_DISTINCT_HOSTS },
      (_, index) => `https://host-${index}.example/1`
    );
    const flooderId = await createUserWithSubscriptions('flooder@example.com', manyHosts);
    await service.sendNotificationToUser(firstUserId, payload);
    await service.sendNotificationToUser(flooderId, payload);
    signSpy.mockClear();

    await service.sendNotificationToUser(firstUserId, payload);

    expect(signSpy).toHaveBeenCalledTimes(1);
  });
});

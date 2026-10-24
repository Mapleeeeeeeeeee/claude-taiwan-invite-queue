import { decodeBase64Url, encodeBase64Url as honoEncodeBase64Url } from 'hono/utils/encode';
import type { PushSubscriptionInput } from '../../shared/types';
import { logError, logInfo, logWarn } from '../logger';
import type {
  PushSubscriptionRepository,
  StoredPushSubscriptionRow,
} from '../repositories/pushSubscriptionRepository';

function encodeBase64Url(bytes: Uint8Array): string {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return honoEncodeBase64Url(buffer).replace(/=+$/, '');
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export interface PushSendResult {
  statusCode: number;
}

export type PushSender = (
  subscription: StoredPushSubscriptionRow,
  payload: PushNotificationPayload
) => Promise<PushSendResult>;

interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export class PushDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushDeliveryError';
  }
}

const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60;
// 快取的 JWT 剩餘時間低於這個值就重簽，避免送出去時剛好過期。
const VAPID_TOKEN_REFRESH_MARGIN_SECONDS = 60 * 60;
// 快取以訂閱者可控的推播服務主機名為 key，所以要有上限，否則 isolate 的記憶體會隨不同主機名無限成長。
const VAPID_JWT_CACHE_MAX_ENTRIES = 100;
const PUSH_MESSAGE_TTL_SECONDS = 24 * 60 * 60;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_GONE = 410;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const P256_UNCOMPRESSED_PUBLIC_KEY_BYTE_LENGTH = 65;
const P256_UNCOMPRESSED_PREFIX = 0x04;
const P256_COORDINATE_BYTE_LENGTH = 32;
const WEB_PUSH_AUTH_SECRET_BYTE_LENGTH = 16;
const AES_GCM_SALT_BYTE_LENGTH = 16;
const AES128GCM_RECORD_SIZE = 4096;
// RFC 8188 的 record header 在 salt 之後是 4 bytes 的 record size 與 1 byte 的 key id 長度。
const RECORD_SIZE_FIELD_BYTE_LENGTH = 4;
const KEY_ID_LENGTH_FIELD_BYTE_LENGTH = 1;
const FINAL_RECORD_PADDING_DELIMITER = 0x02;

function encodeJsonBase64Url(data: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return encodeBase64Url(bytes);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const buffer = new ArrayBuffer(totalLength);
  const combined = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function encryptWebPushPayloadAes128Gcm(
  plaintextBytes: Uint8Array,
  clientPublicKeyBytes: Uint8Array<ArrayBuffer>,
  authSecretBytes: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const clientPublicKey = await crypto.subtle.importKey(
    'raw',
    clientPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  const serverKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  )) as CryptoKeyPair;

  const serverPublicKeyRaw = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);
  const serverPublicKeyBytes = new Uint8Array(serverPublicKeyRaw);

  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPublicKey },
    serverKeyPair.privateKey,
    256
  );

  const sharedSecretKey = await crypto.subtle.importKey(
    'raw',
    sharedSecretBits,
    'HKDF',
    false,
    ['deriveBits']
  );

  const keyInfo = concatBytes([
    new TextEncoder().encode('WebPush: info\0'),
    clientPublicKeyBytes,
    serverPublicKeyBytes,
  ]);

  const ikmBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: authSecretBytes,
      info: keyInfo,
    },
    sharedSecretKey,
    256
  );

  const ikmKey = await crypto.subtle.importKey(
    'raw',
    ikmBits,
    'HKDF',
    false,
    ['deriveKey', 'deriveBits']
  );

  const saltBuffer = new ArrayBuffer(AES_GCM_SALT_BYTE_LENGTH);
  const saltBytes = crypto.getRandomValues(new Uint8Array(saltBuffer));

  const contentEncryptionKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes,
      info: new TextEncoder().encode('Content-Encoding: aes128gcm\0'),
    },
    ikmKey,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt']
  );

  const nonceBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes,
      info: new TextEncoder().encode('Content-Encoding: nonce\0'),
    },
    ikmKey,
    96
  );

  const paddedPlaintext = concatBytes([
    plaintextBytes,
    new Uint8Array([FINAL_RECORD_PADDING_DELIMITER]),
  ]);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonceBits,
      tagLength: 128,
    },
    contentEncryptionKey,
    paddedPlaintext
  );

  const recordHeaderBuffer = new ArrayBuffer(
    RECORD_SIZE_FIELD_BYTE_LENGTH + KEY_ID_LENGTH_FIELD_BYTE_LENGTH
  );
  const recordHeaderView = new DataView(recordHeaderBuffer);
  recordHeaderView.setUint32(0, AES128GCM_RECORD_SIZE, false);
  recordHeaderView.setUint8(RECORD_SIZE_FIELD_BYTE_LENGTH, serverPublicKeyBytes.byteLength);

  return concatBytes([
    saltBytes,
    new Uint8Array(recordHeaderBuffer),
    serverPublicKeyBytes,
    new Uint8Array(ciphertextBuffer),
  ]);
}

interface SignedVapidJwt {
  jwt: string;
  expiresAtSeconds: number;
}

async function signVapidJwt(
  audienceOrigin: string,
  vapidConfig: VapidConfig,
  nowSeconds: number
): Promise<SignedVapidJwt> {
  const header = encodeJsonBase64Url({ typ: 'JWT', alg: 'ES256' });
  const expiresAtSeconds = nowSeconds + VAPID_TOKEN_TTL_SECONDS;
  const payload = encodeJsonBase64Url({
    aud: audienceOrigin,
    exp: expiresAtSeconds,
    sub: vapidConfig.subject,
  });
  const unsignedToken = `${header}.${payload}`;

  const publicKeyBytes = decodeBase64Url(vapidConfig.publicKey);
  if (
    publicKeyBytes.length !== P256_UNCOMPRESSED_PUBLIC_KEY_BYTE_LENGTH ||
    publicKeyBytes[0] !== P256_UNCOMPRESSED_PREFIX
  ) {
    throw new PushDeliveryError('Invalid uncompressed VAPID public key');
  }

  const xStart = 1;
  const yStart = xStart + P256_COORDINATE_BYTE_LENGTH;
  const xCoordinate = encodeBase64Url(
    publicKeyBytes.slice(xStart, xStart + P256_COORDINATE_BYTE_LENGTH)
  );
  const yCoordinate = encodeBase64Url(
    publicKeyBytes.slice(yStart, yStart + P256_COORDINATE_BYTE_LENGTH)
  );

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: xCoordinate,
      y: yCoordinate,
      d: vapidConfig.privateKey,
      ext: false,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const signature = encodeBase64Url(new Uint8Array(signatureBuffer));
  return { jwt: `${unsignedToken}.${signature}`, expiresAtSeconds };
}

interface CachedVapidJwt {
  pending: Promise<SignedVapidJwt>;
  expiresAtSeconds: number;
}

// 簽章要做一次 ECDSA 與 key import；同一個 isolate 內，同一個推播服務（audience）的所有裝置共用一張 JWT。
// 快取的是 promise，同時送往同一個推播服務的多個裝置只會簽一次。
const vapidJwtCache = new Map<string, CachedVapidJwt>();

/** 先清掉已過期的條目；仍超過上限時，再依插入順序淘汰最舊的。 */
function evictVapidJwtCacheEntries(nowSeconds: number): void {
  for (const [key, entry] of vapidJwtCache) {
    if (entry.expiresAtSeconds <= nowSeconds) {
      vapidJwtCache.delete(key);
    }
  }
  for (const key of vapidJwtCache.keys()) {
    if (vapidJwtCache.size < VAPID_JWT_CACHE_MAX_ENTRIES) {
      return;
    }
    vapidJwtCache.delete(key);
  }
}

async function getVapidJwt(
  audienceOrigin: string,
  vapidConfig: VapidConfig,
  nowSeconds: number
): Promise<string> {
  const cacheKey = `${vapidConfig.publicKey}|${vapidConfig.subject}|${audienceOrigin}`;
  const cached = vapidJwtCache.get(cacheKey);
  if (cached && cached.expiresAtSeconds - nowSeconds > VAPID_TOKEN_REFRESH_MARGIN_SECONDS) {
    return (await cached.pending).jwt;
  }

  evictVapidJwtCacheEntries(nowSeconds);
  const pending = signVapidJwt(audienceOrigin, vapidConfig, nowSeconds);
  vapidJwtCache.set(cacheKey, { pending, expiresAtSeconds: nowSeconds + VAPID_TOKEN_TTL_SECONDS });
  // 簽章失敗的結果不能留在快取裡，否則之後每次都拿到同一個失敗。呼叫端 await pending 時仍會收到原本的錯誤。
  pending.catch(() => vapidJwtCache.delete(cacheKey));
  return (await pending).jwt;
}

/** 推播送不到（網路、金鑰、簽章）屬於預期失敗，記錄後回報失敗；其他錯誤代表程式有問題，要往上拋。 */
function isExpectedPushFailure(
  error: unknown
): error is PushDeliveryError | TypeError | DOMException {
  return (
    error instanceof PushDeliveryError ||
    error instanceof TypeError ||
    error instanceof DOMException
  );
}

function createVapidHttpPushSender(vapidConfig: VapidConfig): PushSender {
  return async (subscription, payload): Promise<PushSendResult> => {
    const endpointUrl = new URL(subscription.endpoint);
    const audienceOrigin = `${endpointUrl.protocol}//${endpointUrl.host}`;
    const nowSeconds = Math.floor(Date.now() / 1000);

    try {
      const jwt = await getVapidJwt(audienceOrigin, vapidConfig, nowSeconds);
      const serializedPayload = JSON.stringify(payload);

      let requestBody: BodyInit = serializedPayload;
      const headers: Record<string, string> = {
        Authorization: `vapid t=${jwt}, k=${vapidConfig.publicKey}`,
        'Content-Type': 'application/json',
        TTL: String(PUSH_MESSAGE_TTL_SECONDS),
      };

      const clientPublicKeyBytes = decodeBase64Url(subscription.p256dh);
      const authSecretBytes = decodeBase64Url(subscription.auth);
      const hasValidWebPushKeys =
        clientPublicKeyBytes.length === P256_UNCOMPRESSED_PUBLIC_KEY_BYTE_LENGTH &&
        clientPublicKeyBytes[0] === P256_UNCOMPRESSED_PREFIX &&
        authSecretBytes.length === WEB_PUSH_AUTH_SECRET_BYTE_LENGTH;

      if (hasValidWebPushKeys) {
        const encryptedBody = await encryptWebPushPayloadAes128Gcm(
          new TextEncoder().encode(serializedPayload),
          clientPublicKeyBytes,
          authSecretBytes
        );
        requestBody = encryptedBody;
        headers['Content-Encoding'] = 'aes128gcm';
        headers['Content-Type'] = 'application/octet-stream';
      }

      const response = await fetch(subscription.endpoint, {
        method: 'POST',
        headers,
        body: requestBody,
      });

      return { statusCode: response.status };
    } catch (error) {
      if (isExpectedPushFailure(error)) {
        return { statusCode: HTTP_STATUS_SERVICE_UNAVAILABLE };
      }
      throw error;
    }
  };
}

type DeviceDeliveryOutcome = 'delivered' | 'removed_expired' | 'failed';

export class WebPushService {
  private readonly sender: PushSender;

  constructor(
    private readonly repo: PushSubscriptionRepository,
    options?: {
      sender?: PushSender;
      vapidConfig?: VapidConfig;
    }
  ) {
    if (options?.sender) {
      this.sender = options.sender;
    } else if (options?.vapidConfig) {
      this.sender = createVapidHttpPushSender(options.vapidConfig);
    } else {
      // 沒有 VAPID 設定就無法簽章，不能假裝送成功，否則 /api/push/test 會對使用者謊報。
      this.sender = async () => {
        throw new PushDeliveryError('未設定 VAPID 金鑰，無法送出推播');
      };
    }
  }

  async saveSubscription(
    userId: number,
    input: PushSubscriptionInput,
    now: Date = new Date()
  ): Promise<void> {
    await this.repo.upsertPushSubscription({
      userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      nowIso: now.toISOString(),
    });
    logInfo('push.subscription_saved', { userId });
  }

  /**
   * Sends a push notification to all registered devices for `userId`, in parallel.
   * Automatically removes expired subscriptions when the push server returns 404 or 410.
   * A failure on one device is logged and never throws, so it neither blocks the other devices
   * nor aborts the caller's database state changes.
   * Only the initial subscription lookup can reject.
   * `failedCount` counts devices that still hold a subscription but could not be reached (sender error or non-2xx),
   * so a caller can tell "no device subscribed" (all counts 0) from "device present but delivery failed".
   */
  async sendNotificationToUser(
    userId: number,
    payload: PushNotificationPayload
  ): Promise<{ deliveredCount: number; removedExpiredCount: number; failedCount: number }> {
    const subscriptions = await this.repo.fetchPushSubscriptionsByUserId(userId);

    const settledDeliveries = await Promise.allSettled(
      subscriptions.map((subscription) => this.deliverToDevice(userId, subscription, payload))
    );

    let deliveredCount = 0;
    let removedExpiredCount = 0;
    let failedCount = 0;
    for (const settled of settledDeliveries) {
      if (settled.status === 'rejected') {
        logError('push.delivery_unexpected_error', {
          userId,
          tag: payload.tag,
          errorMessage:
            settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
        });
        failedCount += 1;
        continue;
      }
      if (settled.value === 'delivered') {
        deliveredCount += 1;
      } else if (settled.value === 'removed_expired') {
        removedExpiredCount += 1;
      } else {
        failedCount += 1;
      }
    }

    return { deliveredCount, removedExpiredCount, failedCount };
  }

  private async deliverToDevice(
    userId: number,
    subscription: StoredPushSubscriptionRow,
    payload: PushNotificationPayload
  ): Promise<DeviceDeliveryOutcome> {
    let result: PushSendResult;
    try {
      result = await this.sender(subscription, payload);
    } catch (error) {
      if (isExpectedPushFailure(error)) {
        logWarn('push.delivery_exception', {
          userId,
          tag: payload.tag,
          errorMessage: error.message,
        });
        return 'failed';
      }
      throw error;
    }

    if (result.statusCode === HTTP_STATUS_NOT_FOUND || result.statusCode === HTTP_STATUS_GONE) {
      await this.repo.deletePushSubscriptionByEndpoint(subscription.endpoint);
      logInfo('push.subscription_removed_gone', {
        userId,
        statusCode: result.statusCode,
      });
      return 'removed_expired';
    }

    if (result.statusCode >= 200 && result.statusCode < 300) {
      return 'delivered';
    }

    logWarn('push.delivery_failed', {
      userId,
      statusCode: result.statusCode,
      tag: payload.tag,
    });
    return 'failed';
  }
}

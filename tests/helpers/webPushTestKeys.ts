const P256_UNCOMPRESSED_PUBLIC_KEY_BYTE_LENGTH = 65;
const P256_COORDINATE_BYTE_LENGTH = 32;
const ECDH_P256_SHARED_SECRET_BIT_LENGTH = 256;
const AUTH_SECRET_BYTE_LENGTH = 16;
const AES128GCM_SALT_BYTE_LENGTH = 16;
const RECORD_SIZE_FIELD_BYTE_LENGTH = 4;
const KEY_ID_LENGTH_FIELD_BYTE_LENGTH = 1;
const FINAL_RECORD_PADDING_DELIMITER = 0x02;

function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function hkdf(
  salt: BufferSource,
  inputKeyMaterial: BufferSource,
  info: BufferSource,
  byteLength: number
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', inputKeyMaterial, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    byteLength * 8
  );
  return new Uint8Array(bits);
}

/** 瀏覽器端的推播訂閱：`keys` 給 `subscribePush`，`decrypt` 解開推播服務收到的 aes128gcm 內容。 */
export interface TestPushSubscriber {
  keys: { p256dh: string; auth: string };
  decrypt: (encryptedBody: Uint8Array) => Promise<string>;
}

/**
 * 產生一組真的 Web Push 訂閱金鑰（P-256 公鑰加 16 bytes 驗證密鑰），
 * 並依 RFC 8291 實作接收端的解密，讓測試能驗證伺服器送出的密文真的解得開。
 */
export async function createTestPushSubscriber(): Promise<TestPushSubscriber> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(AUTH_SECRET_BYTE_LENGTH));
  if (publicKey.byteLength !== P256_UNCOMPRESSED_PUBLIC_KEY_BYTE_LENGTH) {
    throw new Error('exported ECDH public key is not an uncompressed P-256 point');
  }

  async function decrypt(encryptedBody: Uint8Array): Promise<string> {
    const salt = encryptedBody.slice(0, AES128GCM_SALT_BYTE_LENGTH);
    const keyIdLengthOffset = AES128GCM_SALT_BYTE_LENGTH + RECORD_SIZE_FIELD_BYTE_LENGTH;
    const keyIdLength = encryptedBody[keyIdLengthOffset]!;
    const keyIdOffset = keyIdLengthOffset + KEY_ID_LENGTH_FIELD_BYTE_LENGTH;
    const senderPublicKey = encryptedBody.slice(keyIdOffset, keyIdOffset + keyIdLength);
    const ciphertext = encryptedBody.slice(keyIdOffset + keyIdLength);

    const senderKey = await crypto.subtle.importKey(
      'raw',
      senderPublicKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    const sharedSecret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'ECDH', public: senderKey },
        keyPair.privateKey,
        ECDH_P256_SHARED_SECRET_BIT_LENGTH
      )
    );
    const keyInfo = concatBytes([
      new TextEncoder().encode('WebPush: info\0'),
      publicKey,
      senderPublicKey,
    ]);
    const inputKeyMaterial = await hkdf(authSecret, sharedSecret, keyInfo, 32);
    const contentEncryptionKey = await crypto.subtle.importKey(
      'raw',
      await hkdf(salt, inputKeyMaterial, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16),
      'AES-GCM',
      false,
      ['decrypt']
    );
    const nonce = await hkdf(salt, inputKeyMaterial, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

    const padded = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, contentEncryptionKey, ciphertext)
    );
    const delimiterIndex = padded.lastIndexOf(FINAL_RECORD_PADDING_DELIMITER);
    return new TextDecoder().decode(padded.slice(0, delimiterIndex));
  }

  return {
    keys: {
      p256dh: Buffer.from(publicKey).toString('base64url'),
      auth: Buffer.from(authSecret).toString('base64url'),
    },
    decrypt,
  };
}

export interface VapidClaims {
  aud: string;
  exp: number;
  sub: string;
}

/**
 * 解析推播請求的 `Authorization: vapid t=<jwt>, k=<公鑰>` 標頭，確認 `k` 是伺服器的 VAPID 公鑰、
 * JWT 的 ES256 簽章能用這把公鑰驗過，再回傳 JWT 的 claims。任何一項不符就丟錯。
 */
export async function readVerifiedVapidClaims(
  authorization: string,
  vapidPublicKey: string
): Promise<VapidClaims> {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(authorization);
  if (!match) {
    throw new Error(`Authorization is not in "vapid t=<jwt>, k=<key>" form: ${authorization}`);
  }
  const [, encodedHeader, encodedPayload, encodedSignature, publicKey] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (publicKey !== vapidPublicKey) {
    throw new Error('Authorization k is not the server VAPID public key');
  }

  const publicKeyBytes = Buffer.from(vapidPublicKey, 'base64url');
  const verificationKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: publicKeyBytes.subarray(1, 1 + P256_COORDINATE_BYTE_LENGTH).toString('base64url'),
      y: publicKeyBytes
        .subarray(1 + P256_COORDINATE_BYTE_LENGTH, 1 + 2 * P256_COORDINATE_BYTE_LENGTH)
        .toString('base64url'),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const isSignatureValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verificationKey,
    Buffer.from(encodedSignature, 'base64url'),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!isSignatureValid) {
    throw new Error('VAPID JWT signature does not verify with the VAPID public key');
  }
  return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()) as VapidClaims;
}

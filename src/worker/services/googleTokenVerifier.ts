import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';
import { AppError } from '../errors';

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
}

export type GoogleTokenVerifier = (idToken: string, clientId: string) => Promise<GoogleProfile>;

const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
// Google 的 ID Token 可能是這兩種 iss 寫法。
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
// Google 公開金鑰會輪替，但新金鑰會先公布；遇到未知 kid 時 jose 還是會重抓，所以這裡只決定平常多久更新一次。
const JWKS_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
// Google 憑證沒有 name 欄位、email 也取不出前綴時，改用這個暱稱。
const GOOGLE_FALLBACK_NICKNAME = 'Claude 版友';

// 這些都代表「這個 token 不可信」；JWKS 抓取逾時、回應格式錯誤、網路失敗等是系統問題，不在此列，要向上傳播。
const INVALID_TOKEN_ERRORS = [
  errors.JWTClaimValidationFailed,
  errors.JWTExpired,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

function createInvalidGoogleTokenError(message = 'Google 登入驗證失敗，請重試'): AppError {
  return new AppError('INVALID_GOOGLE_TOKEN', message, 401);
}

function toGoogleProfile(claims: Record<string, unknown>): GoogleProfile {
  const { sub, email, name, email_verified: isEmailVerified } = claims;
  if (typeof sub !== 'string' || !sub || typeof email !== 'string' || !email) {
    throw createInvalidGoogleTokenError('Google 憑證缺少必要帳號資訊');
  }
  if (isEmailVerified !== true) {
    throw createInvalidGoogleTokenError('Google 帳號的 Email 尚未驗證');
  }
  const [emailLocalPart = ''] = email.split('@');
  const displayName = typeof name === 'string' ? name.trim() : '';
  return { sub, email, name: displayName || emailLocalPart || GOOGLE_FALLBACK_NICKNAME };
}

/**
 * 建立用 Google JWKS 驗證 ID Token 的 verifier。
 * token 無效（簽章、aud、iss、exp、email_verified 任一不符）時丟 401 `AppError`；
 * 取得 JWKS 失敗是系統問題，錯誤會原樣向上傳播。
 * @param fetchJwks 取得 JWKS 的函式，測試時注入；不傳就用全域 `fetch`。
 */
export function createGoogleTokenVerifier(
  fetchJwks?: (url: string) => Promise<Response>
): GoogleTokenVerifier {
  // 金鑰快取存在這個 verifier 裡，所以要建立一次、跨請求共用（同一個 isolate）。
  const getKey = createRemoteJWKSet(GOOGLE_JWKS_URL, {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    [customFetch]: fetchJwks && ((url) => fetchJwks(url)),
  });

  return async (idToken, clientId) => {
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(idToken, getKey, {
        algorithms: ['RS256'],
        issuer: GOOGLE_ISSUERS,
        audience: clientId,
        requiredClaims: ['exp'],
      }));
    } catch (error) {
      if (INVALID_TOKEN_ERRORS.some((errorClass) => error instanceof errorClass)) {
        throw createInvalidGoogleTokenError();
      }
      throw error;
    }
    return toGoogleProfile(claims);
  };
}

export const defaultGoogleTokenVerifier = createGoogleTokenVerifier();

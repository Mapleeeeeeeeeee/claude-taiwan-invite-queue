import { DEMO_DEFAULT_NICKNAME, DEMO_TOKEN_PREFIX } from '../../shared/types';

/**
 * 根據暱稱建立穩定的本地展示用 Google 識別 token，確保相同暱稱登入對應同一帳號。
 * 只有 `devLoginEnabled` 的本機環境會用到，伺服器在正式環境會拒絕這種 token。
 */
export function buildDemoGoogleIdToken(nickname: string): string {
  const normalizedNickname = (nickname.trim() || DEMO_DEFAULT_NICKNAME).toLowerCase();
  return `${DEMO_TOKEN_PREFIX}${encodeURIComponent(normalizedNickname)}`;
}

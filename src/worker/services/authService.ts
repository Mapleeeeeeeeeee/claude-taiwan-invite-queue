import { sign, verify } from 'hono/jwt';
import {
  JwtAlgorithmMismatch,
  JwtHeaderInvalid,
  JwtTokenExpired,
  JwtTokenInvalid,
  JwtTokenSignatureMismatched,
} from 'hono/utils/jwt/types';
import {
  DEMO_DEFAULT_NICKNAME,
  DEMO_TOKEN_PREFIX,
  type LoggedInUserDto,
  type LoginResult,
} from '../../shared/types';
import type { UserRepository } from '../repositories/userRepository';
import {
  defaultGoogleTokenVerifier,
  type GoogleProfile,
  type GoogleTokenVerifier,
} from './googleTokenVerifier';

export const SESSION_COOKIE_NAME = 'claude_tw_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

interface SessionPayload {
  [key: string]: unknown;
  userId: number;
  email: string;
  exp: number;
}

const DEMO_FALLBACK_IDENTIFIER = 'member';
const DEMO_EMAIL_DOMAIN = 'google-demo.claude-tw.dev';
const DEV_LOGIN_SUB_PREFIX = 'dev-sub-';
// dev-login 沒帶暱稱、email 也取不出前綴時，登入者的暱稱。
const DEV_LOGIN_FALLBACK_NICKNAME = '測試版友';

function getEmailLocalPart(email: string): string {
  const [localPart = ''] = email.split('@');
  return localPart;
}

function decodeDemoIdentifier(rawIdentifier: string): string {
  try {
    return decodeURIComponent(rawIdentifier);
  } catch (error) {
    if (error instanceof URIError) {
      return rawIdentifier;
    }
    throw error;
  }
}

function buildDemoGoogleProfile(idToken: string): GoogleProfile {
  const rawIdentifier = idToken.slice(DEMO_TOKEN_PREFIX.length) || DEMO_FALLBACK_IDENTIFIER;
  const decodedName = decodeDemoIdentifier(rawIdentifier).trim();
  const identifier = decodedName.toLowerCase() || DEMO_FALLBACK_IDENTIFIER;
  return {
    sub: `${DEMO_TOKEN_PREFIX}${identifier}`,
    email: `${encodeURIComponent(identifier)}@${DEMO_EMAIL_DOMAIN}`,
    name: decodedName || DEMO_DEFAULT_NICKNAME,
  };
}

function toLoggedInUserDto(user: { id: number; email: string; nickname: string }): LoggedInUserDto {
  return { id: user.id, email: user.email, nickname: user.nickname };
}

export class AuthService {
  private readonly verifier: GoogleTokenVerifier;

  constructor(
    private readonly repo: UserRepository,
    private readonly sessionSecret: string,
    private readonly googleClientId: string,
    private readonly allowDemoTokens: boolean,
    verifier?: GoogleTokenVerifier
  ) {
    this.verifier = verifier ?? defaultGoogleTokenVerifier;
  }

  async loginWithGoogle(params: {
    idToken: string;
    nickname?: string;
    now?: Date;
  }): Promise<LoginResult & { sessionToken: string }> {
    const currentNow = params.now ?? new Date();
    const profile = await this.verifyGoogleIdToken(params.idToken);

    const user = await this.repo.upsertUserByGoogleProfile({
      googleSub: profile.sub,
      email: profile.email,
      defaultNickname: profile.name || getEmailLocalPart(profile.email),
      requestedNickname: params.nickname?.trim() || undefined,
      nowIso: currentNow.toISOString(),
    });

    const sessionToken = await this.createSessionToken(user.id, user.email, currentNow);
    return { user: toLoggedInUserDto(user), sessionToken };
  }

  async loginWithDevAccount(params: {
    email: string;
    nickname?: string;
    googleSub?: string;
    now?: Date;
  }): Promise<LoginResult & { sessionToken: string }> {
    const currentNow = params.now ?? new Date();
    const normalizedEmail = params.email.trim().toLowerCase();
    const googleSub = params.googleSub?.trim() || `${DEV_LOGIN_SUB_PREFIX}${normalizedEmail}`;

    const user = await this.repo.upsertUserByGoogleProfile({
      googleSub,
      email: normalizedEmail,
      defaultNickname: getEmailLocalPart(normalizedEmail) || DEV_LOGIN_FALLBACK_NICKNAME,
      requestedNickname: params.nickname?.trim() || undefined,
      nowIso: currentNow.toISOString(),
    });

    const sessionToken = await this.createSessionToken(user.id, user.email, currentNow);
    return { user: toLoggedInUserDto(user), sessionToken };
  }

  private async verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
    // 展示用 token 不經過 Google 驗證，所以只在 development 環境接受。
    if (this.allowDemoTokens && idToken.startsWith(DEMO_TOKEN_PREFIX)) {
      return buildDemoGoogleProfile(idToken);
    }
    return this.verifier(idToken, this.googleClientId);
  }

  async createSessionToken(
    userId: number,
    email: string,
    now: Date = new Date()
  ): Promise<string> {
    const payload: SessionPayload = {
      userId,
      email,
      exp: Math.floor(now.getTime() / 1000) + SESSION_MAX_AGE_SECONDS,
    };
    return sign(payload, this.sessionSecret, 'HS256');
  }

  async verifySessionToken(
    token: string,
    now: Date = new Date()
  ): Promise<SessionPayload | null> {
    try {
      const payload = (await verify(token, this.sessionSecret, {
        alg: 'HS256',
        exp: false,
      })) as Partial<SessionPayload>;
      if (
        typeof payload.userId !== 'number' ||
        typeof payload.email !== 'string' ||
        typeof payload.exp !== 'number'
      ) {
        return null;
      }

      const nowSeconds = Math.floor(now.getTime() / 1000);
      if (payload.exp <= nowSeconds) {
        return null;
      }

      return {
        userId: payload.userId,
        email: payload.email,
        exp: payload.exp,
      };
    } catch (error) {
      if (
        error instanceof JwtTokenInvalid ||
        error instanceof JwtHeaderInvalid ||
        error instanceof JwtAlgorithmMismatch ||
        error instanceof JwtTokenExpired ||
        error instanceof JwtTokenSignatureMismatched
      ) {
        return null;
      }
      throw error;
    }
  }
}

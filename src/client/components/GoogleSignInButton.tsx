import type { ReactNode } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { useGoogleSignIn } from './GoogleSignInProvider';

export interface GoogleSignInButtonProps {
  size: 'medium' | 'large';
  text: 'signin' | 'signin_with';
  /** 官方按鈕登入後不會自動接續動作，用這行字告訴使用者登入後要自己再按一次。 */
  hint?: string;
  /** 沒有 `GoogleSignInProvider`（本機開發）時顯示的自訂登入按鈕。 */
  fallback: ReactNode;
}

/**
 * Google 官方登入按鈕。GIS 的登入彈窗只能由它渲染的按鈕觸發，所以不能用自訂按鈕代替。
 */
export function GoogleSignInButton({ size, text, hint, fallback }: GoogleSignInButtonProps) {
  const googleSignIn = useGoogleSignIn();
  if (!googleSignIn) {
    return fallback;
  }

  if (googleSignIn.hasScriptFailed) {
    return (
      <div className="google-signin-slot google-signin-failed" role="alert">
        <span>Google 登入元件載入失敗，請確認網路連線後重試。</span>
        <button type="button" className="btn-header-login" onClick={googleSignIn.retryLoadingScript}>
          重新載入
        </button>
      </div>
    );
  }

  return (
    <div className="google-signin-slot">
      <GoogleLogin
        ux_mode="popup"
        theme="outline"
        shape="pill"
        size={size}
        text={text}
        onSuccess={({ credential }) => {
          if (credential) {
            googleSignIn.handleCredential(credential);
          }
        }}
      />
      {hint ? <p className="google-signin-hint">{hint}</p> : null}
    </div>
  );
}

import { useEffect, useId, useState, type ReactNode } from 'react';
import { useGoogleSignIn } from './GoogleSignInProvider';

export interface GoogleSignInButtonProps {
  size: 'medium' | 'large';
  text: 'signin' | 'signin_with';
  /** 官方按鈕登入後不會自動接續動作，用這行字告訴使用者登入後要自己再按一次。 */
  hint?: string;
  /** 沒有可用的 Google 設定（本機開發，或 `/api/me` 還沒回來）時顯示的自訂登入按鈕。 */
  fallback: ReactNode;
}

/**
 * Google 官方登入按鈕。GIS 的登入彈窗只能由它渲染的按鈕觸發，所以不能用自訂按鈕代替。
 */
export function GoogleSignInButton({ size, text, hint, fallback }: GoogleSignInButtonProps) {
  const googleSignIn = useGoogleSignIn();
  const id = useId();
  const [officialButtonSlot, setOfficialButtonSlot] = useState<HTMLDivElement | null>(null);
  const registerOfficialButton = googleSignIn?.registerOfficialButton;

  useEffect(() => {
    if (!officialButtonSlot || !registerOfficialButton) {
      return;
    }
    return registerOfficialButton({ id, slot: officialButtonSlot, size, text });
  }, [id, officialButtonSlot, registerOfficialButton, size, text]);

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
      <div ref={setOfficialButtonSlot} />
      {hint ? <p className="google-signin-hint">{hint}</p> : null}
    </div>
  );
}

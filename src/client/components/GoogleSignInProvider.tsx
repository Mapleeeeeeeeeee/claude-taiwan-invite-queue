import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { GoogleOAuthProvider } from '@react-oauth/google';

export interface GoogleSignInContextValue {
  /** 官方按鈕登入成功後呼叫；身分永遠指向最新的 `onCredential`，所以多顆按鈕可以共用。 */
  handleCredential: (credential: string) => void;
  hasScriptFailed: boolean;
  retryLoadingScript: () => void;
}

const GoogleSignInContext = createContext<GoogleSignInContextValue | null>(null);

/**
 * 取得 Google 官方登入按鈕的共用設定；不在 `GoogleSignInProvider` 底下（本機開發）時回傳 `null`。
 */
export function useGoogleSignIn(): GoogleSignInContextValue | null {
  return useContext(GoogleSignInContext);
}

export interface GoogleSignInProviderProps {
  clientId: string;
  onCredential: (credential: string) => void;
  children: ReactNode;
}

/**
 * 載入 Google Identity Services 並讓底下的 `GoogleSignInButton` 能渲染官方按鈕。
 * 只有正式環境才掛載它，本機開發不載入 Google 的 script。
 * 重試時換掉 `GoogleOAuthProvider` 的 key 讓它重新插入 script，所以底下的元件會重新掛載。
 */
export function GoogleSignInProvider({ clientId, onCredential, children }: GoogleSignInProviderProps) {
  const [scriptAttempt, setScriptAttempt] = useState(0);
  const [hasScriptFailed, setHasScriptFailed] = useState(false);
  const onCredentialRef = useRef(onCredential);
  onCredentialRef.current = onCredential;

  const handleCredential = useCallback((credential: string) => {
    onCredentialRef.current(credential);
  }, []);
  const retryLoadingScript = useCallback(() => {
    setHasScriptFailed(false);
    setScriptAttempt((attempt) => attempt + 1);
  }, []);
  const contextValue = useMemo(
    () => ({ handleCredential, hasScriptFailed, retryLoadingScript }),
    [handleCredential, hasScriptFailed, retryLoadingScript]
  );

  return (
    <GoogleOAuthProvider
      key={scriptAttempt}
      clientId={clientId}
      locale="zh-TW"
      onScriptLoadError={() => setHasScriptFailed(true)}
    >
      <GoogleSignInContext.Provider value={contextValue}>{children}</GoogleSignInContext.Provider>
    </GoogleOAuthProvider>
  );
}

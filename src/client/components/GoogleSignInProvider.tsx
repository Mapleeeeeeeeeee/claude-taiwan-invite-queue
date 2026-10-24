import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { GoogleLogin, GoogleOAuthProvider } from '@react-oauth/google';

export interface OfficialButtonRequest {
  id: string;
  /** 官方按鈕要畫進去的容器。 */
  slot: HTMLElement;
  size: 'medium' | 'large';
  text: 'signin' | 'signin_with';
}

export interface GoogleSignInContextValue {
  /** 官方按鈕登入成功後呼叫；身分永遠指向最新的 `onCredential`，所以多顆按鈕可以共用。 */
  handleCredential: (credential: string) => void;
  hasScriptFailed: boolean;
  retryLoadingScript: () => void;
  /** 登記一顆要渲染官方按鈕的容器，回傳取消登記的函式。 */
  registerOfficialButton: (request: OfficialButtonRequest) => () => void;
}

const GoogleSignInContext = createContext<GoogleSignInContextValue | null>(null);

/**
 * 取得 Google 官方登入按鈕的共用設定；`GoogleSignInProvider` 的 `clientId` 為 `null`（本機開發，
 * 或 `/api/me` 還沒回來）時回傳 `null`。
 */
export function useGoogleSignIn(): GoogleSignInContextValue | null {
  return useContext(GoogleSignInContext);
}

export interface GoogleSignInProviderProps {
  /** 為 `null` 時不載入 Google 的 script，底下的按鈕改顯示自訂的登入按鈕。 */
  clientId: string | null;
  onCredential: (credential: string) => void;
  children: ReactNode;
}

/**
 * 載入 Google Identity Services 並讓底下的 `GoogleSignInButton` 能渲染官方按鈕。
 * 本機開發不載入 Google 的 script，所以 `clientId` 只有在正式環境才會有值。
 *
 * `GoogleLogin` 一定要在 `GoogleOAuthProvider` 底下，但把整頁包進 `GoogleOAuthProvider` 會讓
 * `clientId` 從 `null` 變成有值的那一刻整頁重新掛載。所以 `GoogleOAuthProvider` 只和 `children` 並排，
 * 官方按鈕用 portal 畫進各個按鈕的容器，`children` 的位置不隨 `clientId` 改變。
 * 重試時換掉 `GoogleOAuthProvider` 的 key 讓它重新插入 script，只有官方按鈕會重新渲染。
 */
export function GoogleSignInProvider({ clientId, onCredential, children }: GoogleSignInProviderProps) {
  const [scriptAttempt, setScriptAttempt] = useState(0);
  const [hasScriptFailed, setHasScriptFailed] = useState(false);
  const [officialButtons, setOfficialButtons] = useState<readonly OfficialButtonRequest[]>([]);
  const onCredentialRef = useRef(onCredential);
  onCredentialRef.current = onCredential;

  const handleCredential = useCallback((credential: string) => {
    onCredentialRef.current(credential);
  }, []);
  const retryLoadingScript = useCallback(() => {
    setHasScriptFailed(false);
    setScriptAttempt((attempt) => attempt + 1);
  }, []);
  const registerOfficialButton = useCallback((request: OfficialButtonRequest) => {
    setOfficialButtons((buttons) => [...buttons, request]);
    return () => setOfficialButtons((buttons) => buttons.filter((button) => button !== request));
  }, []);
  const contextValue = useMemo(
    () =>
      clientId === null
        ? null
        : { handleCredential, hasScriptFailed, retryLoadingScript, registerOfficialButton },
    [clientId, handleCredential, hasScriptFailed, retryLoadingScript, registerOfficialButton]
  );

  return (
    <GoogleSignInContext.Provider value={contextValue}>
      {children}
      {clientId === null ? null : (
        <GoogleOAuthProvider
          key={scriptAttempt}
          clientId={clientId}
          locale="zh-TW"
          onScriptLoadError={() => setHasScriptFailed(true)}
        >
          {officialButtons.map((button) =>
            createPortal(
              <GoogleLogin
                ux_mode="popup"
                theme="outline"
                shape="pill"
                size={button.size}
                text={button.text}
                onSuccess={({ credential }) => {
                  if (credential) {
                    handleCredential(credential);
                  }
                }}
              />,
              button.slot,
              button.id
            )
          )}
        </GoogleOAuthProvider>
      )}
    </GoogleSignInContext.Provider>
  );
}

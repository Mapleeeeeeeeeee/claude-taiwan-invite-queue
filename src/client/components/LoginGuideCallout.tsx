import { GoogleBrandIcon } from './GoogleBrandIcon';
import { GoogleSignInButton } from './GoogleSignInButton';

export interface LoginGuideCalloutProps {
  onRequireLogin: () => void;
  isSubmitting: boolean;
  message?: string;
}

export function LoginGuideCallout({
  onRequireLogin,
  isSubmitting,
  message,
}: LoginGuideCalloutProps) {
  return (
    <div className="login-guide-callout" role="region" aria-label="登入引導提示">
      <div className="login-guide-main">
        <div className="login-guide-icon-pill">
          <GoogleBrandIcon size={20} />
        </div>
        <div className="login-guide-text-wrap">
          <strong className="login-guide-title">請先使用 Google 帳號登入</strong>
          <p className="login-guide-desc">
            {message || '登入後系統將為你自動配對邀請碼並保留名額，且可接收手機推播提醒。'}
          </p>
        </div>
      </div>
      <GoogleSignInButton
        size="medium"
        text="signin_with"
        fallback={
          <button
            type="button"
            className="btn-google-login-action"
            onClick={onRequireLogin}
            disabled={isSubmitting}
          >
            <GoogleBrandIcon size={16} />
            <span>立即使用 Google 帳號登入</span>
          </button>
        }
      />
    </div>
  );
}

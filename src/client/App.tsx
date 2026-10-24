import { useCallback, useEffect, useState } from 'react';
import { googleLogout } from '@react-oauth/google';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Cancel01Icon,
  CheckmarkCircle01Icon,
  Facebook01Icon,
  UserCircleIcon,
} from '@hugeicons/core-free-icons';
import { BoardStats } from './components/BoardStats';
import { ClaudeSparkLogo } from './components/ClaudeSparkLogo';
import { GoogleBrandIcon } from './components/GoogleBrandIcon';
import { ProviderPanel } from './components/ProviderPanel';
import { PullToRefreshIndicator } from './components/PullToRefreshIndicator';
import { DevDock } from './components/DevDock';
import { InAppBrowserAlert } from './components/InAppBrowserAlert';
import { PwaInstallBanner } from './components/PwaInstallBanner';
import { PwaInstallProvider } from './components/PwaInstallProvider';
import { ReceiverPanel } from './components/ReceiverPanel';
import { ThankYouWall } from './components/ThankYouWall';
import type { ThankYouWallItemDto } from '../shared/types';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { GoogleSignInProvider } from './components/GoogleSignInProvider';
import {
  useInviteApp,
  type UseInviteAppOptions,
  type UseInviteAppReturn,
} from './hooks/useInviteApp';
import { buildDemoGoogleIdToken } from './utils/demoGoogleIdToken';

const FACEBOOK_GROUP_URL = 'https://www.facebook.com/groups/1224997379198346';
const TOAST_DURATION_MS = 3200;
// 看板尚未載入時共用同一個空陣列，避免每次 render 都產生新參照而讓感謝牆重算。
const NO_THANK_YOU_ITEMS: ThankYouWallItemDto[] = [];

export interface AppProps {
  hookOptions?: UseInviteAppOptions;
}

export function App({ hookOptions }: AppProps) {
  const vm = useInviteApp(hookOptions);

  // 官方按鈕登入後不會接續任何動作，使用者已填的暱稱隨登入一起送出，其餘輸入保留在畫面上。
  const handleGoogleCredential = (credential: string) => {
    void vm.loginWithGoogle(credential, vm.providedNickname);
  };

  // 本機開發的 GOOGLE_CLIENT_ID 是假值，所以 devLoginEnabled 時不載入 Google 的 script。
  const googleClientId = vm.me && !vm.me.devLoginEnabled ? vm.me.googleClientId : null;

  return (
    <PwaInstallProvider>
      <GoogleSignInProvider clientId={googleClientId} onCredential={handleGoogleCredential}>
        <AppContent vm={vm} />
      </GoogleSignInProvider>
    </PwaInstallProvider>
  );
}

function AppContent({ vm }: { vm: UseInviteAppReturn }) {
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const { refreshAll, clearMessages } = vm;
  const refreshBoardAndMe = useCallback(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (vm.actionSuccessMessage) {
      setToastMessage(vm.actionSuccessMessage);
      const timer = window.setTimeout(() => {
        setToastMessage(null);
        clearMessages();
      }, TOAST_DURATION_MS);
      return () => window.clearTimeout(timer);
    }
    setToastMessage(null);
  }, [vm.actionSuccessMessage, clearMessages]);

  // 只有本機開發會走到這裡（正式環境改由 Google 官方按鈕登入）。
  async function handleRequireLogin() {
    await vm.loginWithGoogle(buildDemoGoogleIdToken(vm.providedNickname ?? ''), vm.providedNickname);
  }

  const user = vm.me?.user ?? null;

  return (
    <div className="app-shell">
      <PullToRefreshIndicator onRefresh={refreshAll} />

      <header className="app-header">
        <div className="app-container header-inner">
          <div className="header-brand">
            <a
              href={FACEBOOK_GROUP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="brand-lockup-link"
              title="前往 Claude Taiwan Facebook 社團"
            >
              <ClaudeSparkLogo size={20} className="brand-spark-icon" />
              <span className="brand-community-title">Claude Taiwan</span>
            </a>
            <span className="brand-divider" aria-hidden="true" />
            <h1 className="app-title">邀請碼排隊平台</h1>
          </div>

          <div className="header-actions">
            {user ? (
              <div className="header-user-status" data-testid="header-user-status">
                <HugeiconsIcon icon={UserCircleIcon} size={18} className="header-user-icon" />
                <span className="header-user-name">
                  {user.nickname}
                </span>
                <span className="header-user-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="btn-header-logout"
                  onClick={() => {
                    googleLogout();
                    void vm.logout();
                  }}
                  disabled={vm.isSubmitting}
                >
                  登出
                </button>
              </div>
            ) : (
              <GoogleSignInButton
                size="medium"
                text="signin"
                fallback={
                  <button
                    type="button"
                    className="btn-header-login"
                    onClick={() => void handleRequireLogin()}
                    disabled={vm.isSubmitting}
                  >
                    <GoogleBrandIcon size={15} />
                    <span>Google 帳號登入</span>
                  </button>
                }
              />
            )}
          </div>
        </div>
      </header>

      <main className="app-container app-main">
        <InAppBrowserAlert />
        <PwaInstallBanner />

        <section className="hero-section">
          <h2 className="hero-title">社群邀請碼互助排隊</h2>

          <BoardStats
            board={vm.board}
            isLoading={vm.isLoading}
            boardError={vm.boardError}
            onRefresh={refreshBoardAndMe}
          />
        </section>

        <div className="workspace-card">
          <div className="workspace-tabs-bar" role="tablist" aria-label="功能切換">
            <button
              type="button"
              role="tab"
              aria-selected={vm.activeTab === 'receiver'}
              className={`workspace-tab-btn ${
                vm.activeTab === 'receiver' ? 'tab-btn-active' : ''
              }`}
              onClick={() => {
                clearMessages();
                vm.setActiveTab('receiver');
              }}
            >
              我要排隊領取
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={vm.activeTab === 'provider'}
              className={`workspace-tab-btn ${
                vm.activeTab === 'provider' ? 'tab-btn-active' : ''
              }`}
              onClick={() => {
                clearMessages();
                vm.setActiveTab('provider');
              }}
            >
              我要分享邀請碼
            </button>
          </div>

          <div className="workspace-content">
            {vm.activeTab === 'receiver' ? (
              <ReceiverPanel
                me={vm.me}
                isSubmitting={vm.isSubmitting}
                actionError={vm.actionError}
                isLoginRequired={vm.isLoginRequired}
                nicknameInput={vm.nicknameInput}
                thankYouMessageInput={vm.thankYouMessageInput}
                isEligibleForNewbieTrack={vm.isEligibleForNewbieTrack}
                isReportInvalidConfirmOpen={vm.isReportInvalidConfirmOpen}
                onNicknameChange={vm.setNicknameInput}
                onThankYouMessageChange={vm.setThankYouMessageInput}
                onJoinQueue={vm.joinQueue}
                onRevealSlot={vm.revealSlot}
                onConfirmSlot={vm.confirmSlot}
                onOpenReportInvalidConfirm={vm.openReportInvalidConfirm}
                onCloseReportInvalidConfirm={vm.closeReportInvalidConfirm}
                onReportSlotInvalid={vm.reportSlotInvalid}
                onCancelQueue={vm.cancelQueue}
                onCountdownExpire={refreshBoardAndMe}
                onRequireLogin={() => void handleRequireLogin()}
                push={vm.push}
                onTestPush={vm.testPushNotification}
              />
            ) : (
              <ProviderPanel
                me={vm.me}
                isSubmitting={vm.isSubmitting}
                actionError={vm.actionError}
                isLoginRequired={vm.isLoginRequired}
                nicknameInput={vm.nicknameInput}
                rawUrlInput={vm.rawUrlInput}
                slotCountInput={vm.slotCountInput}
                providerTrackInput={vm.providerTrackInput}
                onNicknameChange={vm.setNicknameInput}
                onRawUrlChange={vm.setRawUrlInput}
                onSlotCountChange={vm.setSlotCountInput}
                onProviderTrackChange={vm.setProviderTrackInput}
                onSubmitInviteLink={vm.submitInviteLink}
                push={vm.push}
                onRequireLogin={() => void handleRequireLogin()}
                onTestPush={vm.testPushNotification}
              />
            )}
          </div>
        </div>

        <ThankYouWall
          items={vm.board?.thankYouWall ?? NO_THANK_YOU_ITEMS}
          isLoading={vm.isLoading}
          boardError={vm.boardError}
          onRetry={refreshBoardAndMe}
        />
      </main>

      <footer className="app-footer">
        <div className="app-container">
          <div className="footer-links-row">
            <a
              href={FACEBOOK_GROUP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="footer-community-link"
              title="前往 Claude Taiwan Facebook 社團"
            >
              <HugeiconsIcon icon={Facebook01Icon} size={15} />
              <span>Claude Taiwan</span>
            </a>
            <span className="footer-divider" aria-hidden="true">/</span>
            <span className="footer-author-credit">
              由{' '}
              <a
                href="https://www.facebook.com/mapleeekuo/"
                target="_blank"
                rel="noopener noreferrer"
                className="footer-author-link"
                title="作者：Maple Kuo"
              >
                Maple Kuo
              </a>{' '}
              開發
            </span>
          </div>
        </div>
      </footer>

      {vm.me?.devLoginEnabled ? (
        <DevDock
          isSubmitting={vm.isSubmitting}
          onDevLogin={vm.loginWithDevAccount}
        />
      ) : null}

      {toastMessage ? (
        <div className="floating-toast" role="status">
          <HugeiconsIcon icon={CheckmarkCircle01Icon} size={16} className="toast-icon" />
          <span className="toast-text">{toastMessage}</span>
          <button
            type="button"
            className="btn-toast-close"
            onClick={() => {
              setToastMessage(null);
              clearMessages();
            }}
            aria-label="關閉訊息"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

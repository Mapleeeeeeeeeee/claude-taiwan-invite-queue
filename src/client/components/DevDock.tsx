import type { DevLoginPayload } from '../api/apiClient';

const DEV_TEST_ACCOUNTS: Array<{ label: string; email: string; nickname: string }> = [
  { label: '提供者小張', email: 'provider1@claude-tw.dev', nickname: '小張' },
  { label: '領取者小華', email: 'receiver1@claude-tw.dev', nickname: '小華' },
  { label: '領取者小美', email: 'receiver2@claude-tw.dev', nickname: '小美' },
];

export interface DevDockProps {
  isSubmitting: boolean;
  onDevLogin: (payload: DevLoginPayload) => Promise<boolean>;
}

export function DevDock({ isSubmitting, onDevLogin }: DevDockProps) {
  return (
    <aside className="dev-dock" aria-label="開發環境快捷登入">
      <div className="app-container dev-dock-inner">
        <span className="dev-dock-tag">開發測試</span>
        <div className="dev-dock-buttons">
          {DEV_TEST_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              className="btn-dev-pill"
              disabled={isSubmitting}
              onClick={() =>
                void onDevLogin({
                  email: account.email,
                  nickname: account.nickname,
                })
              }
            >
              {account.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

import type { ReactNode } from 'react';
import { PwaInstallContext, usePwaInstallState } from '../hooks/usePwaInstall';
import { IosInstallGuideDialog } from './IosInstallGuideDialog';

/**
 * 持有整個頁面唯一一份 PWA 安裝狀態與 iOS 引導視窗，橫幅和推播按鈕都從 `usePwaInstall` 讀它。
 * 它放在 Google 登入元件之上，`beforeinstallprompt` 的監聽才不會因為 `/api/me` 回來後樹狀結構變動而重建。
 */
export function PwaInstallProvider({ children }: { children: ReactNode }) {
  const installState = usePwaInstallState();

  return (
    <PwaInstallContext.Provider value={installState}>
      {children}
      {installState.isIosGuideOpen ? (
        <IosInstallGuideDialog onClose={installState.closeIosGuide} />
      ) : null}
    </PwaInstallContext.Provider>
  );
}

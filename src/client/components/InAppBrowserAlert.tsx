import { HugeiconsIcon } from '@hugeicons/react';
import { AlertCircleIcon, Copy01Icon, Tick01Icon } from '@hugeicons/core-free-icons';
import { useClipboardCopy } from '../hooks/useClipboardCopy';
import { detectInAppBrowser } from '../utils/browserEnvironment';

export function InAppBrowserAlert() {
  const inAppBrowser = detectInAppBrowser();
  const { hasCopied, copyText } = useClipboardCopy();

  if (!inAppBrowser.isInAppBrowser) {
    return null;
  }

  return (
    <div
      className="in-app-browser-alert"
      role="alert"
      data-testid="in-app-browser-alert"
    >
      <div className="in-app-browser-content">
        <div className="in-app-browser-title">
          <HugeiconsIcon icon={AlertCircleIcon} size={15} />
          <strong>偵測到 {inAppBrowser.appName ?? 'App'} 內建瀏覽器</strong>
        </div>
        <p>如需鎖定畫面推播，請點選選單以預設瀏覽器（Safari / Chrome）開啟。</p>
      </div>
      <button
        type="button"
        className="btn btn-outline btn-xs btn-icon"
        onClick={() => void copyText(window.location.href)}
      >
        <HugeiconsIcon icon={hasCopied ? Tick01Icon : Copy01Icon} size={13} />
        <span>{hasCopied ? '已複製' : '複製網址以瀏覽器開啟'}</span>
      </button>
    </div>
  );
}

import { HugeiconsIcon } from "@hugeicons/react";
import { SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { usePwaInstall } from "../hooks/usePwaInstall";

export function PwaInstallBanner() {
  const pwa = usePwaInstall();

  if (!pwa.isInstallable) {
    return null;
  }

  return (
    <div className="pwa-install-banner" data-testid="pwa-install-banner">
      <div className="pwa-install-info">
        <HugeiconsIcon
          icon={SmartPhone01Icon}
          size={16}
          className="pwa-icon"
        />
        <div className="pwa-text-wrap">
          <strong>可加到手機主畫面（PWA）</strong>
          <p>支援鎖定畫面推播提醒，排到名額不漏接。</p>
        </div>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-xs btn-icon"
        onClick={() => void pwa.installPwa()}
      >
        <HugeiconsIcon icon={SmartPhone01Icon} size={13} />
        <span>{pwa.isIos ? "加入 iPhone" : "加入主畫面"}</span>
      </button>
    </div>
  );
}

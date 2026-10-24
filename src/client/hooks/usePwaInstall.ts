import { useEffect, useState } from 'react';
import { detectStandalonePwa } from '../utils/browserEnvironment';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

export interface UsePwaInstallResult {
  isInstallable: boolean;
  isStandalone: boolean;
  isIos: boolean;
  isIosGuideOpen: boolean;
  installPwa: () => Promise<boolean>;
  openIosGuide: () => void;
  closeIosGuide: () => void;
}

/**
 * 提供 PWA 加入主畫面（A2HS）的安裝狀態、提示對話框觸發與 iOS Safari 引導操作。
 */
export function usePwaInstall(): UsePwaInstallResult {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(false);
  const [isIos, setIsIos] = useState<boolean>(false);
  const [isIosGuideOpen, setIsIosGuideOpen] = useState<boolean>(false);

  useEffect(() => {
    setIsStandalone(detectStandalonePwa());

    const ua = navigator.userAgent || '';
    const isIosDevice =
      (/iPad|iPhone|iPod/i.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) &&
      !('MSStream' in window);
    setIsIos(isIosDevice);

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
      setIsIosGuideOpen(false);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const installPwa = async (): Promise<boolean> => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      const isAccepted = choice.outcome === 'accepted';
      if (isAccepted) {
        setDeferredPrompt(null);
      }
      return isAccepted;
    }

    if (isIos && !isStandalone) {
      setIsIosGuideOpen(true);
    }
    return false;
  };

  const isInstallable = !isStandalone && (deferredPrompt !== null || isIos);

  return {
    isInstallable,
    isStandalone,
    isIos,
    isIosGuideOpen,
    installPwa,
    openIosGuide: () => setIsIosGuideOpen(true),
    closeIosGuide: () => setIsIosGuideOpen(false),
  };
}

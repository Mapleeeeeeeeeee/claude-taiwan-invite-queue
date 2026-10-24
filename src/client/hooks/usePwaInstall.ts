import { createContext, useContext, useEffect, useState } from 'react';
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

export const PwaInstallContext = createContext<UsePwaInstallResult | null>(null);

/**
 * 取得整個頁面共用的 PWA 安裝狀態、安裝動作與 iOS Safari 安裝引導的開關。
 * 在 `PwaInstallProvider` 之外呼叫會丟出錯誤。
 */
export function usePwaInstall(): UsePwaInstallResult {
  const installState = useContext(PwaInstallContext);
  if (!installState) {
    throw new Error('usePwaInstall 必須在 PwaInstallProvider 底下使用');
  }
  return installState;
}

/**
 * 由 `PwaInstallProvider` 呼叫來監聽瀏覽器的安裝事件並保存安裝狀態，整個頁面只能呼叫一次。
 */
export function usePwaInstallState(): UsePwaInstallResult {
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

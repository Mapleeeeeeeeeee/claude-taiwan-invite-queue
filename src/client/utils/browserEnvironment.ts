export interface InAppBrowserDetection {
  isInAppBrowser: boolean;
  appName: string | null;
}

const IN_APP_BROWSER_RULES: Array<{ pattern: RegExp; appName: string }> = [
  { pattern: /FBAN|FBAV|FB_IAB|FBIOS|Messenger/i, appName: 'Facebook / Messenger' },
  { pattern: /\bLine\//i, appName: 'LINE' },
  { pattern: /Instagram/i, appName: 'Instagram' },
  { pattern: /Barcelona|Threads/i, appName: 'Threads' },
  { pattern: /MicroMessenger/i, appName: 'WeChat' },
  { pattern: /; wv\)/i, appName: 'App 內建瀏覽器' },
];

/**
 * 偵測目前是否處於社群軟體（Facebook、LINE、Instagram、Threads 等）的內建瀏覽器（In-App Browser）。
 */
export function detectInAppBrowser(userAgent?: string): InAppBrowserDetection {
  const ua = userAgent ?? navigator.userAgent;
  for (const rule of IN_APP_BROWSER_RULES) {
    if (rule.pattern.test(ua)) {
      return { isInAppBrowser: true, appName: rule.appName };
    }
  }

  return { isInAppBrowser: false, appName: null };
}

/**
 * 偵測目前網頁是否已安裝並以獨立 PWA 視窗（Standalone 模式）執行。
 */
export function detectStandalonePwa(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

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
 * 判斷 User-Agent 是否來自社群軟體（Facebook、LINE、Instagram、Threads 等）的內建瀏覽器。
 * 未傳 `userAgent` 時檢查 `navigator.userAgent`。
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

export function detectStandalonePwa(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

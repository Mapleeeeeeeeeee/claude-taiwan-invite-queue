import { describe, expect, it } from 'vitest';
import { detectInAppBrowser } from '../../src/client/utils/browserEnvironment';

describe('detectInAppBrowser', () => {
  it.each([
    [
      'Facebook iOS',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.38.108]',
      'Facebook / Messenger',
    ],
    [
      'LINE Android',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 Line/14.6.1',
      'LINE',
    ],
    [
      'Instagram iOS',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0',
      'Instagram',
    ],
    [
      'Android 通用 WebView',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36',
      'App 內建瀏覽器',
    ],
  ])('把 %s 判定為內建瀏覽器並回報 App 名稱', (_label, userAgent, expectedAppName) => {
    expect(detectInAppBrowser(userAgent)).toEqual({
      isInAppBrowser: true,
      appName: expectedAppName,
    });
  });

  it.each([
    [
      'iOS Safari',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    ],
    [
      'Android Chrome',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
    ],
    ['空字串', ''],
  ])('不把 %s 判定為內建瀏覽器', (_label, userAgent) => {
    expect(detectInAppBrowser(userAgent)).toEqual({
      isInAppBrowser: false,
      appName: null,
    });
  });
});

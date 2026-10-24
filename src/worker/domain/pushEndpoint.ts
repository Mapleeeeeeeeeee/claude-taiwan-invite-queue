// 伺服器會對訂閱網址發 POST，所以只收瀏覽器推播服務的主機，不讓使用者指定任意網址。
// Chrome 與 Android 用 fcm.googleapis.com（Chromium 的 push_messaging_constants.cc；同檔的 jmt17.google.com 是 staging，不收）。
// Firefox 用 updates.push.services.mozilla.com（Mozilla autopush 文件）。
// Safari 與 iOS 用 web.push.apple.com，Apple 文件要求放行 *.push.apple.com。
// Edge 用 *.notify.windows.com，Microsoft WNS 文件規定通道網址的網域是 notify.windows.com。
const PUSH_SERVICE_HOSTNAMES: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
];
const PUSH_SERVICE_HOSTNAME_SUFFIXES: readonly string[] = [
  '.push.apple.com',
  '.notify.windows.com',
];

/**
 * 判斷訂閱網址是否指向已知的瀏覽器推播服務。
 * 只收預設連接埠、不帶帳密的 https 網址；無法解析的字串回 `false`。
 */
export function isKnownPushServiceEndpoint(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) {
    return false;
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  return (
    PUSH_SERVICE_HOSTNAMES.includes(url.hostname) ||
    PUSH_SERVICE_HOSTNAME_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))
  );
}

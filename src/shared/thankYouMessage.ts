/**
 * 感謝小卡的字數：去除前後空白後，以 Unicode 碼點計算（一個 emoji 算 1 字）。
 * 前端計數器與後端驗證共用這個函式，兩邊對同一段文字不會算出不同字數。
 */
export function countThankYouMessageChars(message: string): number {
  return Array.from(message.trim()).length;
}

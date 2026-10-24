// 這組字元用頁面字型畫出來沒有墨水，單獨出現時感謝牆上看起來是空白；U+2800 不在 Default_Ignorable_Code_Point 內，所以另外列出。
const INVISIBLE_CHARS = /[\s\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/**
 * 文字去掉空白與不可見字元（零寬空白、零寬連接符、雙向控制字元、填充字元等）後，是否至少剩一個字元。
 * 只有這類字元的文字能通過長度下限，但顯示出來是空白，所以感謝小卡與暱稱的前後端驗證共用這條規則。
 */
export function hasVisibleText(text: string): boolean {
  return text.replace(INVISIBLE_CHARS, '').length > 0;
}

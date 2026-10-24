import { describe, expect, it } from 'vitest';
import { hasVisibleText } from '../../src/shared/visibleText';

describe('hasVisibleText', () => {
  it.each([
    { name: '5 個零寬空白（U+200B）', message: '​'.repeat(5), expected: false },
    { name: '零寬連接符（ZWJ）與零寬非連接符', message: '‍‌‍‌‍', expected: false },
    { name: '雙向覆寫字元', message: '‮‭‬⁦⁩', expected: false },
    { name: '全是空白、tab 與換行', message: '  \t\n  ', expected: false },
    { name: '空白與零寬字元混合', message: ' ​ ​\n﻿', expected: false },
    { name: '空字串', message: '', expected: false },
    { name: 'Hangul Filler（U+3164）', message: '\u3164', expected: false },
    { name: 'Halfwidth Hangul Filler（U+FFA0）', message: '\uFFA0', expected: false },
    { name: 'Braille Pattern Blank（U+2800）', message: '\u2800', expected: false },
    { name: '單獨的 Variation Selector-16（U+FE0F）', message: '\uFE0F', expected: false },
    { name: '3 個 Variation Selector-16', message: '\uFE0F'.repeat(3), expected: false },
    { name: 'Combining Grapheme Joiner（U+034F）', message: '\u034F', expected: false },
    { name: '填充字元與空白混合', message: '\u3164 \u2800\u200B\uFE0F', expected: false },
    { name: '零寬字元夾一個可見字', message: '​​謝​​', expected: true },
    { name: '一般中文', message: '謝謝你分享', expected: true },
    { name: 'emoji', message: '😀', expected: true },
    { name: '結尾帶 ZWJ 的文字', message: '謝謝你分享‍', expected: true },
    { name: '帶 U+FE0F 的 emoji（❤️）', message: '\u2764\uFE0F', expected: true },
    { name: '含 ZWJ 的 emoji 序列（👨‍👩‍👧）', message: '👨\u200D👩\u200D👧', expected: true },
    { name: '中英文與標點', message: 'Hello, 世界！', expected: true },
    { name: '帶組合記號的字母（e + U+0301）', message: 'e\u0301', expected: true },
  ])('$name 回 $expected', ({ message, expected }) => {
    expect(hasVisibleText(message)).toBe(expected);
  });
});

import { describe, expect, it } from 'vitest';
import { countThankYouMessageChars } from '../../src/shared/thankYouMessage';

describe('countThankYouMessageChars', () => {
  it.each([
    { name: '一個 emoji 算 1 字', message: '😀', expected: 1 },
    { name: '5 個 emoji 算 5 字', message: '😀'.repeat(5), expected: 5 },
    { name: '200 個 emoji 算 200 字', message: '😀'.repeat(200), expected: 200 },
    { name: '201 個 emoji 算 201 字', message: '😀'.repeat(201), expected: 201 },
    { name: '中文每字算 1 字', message: '謝謝你分享', expected: 5 },
    { name: '中英與 emoji 混合各算 1 字', message: '謝謝 abc😀', expected: 7 },
    { name: '前後空白不計入', message: '  \n謝謝你分享\t ', expected: 5 },
    { name: '只有空白算 0 字', message: '   ', expected: 0 },
  ])('$name', ({ message, expected }) => {
    expect(countThankYouMessageChars(message)).toBe(expected);
  });
});

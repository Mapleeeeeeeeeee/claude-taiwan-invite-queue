// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReceiverPanel } from '../../src/client/components/ReceiverPanel';
import { createPanelProps } from '../helpers/receiverPanelFixtures';
import { renderWithPwaInstall as render } from '../helpers/renderWithPwaInstall';

afterEach(cleanup);

describe('ReceiverPanel 感謝小卡字數以 Unicode 碼點計算', () => {
  it('輸入 200 個 emoji 時計數器顯示 200 / 200，送出按鈕仍可用', () => {
    render(<ReceiverPanel {...createPanelProps({ thankYouMessageInput: '😀'.repeat(200) })} />);

    expect(screen.getByText('200 / 200')).not.toBeNull();
    const submitButton = screen.getByRole('button', { name: '使用 Google 帳號登入' });
    expect(submitButton.hasAttribute('disabled')).toBe(false);
  });

  it('輸入 201 個 emoji 時提示超過 1 字並停用送出按鈕', () => {
    render(<ReceiverPanel {...createPanelProps({ thankYouMessageInput: '😀'.repeat(201) })} />);

    expect(screen.getByText(/已超過 1 字/)).not.toBeNull();
    const submitButton = screen.getByRole('button', { name: /字數超過 200 字上限/ });
    expect(submitButton.hasAttribute('disabled')).toBe(true);
  });
});

describe('ReceiverPanel 感謝小卡沒有可見字元', () => {
  it.each([
    { name: '5 個零寬空白', message: '\u200B'.repeat(5) },
    { name: '全是空白與換行', message: '     \n  ' },
  ])('輸入$name 時停用送出按鈕並提示需要可見文字', ({ message }) => {
    render(<ReceiverPanel {...createPanelProps({ thankYouMessageInput: message })} />);

    const submitButton = screen.getByRole('button', { name: /感謝小卡需包含可見文字/ });
    expect(submitButton.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/請輸入至少一個可見字元/)).not.toBeNull();
  });

  it('輸入可見文字夾零寬字元時送出按鈕仍可用', () => {
    render(<ReceiverPanel {...createPanelProps({ thankYouMessageInput: '\u200B\u200B謝\u200B\u200B' })} />);

    const submitButton = screen.getByRole('button', { name: '使用 Google 帳號登入' });
    expect(submitButton.hasAttribute('disabled')).toBe(false);
  });
});

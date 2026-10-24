// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PwaInstallBanner } from '../../src/client/components/PwaInstallBanner';
import { renderWithPwaInstall as render } from '../helpers/renderWithPwaInstall';

const IOS_GUIDE_DIALOG_NAME = '如何將網頁加入 iPhone 主畫面';
const IPHONE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';

let originalUserAgent: PropertyDescriptor | undefined;

beforeEach(() => {
  originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
  Object.defineProperty(navigator, 'userAgent', { value: IPHONE_USER_AGENT, configurable: true });
});

afterEach(() => {
  cleanup();
  if (originalUserAgent) {
    Object.defineProperty(navigator, 'userAgent', originalUserAgent);
  } else {
    delete (navigator as unknown as Record<string, unknown>).userAgent;
  }
});

function openIosGuide() {
  render(<PwaInstallBanner />);
  fireEvent.click(screen.getByRole('button', { name: '加入 iPhone' }));
  return screen.getByRole('dialog', { name: IOS_GUIDE_DIALOG_NAME });
}

describe('PwaInstallBanner iOS 加入主畫面引導視窗', () => {
  it('在 iPhone 點擊「加入 iPhone」時開啟引導視窗', () => {
    const dialog = openIosGuide();

    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('點擊「我知道了」時關閉視窗，橫幅仍在', () => {
    openIosGuide();

    fireEvent.click(screen.getByRole('button', { name: '我知道了' }));

    expect(screen.queryByRole('dialog', { name: IOS_GUIDE_DIALOG_NAME })).toBeNull();
    expect(screen.getByTestId('pwa-install-banner')).not.toBeNull();
  });

  // 瀏覽器在模態 <dialog> 上按 Escape 時，先對它觸發 cancel 事件，再關閉。
  it('按 Escape 時關閉視窗', () => {
    const dialog = openIosGuide();

    fireEvent(dialog, new Event('cancel', { cancelable: true }));

    expect(screen.queryByRole('dialog', { name: IOS_GUIDE_DIALOG_NAME })).toBeNull();
  });

  it('點擊視窗外圍（遮罩）時關閉，點擊卡片本身時不關閉', () => {
    const dialog = openIosGuide();

    fireEvent.click(screen.getByText('點擊右上角', { exact: false }));
    expect(screen.queryByRole('dialog', { name: IOS_GUIDE_DIALOG_NAME })).not.toBeNull();

    fireEvent.click(dialog);
    expect(screen.queryByRole('dialog', { name: IOS_GUIDE_DIALOG_NAME })).toBeNull();
  });
});

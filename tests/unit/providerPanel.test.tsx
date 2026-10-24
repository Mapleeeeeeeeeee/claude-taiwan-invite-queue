// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderPanel,
  type ProviderPanelProps,
} from '../../src/client/components/ProviderPanel';

const scrollIntoView = vi.fn();

// jsdom 沒有實作 scrollIntoView，錯誤提示出現時元件會呼叫它。
beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

function createPanelProps(overrides?: Partial<ProviderPanelProps>): ProviderPanelProps {
  return {
    me: null,
    isSubmitting: false,
    actionError: null,
    isLoginRequired: false,
    nicknameInput: '小張',
    rawUrlInput: 'https://claude.ai/referral/shareTest01',
    slotCountInput: 3,
    providerTrackInput: 'newbie',
    onNicknameChange: vi.fn(),
    onRawUrlChange: vi.fn(),
    onSlotCountChange: vi.fn(),
    onProviderTrackChange: vi.fn(),
    onSubmitInviteLink: vi.fn(async () => true),
    push: { permissionState: 'default', hasPendingGuestSubscription: false, enablePush: vi.fn(async () => true) },
    onRequireLogin: vi.fn(),
    onTestPush: vi.fn(async () => true),
    ...overrides,
  };
}

describe('ProviderPanel 名額受眾單選', () => {
  it('預設選中新手，點選再領取選項時通知父層切換為 community', () => {
    const handleTrackChange = vi.fn();
    render(<ProviderPanel {...createPanelProps({ onProviderTrackChange: handleTrackChange })} />);

    const newbieOption = screen.getByRole('radio', { name: /限新手首次體驗/ });
    const communityOption = screen.getByRole('radio', { name: /開放再領取軌/ });
    expect(newbieOption.getAttribute('aria-checked')).toBe('true');
    expect(communityOption.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(communityOption);

    expect(handleTrackChange).toHaveBeenCalledWith('community');
  });

  it('未登入時送出表單只觸發登入，不提交連結', () => {
    const handleSubmit = vi.fn(async () => true);
    const handleRequireLogin = vi.fn();
    render(
      <ProviderPanel
        {...createPanelProps({
          onSubmitInviteLink: handleSubmit,
          onRequireLogin: handleRequireLogin,
        })}
      />
    );

    fireEvent.submit(screen.getByLabelText(/Claude 邀請連結/).closest('form')!);

    expect(handleRequireLogin).toHaveBeenCalledTimes(1);
    expect(handleSubmit).not.toHaveBeenCalled();
  });
});

describe('ProviderPanel 分享失敗的錯誤提示位置', () => {
  it('分享失敗時，錯誤提示出現在邀請連結輸入框之後', () => {
    render(<ProviderPanel {...createPanelProps({ actionError: '這個邀請代碼已經有人分享過了' })} />);

    const urlInput = screen.getByLabelText(/Claude 邀請連結/);
    const errorAlert = screen.getByRole('alert');

    expect(errorAlert.textContent).toContain('這個邀請代碼已經有人分享過了');
    expect(urlInput.compareDocumentPosition(errorAlert)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('ProviderPanel 分享失敗時捲到錯誤提示', () => {
  it('Given 沒有錯誤 When 錯誤新出現 Then 把錯誤提示捲進可視範圍', () => {
    const { rerender } = render(<ProviderPanel {...createPanelProps()} />);
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender(<ProviderPanel {...createPanelProps({ actionError: '這個邀請代碼已經有人分享過了' })} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('alert'));
  });

  it('Given 錯誤已顯示 When 父層因其他原因重新渲染 Then 不再捲動', () => {
    const props = createPanelProps({ actionError: '這個邀請代碼已經有人分享過了' });
    const { rerender } = render(<ProviderPanel {...props} />);
    scrollIntoView.mockClear();

    rerender(<ProviderPanel {...props} rawUrlInput="https://claude.ai/referral/other" />);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('Given 錯誤已顯示 When 錯誤內容改變 Then 再捲動一次', () => {
    const { rerender } = render(
      <ProviderPanel {...createPanelProps({ actionError: '這個邀請代碼已經有人分享過了' })} />
    );
    scrollIntoView.mockClear();

    rerender(<ProviderPanel {...createPanelProps({ actionError: '操作太頻繁，請稍後再試' })} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('Given 同一個錯誤被清除後再次出現 When 再次送出失敗 Then 再捲動一次', () => {
    const error = '這個邀請代碼已經有人分享過了';
    const { rerender } = render(<ProviderPanel {...createPanelProps({ actionError: error })} />);
    rerender(<ProviderPanel {...createPanelProps({ actionError: null })} />);
    scrollIntoView.mockClear();

    rerender(<ProviderPanel {...createPanelProps({ actionError: error })} />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('Given 需要登入 When 有錯誤訊息 Then 不顯示也不捲動，交給登入引導', () => {
    render(
      <ProviderPanel {...createPanelProps({ actionError: '請先登入', isLoginRequired: true })} />
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

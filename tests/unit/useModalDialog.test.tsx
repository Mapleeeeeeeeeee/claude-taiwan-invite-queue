// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModalDialog } from '../../src/client/hooks/useModalDialog';

const originalShowModal = HTMLDialogElement.prototype.showModal;

// 真實瀏覽器的 showModal() 會把焦點移進對話框；全域替身不模擬這件事，
// 這裡補上，才看得出元件卸載後焦點是否回到原本的觸發元素。
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    originalShowModal.call(this);
    this.querySelector<HTMLElement>('button')?.focus();
  };
});

afterEach(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  cleanup();
});

function TestDialog({ onClose }: { onClose: () => void }) {
  const dialogProps = useModalDialog(onClose);
  return (
    <dialog {...dialogProps} aria-label="測試對話框">
      <div data-testid="card">
        <button type="button" onClick={onClose}>
          關閉
        </button>
        <p>卡片內文</p>
      </div>
    </dialog>
  );
}

/** 對話框開啟時才掛載、關閉時卸載，和專案裡四個對話框的用法一致。 */
function Harness({ removeTriggerOnClose = false }: { removeTriggerOnClose?: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      {isOpen && removeTriggerOnClose ? null : (
        <button type="button" onClick={() => setIsOpen(true)}>
          開啟
        </button>
      )}
      {isOpen ? <TestDialog onClose={() => setIsOpen(false)} /> : null}
    </>
  );
}

function openDialogFromTrigger() {
  const trigger = screen.getByRole('button', { name: '開啟' });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole('dialog', { name: '測試對話框' }) };
}

describe('useModalDialog 關閉後的焦點', () => {
  const closeActions: Array<[string, (dialog: HTMLElement) => void]> = [
    ['按 Escape', (dialog) => fireEvent(dialog, new Event('cancel', { cancelable: true }))],
    ['點內部的關閉鈕', () => fireEvent.click(screen.getByRole('button', { name: '關閉' }))],
    ['點遮罩', (dialog) => fireEvent.click(dialog)],
  ];

  it.each(closeActions)('Given 從按鈕開啟對話框 When %s Then 焦點回到該按鈕', (_name, close) => {
    render(<Harness />);
    const { trigger, dialog } = openDialogFromTrigger();
    expect(document.activeElement).not.toBe(trigger);

    close(dialog);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Given 關閉時觸發元素已被移除 When 關閉對話框 Then 不丟例外，焦點留在 body', () => {
    render(<Harness removeTriggerOnClose />);
    const { dialog } = openDialogFromTrigger();

    expect(() => fireEvent.click(dialog)).not.toThrow();

    expect(document.activeElement).toBe(document.body);
  });
});

describe('useModalDialog 點遮罩關閉', () => {
  function renderOpenDialog() {
    render(<Harness />);
    const { dialog } = openDialogFromTrigger();
    return { dialog, card: screen.getByTestId('card') };
  }

  it('Given 對話框開啟 When 在遮罩上按下並放開 Then 關閉', () => {
    const { dialog } = renderOpenDialog();

    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(dialog);
    fireEvent.click(dialog);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Given 對話框開啟 When 點卡片內部 Then 不關閉', () => {
    const { card } = renderOpenDialog();

    fireEvent.pointerDown(card);
    fireEvent.pointerUp(card);
    fireEvent.click(card);

    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  // Regression: 在卡片內按下滑鼠、拖到遮罩上放開（選取文字拖過邊緣）會誤關對話框，因為此時 click 的目標是 dialog 本身
  it('Given 在卡片內按下 When 拖到遮罩放開 Then 不關閉', () => {
    const { dialog, card } = renderOpenDialog();

    fireEvent.pointerDown(card);
    fireEvent.pointerUp(dialog);
    fireEvent.click(dialog);

    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('Given 在遮罩上按下 When 拖進卡片放開 Then 不關閉', () => {
    const { dialog, card } = renderOpenDialog();

    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(card);
    fireEvent.click(dialog);

    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('Given 上一次拖曳選取沒有關閉 When 之後在遮罩上正常點擊 Then 關閉', () => {
    const { dialog, card } = renderOpenDialog();
    fireEvent.pointerDown(card);
    fireEvent.pointerUp(dialog);
    fireEvent.click(dialog);

    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(dialog);
    fireEvent.click(dialog);

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ThankYouWall } from '../../src/client/components/ThankYouWall';
import type { ThankYouWallItemDto } from '../../src/shared/types';

describe('ThankYouWall Component', () => {
  // 瀏覽器在模態 <dialog> 上按 Escape 時，先對它觸發 cancel 事件，再關閉。
  const pressEscapeOn = (dialog: HTMLElement) =>
    fireEvent(dialog, new Event('cancel', { cancelable: true }));

  const mockItems: ThankYouWallItemDto[] = [
    {
      slotId: 101,
      thankYouMessage: '感謝大大無私分享 Claude 邀請碼！',
      providerNickname: 'Maple Kuo',
      receiverNickname: '小明',
      confirmedAt: '2026-10-24T00:00:00.000Z',
    },
    {
      slotId: 102,
      thankYouMessage: '太棒了終於排到！祝好人一生平安！',
      providerNickname: 'Alice',
      receiverNickname: 'Bob',
      confirmedAt: '2026-10-24T00:10:00.000Z',
    },
  ];

  it('Given 感謝牆沒有任何小卡 When 渲染 Then 顯示空狀態提示', () => {
    render(
      <ThankYouWall
        items={[]}
        isLoading={false}
        boardError={null}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByTestId('thank-you-wall-empty')).toBeDefined();
    expect(screen.getByText(/目前還沒有感謝小卡/)).toBeDefined();
  });

  it('有感謝小卡時，跑馬燈顯示每一則感謝內容與參與者暱稱', () => {
    render(
      <ThankYouWall
        items={mockItems}
        isLoading={false}
        boardError={null}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /查看全部.*2/ })).toBeDefined();
    const ticker = screen.getByRole('list', { name: '即時動態感謝牆' });
    for (const item of mockItems) {
      expect(within(ticker).getAllByText(`「${item.thankYouMessage}」`)).not.toHaveLength(0);
      expect(within(ticker).getAllByText(item.receiverNickname)).not.toHaveLength(0);
      expect(within(ticker).getAllByText(item.providerNickname)).not.toHaveLength(0);
    }
  });

  it('看板載入失敗時，顯示錯誤文案與重新整理按鈕而不顯示跑馬燈，點擊後觸發 onRetry', () => {
    const handleRetry = vi.fn();
    render(
      <ThankYouWall
        items={mockItems}
        isLoading={false}
        boardError="看板暫時無法載入"
        onRetry={handleRetry}
      />
    );

    expect(screen.getByText('看板暫時無法載入')).toBeDefined();
    expect(screen.queryByRole('list', { name: '即時動態感謝牆' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '點擊重新整理' }));
    expect(handleRetry).toHaveBeenCalledTimes(1);
  });

  it('看板載入失敗且正在重新載入時，重新整理按鈕不可點擊', () => {
    const handleRetry = vi.fn();
    render(
      <ThankYouWall
        items={[]}
        isLoading={true}
        boardError="看板暫時無法載入"
        onRetry={handleRetry}
      />
    );

    const retryButton = screen.getByRole('button', { name: '點擊重新整理' });
    expect((retryButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retryButton);
    expect(handleRetry).not.toHaveBeenCalled();
  });

  describe('跑馬燈位置', () => {
    function renderWall(items: ThankYouWallItemDto[]) {
      const wall = (list: ThankYouWallItemDto[]) => (
        <ThankYouWall items={list} isLoading={false} boardError={null} onRetry={vi.fn()} />
      );
      const view = render(wall(items));
      return { rerenderWith: (list: ThankYouWallItemDto[]) => view.rerender(wall(list)) };
    }
    const getTicker = () => screen.getByRole('list', { name: '即時動態感謝牆' });

    // 設計文件沒有規定跑馬燈速度。跑馬燈秒數是 max(22, 張數 × 6.5)（ThankYouWall.tsx 的
    // MIN_MARQUEE_SECONDS 與 MARQUEE_SECONDS_PER_CARD），2 張時停在下限 22 秒，
    // 再加 5 張共 7 張就超過下限而放慢。
    const ITEMS_ADDED_TO_EXCEED_MARQUEE_MIN_DURATION = 5;

    // jsdom 不會執行 CSS 動畫，所以用跑馬燈的 DOM 節點有沒有被重建來代表動畫有沒有從起點重來：
    // 瀏覽器只有在元素重建時才會重啟 CSS 動畫。

    // Regression: 看板重新抓取到相同內容時，跑馬燈因陣列參照改變而跳回起點 (review-efficiency, ThankYouWall 跑馬燈重置)
    it('看板重新抓取到內容相同的感謝小卡時，跑馬燈維持目前位置不跳回起點', () => {
      const { rerenderWith } = renderWall(mockItems);
      const tickerBefore = getTicker();

      rerenderWith(mockItems.map((item) => ({ ...item })));

      expect(getTicker()).toBe(tickerBefore);
    });

    it('感謝小卡數量增加到跑馬燈需要放慢速度時，跑馬燈從起點重新開始', () => {
      const { rerenderWith } = renderWall(mockItems);
      const tickerBefore = getTicker();

      const manyMoreItems = Array.from({ length: ITEMS_ADDED_TO_EXCEED_MARQUEE_MIN_DURATION }, (_, index) => ({
        ...mockItems[0]!,
        slotId: 200 + index,
        thankYouMessage: `新加入的感謝小卡 ${index}`,
      }));
      rerenderWith([...mockItems, ...manyMoreItems]);

      expect(getTicker()).not.toBe(tickerBefore);
    });
  });

  it('Given 跑馬燈播放中 When 點擊暫停再點繼續 Then 跑馬燈依序暫停與恢復，按鈕名稱隨之切換', () => {
    render(
      <ThankYouWall
        items={mockItems}
        isLoading={false}
        boardError={null}
        onRetry={vi.fn()}
      />
    );

    const ticker = screen.getByRole('list', { name: '即時動態感謝牆' });
    const pauseButton = screen.getByRole('button', { name: /暫停動態輪播/ });
    expect(pauseButton).toBeDefined();
    expect(ticker.classList.contains('is-paused')).toBe(false);

    fireEvent.click(pauseButton);
    expect(screen.getByRole('button', { name: /繼續動態輪播/ })).toBeDefined();
    expect(ticker.classList.contains('is-paused')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /繼續動態輪播/ }));
    expect(screen.getByRole('button', { name: /暫停動態輪播/ })).toBeDefined();
    expect(ticker.classList.contains('is-paused')).toBe(false);
  });

  it('手指按住跑馬燈時暫停，放開後繼續', () => {
    render(<ThankYouWall items={mockItems} isLoading={false} boardError={null} onRetry={vi.fn()} />);
    const ticker = screen.getByRole('list', { name: '即時動態感謝牆' });

    fireEvent.touchStart(ticker);
    expect(ticker.classList.contains('is-paused')).toBe(true);

    fireEvent.touchEnd(ticker);
    expect(ticker.classList.contains('is-paused')).toBe(false);
  });

  it('點擊「查看全部」按鈕時開啟完整列表彈窗，並支援關閉按鈕與 Escape 關閉', () => {
    render(
      <ThankYouWall
        items={mockItems}
        isLoading={false}
        boardError={null}
        onRetry={vi.fn()}
      />
    );

    const viewAllButton = screen.getByRole('button', { name: /查看全部社群感謝小卡/ });
    expect(viewAllButton).toBeDefined();

    fireEvent.click(viewAllButton);
    expect(screen.getByTestId('modal-all-thank-you')).toBeDefined();
    expect(screen.getByRole('dialog', { name: '社群感謝小卡完整列表' }).hasAttribute('open')).toBe(true);
    expect(screen.getByText(/社群感謝小卡完整列表/)).toBeDefined();

    const closeBtn = screen.getByRole('button', { name: '關閉完整列表' });
    fireEvent.click(closeBtn);
    expect(screen.queryByTestId('modal-all-thank-you')).toBeNull();

    fireEvent.click(viewAllButton);
    expect(screen.getByTestId('modal-all-thank-you')).toBeDefined();
    pressEscapeOn(screen.getByRole('dialog', { name: '社群感謝小卡完整列表' }));
    expect(screen.queryByTestId('modal-all-thank-you')).toBeNull();
  });

  describe('彈窗行為', () => {
    function renderWall() {
      render(<ThankYouWall items={mockItems} isLoading={false} boardError={null} onRetry={vi.fn()} />);
    }
    const viewAllDialog = () => screen.queryByRole('dialog', { name: '社群感謝小卡完整列表' });
    const spotlightDialog = () => screen.queryByRole('dialog', { name: '社群感謝小卡詳細內容' });
    const openViewAll = () => fireEvent.click(screen.getByRole('button', { name: /查看全部社群感謝小卡/ }));

    function openSpotlightFromTicker() {
      const ticker = screen.getByRole('list', { name: '即時動態感謝牆' });
      fireEvent.click(within(ticker).getAllByText(`「${mockItems[0]!.thankYouMessage}」`)[0]!);
    }

    it('點擊跑馬燈上的小卡時，開啟詳細內容彈窗並顯示領取者、分享者與感謝內容', () => {
      renderWall();
      expect(spotlightDialog()).toBeNull();

      openSpotlightFromTicker();

      const dialog = within(spotlightDialog()!);
      expect(dialog.getByText(`「${mockItems[0]!.thankYouMessage}」`)).toBeDefined();
      expect(dialog.getByText(mockItems[0]!.receiverNickname)).toBeDefined();
      expect(dialog.getByText(mockItems[0]!.providerNickname)).toBeDefined();
    });

    it('詳細內容彈窗可用右上角關閉鈕、底部關閉鈕與點擊彈窗外圍關閉，點擊卡片本身則不關閉', () => {
      renderWall();

      openSpotlightFromTicker();
      fireEvent.click(screen.getByRole('button', { name: '關閉小卡詳情' }));
      expect(spotlightDialog()).toBeNull();

      openSpotlightFromTicker();
      fireEvent.click(within(spotlightDialog()!).getByRole('button', { name: '關閉' }));
      expect(spotlightDialog()).toBeNull();

      openSpotlightFromTicker();
      fireEvent.click(within(spotlightDialog()!).getByText('領取者'));
      expect(spotlightDialog()).not.toBeNull();
      fireEvent.click(spotlightDialog()!);
      expect(spotlightDialog()).toBeNull();
    });

    it('完整列表彈窗點擊彈窗外圍時關閉，點擊列表內容則不關閉', () => {
      renderWall();
      openViewAll();

      fireEvent.click(screen.getByTestId('modal-all-thank-you'));
      expect(viewAllDialog()).not.toBeNull();

      fireEvent.click(viewAllDialog()!);
      expect(viewAllDialog()).toBeNull();
    });

    // 瀏覽器按 Escape 時只對最上層的 <dialog> 觸發 cancel，所以詳細內容先關、列表後關。
    it('在完整列表中點擊小卡時，詳細內容彈窗疊在列表上方；Escape 先關閉詳細內容，再關閉列表', () => {
      renderWall();
      openViewAll();
      fireEvent.click(within(viewAllDialog()!).getByText(`「${mockItems[1]!.thankYouMessage}」`));
      expect(spotlightDialog()).not.toBeNull();
      expect(viewAllDialog()).not.toBeNull();

      pressEscapeOn(spotlightDialog()!);
      expect(spotlightDialog()).toBeNull();
      expect(viewAllDialog()).not.toBeNull();

      pressEscapeOn(viewAllDialog()!);
      expect(viewAllDialog()).toBeNull();
    });

    it('完整列表搜尋暱稱或內容時只留下符合的小卡，查無結果時顯示提示，清除搜尋後恢復全部', () => {
      renderWall();
      openViewAll();
      const dialog = within(viewAllDialog()!);
      const searchBox = dialog.getByPlaceholderText('搜尋暱稱或內容...');

      fireEvent.change(searchBox, { target: { value: 'alice' } });
      expect(dialog.queryByText(`「${mockItems[0]!.thankYouMessage}」`)).toBeNull();
      expect(dialog.getByText(`「${mockItems[1]!.thankYouMessage}」`)).toBeDefined();

      fireEvent.change(searchBox, { target: { value: '不存在的暱稱' } });
      expect(dialog.getByText(/查無符合「不存在的暱稱」的感謝小卡/)).toBeDefined();

      fireEvent.click(dialog.getAllByRole('button', { name: '清除搜尋' })[0]!);
      expect(dialog.getByText(`「${mockItems[0]!.thankYouMessage}」`)).toBeDefined();
      expect(dialog.getByText(`「${mockItems[1]!.thankYouMessage}」`)).toBeDefined();
    });

    it('關閉完整列表後再開啟，搜尋關鍵字仍保留', () => {
      renderWall();
      openViewAll();
      fireEvent.change(within(viewAllDialog()!).getByPlaceholderText('搜尋暱稱或內容...'), {
        target: { value: 'alice' },
      });
      fireEvent.click(screen.getByRole('button', { name: '關閉完整列表' }));

      openViewAll();

      expect(
        (within(viewAllDialog()!).getByPlaceholderText('搜尋暱稱或內容...') as HTMLInputElement).value
      ).toBe('alice');
    });

    // 真實瀏覽器在滑鼠按下小卡時就會把焦點移到可聚焦的小卡上；jsdom 不會，所以測試自己先聚焦。
    // 全域的 showModal 替身也不會把焦點移進對話框，這裡補上，才看得出關閉後焦點是否被還原。
    describe('關閉詳細內容彈窗後的焦點', () => {
      const originalShowModal = HTMLDialogElement.prototype.showModal;

      beforeEach(() => {
        HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
          originalShowModal.call(this);
          this.querySelector<HTMLElement>('button')?.focus();
        };
      });

      afterEach(() => {
        HTMLDialogElement.prototype.showModal = originalShowModal;
      });

      function clickCardWithFocus(messageText: string, scope: HTMLElement) {
        const card = within(scope).getAllByText(`「${messageText}」`)[0]!.closest('li')!;
        card.focus();
        fireEvent.click(card);
        return card;
      }

      it('Given 從跑馬燈點開小卡 When 關閉詳細內容 Then 焦點回到被點的那張小卡', () => {
        renderWall();
        const ticker = screen.getByRole('list', { name: '即時動態感謝牆' });
        const card = clickCardWithFocus(mockItems[0]!.thankYouMessage, ticker);

        fireEvent.click(screen.getByRole('button', { name: '關閉小卡詳情' }));

        expect(spotlightDialog()).toBeNull();
        expect(document.activeElement).toBe(card);
      });

      it('Given 從完整列表點開小卡 When 關閉詳細內容 Then 焦點回到列表內那張小卡，列表仍開著', () => {
        renderWall();
        openViewAll();
        const card = clickCardWithFocus(mockItems[1]!.thankYouMessage, viewAllDialog()!);

        pressEscapeOn(spotlightDialog()!);

        expect(spotlightDialog()).toBeNull();
        expect(viewAllDialog()).not.toBeNull();
        expect(document.activeElement).toBe(card);
      });

      it('Given 從「查看全部」開啟完整列表 When 關閉列表 Then 焦點回到「查看全部」按鈕', () => {
        renderWall();
        const trigger = screen.getByRole('button', { name: /查看全部社群感謝小卡/ });
        trigger.focus();
        fireEvent.click(trigger);

        fireEvent.click(screen.getByRole('button', { name: '關閉完整列表' }));

        expect(viewAllDialog()).toBeNull();
        expect(document.activeElement).toBe(trigger);
      });
    });
  });
});

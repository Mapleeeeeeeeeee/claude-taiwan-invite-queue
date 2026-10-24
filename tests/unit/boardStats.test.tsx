// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardDto } from '../../src/shared/types';
import { BoardStats } from '../../src/client/components/BoardStats';

afterEach(cleanup);

const board: BoardDto = {
  availableSlotsCount: 5,
  waitingQueueCount: 9,
  totalConfirmedCount: 42,
  newbieSlotsCount: 3,
  communitySlotsCount: 2,
  newbieQueueCount: 7,
  communityQueueCount: 2,
  thankYouWall: [],
};

// 軌道拆分容器底下每個直接子元素就是一個項目（新手、再領取）。
const trackItemTexts = (breakdownTestId: string) =>
  Array.from(screen.getByTestId(breakdownTestId).children).map((item) => item.textContent);

describe('BoardStats 即時名額看板', () => {
  it('同時顯示總數，以及新手與再領取各自的席次數與排隊數', () => {
    render(<BoardStats board={board} isLoading={false} boardError={null} onRefresh={vi.fn()} />);

    expect(screen.getByTestId('available-slots-count').textContent).toBe('5');
    expect(screen.getByTestId('waiting-queue-count').textContent).toBe('9');
    expect(screen.getByTestId('total-confirmed-count').textContent).toBe('42');
    expect(trackItemTexts('slots-track-breakdown')).toEqual(['新手 3', '再領取 2']);
    expect(trackItemTexts('queue-track-breakdown')).toEqual(['新手 7', '再領取 2']);
  });

  it('新手與再領取是各自獨立的項目，文字讀起來以空格相隔、沒有「·」', () => {
    render(<BoardStats board={board} isLoading={false} boardError={null} onRefresh={vi.fn()} />);

    const region = screen.getByRole('region', { name: '即時名額看板' });

    expect(screen.getByTestId('slots-track-breakdown').textContent).toBe('新手 3 再領取 2');
    expect(screen.getByTestId('queue-track-breakdown').textContent).toBe('新手 7 再領取 2');
    expect(region.textContent).not.toContain('·');
  });

  it('看板尚未載入時，所有數字顯示佔位符而不是 0', () => {
    render(<BoardStats board={null} isLoading={true} boardError={null} onRefresh={vi.fn()} />);

    expect(screen.getByTestId('available-slots-count').textContent).toBe('—');
    expect(screen.getByTestId('waiting-queue-count').textContent).toBe('—');
    expect(screen.getByTestId('total-confirmed-count').textContent).toBe('—');
    expect(trackItemTexts('slots-track-breakdown')).toEqual(['新手 —', '再領取 —']);
    expect(trackItemTexts('queue-track-breakdown')).toEqual(['新手 —', '再領取 —']);
  });

  it('累計已領取那一格只顯示標籤與數字，不附加說明文字', () => {
    render(<BoardStats board={board} isLoading={false} boardError={null} onRefresh={vi.fn()} />);

    const confirmedMetric = screen.getByTestId('total-confirmed-count').closest('.stat-metric');

    expect(confirmedMetric?.textContent).toBe('累計已領取42次');
  });

  it.each([
    ['slots-track-breakdown', 'available-slots-count'],
    ['queue-track-breakdown', 'waiting-queue-count'],
  ])('軌道拆分文字（%s）與標籤在同一列，數字（%s）在該列之後', (breakdownTestId, numberTestId) => {
    render(<BoardStats board={board} isLoading={false} boardError={null} onRefresh={vi.fn()} />);

    const breakdown = screen.getByTestId(breakdownTestId);
    const metric = breakdown.closest('.stat-metric');
    const headerRow = metric?.querySelector('.stat-metric-label')?.parentElement;
    const numberRow = screen.getByTestId(numberTestId).closest('.stat-metric-value-wrap');

    expect(headerRow).toBe(breakdown.parentElement);
    expect(headerRow?.nextElementSibling).toBe(numberRow);
  });
});

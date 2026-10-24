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

  it('看板尚未載入時，所有數字顯示佔位符而不是 0', () => {
    render(<BoardStats board={null} isLoading={true} boardError={null} onRefresh={vi.fn()} />);

    expect(screen.getByTestId('available-slots-count').textContent).toBe('—');
    expect(screen.getByTestId('waiting-queue-count').textContent).toBe('—');
    expect(screen.getByTestId('total-confirmed-count').textContent).toBe('—');
    expect(trackItemTexts('slots-track-breakdown')).toEqual(['新手 —', '再領取 —']);
    expect(trackItemTexts('queue-track-breakdown')).toEqual(['新手 —', '再領取 —']);
  });

  it('看板文字依序讀作標籤、新手與再領取的拆分、數字與單位，拆分之間以空格相隔且沒有「·」', () => {
    render(<BoardStats board={board} isLoading={false} boardError={null} onRefresh={vi.fn()} />);

    const region = screen.getByRole('region', { name: '即時名額看板' });

    expect(region.textContent).toBe(
      '可用席次新手 3 再領取 2' + '5席' + '排隊中新手 7 再領取 2' + '9人' + '累計已領取' + '42次'
    );
  });
});

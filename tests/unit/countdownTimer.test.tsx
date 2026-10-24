// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountdownTimer } from '../../src/client/components/CountdownTimer';

const NOW = new Date('2026-10-22T01:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderTimer(expiresAt: string | null, onExpire = vi.fn()) {
  render(
    <strong data-testid="timer">
      <CountdownTimer expiresAt={expiresAt} onExpire={onExpire} />
    </strong>
  );
  return { onExpire };
}

describe('CountdownTimer 倒數顯示', () => {
  it.each([
    { scenario: '剩餘 6 小時', expiresAt: '2026-10-22T07:00:00.000Z', expected: '06:00:00' },
    { scenario: '剩餘 30 分鐘', expiresAt: '2026-10-22T01:30:00.000Z', expected: '30:00' },
    { scenario: '沒有終點時間', expiresAt: null, expected: '--:--' },
    { scenario: '終點時間無法解析', expiresAt: 'not-a-date', expected: '--:--' },
  ])('$scenario 時顯示 $expected', ({ expiresAt, expected }) => {
    renderTimer(expiresAt);

    expect(screen.getByTestId('timer').textContent).toBe(expected);
  });

  it('每過一秒更新剩餘時間', () => {
    renderTimer('2026-10-22T01:30:00.000Z');

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByTestId('timer').textContent).toBe('29:55');
  });

  it('倒數歸零時立即通知一次', () => {
    const { onExpire } = renderTimer('2026-10-22T01:00:03.000Z');
    expect(onExpire).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByTestId('timer').textContent).toBe('00:00');
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('歸零後終點沒變（伺服器尚未判定逾時），每隔 3 秒再通知，最多共 5 次', () => {
    const { onExpire } = renderTimer('2026-10-22T01:00:03.000Z');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onExpire).toHaveBeenCalledTimes(2);

    for (let elapsedSeconds = 0; elapsedSeconds < 60; elapsedSeconds += 1) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(onExpire).toHaveBeenCalledTimes(5);
  });
});

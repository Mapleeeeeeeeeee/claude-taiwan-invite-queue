import { describe, expect, it } from 'vitest';
import {
  type AvailableSlot,
  type WaitingTicket,
  matchTicketsToAvailableSlots,
} from '../../src/worker/domain/matchingEngine';

describe('matchingEngine 撮合引擎 (純領域邏輯)', () => {
  it('當可用名額或等候號碼牌為空時，應回傳空撮合清單', () => {
    const slots: AvailableSlot[] = [{ id: 1, linkId: 10, providerUserId: 100, track: 'newbie' }];
    const tickets: WaitingTicket[] = [{ id: 1, userId: 200, track: 'newbie' }];

    expect(matchTicketsToAvailableSlots([], tickets)).toEqual([]);
    expect(matchTicketsToAvailableSlots(slots, [])).toEqual([]);
    expect(matchTicketsToAvailableSlots([], [])).toEqual([]);
  });

  it('應嚴格遵守 FIFO 順序將名額分配給先排隊的號碼牌', () => {
    const slots: AvailableSlot[] = [
      { id: 1, linkId: 10, providerUserId: 999, track: 'newbie' },
      { id: 2, linkId: 10, providerUserId: 999, track: 'newbie' },
    ];
    const tickets: WaitingTicket[] = [
      { id: 101, userId: 1, track: 'newbie' },
      { id: 102, userId: 2, track: 'newbie' },
      { id: 103, userId: 3, track: 'newbie' },
    ];

    const result = matchTicketsToAvailableSlots(slots, tickets);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ slot: slots[0], ticket: tickets[0] });
    expect(result[1]).toEqual({ slot: slots[1], ticket: tickets[1] });
  });

  it('自我防弊：等候者即使排在第一位，若是該名額的提供者本人，應跳過並配對給下一位', () => {
    const slots: AvailableSlot[] = [
      { id: 1, linkId: 10, providerUserId: 100, track: 'newbie' },
    ];
    const tickets: WaitingTicket[] = [
      { id: 1, userId: 100, track: 'newbie' }, // User 100 自己在排隊
      { id: 2, userId: 200, track: 'newbie' }, // 下一位排隊者
    ];

    const result = matchTicketsToAvailableSlots(slots, tickets);

    expect(result).toHaveLength(1);
    expect(result[0]!.slot.id).toBe(1);
    expect(result[0]!.ticket.userId).toBe(200); // 成功跳過 100，配給 200
  });

  it('單一批次中，同一使用者至多只會獲配一個名額', () => {
    const slots: AvailableSlot[] = [
      { id: 1, linkId: 10, providerUserId: 999, track: 'newbie' },
      { id: 2, linkId: 10, providerUserId: 999, track: 'newbie' },
    ];
    const tickets: WaitingTicket[] = [
      { id: 1, userId: 50, track: 'newbie' },
      { id: 2, userId: 50, track: 'newbie' }, // 同一 User 50 的第二張票券
      { id: 3, userId: 60, track: 'newbie' },
    ];

    const result = matchTicketsToAvailableSlots(slots, tickets);

    expect(result).toHaveLength(2);
    expect(result[0]!.ticket.userId).toBe(50);
    expect(result[1]!.ticket.userId).toBe(60); // 50 的第二張被略過，由 60 獲得
  });

  it('當可用名額多於等候人數時，僅撮合現有人數，多餘名額不配對', () => {
    const slots: AvailableSlot[] = [
      { id: 1, linkId: 10, providerUserId: 999, track: 'newbie' },
      { id: 2, linkId: 10, providerUserId: 999, track: 'newbie' },
      { id: 3, linkId: 10, providerUserId: 999, track: 'newbie' },
    ];
    const tickets: WaitingTicket[] = [{ id: 1, userId: 10, track: 'newbie' }];

    const result = matchTicketsToAvailableSlots(slots, tickets);

    expect(result).toHaveLength(1);
    expect(result[0]!.slot.id).toBe(1);
    expect(result[0]!.ticket.userId).toBe(10);
  });
});

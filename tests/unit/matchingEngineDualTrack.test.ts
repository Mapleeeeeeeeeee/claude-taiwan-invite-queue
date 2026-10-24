import { describe, expect, it } from 'vitest';
import type { QueueTrack } from '../../src/shared/types';
import {
  type AvailableSlot,
  type WaitingTicket,
  matchTicketsToAvailableSlots,
  slotTracksMatchableBy,
} from '../../src/worker/domain/matchingEngine';

describe('matchingEngine Dual-Track撮合機制', () => {
  it('新手席次 (newbie) 絕不撮合給再領取票券 (community)', () => {
    const slots: AvailableSlot[] = [
      { id: 1, linkId: 10, providerUserId: 99, track: 'newbie' },
    ];
    const tickets: WaitingTicket[] = [
      { id: 101, userId: 1, track: 'community' },
    ];

    const result = matchTicketsToAvailableSlots(slots, tickets);
    expect(result).toHaveLength(0);
  });

  it('再領取席次 (community) 第一優先撮合給 community 票券', () => {
    const slots: AvailableSlot[] = [
      { id: 1, linkId: 10, providerUserId: 99, track: 'community' },
    ];
    const tickets: WaitingTicket[] = [
      { id: 101, userId: 1, track: 'newbie' },
      { id: 102, userId: 2, track: 'community' },
    ];

    const result = matchTicketsToAvailableSlots(slots, tickets);
    expect(result).toHaveLength(1);
    expect(result[0]!.ticket.id).toBe(102);
    expect(result[0]!.ticket.track).toBe('community');
  });

  it('再領取席次 (community) 在無 community 票券時，自動向下相容分配給新手票券', () => {
    const slots: AvailableSlot[] = [
      { id: 1, linkId: 10, providerUserId: 99, track: 'community' },
    ];
    const tickets: WaitingTicket[] = [
      { id: 101, userId: 1, track: 'newbie' },
    ];

    const result = matchTicketsToAvailableSlots(slots, tickets);
    expect(result).toHaveLength(1);
    expect(result[0]!.ticket.id).toBe(101);
    expect(result[0]!.ticket.track).toBe('newbie');
  });

  it('雙軌混合情況下，各席次依軌道規則與 FIFO 撮合到對應的票券', () => {
    const slots: AvailableSlot[] = [
      { id: 1, linkId: 10, providerUserId: 1, track: 'newbie' },    // 提供者 1
      { id: 2, linkId: 11, providerUserId: 2, track: 'community' }, // 提供者 2
      { id: 3, linkId: 12, providerUserId: 3, track: 'newbie' },    // 提供者 3
    ];

    const tickets: WaitingTicket[] = [
      { id: 101, userId: 1, track: 'community' }, // 使用者 1 (軌道不符 slot 1)
      { id: 102, userId: 2, track: 'newbie' },    // 使用者 2
      { id: 103, userId: 4, track: 'newbie' },    // 使用者 4
    ];

    // slot 1 (newbie, prov 1):
    //   - ticket 101: track is community (skip)
    //   - ticket 102: userId 2 !== prov 1 && track newbie -> matches ticket 102!
    // slot 2 (community, prov 2):
    //   - ticket 101: userId 1 !== prov 2 && track community -> matches ticket 101!
    // slot 3 (newbie, prov 3):
    //   - ticket 103: userId 4 !== prov 3 && track newbie -> matches ticket 103!
    const result = matchTicketsToAvailableSlots(slots, tickets);
    expect(result).toHaveLength(3);

    expect(result[0]!.slot.id).toBe(1);
    expect(result[0]!.ticket.id).toBe(102);

    expect(result[1]!.slot.id).toBe(2);
    expect(result[1]!.ticket.id).toBe(101);

    expect(result[2]!.slot.id).toBe(3);
    expect(result[2]!.ticket.id).toBe(103);
  });

  it('池中較舊的是再領取席次、較新的是新手席次時，新手票先拿新手席次，再領取席次留給之後的再領取票', () => {
    const olderCommunitySlot: AvailableSlot = { id: 1, linkId: 10, providerUserId: 98, track: 'community' };
    const newerNewbieSlot: AvailableSlot = { id: 2, linkId: 11, providerUserId: 99, track: 'newbie' };
    const newbieTicket: WaitingTicket = { id: 101, userId: 1, track: 'newbie' };
    const communityTicket: WaitingTicket = { id: 102, userId: 2, track: 'community' };

    const newbieTicketOnly = matchTicketsToAvailableSlots([olderCommunitySlot, newerNewbieSlot], [newbieTicket]);
    expect(newbieTicketOnly).toEqual([{ slot: newerNewbieSlot, ticket: newbieTicket }]);

    const bothTickets = matchTicketsToAvailableSlots(
      [olderCommunitySlot, newerNewbieSlot],
      [newbieTicket, communityTicket]
    );
    expect(bothTickets).toEqual([
      { slot: olderCommunitySlot, ticket: communityTicket },
      { slot: newerNewbieSlot, ticket: newbieTicket },
    ]);
  });

  it('新手票面對兩個新手席次時，仍取較舊的那個', () => {
    const olderNewbieSlot: AvailableSlot = { id: 1, linkId: 10, providerUserId: 98, track: 'newbie' };
    const newerNewbieSlot: AvailableSlot = { id: 2, linkId: 11, providerUserId: 99, track: 'newbie' };
    const newbieTicket: WaitingTicket = { id: 101, userId: 1, track: 'newbie' };

    const result = matchTicketsToAvailableSlots([olderNewbieSlot, newerNewbieSlot], [newbieTicket]);

    expect(result).toEqual([{ slot: olderNewbieSlot, ticket: newbieTicket }]);
  });

  // community 席次的優先分支與 Fallback 分支各有一道自我配對排除，兩者都要被走到
  it.each([
    { 分支: '優先配對 community 票券', ticketTrack: 'community' as const },
    { 分支: 'Fallback 配對新手票券', ticketTrack: 'newbie' as const },
  ])(
    '再領取席次 (community) $分支 時，排在前面的提供者本人票券被跳過，配給下一位',
    ({ ticketTrack }) => {
      const slots: AvailableSlot[] = [
        { id: 1, linkId: 10, providerUserId: 5, track: 'community' },
      ];
      const tickets: WaitingTicket[] = [
        { id: 101, userId: 5, track: ticketTrack },
        { id: 102, userId: 6, track: ticketTrack },
      ];

      const result = matchTicketsToAvailableSlots(slots, tickets);

      expect(result).toHaveLength(1);
      expect(result[0]!.ticket.userId).toBe(6);
    }
  );
});

describe('slotTracksMatchableBy 只讀取有票能配的席次軌道', () => {
  it.each([
    { 情境: '沒有人排隊', waitingTracks: [] as QueueTrack[], expected: [] as QueueTrack[] },
    { 情境: '只有新手票在排隊，新手席次與可向下相容的再領取席次都配得到', waitingTracks: ['newbie'] as QueueTrack[], expected: ['newbie', 'community'] as QueueTrack[] },
    { 情境: '只有再領取票在排隊，新手席次不可能被配到', waitingTracks: ['community'] as QueueTrack[], expected: ['community'] as QueueTrack[] },
    { 情境: '兩軌都有票，兩種席次都要讀', waitingTracks: ['community', 'newbie', 'community'] as QueueTrack[], expected: ['newbie', 'community'] as QueueTrack[] },
  ])('$情境時回傳 $expected', ({ waitingTracks, expected }) => {
    expect(slotTracksMatchableBy(waitingTracks)).toEqual(expected);
  });
});

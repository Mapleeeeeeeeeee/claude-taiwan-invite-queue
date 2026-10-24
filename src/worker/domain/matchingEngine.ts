import { QUEUE_TRACKS, type QueueTrack } from '../../shared/types';

export interface AvailableSlot {
  id: number;
  linkId: number;
  providerUserId: number;
  track: QueueTrack;
}

export interface WaitingTicket {
  id: number;
  userId: number;
  track: QueueTrack;
}

export interface MatchAssignment {
  slot: AvailableSlot;
  ticket: WaitingTicket;
}

/**
 * 各軌席次可以配給哪些軌道的票，依優先順序排列。
 * 撮合引擎的偏好順序與 `slotTracksMatchableBy` 都由這張表推導，雙軌規則只在這裡定義一次。
 */
const TICKET_TRACKS_BY_SLOT_TRACK: Record<QueueTrack, readonly QueueTrack[]> = {
  newbie: ['newbie'],
  community: ['community', 'newbie'],
};

/**
 * 撮合時處理席次的軌道順序：能配的票種越少的席次軌道越先挑票。
 * 相容性是單向的，新手票能吃再領取席次，再領取票不能吃新手席次；
 * 再領取席次若先挑走新手票，之後的再領取票會等待，新手席次卻閒置。
 * 順序由 `TICKET_TRACKS_BY_SLOT_TRACK` 推導，不另外維護。
 */
const SLOT_TRACKS_IN_MATCHING_ORDER: readonly QueueTrack[] = [...QUEUE_TRACKS].sort(
  (a, b) => TICKET_TRACKS_BY_SLOT_TRACK[a].length - TICKET_TRACKS_BY_SLOT_TRACK[b].length
);

/**
 * 回傳目前有等候票的軌道集合配得到的席次軌道，順序同 `QUEUE_TRACKS`。
 * 呼叫端只需讀取這些軌道的可用席次，其餘軌道的席次不可能被撮合。
 *
 * @param waitingTicketTracks 目前有等候票的軌道，可重複；空集合回傳空陣列。
 */
export function slotTracksMatchableBy(
  waitingTicketTracks: Iterable<QueueTrack>
): QueueTrack[] {
  const waitingTracks = new Set(waitingTicketTracks);
  return QUEUE_TRACKS.filter((slotTrack) =>
    TICKET_TRACKS_BY_SLOT_TRACK[slotTrack].some((ticketTrack) => waitingTracks.has(ticketTrack))
  );
}

/**
 * 將可用名額依先進先出順序分配給等候中的排隊者。
 *
 * 函式遵循 FIFO 規則，並排除分享者領取自身名額的自我配對情況。
 * 雙軌撮合規則：
 * 1. 新手專屬席次（newbie）僅撮合給新手隊列票券。
 * 2. 再領取席次（community）第一優先撮合給 community 票券；無人排隊時改撮合給新手票券（Fallback Matching）。
 * 同時有新手與再領取席次時，新手席次先挑票，所以新手票先拿新手席次，沒有才降級拿再領取席次；同軌道內仍取最舊的席次。
 * 單次撮合批次中，每張排隊號碼牌與每位使用者至多只會獲配一個名額。
 *
 * @param availableSlots 依釋出先後排序的可用席次清單。
 * @param waitingTickets 依加入順序與優先權排序的等候清單。
 * @returns 回傳撮合成功的席次與排隊號碼牌對應陣列，順序同 `availableSlots`。
 */
export function matchTicketsToAvailableSlots(
  availableSlots: readonly AvailableSlot[],
  waitingTickets: readonly WaitingTicket[]
): MatchAssignment[] {
  if (availableSlots.length === 0 || waitingTickets.length === 0) {
    return [];
  }

  const matchedTicketIds = new Set<number>();
  const matchedUserIds = new Set<number>();
  const ticketBySlot = new Map<AvailableSlot, WaitingTicket>();

  const findEligibleTicket = (slot: AvailableSlot, ticketTrack: QueueTrack) =>
    waitingTickets.find(
      (ticket) =>
        !matchedTicketIds.has(ticket.id) &&
        !matchedUserIds.has(ticket.userId) &&
        ticket.userId !== slot.providerUserId &&
        ticket.track === ticketTrack
    );

  for (const slotTrack of SLOT_TRACKS_IN_MATCHING_ORDER) {
    for (const slot of availableSlots) {
      if (slot.track !== slotTrack) {
        continue;
      }

      let matchedTicket: WaitingTicket | undefined;
      for (const ticketTrack of TICKET_TRACKS_BY_SLOT_TRACK[slot.track]) {
        matchedTicket = findEligibleTicket(slot, ticketTrack);
        if (matchedTicket) {
          break;
        }
      }

      if (!matchedTicket) {
        continue;
      }

      matchedTicketIds.add(matchedTicket.id);
      matchedUserIds.add(matchedTicket.userId);
      ticketBySlot.set(slot, matchedTicket);
    }
  }

  return availableSlots.flatMap((slot) => {
    const ticket = ticketBySlot.get(slot);
    return ticket ? [{ slot, ticket }] : [];
  });
}

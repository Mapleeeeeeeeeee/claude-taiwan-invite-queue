import { QUEUE_TRACKS, type QueueTrack } from '../../shared/types';

const QUEUE_TRACK_SET: ReadonlySet<string> = new Set(QUEUE_TRACKS);

/**
 * 把資料庫讀出的 `track` 欄位值轉成 `QueueTrack`。
 * migration 沒有替 `track` 加 CHECK 約束，所以在這裡擋下未知值，不讓它流進撮合引擎。
 *
 * @throws Error 欄位值不是 `QUEUE_TRACKS` 的成員時。
 */
export function parseQueueTrack(rawTrack: string): QueueTrack {
  if (!QUEUE_TRACK_SET.has(rawTrack)) {
    throw new Error(`資料庫出現未知的軌道值：${rawTrack}`);
  }
  return rawTrack as QueueTrack;
}

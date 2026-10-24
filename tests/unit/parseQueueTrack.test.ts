import { describe, expect, it } from 'vitest';
import { QUEUE_TRACKS } from '../../src/shared/types';
import { parseQueueTrack } from '../../src/worker/db/queueTrack';

describe('parseQueueTrack', () => {
  it.each(QUEUE_TRACKS)('資料庫值 %s 是合法軌道，原樣回傳', (track) => {
    expect(parseQueueTrack(track)).toBe(track);
  });

  it('資料庫出現未知軌道值時拋錯，不讓它流進撮合引擎', () => {
    expect(() => parseQueueTrack('foo')).toThrow(/foo/);
  });
});

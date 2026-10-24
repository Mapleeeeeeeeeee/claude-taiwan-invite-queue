import { memo, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  HeartIcon,
  PauseIcon,
  PlayIcon,
  QuotesIcon,
  ViewIcon,
} from '@hugeicons/core-free-icons';
import type { ThankYouWallItemDto } from '../../shared/types';
import { Spotlight } from './Spotlight';
import { LONG_MESSAGE_THRESHOLD, ThankYouCardFooter } from './ThankYouCardParts';
import { ViewAllModal } from './ViewAllModal';

export interface ThankYouWallProps {
  items: ThankYouWallItemDto[];
  isLoading: boolean;
  boardError: string | null;
  onRetry: () => void;
}

const MIN_CARDS_PER_LOOP_HALF = 5;
const MIN_MARQUEE_SECONDS = 22;
const MARQUEE_SECONDS_PER_CARD = 6.5;

/**
 * 跑馬燈捲到 -50% 時要剛好接回起點，所以清單由兩份相同的內容組成；
 * 每一份至少 MIN_CARDS_PER_LOOP_HALF 張，避免卡片太少時畫面出現空白。
 */
function buildMarqueeCards(items: ThankYouWallItemDto[]): ThankYouWallItemDto[] {
  if (items.length === 0) {
    return [];
  }
  let loopHalf = [...items];
  while (loopHalf.length < MIN_CARDS_PER_LOOP_HALF) {
    loopHalf = loopHalf.concat(items);
  }
  return [...loopHalf, ...loopHalf];
}

export const ThankYouWall = memo(function ThankYouWall({
  items,
  isLoading,
  boardError,
  onRetry,
}: ThankYouWallProps) {
  const [isPaused, setIsPaused] = useState(false);
  const [isTouchHeld, setIsTouchHeld] = useState(false);
  const [isViewAllOpen, setIsViewAllOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCardIds, setExpandedCardIds] = useState<Set<number>>(() => new Set());
  const [spotlightItem, setSpotlightItem] = useState<ThankYouWallItemDto | null>(null);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.thankYouMessage.toLowerCase().includes(q) ||
        item.receiverNickname.toLowerCase().includes(q) ||
        item.providerNickname.toLowerCase().includes(q)
    );
  }, [items, searchQuery]);

  function toggleCardExpand(slotId: number) {
    setExpandedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(slotId)) {
        next.delete(slotId);
      } else {
        next.add(slotId);
      }
      return next;
    });
  }

  const displayList = useMemo(() => buildMarqueeCards(items), [items]);

  const marqueeSeconds = Math.max(MIN_MARQUEE_SECONDS, items.length * MARQUEE_SECONDS_PER_CARD);
  // 滑鼠停留時的暫停由 CSS :hover 處理，這裡只管手動暫停與手指按住。
  const isTickerPaused = isPaused || isTouchHeld;

  return (
    <section className="thank-you-wall-section" aria-label="社群感謝牆">
      <div className="section-header wall-header-row">
        <div className="wall-header-text">
          <h2 className="section-title title-with-icon">
            <HugeiconsIcon icon={HeartIcon} size={18} className="header-heart-icon" />
            <span>社群感謝牆</span>
          </h2>
          <p className="section-subtitle">
            每一份成功啟用的邀請碼，都載著版友溫暖的心意
          </p>
        </div>

        {items.length > 0 ? (
          <div className="wall-header-controls">
            <button
              type="button"
              className="btn-wall-view-all"
              onClick={() => setIsViewAllOpen(true)}
              aria-label={`查看全部社群感謝小卡，共 ${items.length} 則`}
              title="查看全部社群感謝小卡"
            >
              <HugeiconsIcon icon={ViewIcon} size={13} />
              <span>查看全部 ({items.length})</span>
            </button>

            <button
              type="button"
              className={`btn-wall-pause ${isPaused ? 'is-paused' : ''}`}
              onClick={() => setIsPaused((prev) => !prev)}
              aria-label={isPaused ? '繼續動態輪播' : '暫停動態輪播'}
              title={isPaused ? '繼續動態輪播' : '暫停動態輪播（滑鼠停留卡片亦會自動暫停）'}
            >
              <HugeiconsIcon icon={isPaused ? PlayIcon : PauseIcon} size={13} />
              <span>{isPaused ? '繼續輪播' : '暫停輪播'}</span>
            </button>
          </div>
        ) : null}
      </div>

      {boardError ? (
        <div className="empty-state">
          <p className="empty-state-text">{boardError}</p>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={onRetry}
            disabled={isLoading}
          >
            點擊重新整理
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state" data-testid="thank-you-wall-empty">
          <HugeiconsIcon icon={QuotesIcon} size={28} className="empty-quote-icon" />
          <p className="empty-state-text">
            目前還沒有感謝小卡，成為第一位分享或領取邀請碼的版友吧！
          </p>
        </div>
      ) : (
        <div
          className="thank-you-ticker-viewport"
          onTouchStart={() => setIsTouchHeld(true)}
          onTouchEnd={() => setIsTouchHeld(false)}
        >
          {/* CSS 動畫在 animation-duration 改變時只會調整進度、不會回到起點；
              用秒數當 key 讓跑馬燈放慢速度時重新從起點開始，看板重抓到同樣內容時則維持目前位置。 */}
          <ul
            key={marqueeSeconds}
            className={`thank-you-ticker-track ${isTickerPaused ? 'is-paused' : ''}`}
            style={{ animationDuration: `${marqueeSeconds}s` }}
            aria-label="即時動態感謝牆"
          >
            {displayList.map((item, index) => {
              const isLong = item.thankYouMessage.length > LONG_MESSAGE_THRESHOLD;
              return (
                <li
                  key={`${item.slotId}-${index}`}
                  className="thank-you-card ticker-card"
                  tabIndex={-1}
                  onClick={() => setSpotlightItem(item)}
                  title="點擊查看小卡詳細內容"
                >
                  <div className="thank-you-quote-decor">
                    <HugeiconsIcon icon={QuotesIcon} size={16} />
                  </div>

                  <p className={`thank-you-message ${isLong ? 'thank-you-message-clamped' : ''}`}>
                    「{item.thankYouMessage}」
                  </p>
                  {isLong ? (
                    <span className="ticker-card-hint">點擊看全文</span>
                  ) : null}

                  <ThankYouCardFooter item={item} />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {isViewAllOpen ? (
        <ViewAllModal
          filteredItems={filteredItems}
          searchQuery={searchQuery}
          expandedCardIds={expandedCardIds}
          onSearchQueryChange={setSearchQuery}
          onToggleCardExpand={toggleCardExpand}
          onSelectItem={setSpotlightItem}
          onClose={() => setIsViewAllOpen(false)}
        />
      ) : null}

      {spotlightItem ? (
        <Spotlight item={spotlightItem} onClose={() => setSpotlightItem(null)} />
      ) : null}
    </section>
  );
});

import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, HeartIcon, QuotesIcon, Search01Icon } from '@hugeicons/core-free-icons';
import type { ThankYouWallItemDto } from '../../shared/types';
import { useModalDialog } from '../hooks/useModalDialog';
import { LONG_MESSAGE_THRESHOLD, ThankYouCardFooter } from './ThankYouCardParts';

export interface ViewAllModalProps {
  filteredItems: ThankYouWallItemDto[];
  searchQuery: string;
  expandedCardIds: ReadonlySet<number>;
  onSearchQueryChange: (query: string) => void;
  onToggleCardExpand: (slotId: number) => void;
  onSelectItem: (item: ThankYouWallItemDto) => void;
  onClose: () => void;
}

export function ViewAllModal({
  filteredItems,
  searchQuery,
  expandedCardIds,
  onSearchQueryChange,
  onToggleCardExpand,
  onSelectItem,
  onClose,
}: ViewAllModalProps) {
  const dialogProps = useModalDialog(onClose);

  return (
    <dialog
      {...dialogProps}
      className="modal modal-dialog-lg"
      aria-label="社群感謝小卡完整列表"
    >
      <div className="modal-card modal-card-lg" data-testid="modal-all-thank-you">
        <div className="modal-header-bar">
          <div className="modal-header-left">
            <div className="modal-header-icon-badge" aria-hidden="true">
              <HugeiconsIcon icon={HeartIcon} size={18} />
            </div>
            <div className="modal-header-titles">
              <div className="modal-title-row">
                <h3 className="modal-title">社群感謝小卡完整列表</h3>
                <span className="modal-count-badge">
                  共 {filteredItems.length} 則{searchQuery ? '符合' : '回饋'}
                </span>
              </div>
              <span className="modal-subtitle">
                版友互助的溫暖回饋，點擊任一張可展開或放大查看
              </span>
            </div>
          </div>

          <div className="modal-header-actions">
            <div className="modal-search-box">
              <HugeiconsIcon
                icon={Search01Icon}
                size={14}
                className="modal-search-icon"
                aria-hidden="true"
              />
              <input
                type="text"
                className="modal-search-input"
                placeholder="搜尋暱稱或內容..."
                value={searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="btn-clear-search"
                  onClick={() => onSearchQueryChange('')}
                  aria-label="清除搜尋"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={13} />
                </button>
              ) : null}
            </div>

            <button
              type="button"
              className="btn-modal-close"
              onClick={onClose}
              aria-label="關閉完整列表"
              title="關閉"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={16} />
            </button>
          </div>
        </div>

        <div className="modal-scroll-body">
          {filteredItems.length === 0 ? (
            <div className="modal-search-empty">
              <p>查無符合「{searchQuery}」的感謝小卡</p>
              <button
                type="button"
                className="btn btn-outline btn-xs"
                onClick={() => onSearchQueryChange('')}
              >
                清除搜尋
              </button>
            </div>
          ) : (
            <ul className="all-thank-you-grid">
              {filteredItems.map((item) => {
                const isLong = item.thankYouMessage.length > LONG_MESSAGE_THRESHOLD;
                const isExpanded = expandedCardIds.has(item.slotId);

                return (
                  <li
                    key={item.slotId}
                    className="thank-you-card modal-thank-you-card"
                    tabIndex={-1}
                    onClick={() => onSelectItem(item)}
                    title="點擊查看完整大卡"
                  >
                    <div className="thank-you-quote-decor">
                      <HugeiconsIcon icon={QuotesIcon} size={16} />
                    </div>

                    <p className={`thank-you-message ${isLong && !isExpanded ? 'thank-you-message-clamped' : ''}`}>
                      「{item.thankYouMessage}」
                    </p>

                    {isLong ? (
                      <button
                        type="button"
                        className="btn-toggle-expand"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleCardExpand(item.slotId);
                        }}
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? '收起全文' : '...展開全文'}
                      </button>
                    ) : null}

                    <ThankYouCardFooter item={item} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </dialog>
  );
}

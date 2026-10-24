import { memo } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ReloadIcon } from '@hugeicons/core-free-icons';
import type { BoardDto } from '../../shared/types';
import { TRACK_LABELS } from '../utils/trackLabels';

// 看板尚未載入時用佔位符，避免把「沒有資料」顯示成真實的 0。
const NOT_LOADED_PLACEHOLDER = '—';

export interface BoardStatsProps {
  board: BoardDto | null;
  isLoading: boolean;
  boardError: string | null;
  onRefresh: () => void;
}

interface TrackBreakdownProps {
  testId: string;
  newbieCount: number | undefined;
  communityCount: number | undefined;
}

// 兩個項目各自是一個 span，窄螢幕換行時整個項目一起換；中間的空白文字節點讓 textContent 讀起來仍有空格。
function TrackBreakdown({ testId, newbieCount, communityCount }: TrackBreakdownProps) {
  return (
    <span className="stat-metric-breakdown" data-testid={testId}>
      <span>
        {TRACK_LABELS.newbie} {newbieCount ?? NOT_LOADED_PLACEHOLDER}
      </span>{' '}
      <span>
        {TRACK_LABELS.community} {communityCount ?? NOT_LOADED_PLACEHOLDER}
      </span>
    </span>
  );
}

export const BoardStats = memo(function BoardStats({
  board,
  isLoading,
  boardError,
  onRefresh,
}: BoardStatsProps) {
  return (
    <div className="stats-strip-container" role="region" aria-label="即時名額看板">
      {boardError ? (
        <div className="alert alert-error stats-error-bar" role="alert">
          <span>{boardError}</span>
          <button
            type="button"
            className="btn btn-outline btn-xs btn-icon"
            onClick={onRefresh}
            disabled={isLoading}
          >
            <HugeiconsIcon icon={ReloadIcon} size={13} />
            <span>重試</span>
          </button>
        </div>
      ) : null}

      <div className="stats-ribbon">
        <div className="stat-metric stat-metric-available">
          <div className="stat-metric-header">
            <span className="stat-metric-label">可用席次</span>
            <TrackBreakdown
              testId="slots-track-breakdown"
              newbieCount={board?.newbieSlotsCount}
              communityCount={board?.communitySlotsCount}
            />
          </div>
          <div className="stat-metric-value-wrap">
            <strong className="stat-metric-number" data-testid="available-slots-count">
              {board?.availableSlotsCount ?? NOT_LOADED_PLACEHOLDER}
            </strong>
            <span className="stat-metric-unit">席</span>
          </div>
        </div>

        <div className="stat-ribbon-divider" />

        <div className="stat-metric">
          <div className="stat-metric-header">
            <span className="stat-metric-label">排隊中</span>
            <TrackBreakdown
              testId="queue-track-breakdown"
              newbieCount={board?.newbieQueueCount}
              communityCount={board?.communityQueueCount}
            />
          </div>
          <div className="stat-metric-value-wrap">
            <strong className="stat-metric-number" data-testid="waiting-queue-count">
              {board?.waitingQueueCount ?? NOT_LOADED_PLACEHOLDER}
            </strong>
            <span className="stat-metric-unit">人</span>
          </div>
        </div>

        <div className="stat-ribbon-divider" />

        <div className="stat-metric">
          <div className="stat-metric-header">
            <span className="stat-metric-label">累計已領取</span>
          </div>
          <div className="stat-metric-value-wrap">
            <strong className="stat-metric-number" data-testid="total-confirmed-count">
              {board?.totalConfirmedCount ?? NOT_LOADED_PLACEHOLDER}
            </strong>
            <span className="stat-metric-unit">次</span>
          </div>
        </div>
      </div>
    </div>
  );
});

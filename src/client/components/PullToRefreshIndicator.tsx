import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, ArrowUp01Icon, Loading03Icon } from '@hugeicons/core-free-icons';
import { usePullToRefresh } from '../hooks/usePullToRefresh';

const FULL_OPACITY_PULL_DISTANCE_PX = 35;

export interface PullToRefreshIndicatorProps {
  onRefresh: () => Promise<void> | void;
}

// 下拉手勢的 state 放在這個葉節點，touchmove 時只有指示條重新渲染，不牽動整棵 App。
export function PullToRefreshIndicator({ onRefresh }: PullToRefreshIndicatorProps) {
  const { pullDistance, isPulling, isRefreshing, hasReachedThreshold } = usePullToRefresh({
    onRefresh,
  });

  if (!isPulling && !isRefreshing) {
    return null;
  }

  return (
    <div
      className="pull-to-refresh-bar"
      style={{
        height: `${pullDistance}px`,
        opacity: Math.min(1, pullDistance / FULL_OPACITY_PULL_DISTANCE_PX),
      }}
      aria-hidden="true"
    >
      <div className="pull-to-refresh-content">
        {isRefreshing ? (
          <>
            <HugeiconsIcon icon={Loading03Icon} size={15} className="spinner-icon" />
            <span>更新看板最新資料中...</span>
          </>
        ) : hasReachedThreshold ? (
          <>
            <HugeiconsIcon icon={ArrowUp01Icon} size={15} className="pull-arrow-icon rotate-up" />
            <span>釋放立即重新整理</span>
          </>
        ) : (
          <>
            <HugeiconsIcon icon={ArrowDown01Icon} size={15} className="pull-arrow-icon" />
            <span>下拉即可更新看板</span>
          </>
        )}
      </div>
    </div>
  );
}

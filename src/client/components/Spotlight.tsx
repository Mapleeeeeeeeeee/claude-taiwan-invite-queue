import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, QuotesIcon, UserCircleIcon } from '@hugeicons/core-free-icons';
import type { ThankYouWallItemDto } from '../../shared/types';
import { useModalDialog } from '../hooks/useModalDialog';
import { formatDisplayTime } from './ThankYouCardParts';

export interface SpotlightProps {
  item: ThankYouWallItemDto;
  onClose: () => void;
}

export function Spotlight({ item, onClose }: SpotlightProps) {
  const dialogProps = useModalDialog(onClose);

  return (
    <dialog {...dialogProps} className="modal spotlight-dialog" aria-label="社群感謝小卡詳細內容">
      <div className="spotlight-card">
        <div className="spotlight-header">
          <div className="spotlight-quote-badge" aria-hidden="true">
            <HugeiconsIcon icon={QuotesIcon} size={20} />
          </div>
          <button
            type="button"
            className="btn-modal-close"
            onClick={onClose}
            aria-label="關閉小卡詳情"
            title="關閉"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} />
          </button>
        </div>

        <p className="spotlight-message">「{item.thankYouMessage}」</p>

        <div className="spotlight-meta-block">
          <div className="spotlight-meta-row">
            <span className="spotlight-meta-label">領取者</span>
            <span className="spotlight-meta-val">
              <HugeiconsIcon
                icon={UserCircleIcon}
                size={15}
                className="participant-user-icon"
                aria-hidden="true"
              />
              <span>{item.receiverNickname}</span>
            </span>
          </div>
          <div className="spotlight-meta-row">
            <span className="spotlight-meta-label">分享者</span>
            <span className="spotlight-meta-val">{item.providerNickname}</span>
          </div>
          <div className="spotlight-meta-row">
            <span className="spotlight-meta-label">確認啟用時間</span>
            <span className="spotlight-meta-val">{formatDisplayTime(item.confirmedAt)}</span>
          </div>
        </div>

        <div className="spotlight-actions">
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
            關閉
          </button>
        </div>
      </div>
    </dialog>
  );
}

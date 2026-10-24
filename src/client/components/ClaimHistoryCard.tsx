import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, CheckmarkCircle01Icon, Copy01Icon, Tick01Icon } from '@hugeicons/core-free-icons';
import {
  FALLBACK_PROVIDER_NICKNAME,
  FALLBACK_THANK_YOU_RECIPIENT,
  type MyQueueEntryDto,
} from '../../shared/types';
import { useClipboardCopy } from '../hooks/useClipboardCopy';

export interface ClaimHistoryCardProps {
  confirmedRecord: MyQueueEntryDto;
}

export function ClaimHistoryCard({ confirmedRecord }: ClaimHistoryCardProps) {
  const { hasCopied: hasCopiedUrl, copyText } = useClipboardCopy();
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);

  return (
    <div className="claim-history-disclosure-card" data-testid="claim-history-card">
      <button
        type="button"
        className="claim-history-summary-bar"
        onClick={() => setIsHistoryExpanded((prev) => !prev)}
        aria-expanded={isHistoryExpanded}
        title={isHistoryExpanded ? '點擊收起紀錄' : '點擊查看邀請連結備查與感謝小卡'}
      >
        <div className="claim-history-summary-left">
          <HugeiconsIcon
            icon={CheckmarkCircle01Icon}
            size={17}
            className="claim-history-icon-check"
            aria-hidden="true"
          />
          <div className="claim-history-text-wrap">
            <span className="claim-history-title">已成功啟用試用名額</span>
            <span className="claim-history-sub">
              感謝版友 <strong>{confirmedRecord.providerNickname ?? FALLBACK_PROVIDER_NICKNAME}</strong> 的分享
            </span>
          </div>
        </div>
        <div className="claim-history-summary-right">
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={16}
            className={`claim-history-chevron ${isHistoryExpanded ? 'is-expanded' : ''}`}
            aria-hidden="true"
          />
        </div>
      </button>

      {isHistoryExpanded ? (
        <div className="claim-history-detail-body">
          {confirmedRecord.referralUrl ? (
            <div className="referral-url-box">
              <span className="preview-label">邀請連結備查（單一帳號僅限使用一次）：</span>
              <code className="referral-url-code">{confirmedRecord.referralUrl}</code>
              <div className="referral-url-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm btn-icon"
                  onClick={() => void copyText(confirmedRecord.referralUrl!)}
                >
                  <HugeiconsIcon icon={hasCopiedUrl ? Tick01Icon : Copy01Icon} size={15} />
                  <span>{hasCopiedUrl ? '已複製連結' : '複製邀請連結'}</span>
                </button>
              </div>
            </div>
          ) : null}

          <div className="preview-card-box">
            <span className="preview-label">
              送給 {confirmedRecord.providerNickname ?? FALLBACK_THANK_YOU_RECIPIENT} 的感謝小卡：
            </span>
            <p className="preview-content">「{confirmedRecord.thankYouMessage}」</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

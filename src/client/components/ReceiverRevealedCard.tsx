import { HugeiconsIcon } from '@hugeicons/react';
import {
  AlertCircleIcon,
  CheckmarkCircle01Icon,
  Copy01Icon,
  Tick01Icon,
} from '@hugeicons/core-free-icons';
import {
  CONFIRM_DURATION_MINUTES,
  FALLBACK_PROVIDER_NICKNAME,
  MAX_INVALID_RETRY_COUNT,
  type MyQueueEntryDto,
} from '../../shared/types';
import { useClipboardCopy } from '../hooks/useClipboardCopy';
import { useModalDialog } from '../hooks/useModalDialog';
import { CountdownTimer } from './CountdownTimer';

interface ReportInvalidConfirmDialogProps {
  isSubmitting: boolean;
  onClose: () => void;
  onConfirm: () => Promise<boolean>;
}

function ReportInvalidConfirmDialog({
  isSubmitting,
  onClose,
  onConfirm,
}: ReportInvalidConfirmDialogProps) {
  const dialogProps = useModalDialog(onClose);

  return (
    <dialog {...dialogProps} className="modal" aria-label="確認回報無效">
      <div className="modal-card">
        <h4 className="modal-title">確定這組邀請連結無法使用嗎？</h4>
        <p className="modal-body">
          回報後將立即停用這組連結尚未發出的剩餘名額，並為你優先排回隊伍最前面等待下一組。
          <strong>（每個帳號終身僅限使用 {MAX_INVALID_RETRY_COUNT} 次無效重排機會）</strong>
        </p>
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-outline"
            disabled={isSubmitting}
            onClick={onClose}
          >
            返回再試一次
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={isSubmitting}
            onClick={() => void onConfirm()}
          >
            確定回報無效並優先重排
          </button>
        </div>
      </div>
    </dialog>
  );
}

export interface ReceiverRevealedCardProps {
  myQueue: MyQueueEntryDto;
  isSubmitting: boolean;
  isReportInvalidConfirmOpen: boolean;
  onConfirmSlot: () => Promise<boolean>;
  onOpenReportInvalidConfirm: () => void;
  onCloseReportInvalidConfirm: () => void;
  onReportSlotInvalid: () => Promise<boolean>;
  /** 確認倒數歸零時呼叫，讓父層向伺服器同步逾時後的狀態。 */
  onCountdownExpire: () => void;
}

export function ReceiverRevealedCard({
  myQueue,
  isSubmitting,
  isReportInvalidConfirmOpen,
  onConfirmSlot,
  onOpenReportInvalidConfirm,
  onCloseReportInvalidConfirm,
  onReportSlotInvalid,
  onCountdownExpire,
}: ReceiverRevealedCardProps) {
  const { hasCopied: hasCopiedUrl, copyText } = useClipboardCopy();
  const canClickReportInvalid = Boolean(myQueue.canReportInvalid);

  return (
    <div className="queue-state-card state-revealed" data-testid="queue-state-revealed">
      <h3 className="state-heading">請立即前往啟用 Claude 邀請連結</h3>
      <p className="state-desc">
        來自版友 <strong>{myQueue.providerNickname ?? FALLBACK_PROVIDER_NICKNAME}</strong> 的分享。
        若解鎖滿 {CONFIRM_DURATION_MINUTES} 分鐘未回報無效，系統將自動為你送出感謝小卡！
      </p>

      <div className="countdown-banner countdown-warning">
        <span>確認截止倒數（{CONFIRM_DURATION_MINUTES} 分鐘內有效）：</span>
        <strong className="countdown-timer">
          <CountdownTimer expiresAt={myQueue.confirmExpiresAt} onExpire={onCountdownExpire} />
        </strong>
      </div>

      <div className="referral-url-box">
        <code className="referral-url-code" data-testid="revealed-referral-url">
          {myQueue.referralUrl}
        </code>
        <div className="referral-url-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-icon"
            onClick={() => {
              if (myQueue.referralUrl) {
                void copyText(myQueue.referralUrl);
              }
            }}
          >
            <HugeiconsIcon icon={hasCopiedUrl ? Tick01Icon : Copy01Icon} size={15} />
            <span>{hasCopiedUrl ? '已複製連結' : '複製邀請連結'}</span>
          </button>
          {myQueue.referralUrl ? (
            <a
              href={myQueue.referralUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary btn-sm btn-icon"
            >
              <span>前往啟用連結</span>
            </a>
          ) : null}
        </div>
      </div>

      <p>
        提醒：同一組 Claude 邀請連結共有多個共用名額，其餘名額正分配給下一位排隊版友。請僅供自己啟用 1 次，切勿轉傳他人，以免造成後續版友額滿失效。
      </p>

      <div className="confirm-action-group">
        <button
          type="button"
          className="btn btn-success btn-lg btn-icon"
          disabled={isSubmitting}
          onClick={() => void onConfirmSlot()}
        >
          <HugeiconsIcon icon={CheckmarkCircle01Icon} size={18} />
          <span>確認啟用並送出感謝</span>
        </button>

        {canClickReportInvalid ? (
          <button
            type="button"
            className="btn btn-warning btn-icon"
            disabled={isSubmitting}
            onClick={onOpenReportInvalidConfirm}
          >
            <HugeiconsIcon icon={AlertCircleIcon} size={16} />
            <span>邀請連結無效或已額滿</span>
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-disabled"
            disabled
            title={`每個帳號終身僅限使用 ${MAX_INVALID_RETRY_COUNT} 次無效重排機會`}
          >
            已用完無效重排額度（限 {MAX_INVALID_RETRY_COUNT} 次）
          </button>
        )}
      </div>


      {isReportInvalidConfirmOpen ? (
        <ReportInvalidConfirmDialog
          isSubmitting={isSubmitting}
          onClose={onCloseReportInvalidConfirm}
          onConfirm={onReportSlotInvalid}
        />
      ) : null}
    </div>
  );
}

import { HugeiconsIcon } from '@hugeicons/react';
import { InformationCircleIcon, ViewIcon } from '@hugeicons/core-free-icons';
import {
  CONFIRM_DURATION_MINUTES,
  FALLBACK_PROVIDER_NICKNAME,
  getRemainingRetryCount,
  MAX_INVALID_RETRY_COUNT,
  RESERVATION_DURATION_HOURS,
  type MeDto,
} from '../../shared/types';
import type { UsePushSubscriptionReturn } from '../hooks/usePushSubscription';
import { useScrollIntoViewOnChange } from '../hooks/useScrollIntoViewOnChange';
import { ClaimHistoryCard } from './ClaimHistoryCard';
import { CountdownTimer } from './CountdownTimer';
import { InfoTooltip } from './InfoTooltip';
import { JoinQueueForm } from './JoinQueueForm';
import { LoginGuideCallout } from './LoginGuideCallout';
import { ReceiverRevealedCard } from './ReceiverRevealedCard';

export interface ReceiverPanelProps {
  me: MeDto | null;
  isSubmitting: boolean;
  actionError: string | null;
  isLoginRequired: boolean;
  nicknameInput: string;
  thankYouMessageInput: string;
  isEligibleForNewbieTrack: boolean;
  isReportInvalidConfirmOpen: boolean;
  onNicknameChange: (value: string) => void;
  onThankYouMessageChange: (value: string) => void;
  onJoinQueue: () => Promise<boolean>;
  onRevealSlot: () => Promise<boolean>;
  onConfirmSlot: () => Promise<boolean>;
  onOpenReportInvalidConfirm: () => void;
  onCloseReportInvalidConfirm: () => void;
  onReportSlotInvalid: () => Promise<boolean>;
  onCancelQueue: () => Promise<boolean>;
  /** 保留或確認倒數歸零時呼叫，讓父層向伺服器同步逾時後的狀態。 */
  onCountdownExpire: () => void;
  onRequireLogin: () => void;
  push: UsePushSubscriptionReturn;
  onTestPush: () => Promise<boolean>;
}

export function ReceiverPanel({
  me,
  isSubmitting,
  actionError,
  isLoginRequired,
  nicknameInput,
  thankYouMessageInput,
  isEligibleForNewbieTrack,
  isReportInvalidConfirmOpen,
  onNicknameChange,
  onThankYouMessageChange,
  onJoinQueue,
  onRevealSlot,
  onConfirmSlot,
  onOpenReportInvalidConfirm,
  onCloseReportInvalidConfirm,
  onReportSlotInvalid,
  onCancelQueue,
  onCountdownExpire,
  onRequireLogin,
  push,
  onTestPush,
}: ReceiverPanelProps) {
  const myQueue = me?.myQueue ?? null;
  const status = myQueue?.status ?? null;
  const confirmedRecord = me?.myConfirmedClaim ?? null;
  const remainingRetryCount = getRemainingRetryCount(me?.user?.invalidRetryCount ?? 0);

  const actionErrorRef = useScrollIntoViewOnChange<HTMLDivElement>(
    isLoginRequired ? null : actionError
  );

  return (
    <div className="panel-card" aria-label="我要排隊領取">
      <div className="panel-top-bar">
        <InfoTooltip
          label="權益與排隊說明"
          title="Claude 邀請碼權益與排隊規則"
          items={[
            <span key="receiver-benefit">
              <span className="tooltip-item-lead">領取者好處：</span>
              透過專屬連結啟用，可獲得
              <strong className="tooltip-highlight-benefit">「免費 1 星期 Pro 方案試用」</strong>。
            </span>,
            <span key="provider-reward">
              <span className="tooltip-item-lead">提供者回饋：</span>
              若後續付費訂閱，分享者可獲
              <strong className="tooltip-highlight-benefit"> $10 的 API Credits 回饋</strong>
              <span className="tooltip-alert-warning">（系統會開啟自動加值，記得關閉）</span>。
            </span>,
            <span key="queue-rule">
              <span className="tooltip-item-lead">排隊與保留：</span>
              先到先得自動配對，配對成功保留 {RESERVATION_DURATION_HOURS} 小時（若暫無需求可主動放棄讓給下一位）；點擊解鎖後有 {CONFIRM_DURATION_MINUTES} 分鐘啟用確認時間。
            </span>,
            <span key="retry-rule">
              <span className="tooltip-item-lead">防失效重排：</span>
              若連結失效可回報無效，系統為你優先重排至隊伍最前（限 {MAX_INVALID_RETRY_COUNT} 次）。
            </span>,
          ]}
        />
      </div>

      {isLoginRequired ? (
        <LoginGuideCallout onRequireLogin={onRequireLogin} isSubmitting={isSubmitting} />
      ) : actionError ? (
        <div ref={actionErrorRef} className="alert alert-error" role="alert">
          <span>{actionError}</span>
        </div>
      ) : null}

      {status === 'waiting' && myQueue ? (
        <div className="queue-state-card" data-testid="queue-state-waiting">
          <div className="state-badge">排隊等待中</div>
          <h3 className="state-heading">
            {myQueue.queuePosition === null ? (
              '排隊成功！'
            ) : (
              <>
                排隊成功！你目前在第{' '}
                <span className="highlight-number">{myQueue.queuePosition}</span> 順位
              </>
            )}
          </h3>
          <p className="state-desc">
            輪到你時會發送手機推播通知，並為你保留名額 {RESERVATION_DURATION_HOURS} 小時。
            {myQueue.isRequeuedWithPriority ? (
              <strong className="priority-tag">
                （已為你優先排回隊伍最前面，剩餘重排機會 {remainingRetryCount} 次）
              </strong>
            ) : null}
          </p>

          <div className="preview-card-box">
            <span className="preview-label">你預寫的感謝小卡：</span>
            <p className="preview-content">「{myQueue.thankYouMessage}」</p>
          </div>

          <div className="state-actions">
            <button
              type="button"
              className="btn btn-outline btn-danger"
              disabled={isSubmitting}
              onClick={() => void onCancelQueue()}
            >
              取消排隊
            </button>
          </div>
        </div>
      ) : status === 'reserved' && myQueue ? (
        <div className="queue-state-card state-reserved" data-testid="queue-state-reserved">
          <div className="state-badge badge-reserved">已為你保留名額</div>
          <h3 className="state-heading">
            輪到你了，請於 {RESERVATION_DURATION_HOURS} 小時內點擊解鎖查看邀請連結
          </h3>
          <p className="state-desc">
            感謝版友 <strong>{myQueue.providerNickname ?? FALLBACK_PROVIDER_NICKNAME}</strong> 的分享！
            在點擊解鎖前不會顯示完整網址；若逾時未解鎖，系統會自動把名額讓給下一位排隊版友。
          </p>

          <div className="countdown-banner">
            <span>保留剩餘時間：</span>
            <strong className="countdown-timer">
              <CountdownTimer expiresAt={myQueue.reserveExpiresAt} onExpire={onCountdownExpire} />
            </strong>
          </div>

          <div className="reserved-notice-box" role="note">
            <div className="reserved-notice-title">
              <HugeiconsIcon icon={InformationCircleIcon} size={16} />
              <span>請在解鎖前確認需求（重要提醒）</span>
            </div>
            <p className="reserved-notice-desc">
              點擊「解鎖」後將視為已取用並開啟 {CONFIRM_DURATION_MINUTES} 分鐘確認窗口。若你目前暫時不需要 Pro 試用，請<strong>不要點擊解鎖</strong>，直接點選下方<strong>「暫無需求，放棄名額留給下一位」</strong>：名額將完好無損立即留給下一位排隊版友，且<strong>不會消耗你的領取資格</strong>，未來需要時仍可隨時再排！
            </p>
          </div>

          <div className="state-actions">
            <button
              type="button"
              className="btn btn-primary btn-lg btn-icon"
              disabled={isSubmitting}
              onClick={() => void onRevealSlot()}
            >
              <HugeiconsIcon icon={ViewIcon} size={18} />
              <span>確認需要，解鎖查看邀請連結</span>
            </button>
            <button
              type="button"
              className="btn btn-outline btn-danger"
              disabled={isSubmitting}
              onClick={() => void onCancelQueue()}
            >
              暫無需求，放棄名額留給下一位
            </button>
          </div>
        </div>
      ) : status === 'revealed' && myQueue ? (
        <ReceiverRevealedCard
          myQueue={myQueue}
          isSubmitting={isSubmitting}
          isReportInvalidConfirmOpen={isReportInvalidConfirmOpen}
          onConfirmSlot={onConfirmSlot}
          onOpenReportInvalidConfirm={onOpenReportInvalidConfirm}
          onCloseReportInvalidConfirm={onCloseReportInvalidConfirm}
          onReportSlotInvalid={onReportSlotInvalid}
          onCountdownExpire={onCountdownExpire}
        />
      ) : (
        <>
          {confirmedRecord ? <ClaimHistoryCard confirmedRecord={confirmedRecord} /> : null}

          <JoinQueueForm
            me={me}
            isSubmitting={isSubmitting}
            isReservationExpired={status === 'expired'}
            nicknameInput={nicknameInput}
            thankYouMessageInput={thankYouMessageInput}
            isEligibleForNewbieTrack={isEligibleForNewbieTrack}
            onNicknameChange={onNicknameChange}
            onThankYouMessageChange={onThankYouMessageChange}
            onJoinQueue={onJoinQueue}
            onRequireLogin={onRequireLogin}
            push={push}
            onTestPush={onTestPush}
          />
        </>
      )}
    </div>
  );
}

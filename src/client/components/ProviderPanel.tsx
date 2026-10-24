import type { FormEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { HeartIcon } from '@hugeicons/core-free-icons';
import {
  CONFIRM_DURATION_MINUTES,
  MAX_NICKNAME_LENGTH,
  RESERVATION_DURATION_HOURS,
  DEFAULT_SLOT_COUNT,
  VALID_SLOT_COUNTS,
  type MeDto,
  type QueueTrack,
  type SlotCount,
  type SlotStatus,
} from '../../shared/types';
import { GoogleBrandIcon } from './GoogleBrandIcon';
import { GoogleSignInButton } from './GoogleSignInButton';
import { InfoTooltip } from './InfoTooltip';
import { LoginGuideCallout } from './LoginGuideCallout';
import { PushToggleButton } from './PushToggleButton';
import type { UsePushSubscriptionReturn } from '../hooks/usePushSubscription';
import { useScrollIntoViewOnChange } from '../hooks/useScrollIntoViewOnChange';
import { TRACK_LABELS } from '../utils/trackLabels';

export interface ProviderPanelProps {
  me: MeDto | null;
  isSubmitting: boolean;
  actionError: string | null;
  isLoginRequired: boolean;
  nicknameInput: string;
  rawUrlInput: string;
  slotCountInput: SlotCount;
  providerTrackInput: QueueTrack;
  onNicknameChange: (value: string) => void;
  onRawUrlChange: (value: string) => void;
  onSlotCountChange: (value: SlotCount) => void;
  onProviderTrackChange: (track: QueueTrack) => void;
  onSubmitInviteLink: () => Promise<boolean>;
  push: UsePushSubscriptionReturn;
  onRequireLogin: () => void;
  onTestPush: () => Promise<boolean>;
}

const MIN_SLOT_COUNT = Math.min(...VALID_SLOT_COUNTS);

// 選項從名額數最多的開始排。
const SLOT_COUNT_OPTIONS: ReadonlyArray<SlotCount> = [...VALID_SLOT_COUNTS].reverse();

const SLOT_STATUS_LABELS: Record<SlotStatus, string> = {
  available: '等待排隊者中',
  reserved: `已保留給版友（${RESERVATION_DURATION_HOURS}hr 解鎖中）`,
  revealed: `版友已解鎖（${CONFIRM_DURATION_MINUTES}min 確認中）`,
  confirmed: '已成功啟用',
  invalidated: '被回報無效',
  closed: '因同組無效而停用',
};

export function ProviderPanel({
  me,
  isSubmitting,
  actionError,
  isLoginRequired,
  nicknameInput,
  rawUrlInput,
  slotCountInput,
  providerTrackInput,
  onNicknameChange,
  onRawUrlChange,
  onSlotCountChange,
  onProviderTrackChange,
  onSubmitInviteLink,
  push,
  onRequireLogin,
  onTestPush,
}: ProviderPanelProps) {
  const user = me?.user ?? null;
  const isProviderBlocked = user?.isProviderBlocked ?? false;
  const mySharedLinks = me?.mySharedLinks ?? [];

  async function handleShareSubmit(e: FormEvent) {
    e.preventDefault();
    if (!user) {
      onRequireLogin();
      return;
    }

    await onSubmitInviteLink();
  }

  // 母文件規定分享失敗的原因顯示在輸入框下方；需要登入時改由上方的登入引導接手。
  const shareErrorMessage = actionError && !isLoginRequired ? actionError : null;
  const shareErrorRef = useScrollIntoViewOnChange<HTMLDivElement>(shareErrorMessage);
  const shareErrorAlert = shareErrorMessage ? (
    <div ref={shareErrorRef} className="alert alert-error" role="alert">
      <span>{shareErrorMessage}</span>
    </div>
  ) : null;

  const submitButton = (
    <button
      type="submit"
      className="btn btn-primary btn-lg"
      disabled={isSubmitting}
    >
      {user ? (
        '送出分享邀請連結'
      ) : (
        <span className="btn-inline-content">
          <GoogleBrandIcon size={18} />
          <span>使用 Google 帳號登入</span>
        </span>
      )}
    </button>
  );

  return (
    <div className="panel-card" aria-label="我要分享邀請碼">
      <div className="panel-top-bar">
        <InfoTooltip
          label="回饋與分享說明"
          title="Claude 邀請碼回饋與分享規則"
          items={[
            <span key="provider-reward">
              <span className="tooltip-item-lead">分享回饋：</span>
              被邀請者若付費訂閱，提供者可獲
              <strong className="tooltip-highlight-benefit"> $10 的 API Credits 回饋</strong>
              <span className="tooltip-alert-warning">（系統會開啟自動加值，記得關閉）</span>。
            </span>,
            <span key="receiver-benefit">
              <span className="tooltip-item-lead">受邀者好處：</span>
              版友透過你的連結啟用，享有
              <strong className="tooltip-highlight-benefit">「免費 1 星期 Pro 方案試用」</strong>。
            </span>,
            <span key="slot-mgmt">
              <span className="tooltip-item-lead">名額管理：</span>
              每組 Claude 邀請碼預設為 {DEFAULT_SLOT_COUNT} 個名額，可依實際剩餘自訂指定 {MIN_SLOT_COUNT}～{DEFAULT_SLOT_COUNT} 次。
            </span>,
            <span key="feedback">
              <span className="tooltip-item-lead">即時反饋：</span>
              版友確認啟用成功後，你會第一時間收到推播通知與專屬感謝小卡。
            </span>,
          ]}
        />
      </div>

      {isLoginRequired ? (
        <LoginGuideCallout
          onRequireLogin={onRequireLogin}
          isSubmitting={isSubmitting}
          message="登入後系統將記錄你分享的名額狀態，並在版友啟用時發送感謝推播。"
        />
      ) : null}

      {isProviderBlocked ? (
        <>
          <div className="alert alert-error" data-testid="provider-blocked-notice">
            <strong>由於先前提供的連結多次被回報無效，目前已暫停提供權限</strong>
          </div>
          {shareErrorAlert}
        </>
      ) : (
        <form className="form-stack" onSubmit={(e) => void handleShareSubmit(e)}>
          <div className="form-group">
            <label htmlFor="provider-nickname" className="form-label">
              你的顯示暱稱
            </label>
            <input
              id="provider-nickname"
              type="text"
              className="input-field"
              placeholder="例如：小張、Claude 愛用者"
              value={nicknameInput}
              onChange={(e) => onNicknameChange(e.target.value)}
              maxLength={MAX_NICKNAME_LENGTH}
            />
          </div>

          <div className="form-group">
            <label htmlFor="referral-url-input" className="form-label">
              Claude 邀請連結（可直接貼上整段文字，系統會自動擷取網址）
            </label>
            <textarea
              id="referral-url-input"
              className="textarea-field"
              rows={2}
              placeholder="請貼上 https://claude.ai/referral/... 連結或包含連結的整段訊息"
              value={rawUrlInput}
              onChange={(e) => onRawUrlChange(e.target.value)}
              required
            />
            {shareErrorAlert}
          </div>

          <div className="form-group">
            <span className="form-label">名額適用對象</span>
            <div className="track-selector-group" role="radiogroup" aria-label="名額適用對象">
              <button
                type="button"
                role="radio"
                aria-checked={providerTrackInput === 'newbie'}
                className={`track-option-btn ${providerTrackInput === 'newbie' ? 'track-option-active' : ''}`}
                onClick={() => onProviderTrackChange('newbie')}
              >
                <strong>限新手首次體驗（預設）</strong>
                <span className="track-option-sub">
                  保留給尚未體驗過 Pro 的版友，優先保障新手
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={providerTrackInput === 'community'}
                className={`track-option-btn ${providerTrackInput === 'community' ? 'track-option-active' : ''}`}
                onClick={() => onProviderTrackChange('community')}
              >
                <strong>開放再領取軌</strong>
                <span className="track-option-sub">
                  允許已領取過者為第二帳號啟用；若無人排隊自動讓給新手
                </span>
              </button>
            </div>
          </div>

          <div className="form-group">
            <span className="form-label">剩餘可用次數（預設 {DEFAULT_SLOT_COUNT} 次）</span>
            <div className="slot-selector-group" role="radiogroup" aria-label="剩餘可用次數">
              {SLOT_COUNT_OPTIONS.map((count) => {
                const isSelected = slotCountInput === count;
                return (
                  <button
                    key={count}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    className={`slot-option-btn ${isSelected ? 'slot-option-active' : ''}`}
                    onClick={() => onSlotCountChange(count)}
                  >
                    <strong>{count} 次</strong>
                    <span className="slot-option-sub">
                      {count === DEFAULT_SLOT_COUNT ? `完整 ${DEFAULT_SLOT_COUNT} 個名額` : `剩餘 ${count} 個名額`}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="form-push-row">
            <PushToggleButton
              me={me}
              isSubmitting={isSubmitting}
              push={push}
              onTestPush={onTestPush}
            />
          </div>

          {user ? (
            submitButton
          ) : (
            <GoogleSignInButton
              size="large"
              text="signin_with"
              hint="登入後再按「送出分享邀請連結」即可，你填寫的內容會保留。"
              fallback={submitButton}
            />
          )}
        </form>
      )}

      <div className="shared-history-block">
        <h3 className="subsection-title">我的分享紀錄</h3>
        {mySharedLinks.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state-text">
              尚未分享過邀請連結。當你分享連結後，可在這裡查看每個名額的領取進度與收到的感謝小卡！
            </p>
          </div>
        ) : (
          <div className="shared-links-list">
            {mySharedLinks.map((link) => (
              <div key={link.id} className="shared-link-card">
                <div className="shared-link-header">
                  <div>
                    <code className="shared-link-url">{link.normalizedUrl}</code>
                    <span className="shared-link-meta">
                      共 {link.totalSlots} 個名額
                    </span>
                  </div>
                </div>

                <ul className="slot-status-list">
                  {link.slots.map((slot, index) => (
                    <li key={slot.id} className="slot-status-item">
                      <div className="slot-status-row">
                        <span className="slot-index-label">名額 #{index + 1}</span>
                        <span className="slot-track-tag">{TRACK_LABELS[slot.track]}</span>
                        <span className={`slot-pill pill-${slot.status}`}>
                          {SLOT_STATUS_LABELS[slot.status]}
                        </span>
                        {slot.receiverNickname ? (
                          <span>
                            領取版友：<strong>{slot.receiverNickname}</strong>
                          </span>
                        ) : null}
                      </div>
                      {slot.status === 'confirmed' && slot.thankYouMessage ? (
                        <div className="slot-thank-you-bubble">
                          <HugeiconsIcon icon={HeartIcon} size={14} className="bubble-heart-icon" />
                          <span>收到感謝小卡：「{slot.thankYouMessage}」</span>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

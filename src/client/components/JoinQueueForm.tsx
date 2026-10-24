import { type FormEvent } from 'react';
import {
  MAX_NICKNAME_LENGTH,
  MAX_THANK_YOU_MESSAGE_LENGTH,
  MIN_THANK_YOU_MESSAGE_LENGTH,
  type MeDto,
} from '../../shared/types';
import { countThankYouMessageChars } from '../../shared/thankYouMessage';
import { hasVisibleText } from '../../shared/visibleText';
import type { UsePushSubscriptionReturn } from '../hooks/usePushSubscription';
import { GoogleBrandIcon } from './GoogleBrandIcon';
import { GoogleSignInButton } from './GoogleSignInButton';
import { PushToggleButton } from './PushToggleButton';
import { TRACK_LABELS } from '../utils/trackLabels';

export interface JoinQueueFormProps {
  me: MeDto | null;
  isSubmitting: boolean;
  /** 上一筆排隊的名額保留已逾時，表單上方要提示可重新加入。 */
  isReservationExpired: boolean;
  nicknameInput: string;
  thankYouMessageInput: string;
  isEligibleForNewbieTrack: boolean;
  onNicknameChange: (value: string) => void;
  onThankYouMessageChange: (value: string) => void;
  onJoinQueue: () => Promise<boolean>;
  onRequireLogin: () => void;
  push: UsePushSubscriptionReturn;
  onTestPush: () => Promise<boolean>;
}

export function JoinQueueForm({
  me,
  isSubmitting,
  isReservationExpired,
  nicknameInput,
  thankYouMessageInput,
  isEligibleForNewbieTrack,
  onNicknameChange,
  onThankYouMessageChange,
  onJoinQueue,
  onRequireLogin,
  push,
  onTestPush,
}: JoinQueueFormProps) {
  const user = me?.user ?? null;

  const trimmedMessageLength = countThankYouMessageChars(thankYouMessageInput);
  const isMessageTooLong = trimmedMessageLength > MAX_THANK_YOU_MESSAGE_LENGTH;
  // 空字串交給 textarea 的 required 擋，這裡只處理「有輸入但全是空白或不可見字元」。
  const isMessageInvisible =
    thankYouMessageInput.length > 0 && !hasVisibleText(thankYouMessageInput);
  const isMessageBlocked = isMessageTooLong || isMessageInvisible;

  function handleJoinSubmit(e: FormEvent) {
    e.preventDefault();
    if (isMessageBlocked) {
      return;
    }
    if (!user) {
      onRequireLogin();
      return;
    }
    void onJoinQueue();
  }

  const submitButton = (
    <button
      type="submit"
      className={`btn btn-primary btn-lg ${isMessageBlocked ? 'btn-disabled' : ''}`}
      disabled={isSubmitting || isMessageBlocked}
    >
      {isMessageTooLong ? (
        `字數超過 ${MAX_THANK_YOU_MESSAGE_LENGTH} 字上限（無法送出）`
      ) : isMessageInvisible ? (
        '感謝小卡需包含可見文字（無法送出）'
      ) : user ? (
        !isEligibleForNewbieTrack ? `加入「${TRACK_LABELS.community}」排隊` : '加入排隊領取邀請連結'
      ) : (
        <span className="btn-inline-content">
          <GoogleBrandIcon size={18} />
          <span>使用 Google 帳號登入</span>
        </span>
      )}
    </button>
  );

  return (
    <form className="form-stack" onSubmit={handleJoinSubmit}>
      {isReservationExpired ? (
        <div className="alert alert-warning">
          <span>名額保留已逾時，已讓給下一位版友。可重新填寫小卡加入排隊！</span>
        </div>
      ) : null}

      {!isEligibleForNewbieTrack ? (
        <div className="track-auto-badge-banner" role="status">
          <span className="track-auto-badge">{TRACK_LABELS.community}</span>
          <span className="track-auto-text">
            已自動切換為再領取排隊（提醒：Claude 單一帳號無法重複試用，此名額請用於第二個帳號）
          </span>
        </div>
      ) : null}

      <div className="form-group">
        <label htmlFor="receiver-nickname" className="form-label">
          你的顯示暱稱
        </label>
        <input
          id="receiver-nickname"
          type="text"
          className="input-field"
          placeholder="例如：阿明、台北工程師"
          value={nicknameInput}
          onChange={(e) => onNicknameChange(e.target.value)}
          maxLength={MAX_NICKNAME_LENGTH}
        />
      </div>

      <div className="form-group">
        <div className="form-label-row">
          <label htmlFor="thank-you-message" className="form-label">
            給提供者的感謝小卡（必填，{MIN_THANK_YOU_MESSAGE_LENGTH}～{MAX_THANK_YOU_MESSAGE_LENGTH} 字）
          </label>
          <span className={`char-counter ${isMessageTooLong ? 'char-counter-exceeded' : ''}`}>
            {trimmedMessageLength} / {MAX_THANK_YOU_MESSAGE_LENGTH}
            {isMessageTooLong ? `（已超過 ${trimmedMessageLength - MAX_THANK_YOU_MESSAGE_LENGTH} 字）` : ''}
          </span>
        </div>
        <textarea
          id="thank-you-message"
          className={`textarea-field ${isMessageBlocked ? 'input-field-error' : ''}`}
          rows={2}
          placeholder="例如：謝謝好心版友分享！祝你寫 code 都不會遇到 bug！"
          value={thankYouMessageInput}
          onChange={(e) => onThankYouMessageChange(e.target.value)}
          required
        />
        {isMessageTooLong ? (
          <span className="field-error-hint">
            感謝小卡不可超過 {MAX_THANK_YOU_MESSAGE_LENGTH} 字，請稍微精簡內容再送出。
          </span>
        ) : null}
        {isMessageInvisible ? (
          <span className="field-error-hint">
            感謝小卡全是空白或看不見的字元，請輸入至少一個可見字元。
          </span>
        ) : null}
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
          hint="登入後再按「加入排隊」即可，你填寫的暱稱與感謝小卡會保留。"
          fallback={submitButton}
        />
      )}
    </form>
  );
}

import { HugeiconsIcon } from '@hugeicons/react';
import { UserCircleIcon } from '@hugeicons/core-free-icons';
import type { ThankYouWallItemDto } from '../../shared/types';

export const LONG_MESSAGE_THRESHOLD = 60;

export function formatDisplayTime(isoString: string): string {
  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) {
    return isoString;
  }
  return new Date(timestamp).toLocaleString('zh-TW', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ThankYouCardFooter({ item }: { item: ThankYouWallItemDto }) {
  return (
    <div className="thank-you-footer">
      <div className="thank-you-participants">
        <HugeiconsIcon
          icon={UserCircleIcon}
          size={15}
          className="participant-user-icon"
          aria-hidden="true"
        />
        <div className="participants-text">
          <span className="party-receiver">{item.receiverNickname}</span>
          <span className="party-action">感謝</span>
          <span className="party-provider">{item.providerNickname}</span>
        </div>
      </div>

      <time className="thank-you-time" dateTime={item.confirmedAt}>
        {formatDisplayTime(item.confirmedAt)}
      </time>
    </div>
  );
}

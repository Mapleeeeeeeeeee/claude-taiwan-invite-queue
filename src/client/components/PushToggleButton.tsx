import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AlertCircleIcon,
  Notification01Icon,
  SmartPhone01Icon,
  Tick01Icon,
} from '@hugeicons/core-free-icons';
import type { MeDto } from '../../shared/types';
import type { UsePushSubscriptionReturn } from '../hooks/usePushSubscription';
import { usePwaInstall } from '../hooks/usePwaInstall';

const TEST_PUSH_FEEDBACK_MS = 2000;

export interface PushToggleButtonProps {
  me: MeDto | null;
  isSubmitting: boolean;
  push: UsePushSubscriptionReturn;
  onTestPush?: () => Promise<boolean>;
}

export function PushToggleButton({ me, isSubmitting, push, onTestPush }: PushToggleButtonProps) {
  const { permissionState, hasPendingGuestSubscription, enablePush } = push;
  const [isTesting, setIsTesting] = useState(false);
  const testTimerRef = useRef<number | null>(null);

  const user = me?.user ?? null;
  const pwa = usePwaInstall();
  const isIosSafariNeedInstall = pwa.isIos && !pwa.isStandalone;

  useEffect(() => {
    return () => {
      if (testTimerRef.current !== null) {
        window.clearTimeout(testTimerRef.current);
      }
    };
  }, []);

  async function handleTestPushClick() {
    if (!onTestPush || isTesting) return;
    setIsTesting(true);
    try {
      await onTestPush();
    } finally {
      testTimerRef.current = window.setTimeout(() => setIsTesting(false), TEST_PUSH_FEEDBACK_MS);
    }
  }

  if (user?.hasPushSubscription) {
    return (
      <button
        type="button"
        className="btn-push-morph is-active"
        onClick={() => void handleTestPushClick()}
        disabled={isSubmitting || isTesting}
        data-testid="btn-test-push"
        title="推播通知已啟用，點擊可立即發送測試通知"
      >
        <HugeiconsIcon icon={Tick01Icon} size={14} className="push-check-icon" />
        <span>{isTesting ? '已送出測試通知！' : '推播已就緒（點此測試）'}</span>
      </button>
    );
  }

  if (!user && hasPendingGuestSubscription) {
    return (
      <button
        type="button"
        className="btn-push-morph is-active"
        disabled
        title="瀏覽器通知權限已允許，使用 Google 登入後將自動完成推播綁定"
      >
        <HugeiconsIcon icon={Tick01Icon} size={14} className="push-check-icon" />
        <span>通知權限已允許（登入後自動綁定）</span>
      </button>
    );
  }

  if (isIosSafariNeedInstall) {
    return (
      <button
        type="button"
        className="btn-push-morph is-guide"
        onClick={pwa.openIosGuide}
        title="iPhone 請點此查看加入主畫面說明"
      >
        <HugeiconsIcon icon={SmartPhone01Icon} size={14} />
        <span>加到主畫面開啟推播</span>
      </button>
    );
  }

  if (permissionState === 'unsupported') {
    return (
      <button
        type="button"
        className="btn-push-morph is-denied"
        disabled
        title="此瀏覽器不支援網頁推播通知"
      >
        <HugeiconsIcon icon={AlertCircleIcon} size={14} />
        <span>此瀏覽器不支援推播</span>
      </button>
    );
  }

  if (permissionState === 'denied') {
    return (
      <>
        <button type="button" className="btn-push-morph is-denied" disabled>
          <HugeiconsIcon icon={AlertCircleIcon} size={14} />
          <span>通知權限已關閉</span>
        </button>
        <p className="push-denied-hint">
          你已在瀏覽器設定中封鎖通知，請至網站設定開啟權限，或記得定時回來查看進度
        </p>
      </>
    );
  }

  return (
    <button
      type="button"
      className="btn-push-morph"
      onClick={() => void enablePush()}
      disabled={isSubmitting}
      title="開啟推播通知，排到名額或收到感謝時即時提醒"
    >
      <HugeiconsIcon icon={Notification01Icon} size={14} />
      <span>開啟手機推播通知</span>
    </button>
  );
}

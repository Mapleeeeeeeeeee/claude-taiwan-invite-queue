import { useEffect, useRef, useState } from 'react';

const TICK_INTERVAL_MS = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const EMPTY_COUNTDOWN_TEXT = '--:--';
// 本機時鐘比伺服器快時，歸零當下伺服器還沒逾時，所以隔一段時間再同步，次數有上限以免無限重送。
const EXPIRE_SYNC_RETRY_INTERVAL_MS = 3000;
const MAX_EXPIRE_SYNC_ATTEMPTS = 5;

export interface CountdownTimerProps {
  /** 倒數終點（ISO 8601 字串）；為 `null` 或無法解析時顯示 `--:--`。 */
  expiresAt: string | null;
  /**
   * 倒數歸零時呼叫，讓呼叫端向伺服器同步逾時後的狀態。
   * 終點沒變（伺服器尚未判定逾時）時每隔數秒再呼叫，最多共 5 次。
   */
  onExpire: () => void;
}

interface ExpireSyncState {
  expiresAt: string | null;
  attempts: number;
  lastAttemptMs: number;
}

function calculateRemainingSeconds(
  expiresAtIso: string | null,
  nowMs: number,
): number | null {
  if (!expiresAtIso) {
    return null;
  }
  const expiresAtMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiresAtMs)) {
    return null;
  }
  return Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000));
}

function formatRemainingDuration(remainingSeconds: number | null): string {
  if (remainingSeconds === null) {
    return EMPTY_COUNTDOWN_TEXT;
  }
  const hours = Math.floor(remainingSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor(
    (remainingSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE,
  );
  const seconds = remainingSeconds % SECONDS_PER_MINUTE;

  const paddedMinutes = String(minutes).padStart(2, '0');
  const paddedSeconds = String(seconds).padStart(2, '0');

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${paddedMinutes}:${paddedSeconds}`;
  }
  return `${paddedMinutes}:${paddedSeconds}`;
}

// 每秒更新的時鐘放在這個葉節點，避免整棵 App 跟著每秒重新渲染。
export function CountdownTimer({ expiresAt, onExpire }: CountdownTimerProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const expireSyncRef = useRef<ExpireSyncState>({ expiresAt: null, attempts: 0, lastAttemptMs: 0 });

  useEffect(() => {
    const timerId = window.setInterval(
      () => setNowMs(Date.now()),
      TICK_INTERVAL_MS,
    );
    return () => window.clearInterval(timerId);
  }, []);

  const remainingSeconds = calculateRemainingSeconds(expiresAt, nowMs);

  useEffect(() => {
    if (remainingSeconds !== 0 || expiresAt === null) {
      return;
    }
    if (expireSyncRef.current.expiresAt !== expiresAt) {
      expireSyncRef.current = { expiresAt, attempts: 0, lastAttemptMs: 0 };
    }
    const sync = expireSyncRef.current;
    const isRetryDue =
      sync.attempts === 0 || nowMs - sync.lastAttemptMs >= EXPIRE_SYNC_RETRY_INTERVAL_MS;
    if (sync.attempts >= MAX_EXPIRE_SYNC_ATTEMPTS || !isRetryDue) {
      return;
    }
    sync.attempts += 1;
    sync.lastAttemptMs = nowMs;
    onExpire();
  }, [expiresAt, nowMs, onExpire, remainingSeconds]);

  return <>{formatRemainingDuration(remainingSeconds)}</>;
}

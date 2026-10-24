type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

function writeStructuredLog(
  level: LogLevel,
  event: string,
  metadata: Record<string, unknown> = {}
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...metadata,
  };
  const serialized = JSON.stringify(entry);

  if (level === 'error') {
    console.error(serialized);
    return;
  }
  if (level === 'warn') {
    console.warn(serialized);
    return;
  }
  console.info(serialized);
}

export function logInfo(event: string, metadata?: Record<string, unknown>): void {
  writeStructuredLog('info', event, metadata);
}

export function logWarn(event: string, metadata?: Record<string, unknown>): void {
  writeStructuredLog('warn', event, metadata);
}

export function logError(event: string, metadata?: Record<string, unknown>): void {
  writeStructuredLog('error', event, metadata);
}

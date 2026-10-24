export interface BackgroundContext {
  executionCtx: ExecutionContext;
  /** 尚未被 `settle` 等過的 `waitUntil` 工作數量。 */
  pendingTaskCount: () => number;
  /** 只等最早一個還沒被等過的背景工作，不等它之後才交出去的工作。沒有尚未等過的工作時直接回傳。 */
  settleNext: () => Promise<void>;
  /** 等所有收集到的背景工作完成，包含工作執行中又交出去的新工作。任何一個工作失敗就拒絕。 */
  settle: () => Promise<void>;
}

/**
 * 假的 ExecutionContext：把 `waitUntil` 收到的 promise 存起來，讓測試決定何時等它們完成。
 * HTTP 推播與 cron 排程共用，這樣才能分辨「回應回來時推播尚未送出」與「背景工作完成後才送出」。
 */
export function createBackgroundContext(): BackgroundContext {
  const tasks: Promise<unknown>[] = [];
  let settledCount = 0;

  const executionCtx = {
    waitUntil(task: Promise<unknown>) {
      tasks.push(task);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  return {
    executionCtx,
    pendingTaskCount: () => tasks.length - settledCount,
    async settleNext() {
      if (settledCount >= tasks.length) {
        return;
      }
      await tasks[settledCount];
      settledCount += 1;
    },
    async settle() {
      while (settledCount < tasks.length) {
        await tasks[settledCount];
        settledCount += 1;
      }
    },
  };
}

import type { InjectedWrite } from "./testD1";

const WRITE_PREFIX_PATTERNS: Record<
  InjectedWrite["operation"],
  (table: string) => RegExp
> = {
  INSERT: (table) =>
    new RegExp(`^\\s*insert\\s+into\\s+"?${table}"?[\\s(]`, "i"),
  UPDATE: (table) => new RegExp(`^\\s*update\\s+"?${table}"?\\s`, "i"),
  DELETE: (table) => new RegExp(`^\\s*delete\\s+from\\s+"?${table}"?\\s`, "i"),
};

export interface RacingD1 {
  /** 把它當作 Env.DB 交給要被測的 service；其他請求仍用原本的資料庫，所以不會觸發自己的攔截。 */
  db: D1Database;
  /**
   * 登記一次競態：被測 service 下一次送出符合 `write`（操作與資料表）的寫入之前，先執行 `competingRequest`。
   * 因此 service 先前讀到的資料在它寫入的當下已經過期，寫入條件（guard）必須自己擋下。
   * 只攔截一次；攔截時 `competingRequest` 會先解除登記，所以它自己的寫入不會再觸發。
   */
  raceBeforeNextWrite(
    write: InjectedWrite,
    competingRequest: () => Promise<unknown>,
  ): void;
}

/**
 * 在不碰 repository 方法名稱的前提下，把另一個請求精準插進「service 讀完資料」與「service 寫入」之間。
 *
 * better-sqlite3 是同步的，兩個請求不會自己交錯；tests/stress 的 `withInterleavedAccess` 用隨機讓出事件迴圈
 * 製造交錯，適合大量請求的壓力測試，但無法指定「哪一筆寫入之前」，所以單一競態情境用這個。
 */
export function createRacingD1(db: D1Database): RacingD1 {
  let pending: {
    write: InjectedWrite;
    competingRequest: () => Promise<unknown>;
  } | null = null;

  async function runCompetingRequestIfWriteMatches(
    queries: readonly string[],
  ): Promise<void> {
    if (pending === null) {
      return;
    }
    const { write, competingRequest } = pending;
    const matcher = WRITE_PREFIX_PATTERNS[write.operation](write.table);
    if (!queries.some((query) => matcher.test(query))) {
      return;
    }
    pending = null;
    await competingRequest();
  }

  class RacingStatement implements D1PreparedStatement {
    constructor(
      readonly query: string,
      readonly inner: D1PreparedStatement,
    ) {}

    bind(...values: unknown[]): D1PreparedStatement {
      return new RacingStatement(this.query, this.inner.bind(...values));
    }

    first<T = unknown>(colName?: string): Promise<T | null> {
      return colName === undefined
        ? this.inner.first<T>()
        : this.inner.first<T>(colName);
    }

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      await runCompetingRequestIfWriteMatches([this.query]);
      return this.inner.run<T>();
    }

    all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      return this.inner.all<T>();
    }

    raw<T = unknown[]>(options: {
      columnNames: true;
    }): Promise<[string[], ...T[]]>;
    raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
    raw<T = unknown[]>(options?: {
      columnNames?: boolean;
    }): Promise<[string[], ...T[]] | T[]> {
      return options?.columnNames
        ? this.inner.raw<T>({ columnNames: true })
        : this.inner.raw<T>();
    }
  }

  const racingDb: D1Database = {
    prepare: (query) => new RacingStatement(query, db.prepare(query)),
    async batch<T = unknown>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> {
      const racingStatements = statements as RacingStatement[];
      await runCompetingRequestIfWriteMatches(
        racingStatements.map(({ query }) => query),
      );
      // 底層 batch 需要未包裝的 statement 才能在同一個交易裡執行。
      return db.batch<T>(racingStatements.map(({ inner }) => inner));
    },
    exec: (query) => db.exec(query),
    // D1Database 仍要求 dump()，但它在 workers-types 已標為 deprecated，這裡不轉呼叫；測試用的 D1 也只回傳空內容。
    dump: async () => new ArrayBuffer(0),
    withSession: () => db.withSession(),
  };

  return {
    db: racingDb,
    raceBeforeNextWrite(write, competingRequest) {
      pending = { write, competingRequest };
    },
  };
}

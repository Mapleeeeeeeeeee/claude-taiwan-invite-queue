import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

export interface InjectedWrite {
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
}

/**
 * 讓測試指定「下一次對某張表的 INSERT / UPDATE / DELETE 失敗」，用來模擬批次中途失敗。
 * 失敗由 SQLite 的 TEMP trigger 在語句執行到那張表時丟出，所以不依賴 ORM 產生的 SQL 文字。
 * 觸發一次就解除，所以一次登記只會讓一條語句失敗。
 * trigger 是逐列觸發，語句沒有影響任何一列時不會失敗。
 */
export class StatementFailureInjector {
  private pendingWrite: InjectedWrite | null = null;

  constructor(private readonly sqlite: Database.Database) {
    // 解除登記要發生在 JS 端：若寫進資料表，整批回滾時登記也會跟著回滾，下一次重試又會失敗。
    sqlite.function('claim_injected_failure', (operation, table) => {
      const isPendingWrite =
        this.pendingWrite !== null &&
        this.pendingWrite.operation === operation &&
        this.pendingWrite.table === table;
      if (isPendingWrite) {
        this.pendingWrite = null;
      }
      return isPendingWrite ? 1 : 0;
    });
  }

  failNextWrite(write: InjectedWrite): void {
    this.sqlite.exec(`
      CREATE TEMP TRIGGER IF NOT EXISTS inject_${write.operation}_${write.table}
      BEFORE ${write.operation} ON main.${write.table}
      WHEN claim_injected_failure('${write.operation}', '${write.table}')
      BEGIN
        SELECT RAISE(ABORT, 'injected D1 failure on ${write.operation} ${write.table}');
      END`);
    this.pendingWrite = write;
  }
}

export class SqliteD1PreparedStatement implements D1PreparedStatement {
  private readonly boundValues: unknown[];

  constructor(
    private readonly sqlite: Database.Database,
    private readonly query: string,
    boundValues: unknown[] = []
  ) {
    this.boundValues = boundValues;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.sqlite, this.query, values);
  }

  private prepareStatement(): Database.Statement {
    return this.sqlite.prepare(this.query);
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const stmt = this.prepareStatement();
    const row = stmt.get(...this.boundValues) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    if (colName !== undefined) {
      return (row[colName] as T) ?? null;
    }
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.prepareStatement();
    const info = stmt.run(...this.boundValues);
    return {
      results: [],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        changed_db: info.changes > 0,
        changes: info.changes,
      },
    };
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.prepareStatement();
    const rows = stmt.all(...this.boundValues) as T[];
    return {
      results: rows,
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: rows.length,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    };
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<[string[], ...T[]] | T[]> {
    const stmt = this.prepareStatement().raw(true);
    const rows = stmt.all(...this.boundValues) as T[];
    if (options?.columnNames) {
      const columns = this.sqlite
        .prepare(this.query)
        .columns()
        .map((c) => c.name);
      return [columns, ...rows];
    }
    return rows;
  }

  executeSync(): D1Result<Record<string, unknown>> {
    const trimmed = this.query.trim().toUpperCase();
    const stmt = this.prepareStatement();
    if (trimmed.startsWith('SELECT')) {
      const rows = stmt.all(...this.boundValues) as Record<string, unknown>[];
      return {
        results: rows,
        success: true,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: rows.length,
          rows_written: 0,
          last_row_id: 0,
          changed_db: false,
          changes: 0,
        },
      };
    }

    const info = stmt.run(...this.boundValues);
    return {
      results: [],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        changed_db: info.changes > 0,
        changes: info.changes,
      },
    };
  }
}

export function createTestD1Database(migrationPath?: string): {
  db: D1Database;
  sqlite: Database.Database;
  failureInjector: StatementFailureInjector;
} {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const failureInjector = new StatementFailureInjector(sqlite);

  if (migrationPath) {
    const migrationSql = readFileSync(resolve(process.cwd(), migrationPath), 'utf-8');
    sqlite.exec(migrationSql);
  } else {
    const migrationsDir = resolve(process.cwd(), 'migrations');
    const sqlFiles = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const sqlFile of sqlFiles) {
      const sql = readFileSync(resolve(migrationsDir, sqlFile), 'utf-8');
      sqlite.exec(sql);
    }
  }

  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      return new SqliteD1PreparedStatement(sqlite, query, []);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const runTransaction = sqlite.transaction((stmts: SqliteD1PreparedStatement[]) => {
        return stmts.map((stmt) => stmt.executeSync() as D1Result<T>);
      });
      return runTransaction(statements as unknown as SqliteD1PreparedStatement[]);
    },
    async exec(query: string): Promise<D1ExecResult> {
      sqlite.exec(query);
      return { count: 1, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
    withSession(): D1DatabaseSession {
      throw new Error('withSession not used in tests');
    },
  };

  return { db, sqlite, failureInjector };
}

/** 依 rowid 順序讀出整張表，用來比對「失敗前後資料表完全沒變」。 */
export function dumpTables(
  sqlite: Database.Database,
  tableNames: readonly string[]
): Record<string, unknown[]> {
  return Object.fromEntries(
    tableNames.map((tableName) => [
      tableName,
      sqlite.prepare(`SELECT * FROM ${tableName} ORDER BY rowid`).all(),
    ])
  );
}

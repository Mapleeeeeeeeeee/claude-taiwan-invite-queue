import type Database from 'better-sqlite3';
import { is, type SQL } from 'drizzle-orm';
import { getTableConfig, SQLiteAsyncDialect, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/worker/db/schema';
import { createTestD1Database } from '../helpers/testD1';

// 部署用 wrangler 套用 migrations/，drizzle-kit 無法拿它們當基準（inline UNIQUE、未命名 CHECK 會被視為差異），
// 所以這個測試逐項比對 schema.ts 與 migrations 實際建出來的資料庫。

const dialect = new SQLiteAsyncDialect();

interface IndexShape {
  name: string;
  unique: boolean;
  columns: { name: string; isDescending: boolean }[];
  where: string | null;
}

interface TableShape {
  columns: {
    name: string;
    type: string;
    isNotNull: boolean;
    defaultValue: string | null;
    isPrimaryKey: boolean;
  }[];
  foreignKeys: { column: string; referencesTable: string; referencesColumn: string }[];
  uniqueConstraints: string[][];
  checks: string[];
  indexes: IndexShape[];
}

/** 去掉引號、表名前綴與大小寫差異，讓 drizzle 渲染的 SQL 能和資料庫存的 SQL 比對。 */
function normalizeSql(sqlText: string): string {
  return sqlText
    .replace(/["`]/g, '')
    .replace(/\b\w+\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function renderSql(fragment: SQL): string {
  return normalizeSql(dialect.sqlToQuery(fragment).sql);
}

function byName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function sortedForeignKeys(foreignKeys: TableShape['foreignKeys']): TableShape['foreignKeys'] {
  return [...foreignKeys].sort((a, b) => a.column.localeCompare(b.column));
}

function sortedColumnLists(lists: string[][]): string[][] {
  return [...lists].sort((a, b) => a.join(',').localeCompare(b.join(',')));
}

function renderDefault(defaultValue: unknown): string {
  return typeof defaultValue === 'string' ? `'${defaultValue}'` : String(defaultValue);
}

function describeDrizzleTable(table: SQLiteTable): TableShape {
  const config = getTableConfig(table);

  return {
    columns: config.columns.map((column) => ({
      name: column.name,
      type: column.getSQLType().toLowerCase(),
      // INTEGER PRIMARY KEY 在 SQLite 的 table_info 不標 notnull，所以主鍵欄位不比對這項。
      isNotNull: column.notNull && !column.primary,
      defaultValue: column.default === undefined ? null : renderDefault(column.default),
      isPrimaryKey: column.primary,
    })),
    foreignKeys: sortedForeignKeys(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          column: reference.columns[0]!.name,
          referencesTable: getTableConfig(reference.foreignTable).name,
          referencesColumn: reference.foreignColumns[0]!.name,
        };
      })
    ),
    uniqueConstraints: [
      ...config.columns.filter((column) => column.isUnique).map((column) => [column.name]),
      ...config.uniqueConstraints.map((constraint) => constraint.columns.map((column) => column.name)),
    ],
    checks: config.checks.map((check) => renderSql(check.value)),
    indexes: byName(
      config.indexes.map(({ config: index }) => ({
        name: index.name,
        unique: index.unique,
        columns: index.columns.map((column) => {
          if ('name' in column) {
            return { name: column.name, isDescending: false };
          }
          const ordered = /^(\w+) (asc|desc)$/.exec(renderSql(column));
          if (!ordered) {
            throw new Error(`schema.ts 的索引欄位運算式需要是「欄位 ASC|DESC」：${renderSql(column)}`);
          }
          return { name: ordered[1]!, isDescending: ordered[2] === 'desc' };
        }),
        where: index.where ? renderSql(index.where) : null,
      }))
    ),
  };
}

/** 取出 CREATE TABLE 語句中每個 CHECK (...) 括號內的運算式。 */
function extractCheckExpressions(createTableSql: string): string[] {
  const expressions: string[] = [];
  for (const match of createTableSql.matchAll(/CHECK\s*\(/gi)) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    while (depth > 0) {
      const char = createTableSql[cursor];
      if (char === undefined) {
        throw new Error(`CHECK 的括號沒有成對：${createTableSql}`);
      }
      depth += char === '(' ? 1 : char === ')' ? -1 : 0;
      cursor += 1;
    }
    expressions.push(normalizeSql(createTableSql.slice(match.index + match[0].length, cursor - 1)));
  }
  return expressions;
}

function describeDatabaseTable(sqlite: Database.Database, tableName: string): TableShape {
  const tableInfo = sqlite.pragma(`table_info(${tableName})`) as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  const foreignKeyList = sqlite.pragma(`foreign_key_list(${tableName})`) as {
    from: string;
    table: string;
    to: string;
    on_update: string;
    on_delete: string;
  }[];
  const indexList = sqlite.pragma(`index_list(${tableName})`) as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  const tableSql = (
    sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) as {
      sql: string;
    }
  ).sql;

  const createdIndexes = indexList.filter((index) => index.origin === 'c');
  const uniqueConstraintIndexes = indexList.filter((index) => index.origin === 'u');

  return {
    columns: tableInfo.map((column) => ({
      name: column.name,
      type: column.type.toLowerCase(),
      isNotNull: column.notnull === 1,
      defaultValue: column.dflt_value,
      isPrimaryKey: column.pk > 0,
    })),
    foreignKeys: sortedForeignKeys(
      foreignKeyList.map((foreignKey) => {
        // drizzle 的外鍵預設就是 NO ACTION，migrations 也沒有寫其他動作。
        expect([foreignKey.on_update, foreignKey.on_delete]).toEqual(['NO ACTION', 'NO ACTION']);
        return {
          column: foreignKey.from,
          referencesTable: foreignKey.table,
          referencesColumn: foreignKey.to,
        };
      })
    ),
    uniqueConstraints: uniqueConstraintIndexes.map((index) =>
      (sqlite.pragma(`index_info(${index.name})`) as { name: string }[]).map((column) => column.name)
    ),
    checks: extractCheckExpressions(tableSql),
    indexes: byName(
      createdIndexes.map((index) => {
        const keyColumns = (
          sqlite.pragma(`index_xinfo(${index.name})`) as { name: string; desc: number; key: number }[]
        ).filter((column) => column.key === 1);
        const indexSql = (
          sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(index.name) as {
            sql: string;
          }
        ).sql;
        const wherePredicate = /\sWHERE\s+([\s\S]+)$/i.exec(indexSql)?.[1];
        return {
          name: index.name,
          unique: index.unique === 1,
          columns: keyColumns.map((column) => ({ name: column.name, isDescending: column.desc === 1 })),
          where: wherePredicate ? normalizeSql(wherePredicate) : null,
        };
      })
    ),
  };
}

describe('schema.ts 與 migrations 建出來的資料庫沒有漂移', () => {
  const { sqlite } = createTestD1Database();
  const tables = Object.values<unknown>(schema).filter((exported) => is(exported, SQLiteTable)) as SQLiteTable[];

  it('schema.ts 涵蓋 migrations 建出的每一張資料表', () => {
    const databaseTables = (
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as { name: string }[]
    ).map((row) => row.name);

    expect(tables.map((table) => getTableConfig(table).name).sort()).toEqual(databaseTables.sort());
  });

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    '%s 的欄位、外鍵、唯一約束、CHECK 與索引和資料庫一致',
    (tableName, table) => {
      const expected = describeDrizzleTable(table);
      const actual = describeDatabaseTable(sqlite, tableName);

      expect({ ...actual, uniqueConstraints: sortedColumnLists(actual.uniqueConstraints) }).toEqual({
        ...expected,
        uniqueConstraints: sortedColumnLists(expected.uniqueConstraints),
      });
    }
  );
});

import type { NativeTables } from './native.js';

export type TableName =
  | 'turn'
  | 'session'
  | 'extraction'
  | 'observationContext'
  | 'observation';

export class TableMutationLocks {
  private readonly queues = new Map<TableName, Promise<void>>();

  async with<T>(table: TableName, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(table) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    this.queues.set(table, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(table) === tail) {
        this.queues.delete(table);
      }
    }
  }
}

export function lockNativeTables<T extends NativeTables>(tables: T, locks: TableMutationLocks): T {
  return {
    ...tables,
    turnTable: tables.turnTable && {
      ...tables.turnTable,
      insert: (params) => locks.with('turn', () => tables.turnTable.insert(params)),
      deleteTurns: (params) => locks.with('turn', () => tables.turnTable.deleteTurns(params)),
      compact: () => locks.with('turn', () => tables.turnTable.compact()),
      cleanup: (params) => locks.with('turn', () => tables.turnTable.cleanup(params)),
    },
    sessionTable: tables.sessionTable && {
      ...tables.sessionTable,
      insert: (params) => locks.with('session', () => tables.sessionTable.insert(params)),
      compact: () => locks.with('session', () => tables.sessionTable.compact()),
      cleanup: (params) => locks.with('session', () => tables.sessionTable.cleanup(params)),
    },
    extractionTable: tables.extractionTable && {
      ...tables.extractionTable,
      upsert: (params) => locks.with('extraction', () => tables.extractionTable.upsert(params)),
      delete: (params) => locks.with('extraction', () => tables.extractionTable.delete(params)),
      ensureVectorIndex: (params) => locks.with('extraction', () => tables.extractionTable.ensureVectorIndex(params)),
      compact: () => locks.with('extraction', () => tables.extractionTable.compact()),
      cleanup: (params) => locks.with('extraction', () => tables.extractionTable.cleanup(params)),
      optimize: (params) => locks.with('extraction', () => tables.extractionTable.optimize(params)),
    },
    observationContextTable: tables.observationContextTable && {
      ...tables.observationContextTable,
      upsert: (params) => locks.with('observationContext', () => tables.observationContextTable.upsert(params)),
      delete: (params) => locks.with('observationContext', () => tables.observationContextTable.delete(params)),
      ensureIdIndex: () => locks.with('observationContext', () => tables.observationContextTable.ensureIdIndex()),
      optimize: (params) => locks.with('observationContext', () => tables.observationContextTable.optimize(params)),
    },
    observationTable: tables.observationTable && {
      ...tables.observationTable,
      upsert: (params) => locks.with('observation', () => tables.observationTable.upsert(params)),
      delete: (params) => locks.with('observation', () => tables.observationTable.delete(params)),
      ensureVectorIndex: (params) => locks.with('observation', () => tables.observationTable.ensureVectorIndex(params)),
      compact: () => locks.with('observation', () => tables.observationTable.compact()),
      cleanup: (params) => locks.with('observation', () => tables.observationTable.cleanup(params)),
      optimize: (params) => locks.with('observation', () => tables.observationTable.optimize(params)),
    },
  };
}

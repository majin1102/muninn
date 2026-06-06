import type { NativeTables } from './native.js';

export type TableName =
  | 'turn'
  | 'session'
  | 'extraction'
  | 'globalObservationContext'
  | 'globalObservation';

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
    globalObservationContextTable: tables.globalObservationContextTable && {
      ...tables.globalObservationContextTable,
      upsert: (params) => locks.with('globalObservationContext', () => tables.globalObservationContextTable.upsert(params)),
      delete: (params) => locks.with('globalObservationContext', () => tables.globalObservationContextTable.delete(params)),
      ensureIdIndex: () => locks.with('globalObservationContext', () => tables.globalObservationContextTable.ensureIdIndex()),
      optimize: (params) => locks.with('globalObservationContext', () => tables.globalObservationContextTable.optimize(params)),
    },
    globalObservationTable: tables.globalObservationTable && {
      ...tables.globalObservationTable,
      upsert: (params) => locks.with('globalObservation', () => tables.globalObservationTable.upsert(params)),
      delete: (params) => locks.with('globalObservation', () => tables.globalObservationTable.delete(params)),
      ensureVectorIndex: (params) => locks.with('globalObservation', () => tables.globalObservationTable.ensureVectorIndex(params)),
      compact: () => locks.with('globalObservation', () => tables.globalObservationTable.compact()),
      cleanup: (params) => locks.with('globalObservation', () => tables.globalObservationTable.cleanup(params)),
      optimize: (params) => locks.with('globalObservation', () => tables.globalObservationTable.optimize(params)),
    },
  };
}

import type { NativeTables, Extraction } from '../native.js';

export function parseExtractionMemoryId(memoryId: string): string {
  const [layer, id, extra] = memoryId.split(':');
  if (layer !== 'extraction' || !id || extra !== undefined) {
    throw new Error(`invalid extraction memory id: ${memoryId}`);
  }
  return id;
}

export async function getExtraction(
  client: NativeTables,
  memoryId: string,
): Promise<Extraction | null> {
  const id = parseExtractionMemoryId(memoryId);
  const rows = await client.extractionTable.loadByIds({ ids: [id] });
  return rows[0] ?? null;
}

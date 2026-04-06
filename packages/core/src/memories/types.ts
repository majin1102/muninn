export function assertMemoryIdLayer(memoryId: string, expectedLayer: 'session' | 'observing'): void {
  const [layer, point, extra] = memoryId.split(':');
  if (!layer || !point || extra !== undefined || !/^\d+$/.test(point)) {
    throw new Error(`invalid memory id: ${memoryId}`);
  }
  if (layer !== expectedLayer) {
    throw new Error(`invalid memory id layer: expected ${expectedLayer}, got ${layer}`);
  }
}

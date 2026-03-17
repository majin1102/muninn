export interface MemoryHook {
  onRecall?(query: string): void;
  onMemoryAccessed?(memoryId: string): void;
}

export class HookManager {
  private hooks: MemoryHook[] = [];

  register(hook: MemoryHook) {
    this.hooks.push(hook);
  }

  unregister(hook: MemoryHook) {
    this.hooks = this.hooks.filter(h => h !== hook);
  }

  triggerRecall(query: string) {
    this.hooks.forEach(hook => hook.onRecall?.(query));
  }

  triggerMemoryAccessed(memoryId: string) {
    this.hooks.forEach(hook => hook.onMemoryAccessed?.(memoryId));
  }
}

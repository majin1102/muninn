export class ObserverTask {
  private promise: Promise<void> | null = null;

  get active(): boolean {
    return this.promise !== null;
  }

  run(work: () => Promise<void>): void {
    if (this.promise) {
      return;
    }
    this.promise = Promise.resolve()
      .then(work)
      .finally(() => {
        this.promise = null;
      });
  }

  async wait(): Promise<void> {
    await this.promise;
  }
}

export function createMutex(): { tryAcquire(): boolean; release(): void } {
  let held = false;
  return {
    tryAcquire(): boolean {
      if (held) {
        return false;
      }
      held = true;
      return true;
    },
    release(): void {
      held = false;
    },
  };
}

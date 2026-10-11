/**
 * The question "enter a new code from your authenticator" (CP-S2). The API client asks before a
 * step-up operation; the dialog (`StepUpDialog`) shows it and answers with the code, or with
 * nothing when the person cancels.
 */
export class StepUpPrompt {
  private pending: ((code: string | undefined) => void) | undefined;
  private readonly listeners = new Set<() => void>();
  private open = false;

  /** For `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly isOpen = (): boolean => this.open;

  ask(): Promise<string | undefined> {
    // A second question while one is open cancels the first.
    this.answer(undefined);
    return new Promise((resolve) => {
      this.pending = resolve;
      this.set(true);
    });
  }

  answer(code: string | undefined): void {
    const pending = this.pending;
    this.pending = undefined;
    this.set(false);
    pending?.(code);
  }

  private set(open: boolean): void {
    this.open = open;
    for (const listener of this.listeners) listener();
  }
}

/**
 * A small interval scheduler for the pollers.
 *
 * Deliberately not a cron library. What this needs that `setInterval` does not
 * give you:
 *
 *   - **Overlap protection.** If a status tick takes longer than its interval,
 *     the next one is skipped rather than stacked. Stacked ticks are how a
 *     briefly-slow API turns into a self-inflicted outage.
 *   - **Startup jitter.** Tasks do not all fire on the same tick, so we do not
 *     hammer the gateway in synchronised bursts.
 *   - **Graceful shutdown.** SIGTERM stops scheduling and waits for in-flight
 *     work, so a deploy cannot leave a half-written batch behind.
 */

export interface Task {
  name: string;
  intervalMs: number;
  /** Runs once at startup before the interval begins. Default true. */
  runOnStart?: boolean;
  handler: () => Promise<void>;
}

export interface SchedulerLog {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const consoleLog: SchedulerLog = {
  info: (m) => console.log(`[scheduler] ${m}`),
  warn: (m) => console.warn(`[scheduler] ${m}`),
  error: (m) => console.error(`[scheduler] ${m}`),
};

export class Scheduler {
  #timers: NodeJS.Timeout[] = [];
  #running = new Set<string>();
  #inFlight = new Set<Promise<void>>();
  #stopped = false;
  #skipped = new Map<string, number>();

  /**
   * @param keepAlive Whether pending timers should hold the Node event loop
   *   open. TRUE is required for daemon mode and is the default.
   *
   *   This defaulted to false (every timer `unref()`d) and it silently broke
   *   the daemon: signal listeners do not ref the event loop, so once the
   *   startup burst of work finished Node had nothing ref'd and exited with
   *   "Detected unsettled top-level await". The process looked like it had
   *   started — it logged "started 9 task(s)" — and then died within seconds.
   *
   *   The cost was invisible and large: collection never ran continuously, so
   *   SLA collection coverage sat at ~1%, no device was ever claimable, and the
   *   whole uptime product was starved. Nothing failed loudly; the daemon just
   *   was not there.
   *
   *   Tests pass false so a forgotten scheduler cannot hang the test runner.
   */
  constructor(
    private readonly tasks: Task[],
    private readonly log: SchedulerLog = consoleLog,
    private readonly keepAlive = true,
  ) {}

  /** Fire every task exactly once, sequentially. Used for `--once` and tests. */
  async runOnce(): Promise<void> {
    for (const task of this.tasks) {
      if (this.#stopped) return;
      await this.#invoke(task);
    }
  }

  start(): void {
    if (this.#stopped) throw new Error("Scheduler already stopped.");

    this.tasks.forEach((task, index) => {
      // Stagger startup so tasks do not align on the same tick.
      const jitter = Math.min(index * 1_500, task.intervalMs);

      const schedule = (): void => {
        const timer = setTimeout(async () => {
          if (this.#stopped) return;
          await this.#invoke(task);
          schedule();
        }, task.intervalMs + jitter);
        if (!this.keepAlive) timer.unref?.();
        this.#timers.push(timer);
      };

      if (task.runOnStart !== false) {
        const timer = setTimeout(() => void this.#invoke(task), jitter);
        if (!this.keepAlive) timer.unref?.();
        this.#timers.push(timer);
      }
      schedule();
    });

    this.log.info(
      `started ${this.tasks.length} task(s): ` +
        this.tasks.map((t) => `${t.name} every ${Math.round(t.intervalMs / 1000)}s`).join(", "),
    );
  }

  async #invoke(task: Task): Promise<void> {
    if (this.#stopped) return;

    if (this.#running.has(task.name)) {
      const count = (this.#skipped.get(task.name) ?? 0) + 1;
      this.#skipped.set(task.name, count);
      this.log.warn(
        `${task.name} is still running — skipping this tick (${count} skipped so far). ` +
          `Consistent skipping means the interval is shorter than the work takes.`,
      );
      return;
    }

    this.#running.add(task.name);
    const promise = (async () => {
      const started = Date.now();
      try {
        await task.handler();
        this.log.info(`${task.name} finished in ${Date.now() - started}ms`);
      } catch (error) {
        // A task must never take the process down — the next tick retries.
        this.log.error(`${task.name} threw: ${(error as Error).message}`);
      } finally {
        this.#running.delete(task.name);
      }
    })();

    this.#inFlight.add(promise);
    promise.finally(() => this.#inFlight.delete(promise));
    await promise;
  }

  /** Stop scheduling and wait for in-flight work to finish. */
  /** Pending timers. Exposed so a test can assert the daemon is actually armed. */
  pendingTimerCount(): number {
    return this.#timers.length;
  }

  /**
   * Whether pending timers hold the Node event loop open — i.e. whether this
   * scheduler will keep the process running. False here means the daemon exits
   * as soon as its startup work drains.
   */
  keepsProcessAlive(): boolean {
    return this.keepAlive && this.#timers.some((t) => t.hasRef?.() !== false);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];

    if (this.#inFlight.size > 0) {
      this.log.info(`waiting for ${this.#inFlight.size} in-flight task(s)…`);
      await Promise.allSettled([...this.#inFlight]);
    }

    const skipped = [...this.#skipped.entries()];
    if (skipped.length > 0) {
      this.log.warn(`skipped ticks: ${skipped.map(([n, c]) => `${n}=${c}`).join(", ")}`);
    }
    this.log.info("stopped");
  }

  /** Wire SIGINT/SIGTERM to a clean shutdown. Returns a promise that resolves on exit. */
  handleSignals(): Promise<void> {
    return new Promise<void>((resolve) => {
      const shutdown = (signal: string) => async () => {
        this.log.info(`received ${signal}, shutting down`);
        await this.stop();
        resolve();
      };
      process.once("SIGINT", shutdown("SIGINT"));
      process.once("SIGTERM", shutdown("SIGTERM"));
    });
  }
}

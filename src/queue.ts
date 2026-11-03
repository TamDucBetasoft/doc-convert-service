import { EventEmitter, once } from 'node:events';
import { Errors } from './errors.js';

/**
 * Bounded in-process worker pool. Refusing work when full (backpressure) keeps latency predictable instead of
 * letting every request slow down until all of them time out.
 *
 * Jobs live only on the instance that accepted them; state is in Redis so any instance can answer polls.
 */
export class JobQueue {
  private readonly pending: string[] = [];
  private readonly events = new EventEmitter();
  private running = 0;
  private accepting = true;

  constructor(
    private readonly concurrency: number,
    private readonly maxPending: number,
    private readonly retryAfterSeconds: number,
    private readonly handler: (jobId: string) => Promise<void>,
  ) {
    this.events.setMaxListeners(0);
  }

  get depth(): number {
    return this.pending.length;
  }

  get active(): number {
    return this.running;
  }

  /** Throws `queue_full` instead of queueing when the backlog is already at `maxPending`. */
  enqueue(jobId: string): void {
    if (!this.accepting || this.pending.length >= this.maxPending) {
      throw Errors.queueFull(this.retryAfterSeconds);
    }
    this.pending.push(jobId);
    this.pump();
  }

  /** Resolves true when the job settles (done or failed), false on timeout. */
  async waitFor(jobId: string, timeoutMs: number): Promise<boolean> {
    try {
      await once(this.events, `settled:${jobId}`, { signal: AbortSignal.timeout(timeoutMs) });
      return true;
    } catch {
      return false;
    }
  }

  /** Stops accepting work and waits for running and queued jobs, up to `timeoutMs`. */
  async drain(timeoutMs: number): Promise<boolean> {
    this.accepting = false;
    if (this.running === 0 && this.pending.length === 0) return true;
    try {
      await once(this.events, 'idle', { signal: AbortSignal.timeout(timeoutMs) });
      return true;
    } catch {
      return false;
    }
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const jobId = this.pending.shift()!;
      this.running++;
      this.handler(jobId)
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          this.events.emit(`settled:${jobId}`);
          if (this.running === 0 && this.pending.length === 0) this.events.emit('idle');
          this.pump();
        });
    }
  }
}

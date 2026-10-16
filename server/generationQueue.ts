import { randomUUID } from 'node:crypto';
import { AiFailure } from './aiSupport.ts';

type Waiter = { signal: AbortSignal; start: () => void; cancel: () => void; position?: (position: number) => void };
type Transaction = { owner: string; release: () => void; touched: number; running: boolean; closing: boolean; controller?: AbortController };

/** FIFO slots belong to a whole generation, including gaps between its HTTP steps. */
export class GenerationQueue {
  readonly limit: number;

  constructor(limit = 50) {
    this.limit = limit;
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Generation queue limit must be a positive integer');
  }

  private active = 0;
  private waiting: Waiter[] = [];
  private transactions = new Map<string, Transaction>();

  acquire(signal: AbortSignal, position?: (position: number) => void): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal, position,
        start: () => {
          signal.removeEventListener('abort', waiter.cancel);
          this.active++;
          let released = false;
          resolve(() => { if (released) return; released = true; this.active--; this.drain(); });
        },
        cancel: () => {
          this.waiting = this.waiting.filter(item => item !== waiter);
          reject(signal.reason ?? new DOMException('已取消排队', 'AbortError'));
          this.drain();
        },
      };
      signal.addEventListener('abort', waiter.cancel, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.limit && this.waiting.length) {
      const waiter = this.waiting.shift()!;
      if (waiter.signal.aborted) waiter.cancel(); else waiter.start();
    }
    this.waiting.forEach((waiter, index) => waiter.position?.(index + 1));
  }

  async begin(owner: string, signal: AbortSignal, position?: (position: number) => void) {
    this.expire();
    const release = await this.acquire(signal, position);
    if (signal.aborted) { release(); signal.throwIfAborted(); }
    const token = randomUUID();
    this.transactions.set(token, { owner, release, touched: Date.now(), running: false, closing: false });
    return token;
  }

  private get(token: string, owner: string) {
    this.expire();
    const transaction = this.transactions.get(token);
    if (!transaction || transaction.owner !== owner || transaction.closing) {
      throw new AiFailure(409, 'GENERATION_EXPIRED', '本次生成名额已释放，请重新开始生成并排队。');
    }
    transaction.touched = Date.now();
    return transaction;
  }

  heartbeat(token: string, owner: string) { this.get(token, owner); }

  enter(token: string, owner: string, controller: AbortController) {
    const transaction = this.get(token, owner);
    if (transaction.running) throw new AiFailure(409, 'GENERATION_STEP_RUNNING', '同一次专利生成的前一步尚未结束，请等待完成。');
    transaction.running = true;
    transaction.controller = controller;
    return () => {
      transaction.running = false;
      transaction.controller = undefined;
      transaction.touched = Date.now();
      if (transaction.closing) { this.transactions.delete(token); transaction.release(); }
    };
  }

  end(token: string, owner: string) {
    const transaction = this.transactions.get(token);
    if (!transaction || transaction.owner !== owner) return;
    transaction.closing = true;
    transaction.controller?.abort();
    if (!transaction.running) { this.transactions.delete(token); transaction.release(); }
  }

  expire(now = Date.now()) {
    // Browsers renew every 30 seconds. A closed/crashed page cannot keep a slot forever.
    for (const [token, transaction] of this.transactions) {
      if (!transaction.running && now - transaction.touched > 90000) this.end(token, transaction.owner);
    }
  }
}

export const defaultGenerationQueue = new GenerationQueue();

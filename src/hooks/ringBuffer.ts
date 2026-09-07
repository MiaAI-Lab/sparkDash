export interface TimedSample {
  at: number;
  value: number;
}

export class TimedRingBuffer {
  private readonly items: Array<TimedSample | undefined>;
  private start = 0;
  private length = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("capacity must be positive");
    this.items = new Array(capacity);
  }

  push(sample: TimedSample): void {
    const index = (this.start + this.length) % this.capacity;
    this.items[index] = sample;
    if (this.length < this.capacity) this.length += 1;
    else this.start = (this.start + 1) % this.capacity;
  }

  pruneBefore(cutoff: number): void {
    while (this.length > 0 && (this.items[this.start]?.at ?? Infinity) < cutoff) {
      this.items[this.start] = undefined;
      this.start = (this.start + 1) % this.capacity;
      this.length -= 1;
    }
  }

  toArray(): TimedSample[] {
    return Array.from({ length: this.length }, (_, i) => this.items[(this.start + i) % this.capacity]!);
  }

  tail(count: number): TimedSample[] {
    const take = Math.min(this.length, Math.max(0, count));
    return Array.from({ length: take }, (_, i) => this.items[(this.start + this.length - take + i) % this.capacity]!);
  }
}

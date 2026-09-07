export interface TimedSample {
  at: number;
  value: number;
}

export class RingBuffer<T> {
  private readonly items: Array<T | undefined>;
  private start = 0;
  length = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("capacity must be positive");
    this.items = new Array(capacity);
  }

  push(value: T): void {
    const index = (this.start + this.length) % this.capacity;
    this.items[index] = value;
    if (this.length < this.capacity) this.length += 1;
    else this.start = (this.start + 1) % this.capacity;
  }

  replaceLast(value: T): void {
    if (this.length === 0) {
      this.push(value);
      return;
    }
    this.items[(this.start + this.length - 1) % this.capacity] = value;
  }

  shift(): T | undefined {
    if (this.length === 0) return undefined;
    const value = this.items[this.start];
    this.items[this.start] = undefined;
    this.start = (this.start + 1) % this.capacity;
    this.length -= 1;
    return value;
  }

  get first(): T | undefined {
    return this.length === 0 ? undefined : this.items[this.start];
  }

  get last(): T | undefined {
    return this.length === 0 ? undefined : this.items[(this.start + this.length - 1) % this.capacity];
  }

  toArray(): T[] {
    return Array.from({ length: this.length }, (_, i) => this.items[(this.start + i) % this.capacity]!);
  }
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

  last(): TimedSample | undefined {
    if (this.length === 0) return undefined;
    return this.items[(this.start + this.length - 1) % this.capacity];
  }

  replaceLast(sample: TimedSample): void {
    if (this.length === 0) {
      this.push(sample);
      return;
    }
    this.items[(this.start + this.length - 1) % this.capacity] = sample;
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

// FILE: src/observability/bounded-queue.ts
//
// A plain FIFO with a hard capacity: enqueue() past `maxSize` is refused
// (never blocks, never grows unbounded) rather than dropped silently — the
// caller decides what "refused" means (kafka-producer.ts counts + logs it).
// Single responsibility, no Kafka/observability knowledge — independently
// testable.

export class BoundedQueue<T> {
  private readonly items: T[] = [];

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.items.length;
  }

  /** Returns false (refused) if the queue is already at capacity. */
  enqueue(item: T): boolean {
    if (this.items.length >= this.maxSize) return false;
    this.items.push(item);
    return true;
  }

  dequeue(): T | undefined {
    return this.items.shift();
  }

  drain(): T[] {
    return this.items.splice(0, this.items.length);
  }
}

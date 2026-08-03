// Unit tests for BoundedQueue (src/observability/bounded-queue.ts). Pure — no I/O.
// Run after build: node --test dist/observability/bounded-queue.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BoundedQueue } from "./bounded-queue.js";

describe("BoundedQueue", () => {
  test("enqueue succeeds up to maxSize", () => {
    const q = new BoundedQueue<number>(2);
    assert.equal(q.enqueue(1), true);
    assert.equal(q.enqueue(2), true);
    assert.equal(q.size, 2);
  });

  test("enqueue past maxSize is refused (edge case)", () => {
    const q = new BoundedQueue<number>(2);
    q.enqueue(1);
    q.enqueue(2);
    assert.equal(q.enqueue(3), false);
    assert.equal(q.size, 2, "refused item must not be added");
  });

  test("dequeue frees capacity for a subsequent enqueue", () => {
    const q = new BoundedQueue<number>(1);
    q.enqueue(1);
    assert.equal(q.enqueue(2), false);
    assert.equal(q.dequeue(), 1);
    assert.equal(q.enqueue(2), true);
    assert.equal(q.size, 1);
  });

  test("dequeue is FIFO order", () => {
    const q = new BoundedQueue<string>(3);
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");
    assert.equal(q.dequeue(), "a");
    assert.equal(q.dequeue(), "b");
    assert.equal(q.dequeue(), "c");
  });

  test("dequeue on an empty queue returns undefined (edge case)", () => {
    const q = new BoundedQueue<number>(1);
    assert.equal(q.dequeue(), undefined);
  });

  test("drain empties the queue and returns every pending item in order", () => {
    const q = new BoundedQueue<number>(3);
    q.enqueue(1);
    q.enqueue(2);
    assert.deepEqual(q.drain(), [1, 2]);
    assert.equal(q.size, 0);
  });

  test("drain on an empty queue returns an empty array (edge case)", () => {
    const q = new BoundedQueue<number>(3);
    assert.deepEqual(q.drain(), []);
  });

  test("a maxSize of 0 refuses every enqueue (edge case)", () => {
    const q = new BoundedQueue<number>(0);
    assert.equal(q.enqueue(1), false);
    assert.equal(q.size, 0);
  });
});

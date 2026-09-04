import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves result order regardless of completion order', async () => {
    const items = [30, 10, 20];
    const results = await mapWithConcurrency(items, 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let current = 0;
    let max = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (i) => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 5));
      current -= 1;
      return i;
    });
    expect(max).toBeLessThanOrEqual(3);
    expect(max).toBeGreaterThan(0);
  });

  it('runs everything when the limit exceeds the item count', async () => {
    const items = [1, 2, 3];
    const results = await mapWithConcurrency(items, 100, (i) => Promise.resolve(i * 2));
    expect(results).toEqual([2, 4, 6]);
  });

  it('handles an empty item list', async () => {
    const results = await mapWithConcurrency<number, number>([], 3, (i) => Promise.resolve(i));
    expect(results).toEqual([]);
  });
});

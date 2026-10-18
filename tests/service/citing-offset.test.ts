/**
 * @fileoverview Decimal citation cursor boundaries and scanner CPU growth.
 * @module tests/service/citing-offset.test
 */

import { describe, expect, it } from 'vitest';
import { citingOffset } from '@/services/courtlistener/citing-offset.js';

describe('citingOffset', () => {
  it.each(['9007199254740991', '00001.000', '.0', '+.0'])(
    'accepts exact nonnegative decimal integer %j',
    (cursor) => {
      expect(citingOffset(cursor)).toBe(Number(cursor));
    },
  );
  it.each(['1.0000000000000001', '1..0', '.', '+', 'Infinity', 'NaN', '1\n0'])(
    'rejects invalid decimal %j',
    (cursor) => {
      expect(() => citingOffset(cursor)).toThrow();
    },
  );

  it('keeps citing scanner timing bounded across a 64-fold span', () => {
    const shapes = [
      (size: number) => '0'.repeat(size),
      (size: number) => `${'0'.repeat(size)}x`,
      (size: number) => `${'0'.repeat(size)}\ny`,
      (size: number) => `${'§1 x'.repeat(size)}\ny`,
      (size: number) => `${'<a'.repeat(size)}${'>'.repeat(size)}`,
    ];
    for (const shape of shapes) {
      let first = 0;
      let last = 0;
      for (let size = 5_000; size <= 320_000; size *= 2) {
        const input = shape(size);
        let attempts = 20;
        let sample = 0;
        for (;;) {
          const start = process.threadCpuUsage();
          for (let attempt = 0; attempt < attempts; attempt++) {
            try {
              citingOffset(input);
            } catch {
              /* Invalid inputs exercise the same bounded scan. */
            }
          }
          const elapsed = process.threadCpuUsage(start);
          const cpu = elapsed.user + elapsed.system;
          expect(cpu).toBeLessThan(500_000);
          if (cpu >= 20_000) {
            sample = cpu / attempts;
            break;
          }
          attempts *= 2;
        }
        if (size === 5_000) first = sample;
        last = sample;
      }
      expect(last / first).toBeLessThan(256);
    }
  }, 60_000);
});

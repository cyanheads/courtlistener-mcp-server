/**
 * @fileoverview Normalization and presentation scanner CPU growth.
 * @module tests/service/readable-text.test
 */
import { expect, it } from 'vitest';
import { escapeText, fenceSource, readableText } from '@/services/courtlistener/readable-text.js';

it('keeps readable text scanner timing bounded across a 64-fold span', () => {
  const shapes = [
    (size: number) => '1'.repeat(size),
    (size: number) => '<'.repeat(size),
    (size: number) => `${'<a'.repeat(size)}${'>'.repeat(size)}`,
    (size: number) => `${'§1 x'.repeat(size)}\ny`,
    (size: number) => `${' '.repeat(size)}\ny`,
    (size: number) => '`'.repeat(size),
  ];
  for (const shape of shapes) {
    let first = 0;
    let last = 0;
    for (let size = 5000; size <= 320_000; size *= 2) {
      const input = shape(size);
      let attempts = 1;
      for (;;) {
        const start = process.threadCpuUsage();
        for (let attempt = 0; attempt < attempts; attempt++) {
          readableText(input);
          escapeText(input);
          fenceSource(input);
        }
        const elapsed = process.threadCpuUsage(start);
        const cpu = elapsed.user + elapsed.system;
        expect(cpu).toBeLessThan(1_000_000);
        if (cpu >= 20_000) {
          last = cpu / attempts;
          break;
        }
        attempts *= 2;
      }
      if (size === 5000) first = last;
    }
    expect(last / first).toBeLessThan(256);
  }
}, 60_000);

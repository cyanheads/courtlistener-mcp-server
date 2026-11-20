/**
 * @fileoverview Normalization and presentation scanner CPU growth.
 * @module tests/service/readable-text.test
 */
import { expect, it } from 'vitest';
import { escapeText, fenceSource, readableText } from '@/services/courtlistener/readable-text.js';

it('retains document boundaries, cells, and decoded entities', () => {
  expect(readableText('<p>A &amp;amp; B</p><table><tr><td>C</td><td>D</td></tr></table>')).toBe(
    'A &amp; B\n\nC\tD',
  );
});

it('collapses source wrapping across inline tags but keeps explicit breaks and preformatted text', () => {
  expect(
    readableText(
      '<p>Court in\n <em>\n Plessy\n </em>\n v.\t<em>Ferguson,</em>&nbsp;163 U.S.<br>Next</p><pre>  A  B\n C  </pre>',
    ),
  ).toBe('Court in Plessy v. Ferguson,\u00a0163 U.S.\n\nNext\n\n  A  B\n C  ');
  expect(readableText('<p>un<em>broken</em></p>')).toBe('unbroken');
  expect(readableText(' \t\n ')).toBe('');
});

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

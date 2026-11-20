/**
 * @fileoverview Readable legal text from markup and presentation-only escaping.
 * @module services/courtlistener/readable-text
 */
import { SAXParser } from 'parse5-sax-parser';

const BLOCKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'opinion',
  'head-matter',
  'footnote',
  'blockquote',
  'ul',
  'ol',
  'li',
  'table',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
]);
const HIDDEN = new Set(['script', 'style', 'title', 'template']);

/** Decode markup once, retaining block, cell, list and footnote boundaries. */
export function readableText(markup: string): string {
  const parser = new SAXParser();
  const pieces: string[] = [];
  const hidden: string[] = [];
  let separator = '';
  let preformatted = 0;

  const append = (value: string) => {
    if (pieces.length && separator) pieces.push(separator.replace(/^\n\n\t/, '\n\n'));
    pieces.push(value);
    separator = '';
  };

  parser.on('startTag', ({ tagName, attrs, selfClosing }) => {
    if (HIDDEN.has(tagName)) {
      if (!selfClosing) hidden.push(tagName);
      return;
    }
    if (hidden.length) return;
    if (BLOCKS.has(tagName) || tagName === 'br') separator = '\n\n';
    if (tagName === 'pre') preformatted++;
    if (tagName === 'td' || tagName === 'th')
      separator = separator === ' ' ? '\t' : `${separator}\t`;
    if (tagName === 'li') {
      append('•');
      separator = ' ';
    }
    if (tagName === 'footnote') {
      const label = attrs.find((attr) => attr.name === 'label' || attr.name === 'id')?.value;
      if (label) {
        append(`[${label}]`);
        separator = ' ';
      }
    }
  });
  parser.on('endTag', ({ tagName }) => {
    if (hidden.length) {
      if (tagName === hidden[hidden.length - 1]) hidden.pop();
      return;
    }
    if (tagName === 'pre' && preformatted) preformatted--;
    if (BLOCKS.has(tagName)) separator = '\n\n';
  });
  parser.on('text', ({ text }) => {
    if (hidden.length) return;
    if (preformatted) {
      append(text);
      return;
    }
    // Normalize only HTML whitespace. Structural separators and nonbreaking spaces stay distinct.
    const normalized = text.replace(/[ \t\n\f\r]+/g, ' ');
    if (normalized.startsWith(' ') && !separator) separator = ' ';
    const value = normalized.replace(/^ | $/g, '');
    if (value) append(value);
    if (normalized.endsWith(' ') && !separator) separator = ' ';
  });
  parser.end(markup);
  return pieces.join('');
}

/** Remove upstream search highlighting from labels without changing unmarked values. */
export function unhighlight(value: string): string {
  return value.includes('<mark>') ? readableText(value) : value;
}

/** Preserve source line endings while escaping sliced text; framework inline escaping normalizes CRLF. */
export function escapeText(value: string): string {
  return value.replace(/[&<>\\`*_{}[\]()#+.!|~-]/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    return `\\${char}`;
  });
}

/** Fence source markup with a delimiter that cannot be closed by its contents. */
export function fenceSource(value: string): string {
  let longest = 0;
  let run = 0;
  for (const char of value) {
    run = char === '`' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `\n${fence}text\n${value}\n${fence}\n`;
}

/** Copy domain values into safe presentation values, leaving the structured data intact. */
export function presentation<T>(value: T, key = ''): T {
  if (typeof value === 'string')
    return (key === 'html_text' && value ? fenceSource(value) : escapeText(value)) as T;
  if (Array.isArray(value)) return value.map((item) => presentation(item, key)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, presentation(item, name)]),
    ) as T;
  return value;
}

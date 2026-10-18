/**
 * @fileoverview Decimal offset validation for outbound citation pagination.
 * @module services/courtlistener/citing-offset
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

/** Normalize a nonnegative safe decimal integer without accepting exponent or radix notation. */
export function citingOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = cursor.trim();
  let index = value[0] === '+' || value[0] === '-' ? 1 : 0;
  let digits = 0;
  let decimal = false;
  let valid = true;
  for (; index < value.length; index++) {
    const char = value.charAt(index);
    if (char === '.' && !decimal) {
      decimal = true;
    } else if (char >= '0' && char <= '9' && (!decimal || char === '0')) {
      digits++;
    } else {
      valid = false;
      break;
    }
  }
  const offset = Number(value);
  if (!valid || digits === 0 || !Number.isSafeInteger(offset) || offset < 0) {
    throw validationError('Invalid citing cursor: use a nonnegative safe decimal integer offset.', {
      reason: 'invalid_cursor',
      recovery: {
        hint: 'Pass the next_cursor from a citing response, or omit cursor to start over.',
      },
    });
  }
  return offset === 0 ? 0 : offset;
}

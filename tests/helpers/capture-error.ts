/**
 * @fileoverview Shared helper for capturing the error a definition handler rejects with.
 * @module tests/helpers/capture-error
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Runs `run()` and returns the error it rejects with.
 *
 * A definition's `handler` is typed `TOutput | Promise<TOutput>`, so `.catch()`
 * is not a member of the returned union and a bare `await` inside `try` needs
 * the same cast at every call site. Throws when the call resolves instead, so a
 * handler that stops failing surfaces as a test failure rather than a silent
 * pass through a `toMatchObject` on a success payload.
 */
export async function captureError(run: () => unknown): Promise<McpError> {
  try {
    await run();
  } catch (error) {
    return error as McpError;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

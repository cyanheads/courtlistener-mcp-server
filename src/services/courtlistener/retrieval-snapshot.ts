/**
 * @fileoverview Short-lived raw source snapshots for retrieval continuations.
 * @module services/courtlistener/retrieval-snapshot
 */

import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { requestCancelled } from '@cyanheads/mcp-ts-core/errors';

const ttlMs = 5 * 60_000;
const maxRetainedBytes = 16 * 1024 * 1024;
const maxEntries = 256;

interface Snapshot {
  fetchedAt: number;
  payload: Uint8Array;
}

const serviceIds = new WeakMap<object, number>();
const snapshots = new Map<string, Snapshot>();
let nextServiceId = 0;
let retainedBytes = 0;

function discard(key: string, snapshot: Snapshot) {
  snapshots.delete(key);
  retainedBytes -= snapshot.payload.byteLength;
}

/**
 * Fetch a raw, serializable source or replay one for a continuation. Normalize and
 * verify the existing cursor digest after this call. The fetch callback must reject
 * on failed requests or ownership checks and pass its caller's signal upstream.
 */
export async function readRetrievalSnapshot<T>(options: {
  service: object;
  tenantId: string | undefined;
  source: readonly (string | number | null | readonly (string | number)[])[];
  continuing: boolean;
  signal?: AbortSignal | undefined;
  fetch: () => Promise<T>;
}): Promise<{ value: T; fetchedAt: string }> {
  const { service, tenantId, source, continuing, signal, fetch } = options;
  const checkCancellation = () => {
    if (signal?.aborted) throw requestCancelled('Retrieval cancelled.');
  };
  checkCancellation();
  const load = async () => {
    const value = await fetch();
    checkCancellation();
    return { value, fetchedAt: Date.now() };
  };
  if (!tenantId) {
    const { value, fetchedAt } = await load();
    return { value, fetchedAt: new Date(fetchedAt).toISOString() };
  }

  let serviceId = serviceIds.get(service);
  if (serviceId === undefined) {
    serviceId = ++nextServiceId;
    serviceIds.set(service, serviceId);
  }
  const key = createHash('sha256')
    .update(JSON.stringify([serviceId, tenantId, source]))
    .digest('hex');
  const cached = snapshots.get(key);
  if (cached && Date.now() >= cached.fetchedAt + ttlMs) discard(key, cached);
  else if (cached && continuing) {
    /** The serialized value came from the same source-specific fetch callback. */
    const value = deserialize(cached.payload) as T;
    checkCancellation();
    return { value, fetchedAt: new Date(cached.fetchedAt).toISOString() };
  }

  const { value, fetchedAt } = await load();
  checkCancellation();
  const payload = serialize(value);
  const previous = snapshots.get(key);
  if (previous) discard(key, previous);
  if (payload.byteLength <= maxRetainedBytes) {
    for (const [olderKey, older] of snapshots) {
      if (retainedBytes + payload.byteLength <= maxRetainedBytes && snapshots.size < maxEntries)
        break;
      discard(olderKey, older);
    }
    /** Retain exactly the serialized length, independent of the serializer's allocation. */
    snapshots.set(key, { payload: Uint8Array.from(payload), fetchedAt });
    retainedBytes += payload.byteLength;
  }
  return { value, fetchedAt: new Date(fetchedAt).toISOString() };
}

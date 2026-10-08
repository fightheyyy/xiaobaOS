/** Shared cooperative cancellation; never treated as a retryable provider failure. */
export function cancellationError(): Error {
  return Object.assign(new Error('Operation cancelled.'), { name: 'AbortError', code: 'CANCELLED', error_code: 'CANCELLED', retryable: false });
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

export function isCancellation(error: any): boolean {
  return error?.name === 'AbortError' || error?.name === 'APIUserAbortError' || error?.constructor?.name === 'APIUserAbortError'
    || ['CANCELLED', 'ERR_CANCELED', 'ABORT_ERR'].includes(error?.code);
}

export function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(cancellationError()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

import 'server-only';

/**
 * Graceful-shutdown flag shared by long-lived responses (SSE). On SIGTERM/SIGINT open streams finish within a tick instead of holding
 * `next start` open for up to 55 s; widgets then reconnect to the next instance. If nothing else handles the signal we exit ourselves.
 */
interface State { down: boolean }
const g = globalThis as { __csaiShutdown?: State };
export const shutdownState: State = (g.__csaiShutdown ??= (() => {
  const s: State = { down: false };
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => {
    s.down = true;
    if (process.listenerCount(sig) === 1) setTimeout(() => process.exit(0), 3000).unref();   // we are the only handler: do not turn the signal into a no-op
  });
  return s;
})());

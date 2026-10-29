// A signal that aborts when the caller aborts or the deadline passes.
// AbortSignal.any/timeout need Safari 17.4, Firefox 124 and Chrome 116; the
// panel's build target (Vite's default) still includes older browsers.

export function deadlineSignal(caller: AbortSignal | undefined, timeoutInMs: number): AbortSignal {
  const native = typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function";
  if (native === false) return manualDeadlineSignal(caller, timeoutInMs);
  const timeout = AbortSignal.timeout(timeoutInMs);
  if (caller === undefined) return timeout;
  return AbortSignal.any([caller, timeout]);
}

/** The same combination with an AbortController, for browsers without the native helpers. */
export function manualDeadlineSignal(
  caller: AbortSignal | undefined,
  timeoutInMs: number,
): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    timeoutInMs,
  );
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  if (caller === undefined) return controller.signal;
  if (caller.aborted) {
    controller.abort(caller.reason);
    return controller.signal;
  }
  caller.addEventListener("abort", () => controller.abort(caller.reason), { once: true });
  return controller.signal;
}

/** A synchronous resolver for a deliberately held browser-fixture boundary. */
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

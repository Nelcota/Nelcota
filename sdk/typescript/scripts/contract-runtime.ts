import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createServer } from "node:net";
const DEFAULT_WAIT_SECONDS = 60,
  SECOND_IN_MS = 1000;
export function freePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error(`Unexpected probe address: ${String(address)}`));
        return;
      }
      probe.close(() => resolvePort(address.port));
    });
  });
}
export function run(command: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result;
}

export function docker(...args: string[]) {
  return spawnSync("docker", args, { encoding: "utf8" });
}

export function mappedPort(container: string, port: string): number {
  const result = docker("port", container, port);
  const match = result.stdout.trim().match(/:(\d+)$/);
  if (result.status !== 0 || match == null)
    throw new Error(`No mapped port for ${container}:${port}`);
  return Number(match[1]);
}

export async function waitFor(
  what: string,
  check: () => boolean | Promise<boolean>,
  seconds = DEFAULT_WAIT_SECONDS,
): Promise<void> {
  const delayInMs = 300;

  const deadline = Date.now() + seconds * SECOND_IN_MS;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Wait for the current bounded readiness attempt before checking the fixture again.
    if (await check()) return;
    // oxlint-disable-next-line no-await-in-loop -- Wait for the current bounded readiness attempt before checking the fixture again.
    await new Promise((r) => setTimeout(r, delayInMs));
  }
  throw new Error(`${what} did not come up in ${seconds}s`);
}

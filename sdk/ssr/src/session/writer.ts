import { requestClient, dataClient } from "../http/scoped-client.js";
import type { SessionRecords } from "../sealing/records.js";
import type { SessionLease } from "../store.js";
import { AuthQueue } from "./actions.js";
import { authenticationClient } from "./auth-client.js";
import { authOperations } from "./auth-operations.js";
import { accessToken } from "./mutation-options.js";
import { publishAcceptedSession } from "./publication.js";
import type { CookieWriter, WritableContext } from "./types.js";
import { WriteState } from "./write-state.js";

type WriteSetup = Parameters<typeof WriteState.create>[2] & {
  cookies: CookieWriter;
  request: Request;
};

/** Run one lease-owned session context and dispose all request capabilities after publication. */
export async function writeSession<Database, T>(
  records: SessionRecords,
  lease: SessionLease,
  operation: { setup: WriteSetup; work: (context: WritableContext<Database>) => Promise<T> },
): Promise<T> {
  const state = await WriteState.create(records, lease, operation.setup);
  const config = records.config;
  const client = requestClient<Database>(config, {
    token: () => {
      state.ensure();
      return accessToken(state.state);
    },
    alive: () => state.alive && state.accepting && lease.signal.aborted === false,
    readOnly: operation.setup.callbackRequest,
    lifetime: lease.signal,
  });
  const authClient = authenticationClient<Database>(state);
  const queue = new AuthQueue(state);
  const actions = queue.actions(authOperations(state, authClient.auth, operation.setup.request));
  try {
    // Temporary refresh failures must not prevent explicit sign-in or sign-out.
    if (operation.setup.callbackRequest === false) await authClient.auth.getSession();
    return await operation.work({ client: dataClient(client), auth: actions });
  } finally {
    try {
      await publishAcceptedSession(state, queue, operation.setup.cookies);
    } finally {
      state.close();
      client.dispose();
      authClient.dispose();
    }
  }
}

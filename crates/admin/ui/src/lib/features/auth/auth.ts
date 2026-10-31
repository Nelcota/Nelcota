import { profile } from "$lib/features/profile/profile.svelte";
import { sqlStore } from "$lib/features/sql/store/sql-store.svelte";
import { querySession } from "$lib/resources/query-client";
import { endSession, onSessionEnded, session } from "$lib/resources/session.svelte";
// Session actions used in more than one place (sidebar, command palette).
import { api } from "$lib/transport/api";

// Sign-out, expiry or sign-out in another tab: the SQL history and drafts
// can hold passwords or keys on a shared machine. Saved queries stay. The
// signed-in shell loads this module, so the cleanup is in place before any
// session can end.
onSessionEnded(() => sqlStore.forgetSession());

export async function logout() {
  // Even if the request fails, the panel returns to the login screen.
  const pending = api.post("/logout"),
    started = querySession();
  await pending.catch(() => {});
  // A newer sign-in keeps its session. A read that got 401 while logging out
  // also moves the epoch, but must not leave "your session expired" behind.
  if (started !== querySession() && session.email != null && session.email !== "") return;
  endSession(false);
  profile.avatar = null;
  profile.loaded = false;
}

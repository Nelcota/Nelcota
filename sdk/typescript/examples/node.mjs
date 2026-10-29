// NELCOTA_URL, NELCOTA_EMAIL and NELCOTA_PASSWORD; optional NELCOTA_SIGN_UP=1.
import { createClient, unwrap } from "@nelcota/client";
const PAGE_SIZE = 20;

/**
 * @param {string | undefined} value
 * @returns {value is string}
 */
function nonEmptySetting(value) {
  return typeof value === "string" && value !== "";
}

/**
 * @param {{url: string | undefined, email: string | undefined, password: string | undefined, signUp?: boolean}} options
 */
export async function runExample({ url, email, password, signUp = false }) {
  if (
    nonEmptySetting(url) === false ||
    nonEmptySetting(email) === false ||
    nonEmptySetting(password) === false
  )
    throw new Error("Set NELCOTA_URL, NELCOTA_EMAIL and NELCOTA_PASSWORD");
  const client = createClient(url);
  const credentials = { email, password };
  try {
    await authenticate(client, credentials, signUp);
    const session = unwrap(await client.auth.getSession());
    if (session === null) throw new Error("Authentication did not produce a session");
    const note = unwrap(
      await client
        .from("notes")
        .insert({ body: "Hello from Node" })
        .select("id,body")
        .single()
        .execute(),
    );
    const { data: notes } = await client
      .from("notes")
      .select("id,body")
      .order("id", { ascending: false })
      .limit(PAGE_SIZE)
      .throwOnError()
      .execute();
    const files = client.storage.from("files");
    const path = `${session.user.id}/node-example.txt`;
    unwrap(await files.upload(path, "Hello from Node", { upsert: true }));
    const downloaded = unwrap(await files.download(path));
    const text = await downloaded.text();
    unwrap(await files.remove(path));
    if (typeof note.id !== "number" && typeof note.id !== "string")
      throw new Error("The inserted note has no valid identifier");
    unwrap(await client.from("notes").delete().eq("id", note.id).execute());
    unwrap(await client.auth.signOut());
    console.log({ note, notes, downloaded: text });
    return { note, notes, downloaded: text };
  } finally {
    client.dispose();
  }
}

// Importing this function from a test does not start a demo account or request.
if (
  process.argv[1] !== undefined &&
  import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href
) {
  await runExample({
    url: process.env.NELCOTA_URL,
    email: process.env.NELCOTA_EMAIL,
    password: process.env.NELCOTA_PASSWORD,
    signUp: process.env.NELCOTA_SIGN_UP === "1",
  });
}

/** @param {import("@nelcota/client").NelcotaClient} client
 * @param {{email: string, password: string}} credentials
 * @param {boolean} signUp */
async function authenticate(client, credentials, signUp) {
  if (signUp === false) return unwrap(await client.auth.signInWithPassword(credentials));
  const account = unwrap(await client.auth.signUp(credentials));
  if (account.session === null)
    throw new Error("Confirm the signup email, then run again with NELCOTA_SIGN_UP unset");
  return account.session;
}

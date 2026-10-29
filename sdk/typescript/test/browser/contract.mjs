import { createClient, NelcotaUsageError } from "/dist/index.js";

/** Runs the browser-only public SDK contract against the real disposable backend.
 * @param {{api: string, serviceToken: string}} options */
export async function browserContract({ api, serviceToken }) {
  const probe = new BrowserContract(api, serviceToken);
  await probe.signUp();
  await probe.rest();
  await probe.storage();
  await probe.serviceRole();
  await probe.signOut();
  probe.dispose();
  return probe.out;
}
class BrowserContract {
  /** @type {Record<string,unknown>} */ out = {};
  /** @type {string | undefined} */ uid;
  /** @type {ReturnType<typeof createClient> | undefined} */ admin;
  /** @param {string} api @param {string} serviceToken */
  constructor(api, serviceToken) {
    this.api = api;
    this.serviceToken = serviceToken;
    this.nelcota = createClient(api);
    this.out.link = this.nelcota.auth.readEmailLink();
    this.out.cleanedUrl = location.href;
  }
  async signUp() {
    const email = `browser-${crypto.randomUUID()}@example.com`;
    const signup = await this.nelcota.auth.signUp({ email, password: "browser-password-1" });
    this.out.signUpError = signup.error?.code ?? null;
    this.out.stored = Object.keys(localStorage).filter((key) => key.startsWith("nelcota."));
    this.uid = signup.data?.user.id;
  }
  async rest() {
    const inserted = await this.nelcota
      .from("echo")
      .insert({ value: "from the browser" })
      .select("id,value")
      .single()
      .execute();
    this.out.inserted = inserted.data?.value ?? inserted.error?.message;
    const counted = await this.nelcota
      .from("customers")
      .select("id", { count: "exact" })
      .limit(1)
      .execute();
    this.out.count = counted.count;
  }
  async storage() {
    const files = this.nelcota.storage.from("private-files");
    const up = await files.upload(
      `${this.uid}/browser.txt`,
      new Blob(["blob body"], { type: "text/plain" }),
    );
    this.out.upload = up.error?.code ?? up.data?.size;
    const opened = await files.open(`${this.uid}/browser.txt`);
    this.out.etagReadable = Boolean(opened.data?.headers.get("etag"));
    this.out.download = await opened.data?.text();
  }
  async serviceRole() {
    this.admin = createClient(this.api, { accessToken: () => this.serviceToken });
    try {
      await this.admin.from("customers").select().execute();
      this.out.serviceRole = "allowed";
    } catch (error) {
      this.out.serviceRole = error instanceof NelcotaUsageError ? "refused" : String(error);
    }
  }
  async signOut() {
    const signout = await this.nelcota.auth.signOut();
    this.out.signOut = signout.error?.code ?? "ok";
    this.out.storedAfter = Object.keys(localStorage).filter((key) => key.startsWith("nelcota."));
  }
  dispose() {
    // Retire both clients before the two-tab rotation starts.
    this.nelcota.dispose();
    this.admin?.dispose();
  }
}

import { createClient, unwrap } from "@nelcota/client";
const PAGE_SIZE = 20;

/** @type {import("@nelcota/client").NelcotaClient | undefined} */
let client;

/**
 * @template {Element} T
 * @param {string} selector
 * @param {new () => T} expected
 * @returns {T}
 */
function element(selector, expected) {
  const node = document.querySelector(selector);
  if (node instanceof expected) return node;
  throw new Error(`Missing example element: ${selector}`);
}

const output = element("#result", HTMLElement);
/** @param {unknown} value */
const show = (value) => {
  output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
};
/** @param {() => Promise<unknown>} task */
async function action(task) {
  try {
    show(await task());
  } catch (error) {
    show(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}
function signedIn() {
  if (client === undefined) throw new Error("Sign in first.");
  return client;
}

const authForm = element("#auth", HTMLFormElement);
authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(authForm);
  const submitter = event.submitter;
  const signup = submitter instanceof HTMLButtonElement && submitter.value === "signup";
  void action(async () => {
    client?.dispose();
    client = createClient(formText(values, "url"));
    const credentials = {
      email: formText(values, "email"),
      password: formText(values, "password"),
    };
    if (signup) {
      const account = unwrap(await client.auth.signUp(credentials));
      return account.session === null
        ? "Confirm your email, then sign in."
        : "Account created. You are signed in.";
    }
    unwrap(await client.auth.signInWithPassword(credentials));
    return "You are signed in.";
  });
});
const noteForm = element("#note", HTMLFormElement);
noteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(noteForm);
  void action(async () =>
    unwrap(
      await signedIn()
        .from("notes")
        .insert({ body: formText(values, "body") })
        .select("id,body")
        .single()
        .execute(),
    ),
  );
});
const fileForm = element("#file", HTMLFormElement);
fileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const file = new FormData(fileForm).get("file");
  void action(async () => {
    if (file instanceof File === false) throw new Error("Choose a file to upload.");
    const sdk = signedIn();
    const session = unwrap(await sdk.auth.getSession());
    if (session === null) throw new Error("Sign in first.");
    return unwrap(
      await sdk.storage
        .from("files")
        .upload(`${session.user.id}/${file.name}`, file, { upsert: true }),
    );
  });
});
element("#list", HTMLButtonElement).addEventListener("click", () => {
  void action(async () =>
    unwrap(
      await signedIn()
        .from("notes")
        .select("id,body")
        .order("id", { ascending: false })
        .limit(PAGE_SIZE)
        .execute(),
    ),
  );
});
element("#logout", HTMLButtonElement).addEventListener("click", () => {
  void action(async () => {
    unwrap(await signedIn().auth.signOut());
    return "You are signed out.";
  });
});
window.addEventListener("pagehide", () => client?.dispose());

/** @param {FormData} form
 * @param {string} name
 * @returns {string} */
function formText(form, name) {
  const value = form.get(name);
  if (typeof value === "string") return value;
  throw new TypeError(`Expected text for ${name}`);
}

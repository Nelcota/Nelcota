import { expect, it } from "vitest";

import { promiseResult } from "../src/lifecycle/promise-result.js";
import {
  Browser,
  post,
  login,
  memoryFixture,
  postgresFixture,
  credentialRows,
  whoAmI,
  bootstrapped,
} from "./lineage-fixtures.js";
import { requiredValue } from "./required-value.js";

it.each([
  ["memory store", memoryFixture],
  ["PostgreSQL store (mocked pool, two instances)", postgresFixture],
])(
  "concurrent first sign-ins — %s > never lets an older identity win when its response arrives last",
  async (_name, create) => {
    const fixture = await create(),
      [one, two] = fixture.apps;
    const browser = await bootstrapped(one);
    // Two tabs send their sign-in with the same bootstrap cookie, to different instances.
    const tabA = browser.request(),
      tabB = browser.request();
    let entered!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = one.write(tabA, post(), (context) => {
      entered();
      return context.auth.signInWithPassword(login("alice"));
    });
    // Hashing may complete in either order on Web Crypto. Establish who owns
    // the bootstrap lease first before starting the competing request.
    await ownerStarted;
    const [a, b] = await Promise.all([
      first,
      two.write(tabB, post(), (context) => context.auth.signInWithPassword(login("bob"))),
    ]);
    expect(a.data?.id).toBe("user-alice");
    expect(b.data?.id).toBe("user-bob");
    expect(tabA.sets).toHaveLength(1);
    expect(tabB.sets).toHaveLength(1);
    // Responses reordered: the older identity (alice, published first) arrives last.
    browser.receive(tabB);
    browser.receive(tabA);
    expect(await whoAmI(two, browser)).toEqual({ user: null, superseded: true });
    // The other order selects the newest identity.
    const ordered = new Browser();
    ordered.receive(tabA);
    ordered.receive(tabB);
    expect(await whoAmI(one, ordered)).toEqual({ user: "user-bob", superseded: false });
    // Only the newest identity keeps credentials; the superseded row is a tombstone.
    expect(await credentialRows(fixture)).toBe(1);
  },
);

it.each([
  ["memory store", memoryFixture],
  ["PostgreSQL store (mocked pool, two instances)", postgresFixture],
])(
  "concurrent first sign-ins — %s > signs the same user in twice and keeps exactly one live row",
  async (_name, create) => {
    const fixture = await create(),
      [one, two] = fixture.apps;
    const browser = await bootstrapped(one);
    const tabA = browser.request(),
      tabB = browser.request();
    let entered!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = one.write(tabA, post(), (context) => {
      entered();
      return context.auth.signInWithPassword(login("alice"));
    });
    await ownerStarted;
    await Promise.all([
      first,
      two.write(tabB, post(), (context) => context.auth.signInWithPassword(login("alice"))),
    ]);
    browser.receive(tabB);
    browser.receive(tabA);
    expect((await whoAmI(one, browser)).superseded).toBe(true);
    expect(await credentialRows(fixture)).toBe(1);
  },
);

it.each([
  ["memory store", memoryFixture],
  ["PostgreSQL store (mocked pool, two instances)", postgresFixture],
])(
  "concurrent first sign-ins — %s > withholds a stale publication when a later sign-in wins while it is still running",
  async (_name, create) => {
    const fixture = await create(),
      [one, two] = fixture.apps;
    const browser = await bootstrapped(one);
    const stale = browser.request();
    const first = browser.request();
    await one.write(first, post(), (context) => context.auth.signInWithPassword(login("alice")));
    browser.receive(first);
    // Tab A (current cookie) signs in as carol but has not responded yet.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signedIn!: () => void;
    const entered = new Promise<void>((resolve) => {
      signedIn = resolve;
    });
    const tabA = browser.request();
    const pending = one.write(tabA, post(), async (context) => {
      const result = await context.auth.signInWithPassword(login("carol"));
      signedIn();
      await gate;
      return result;
    });
    await entered;
    // A delayed tab still holding the bootstrap ID signs in as bob afterwards.
    const result = await two.write(stale, post(), (context) =>
      context.auth.signInWithPassword(login("bob")),
    );
    expect(result.data?.id).toBe("user-bob");
    release();
    expect((await pending).data?.id).toBe("user-carol");
    // carol's response is rejected at publication: no Set-Cookie can overwrite bob.
    expect(tabA.sets).toHaveLength(0);
    browser.receive(stale);
    browser.receive(tabA);
    expect(await whoAmI(one, browser)).toEqual({ user: "user-bob", superseded: false });
    expect(await credentialRows(fixture)).toBe(1);
  },
);

it.each([
  ["memory store", memoryFixture],
  ["PostgreSQL store (mocked pool, two instances)", postgresFixture],
])(
  "concurrent first sign-ins — %s > lets a delayed sign-out with an older cookie end the newer identity",
  async (_name, create) => {
    const fixture = await create(),
      [one, two] = fixture.apps;
    const browser = await bootstrapped(one);
    const tabA = browser.request(),
      tabB = browser.request();
    await one.write(tabA, post(), (context) => context.auth.signInWithPassword(login("alice")));
    browser.receive(tabA);
    await two.write(tabB, post(), (context) => context.auth.signOut());
    expect(tabB.sets.at(-1)?.options.maxAge).toBe(0);
    // Even if the sign-out response is lost, alice's cookie no longer authenticates.
    expect(await whoAmI(one, browser)).toEqual({ user: null, superseded: true });
    expect(await credentialRows(fixture)).toBe(0);
  },
);

it.each([
  ["memory store", memoryFixture],
  ["PostgreSQL store (mocked pool, two instances)", postgresFixture],
])(
  "concurrent first sign-ins — %s > does not clear the cookie for a stale non-publishing request",
  async (_name, create) => {
    const fixture = await create(),
      [one, two] = fixture.apps;
    const browser = await bootstrapped(one);
    const signIn = browser.request();
    await one.write(signIn, post(), (context) => context.auth.signInWithPassword(login("alice")));
    const older = new Browser();
    older.cookies.set(
      requiredValue(signIn.sets[0], "published cookie").name,
      requiredValue(signIn.sets[0], "published cookie").value,
    );
    browser.receive(signIn);
    const replace = browser.request();
    await one.write(replace, post(), (context) => context.auth.signInWithPassword(login("bob")));
    browser.receive(replace);
    // A request sent before the replacement arrives late and publishes nothing.
    const late = older.request();
    await two.write(late, post(), () => promiseResult(() => undefined));
    expect(late.sets).toHaveLength(0);
    expect(await whoAmI(one, browser)).toEqual({ user: "user-bob", superseded: false });
  },
);

it.each([
  ["memory store", memoryFixture],
  ["PostgreSQL store (mocked pool, two instances)", postgresFixture],
])(
  "concurrent first sign-ins — %s > residual: cookie-less concurrent sign-ins cannot be linked and both stay valid",
  async (_name, create) => {
    const fixture = await create(),
      [one, two] = fixture.apps;
    const browser = new Browser();
    const tabA = browser.request(),
      tabB = browser.request();
    await Promise.all([
      one.write(tabA, post(), (context) => context.auth.signInWithPassword(login("alice"))),
      two.write(tabB, post(), (context) => context.auth.signInWithPassword(login("bob"))),
    ]);
    browser.receive(tabB);
    browser.receive(tabA);
    // Without a shared bootstrap ID the server cannot tell these tabs apart from two browsers.
    expect(await whoAmI(one, browser)).toEqual({ user: "user-alice", superseded: false });
    expect(await credentialRows(fixture)).toBe(2);
  },
);

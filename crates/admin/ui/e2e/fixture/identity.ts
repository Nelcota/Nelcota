import type { FixtureEndpoint } from "./types.js";
export const identityEndpoints: readonly FixtureEndpoint[] = [
  {
    matches: ({ path, method }) => path === "/tokens/deploy" && method === "GET",
    respond: () => {
      return { status: 200, json: { tokens: [] } };
    },
  },
  {
    matches: ({ path }) => path === "/profile",
    respond: () => {
      return { status: 200, json: { avatar: null } };
    },
  },
  {
    matches: ({ path }) => path === "/session" || path === "/login",
    respond: () => {
      return { status: 200, json: { email: "admin@example.test" } };
    },
  },
  {
    matches: ({ path }) => path === "/whoami",
    respond: () => {
      return { status: 200, json: { project: "nelcota-demo" } };
    },
  },
  {
    matches: ({ path }) => path === "/sign-in",
    respond: () => {
      return {
        status: 200,
        json: {
          signup_enabled: true,
          email: false,
          email_confirmation: false,
          password_recovery: false,
          magic_link: false,
          providers: { google: false, github: true },
          redirect_urls: ["https://app.example.test/auth/callback"],
          callback_url: "https://api.example.test/auth/v1/callback",
          access_ttl_secs: 900,
          refresh_ttl_days: 30,
          rate_limit_per_minute: 30,
        },
      };
    },
  },
];

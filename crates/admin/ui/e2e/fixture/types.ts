import type { Route } from "@playwright/test";

import type { FixtureData } from "./data.js";
export interface FixtureRequest {
  readonly path: string;
  readonly method: string;
  readonly url: URL;
  readonly prefix: string;
  readonly search: string;
  readonly data: FixtureData;
}
export interface FixtureEndpoint {
  matches: (request: FixtureRequest) => boolean;
  respond: (request: FixtureRequest) => NonNullable<Parameters<Route["fulfill"]>[0]>;
}

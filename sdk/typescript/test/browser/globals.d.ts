import type { NelcotaClient } from "../../src/index.js";

declare global {
  /** Client intentionally shared by the two browser-test tabs. */
  var sdkClient: NelcotaClient;
}

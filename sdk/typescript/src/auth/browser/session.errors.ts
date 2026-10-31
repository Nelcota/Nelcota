export class BrowserSessionConflictError extends Error {
  constructor() {
    super("Browser session changed during refresh");
    this.name = "BrowserSessionConflictError";
  }
}

/** Another live client reserved the same refresh token within the lease. */
export class BrowserRefreshPendingError extends Error {
  constructor() {
    super("Another tab is refreshing this session");
    this.name = "BrowserRefreshPendingError";
  }
}

export class BrowserSessionConflictError extends Error {
  constructor() {
    super("Browser session changed during refresh");
    this.name = "BrowserSessionConflictError";
  }
}

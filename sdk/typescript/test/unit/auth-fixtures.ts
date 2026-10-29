import {
  createClient,
  memoryStorage,
  type AuthEvent,
  type SessionStorage,
} from "../../src/index.js";
import { mockFetch } from "./http-fixtures.js";

export const KEY = "nelcota.api.example.com.session";

export function setup(
  storage: SessionStorage = memoryStorage(),
  ...replies: Parameters<typeof mockFetch>
) {
  const mock = mockFetch(...replies);
  const nelcota = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { storage, autoRefresh: false },
  });
  const events: AuthEvent[] = [];
  nelcota.auth.onChange((event) => events.push(event));
  return { nelcota, calls: mock.calls, storage, events };
}

export function stored(value: unknown): SessionStorage {
  const storage = memoryStorage();
  void storage.setItem(KEY, JSON.stringify(value));
  return storage;
}

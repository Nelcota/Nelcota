import type { Page } from "@playwright/test";

import { requestObject } from "./request-json";
export type Saved = {
  image: string;
  source: string;
  crop: { x: number; y: number; zoom: number; rotation: number };
};

/** Holds one avatar mutation until the test releases its response. */
export async function heldAvatar(
  page: Page,
  save: (value: Saved | null) => void,
  action: "save" | "remove",
) {
  let finish: (() => Promise<void>) | undefined;
  let released = false;
  await page.route("**/admin/api/profile/avatar", (route) => {
    if (route.request().method() !== (action === "save" ? "PUT" : "DELETE"))
      return route.fallback();
    return new Promise<void>((resolve) => {
      finish = async () => {
        if (released) return;
        released = true;
        save(action === "save" ? (requestObject(route.request()) as Saved) : null);
        try {
          await route.fulfill({ json: { avatar: action === "save" ? 124 : null } });
        } finally {
          resolve();
        }
      };
    });
  });

  return {
    get finish() {
      return finish;
    },
  };
}

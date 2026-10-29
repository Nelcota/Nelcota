import { querySession } from "$lib/resources/query-client";
// Admin profile: photo version (ms of the last change) or `null` without a photo.
// The version goes into the URL, so the browser caches the image until it changes.
import { api } from "$lib/transport/api";

const value = $state<{ avatar: number | null; loaded: boolean; epoch: number }>({
  avatar: null,
  loaded: false,
  epoch: -1,
});
let generation = 0;

export const profile = {
  get avatar() {
    return value.epoch === querySession() ? value.avatar : null;
  },
  set avatar(avatar: number | null) {
    // A successful edit supersedes reads that started before it.
    generation++;
    value.epoch = querySession();
    value.avatar = avatar;
    value.loaded = true;
  },
  get loaded() {
    return value.epoch === querySession() && value.loaded;
  },
  set loaded(loaded: boolean) {
    generation++;
    value.loaded = loaded;
  },
};

export async function loadProfile() {
  const started = querySession(),
    request = ++generation;
  const current = () => started === querySession() && request === generation;
  try {
    const result = await api.get<{ avatar: number | null }>("/profile");
    if (current()) profile.avatar = result.avatar;
  } catch {
    if (current()) profile.avatar = null;
  }
}

export const avatarUrl = (version: number) => `/admin/api/profile/avatar?v=${version}`;

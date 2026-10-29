import type { StorageListing, StorageOverview } from "$lib/contracts/types";
import { api, ApiError, enc, uploadFile } from "$lib/transport/api";

import type { StorageBrowserAdapter } from "./browser.svelte";

export const storageBrowserAdapter: StorageBrowserAdapter = {
  async info(bucket, signal) {
    const data = await api.get<StorageOverview>(`/storage?${new URLSearchParams({ bucket })}`, {
      signal,
    });
    const found = data.enabled ? data.buckets.find((item) => item.id === bucket) : undefined;
    return data.enabled && found != null
      ? {
          bucket: found,
          publicOrigin: data.public_url ?? location.origin,
          serverLimit: data.max_file_size,
        }
      : null;
  },
  list: (target, offset, signal) =>
    api.get<StorageListing>(
      `/storage/buckets/${enc(target.bucket)}/objects?${new URLSearchParams({ prefix: target.prefix, offset: String(offset) })}`,
      { signal },
    ),
  remove: (bucket, name) =>
    api.delete(`/storage/buckets/${enc(bucket)}/file?${new URLSearchParams({ name })}`),
  removeMany: async (bucket, names) =>
    (await api.post<{ deleted: number }>(`/storage/buckets/${enc(bucket)}/files/delete`, { names }))
      .deleted,
  upload(file, target, { replace, progress }) {
    const params = new URLSearchParams({ name: target.prefix + file.name });
    if (replace) params.set("replace", "true");
    return uploadFile(`/storage/buckets/${enc(target.bucket)}/upload?${params}`, file, progress);
  },
  isConflict: (error) => error instanceof ApiError && error.code === "object_exists",
};

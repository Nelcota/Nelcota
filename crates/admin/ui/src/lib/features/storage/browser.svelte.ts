import { RemoteResource } from '$lib/resources/remote-resource.svelte'
import type { Bucket, StorageListing } from '$lib/contracts/types'
import { UploadQueue, type UploadTarget } from './upload-queue.svelte'

/** Files per bulk deletion request (the server's limit, MAX_BULK_DELETE). */
export const BULK_DELETE_BATCH = 200

/** A bucket with what its page needs: the public origin and the server's per-file limit. */
export type BucketInfo = { bucket: Bucket; publicOrigin: string; serverLimit: number } | null
export interface StorageBrowserAdapter {
  info(bucket: string, signal: AbortSignal): Promise<BucketInfo>
  list(target: UploadTarget, offset: number, signal: AbortSignal): Promise<StorageListing>
  remove(bucket: string, name: string): Promise<unknown>
  /** Deletes up to {@link BULK_DELETE_BATCH} files; resolves to how many were deleted. */
  removeMany(bucket: string, names: string[]): Promise<number>
  upload(file: File, target: UploadTarget, replace: boolean, progress: (loaded: number, total: number) => void): Promise<unknown>
  isConflict(error: unknown): boolean
}

/** Owns folder paging and mutation refreshes against captured destinations. */
export class StorageBrowser {
  readonly infoResource = new RemoteResource<BucketInfo>()
  readonly filesResource = new RemoteResource<StorageListing>()
  readonly uploads: UploadQueue
  private target?: UploadTarget

  constructor(private adapter: StorageBrowserAdapter) {
    this.uploads = new UploadQueue(
      (file, target, replace, progress) => adapter.upload(file, target, replace, progress),
      error => adapter.isConflict(error),
    )
  }

  async open(target: UploadTarget) {
    const bucketChanged = this.target?.bucket !== target.bucket
    if (this.matches(target)) return
    this.target = { ...target }
    this.filesResource.clear()
    if (bucketChanged) this.infoResource.clear()
    await Promise.all([this.load(), ...(bucketChanged ? [this.loadInfo()] : [])])
  }

  loadInfo() {
    const bucket = this.target?.bucket
    if (!bucket) return Promise.resolve(false)
    return this.infoResource.load(signal => this.adapter.info(bucket, signal))
  }

  load(more = false) {
    if (!this.target || (more && this.filesResource.loading)) return Promise.resolve(false)
    const target = { ...this.target }
    const previous = more ? this.filesResource.data : null
    const objects = [...(previous?.objects ?? [])]
    const folders = [...(previous?.folders ?? [])]
    return this.filesResource.load(async signal => {
      const page = await this.adapter.list(target, Math.max(objects.length, folders.length), signal)
      return { ...page, objects: [...objects, ...page.objects], folders: [...folders, ...page.folders] }
    })
  }

  async send(files: File[], replace = false, destination = this.target) {
    if (!destination) return undefined
    const result = await this.uploads.send(files, destination, replace)
    if (result && this.matches(result.target)) await this.refresh()
    return result
  }

  async remove(name: string) {
    if (!this.target) return
    const target = { ...this.target }
    await this.adapter.remove(target.bucket, name)
    if (this.matches(target)) await this.refresh()
  }

  /**
   * Deletes several files in batches; resolves to how many were deleted. The
   * folder reloads even after a failure, since earlier batches already went.
   */
  async removeMany(names: string[]) {
    if (!this.target || names.length === 0) return 0
    const target = { ...this.target }
    let deleted = 0
    try {
      for (let start = 0; start < names.length; start += BULK_DELETE_BATCH) {
        deleted += await this.adapter.removeMany(target.bucket, names.slice(start, start + BULK_DELETE_BATCH))
      }
    } finally {
      if (this.matches(target)) await this.refresh()
    }
    return deleted
  }

  private matches(target: UploadTarget) {
    return this.target?.bucket === target.bucket && this.target.prefix === target.prefix
  }
  private refresh() { return Promise.all([this.reload(), this.loadInfo()]) }

  /**
   * Reloads the folder after a change, page by page until it shows at least
   * as many entries as before, so "Load more" progress is not lost.
   */
  private reload() {
    if (!this.target) return Promise.resolve(false)
    const target = { ...this.target }
    const current = this.filesResource.data
    const shown = Math.max(current?.objects.length ?? 0, current?.folders.length ?? 0)
    return this.filesResource.load(async signal => {
      const objects: StorageListing['objects'] = []
      const folders: string[] = []
      let page: StorageListing
      do {
        page = await this.adapter.list(target, Math.max(objects.length, folders.length), signal)
        objects.push(...page.objects)
        folders.push(...page.folders)
      } while (page.has_next && page.objects.length + page.folders.length > 0 && Math.max(objects.length, folders.length) < shown)
      return { ...page, objects, folders }
    })
  }
  cancel() {
    this.target = undefined
    this.filesResource.cancel()
    this.infoResource.cancel()
  }
}

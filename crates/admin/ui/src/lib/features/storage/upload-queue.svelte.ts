import { requiredValue } from "../../contracts/required-value.js";
export type UploadTarget = { bucket: string; prefix: string };
export type UploadItem = {
  name: string;
  loaded: number;
  total: number;
  status: "queued" | "sending" | "done" | "error" | "conflict";
};
export type UploadAttempt = {
  replace: boolean;
  progress: (loaded: number, total: number) => void;
};
type Adapter = (file: File, target: UploadTarget, attempt: UploadAttempt) => Promise<unknown>;

type UploadResult = { status: "done" | "conflict" } | { status: "error"; error: unknown };
function recordUploadResult(
  file: File,
  result: UploadResult,
  { conflicts, errors }: { conflicts: File[]; errors: { file: File; error: unknown }[] },
): void {
  if (result.status === "conflict") conflicts.push(file);
  if (result.status === "error") errors.push({ file, error: result.error });
}

/** Owns upload ordering and captures the destination before navigation can change it. */
export class UploadQueue {
  items = $state<UploadItem[]>([]);
  progress = $state<{ done: number; total: number } | null>(null);
  constructor(
    private readonly upload: Adapter,
    private readonly isConflict: (error: unknown) => boolean,
  ) {}
  clear() {
    if (this.progress == null) this.items = [];
  }

  async send(files: File[], destination: UploadTarget, replace = false) {
    if (this.progress != null || files.length === 0) return undefined;
    const target = { ...destination };
    this.progress = { done: 0, total: files.length };
    this.items = files.map((file) => ({
      name: file.name,
      loaded: 0,
      total: file.size,
      status: "queued",
    }));
    try {
      return await this.sendFiles(files, target, replace);
    } finally {
      this.progress = null;
    }
  }

  private async sendFiles(files: File[], target: UploadTarget, replace: boolean) {
    const conflicts: File[] = [];
    const errors: { file: File; error: unknown }[] = [];
    let sent = 0;
    for (const [index, file] of files.entries()) {
      const item = requiredValue(this.items[index], "bounded operation item");
      try {
        // oxlint-disable-next-line no-await-in-loop -- Preserve file order and publish each upload result before starting the next file.
        const result = await this.sendOne(file, target, { item, replace });
        sent += Number(result.status === "done");
        recordUploadResult(file, result, { conflicts, errors });
      } finally {
        this.progress = { done: index + 1, total: files.length };
      }
    }
    return { target, sent, conflicts, errors };
  }

  private async sendOne(
    file: File,
    target: UploadTarget,
    attempt: { item: UploadItem; replace: boolean },
  ): Promise<UploadResult> {
    const { item, replace } = attempt;
    item.status = "sending";
    try {
      await this.upload(file, target, {
        replace,
        progress: (loaded, total) => {
          item.loaded = loaded;
          item.total = total;
        },
      });
      item.status = "done";
      item.loaded = file.size;
      return { status: "done" };
    } catch (error) {
      if (this.isConflict(error)) {
        item.status = "conflict";
        return { status: "conflict" };
      }
      item.status = "error";
      return { status: "error", error };
    }
  }
}

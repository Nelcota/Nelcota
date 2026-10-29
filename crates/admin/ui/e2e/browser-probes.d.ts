/** State installed by browser lifecycle fixtures before a probe is read. */
export {};

declare global {
  interface Window {
    pendingRename: {
      saving: boolean;
      reloading: boolean;
      finish: () => void;
      finishReload: () => void;
    };
    pendingDrop: { saving: boolean; finish: () => void };
    oldStructure: { calls: number; finish: () => void };
    oldPhotoRead: { ready: boolean; finish: () => void };
    previewBodySizes: number[];
    previewStream: { bytes: number; cancelled: boolean };
    previewPending: { calls: number; cancelled: boolean };
    oldPreview: { calls: number; fail: () => void };
    conflictingFile: WeakRef<object>;
    oldLogout: Promise<unknown>;
    newLogin: Promise<unknown>;
    oldUpload: Promise<unknown>;
    webhookXss?: unknown;
  }
}

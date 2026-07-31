// The OPFS synchronous access API is Worker-only and lives in TS's webworker
// lib, which we can't add alongside DOM. Declare the slice we use.

interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

interface FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>;
}

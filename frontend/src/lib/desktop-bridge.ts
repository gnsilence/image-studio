export type DesktopRecordNamespace =
  | 'generation-jobs'
  | 'image-records'
  | 'reverse-results'
  | 'upload-cache'
  | 'agent-messages'
  | 'agent-images'
  | 'agent-meta'
  | 'assets'
  | 'canvas-state';

export type DesktopFileNamespace = 'history' | 'assets' | 'agent' | 'canvas' | 'cache';

export interface DesktopRecordEntry<T = unknown> {
  key: string;
  value: T;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopStoredFile {
  id: string;
  namespace: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  data: Uint8Array;
}

export interface DesktopUpdateStatus {
  state: 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  message?: string;
}

export interface S3ConfigInput {
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix: string;
  forcePathStyle: boolean;
}

export interface S3PublicConfig extends S3ConfigInput {
  hasAccessKeyId: boolean;
  hasSecretAccessKey: boolean;
  hasSessionToken: boolean;
}

export interface S3CredentialsInput {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export interface S3Folder {
  name: string;
  prefix: string;
}

export interface S3ImageObject {
  key: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  etag?: string;
  lastModified?: string;
}

export interface S3ListResult {
  prefix: string;
  folders: S3Folder[];
  objects: S3ImageObject[];
  nextToken?: string;
}

export interface NovaDesktopBridge {
  platform: 'win32' | 'darwin';
  config: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
  records: {
    get<T = unknown>(namespace: DesktopRecordNamespace, key: string): Promise<T | null>;
    list<T = unknown>(namespace: DesktopRecordNamespace): Promise<DesktopRecordEntry<T>[]>;
    put(namespace: DesktopRecordNamespace, key: string, value: unknown): Promise<void>;
    delete(namespace: DesktopRecordNamespace, key: string): Promise<void>;
    clear(namespace: DesktopRecordNamespace): Promise<void>;
  };
  files: {
    read(namespace: DesktopFileNamespace, id: string): Promise<DesktopStoredFile | null>;
    list(namespace: DesktopFileNamespace): Promise<Array<Omit<DesktopStoredFile, 'data'>>>;
    write(namespace: DesktopFileNamespace, id: string, data: Uint8Array, mimeType: string): Promise<Omit<DesktopStoredFile, 'data'>>;
    delete(namespace: DesktopFileNamespace, id: string): Promise<void>;
  };
  s3: {
    getConfig(): Promise<S3PublicConfig>;
    saveConfig(input: { config: S3ConfigInput; credentials?: S3CredentialsInput }): Promise<S3PublicConfig>;
    clearCredentials(): Promise<S3PublicConfig>;
    testConnection(input: { config: S3ConfigInput; credentials?: S3CredentialsInput }): Promise<{ available: boolean; message: string }>;
    listFolder(input: { prefix?: string; continuationToken?: string }): Promise<S3ListResult>;
    readThumbnail(object: S3ImageObject): Promise<DesktopStoredFile>;
    readObject(object: S3ImageObject): Promise<DesktopStoredFile>;
    uploadObject(input: { prefix: string; fileName: string; mimeType: string; data: Uint8Array }): Promise<S3ImageObject>;
    createFolder(input: { prefix: string; name: string }): Promise<S3Folder>;
    downloadObject(object: S3ImageObject): Promise<{ canceled: boolean; filePath?: string }>;
  };
  backup: {
    export(): Promise<{ canceled: boolean; filePath?: string }>;
    import(): Promise<{ canceled: boolean }>;
  };
  updater: {
    check(): Promise<DesktopUpdateStatus>;
    getStatus(): Promise<DesktopUpdateStatus>;
    restartAndInstall(): Promise<{ installed: boolean; reason?: string }>;
    onStatus(callback: (status: DesktopUpdateStatus) => void): () => void;
  };
  openDataDirectory(): Promise<string>;
}

declare global {
  interface Window {
    novaDesktop?: NovaDesktopBridge;
  }
}

export function getDesktopBridge(): NovaDesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return window.novaDesktop || null;
}

export function isDesktopRuntime(): boolean {
  return getDesktopBridge() !== null;
}

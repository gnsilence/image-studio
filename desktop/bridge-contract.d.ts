export {};

type DesktopRecordEntry<T = unknown> = {
  key: string;
  value: T;
  createdAt: string;
  updatedAt: string;
};

type DesktopStoredFile = {
  id: string;
  namespace: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  data: Uint8Array;
};

type DesktopUpdateStatus = {
  state: 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  message?: string;
};

type S3ConfigInput = {
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix: string;
  forcePathStyle: boolean;
};

type S3PublicConfig = S3ConfigInput & {
  hasAccessKeyId: boolean;
  hasSecretAccessKey: boolean;
  hasSessionToken: boolean;
};

type S3CredentialsInput = {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

type S3Folder = { name: string; prefix: string };
type S3ImageObject = {
  key: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  etag?: string;
  lastModified?: string;
};
type S3ListResult = { prefix: string; folders: S3Folder[]; objects: S3ImageObject[]; nextToken?: string };

declare global {
  interface Window {
    novaDesktop?: {
      platform: 'win32';
      config: {
        get(key: string): string | null;
        set(key: string, value: string): void;
        remove(key: string): void;
      };
      records: {
        get<T = unknown>(namespace: string, key: string): Promise<T | null>;
        list<T = unknown>(namespace: string): Promise<DesktopRecordEntry<T>[]>;
        put(namespace: string, key: string, value: unknown): Promise<void>;
        delete(namespace: string, key: string): Promise<void>;
        clear(namespace: string): Promise<void>;
      };
      files: {
        read(namespace: string, id: string): Promise<DesktopStoredFile | null>;
        list(namespace: string): Promise<Array<Omit<DesktopStoredFile, 'data'>>>;
        write(namespace: string, id: string, data: Uint8Array, mimeType: string): Promise<Omit<DesktopStoredFile, 'data'>>;
        delete(namespace: string, id: string): Promise<void>;
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
    };
  }
}

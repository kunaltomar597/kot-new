/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The console's version, reported when the device pairs (set by the build). */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

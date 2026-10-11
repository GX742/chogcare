/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TWITCH_CHANNEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

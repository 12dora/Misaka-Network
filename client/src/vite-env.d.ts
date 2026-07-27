/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_WS_URL?: string
  readonly VITE_E2E_BUILD_NONCE?: string
  readonly VITE_E2E_HOST_ICE_ONLY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

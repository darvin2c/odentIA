/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** El WhatsApp de ventas del Grupo Sallca, en E.164 (`vars.SALES_WHATSAPP` en el CI). */
  readonly VITE_SALES_WHATSAPP?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

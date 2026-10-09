import { z } from "zod"

const envSchema = z.object({
  APP_DATABASE_URL: z.string().min(1),
  /** Rol owner: setup de memoria del agente (paso 7). */
  DATABASE_URL: z.string().min(1),
  SECRETS_KEY: z.string().min(1),
  /** Origen público de la plataforma para confirmaciones y bajas. */
  WEB_URL: z.string().url(),
  COOKIE_DOMAIN: z.string().min(1),
  GMAIL_CLIENT_ID: z.string().default(""),
  GMAIL_CLIENT_SECRET: z.string().default(""),
  GMAIL_REDIRECT_URI: z.string().default(""),
  MICROSOFT_MAIL_CLIENT_ID: z.string().default(""),
  MICROSOFT_MAIL_CLIENT_SECRET: z.string().default(""),
  MICROSOFT_MAIL_REDIRECT_URI: z.string().default(""),
  MICROSOFT_MAIL_TENANT: z.string().default("common"),
  MAILBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
  CHANNEL_SENDER_MODE: z.enum(["mock", "live"]).default("mock"),
  /** Modelo del endpoint compatible con OpenAI (prefijo openai: opcional); fake = determinista. */
  LLM_MODEL: z.string().min(1).default("fake"),
  LLM_API_KEY: z.string().optional().default(""),
  LLM_BASE_URL: z.string().url().optional(),
  /** Tiempo límite por intento y reintentos del cliente del modelo. */
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** dev/e2e: admite http y destinos privados para servidores locales de prueba. */
  LLM_ALLOW_INSECURE_BASE_URL: z.enum(["true", "false"]).default("false"),
  /** Transcripción de notas de voz inbound (endpoint OpenAI-compatible); vacío = desactivada. */
  TRANSCRIBE_MODEL: z.string().optional().default(""),
  /** Cae a LLM_API_KEY solo si TRANSCRIBE_BASE_URL apunta al mismo host que LLM_BASE_URL. */
  TRANSCRIBE_API_KEY: z.string().optional(),
  TRANSCRIBE_BASE_URL: z.string().url().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().optional(),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default("auto"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ATTACHMENTS_BUCKET: z.string().min(1),
  S3_PUBLIC_URL: z.string().url(),
})

function loadEnv() {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error("Variables de entorno inválidas:", parsed.error.flatten().fieldErrors)
    process.exit(1)
  }
  return parsed.data
}

export const env = loadEnv()
export type Env = typeof env

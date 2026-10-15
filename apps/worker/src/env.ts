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
  /**
   * Cuentas de odentIA para los modelos que elige la clínica (ADR 0022). Sin
   * la clave del proveedor del modelo elegido, el agente deriva y lo avisa.
   * `LLM_MODEL=fake`: modelo determinista de desarrollo y pruebas (otro valor no tiene efecto).
   */
  LLM_MODEL: z.string().optional(),
  LLM_OPENAI_API_KEY: z.string().optional().default(""),
  LLM_OPENAI_BASE_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
  LLM_ANTHROPIC_API_KEY: z.string().optional().default(""),
  LLM_ANTHROPIC_BASE_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
  /** Tiempo límite por intento y reintentos del cliente del modelo. */
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  // Segundos que el agente espera tras un mensaje entrante antes de leer el
  // hilo: agrupa ráfagas en una sola corrida. 0 responde sin esperar.
  // Vacío en el .env cuenta como no definido (no como 0, que la desactivaría).
  AGENT_BURST_WINDOW_SECONDS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(0).max(30).default(6),
  ),
  // La espera se reinicia con cada mensaje nuevo de la persona; este es el
  // tope desde su primer mensaje sin responder, para que nadie espere de más.
  AGENT_BURST_MAX_WAIT_SECONDS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(0).max(120).default(30),
  ),
  /** Modelos de decisión (plataforma); vacíos = ese proveedor no está disponible. */
  JEV_API_KEY: z.string().optional().default(""),
  JEV_BASE_URL: z.string().url().optional(),
  JEV_MODEL: z.string().optional().default("jev-1.13.0"),
  OPENAI_DECISIONS_API_KEY: z.string().optional().default(""),
  OPENAI_DECISIONS_BASE_URL: z.string().url().optional(),
  OPENAI_DECISIONS_MODEL: z.string().optional().default("gpt-6-luna"),
  /** Plazo de la sombra, por debajo de la visibilidad de la cola (30 s). */
  DECISIONS_TIMEOUT_MS: z.coerce.number().int().min(500).max(20_000).default(5_000),
  /**
   * Búsqueda por significado del agente (ADR 0021): proveedor de vectores de la
   * plataforma, compatible con OpenAI. `fake`: vectores por letras, sin red.
   * Vacío: el agente busca solo por palabras.
   */
  EMBEDDINGS_MODEL: z.string().optional(),
  EMBEDDINGS_BASE_URL: z.string().url().optional(),
  EMBEDDINGS_API_KEY: z.string().optional().default(""),
  EMBEDDINGS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  /** Transcripción de notas de voz inbound (endpoint OpenAI-compatible); vacío = desactivada. */
  TRANSCRIBE_MODEL: z.string().optional().default(""),
  /** Cae a LLM_OPENAI_API_KEY solo si TRANSCRIBE_BASE_URL apunta al mismo host que LLM_OPENAI_BASE_URL. */
  TRANSCRIBE_API_KEY: z.string().optional(),
  TRANSCRIBE_BASE_URL: z.string().url().optional(),
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

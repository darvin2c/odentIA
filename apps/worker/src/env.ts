import { fakeModelStartProblem } from "@odentia/agent"
import { z } from "zod"

const envSchema = z.object({
  APP_DATABASE_URL: z.string().min(1),
  /** Rol owner: setup de memoria del agente (paso 7). */
  DATABASE_URL: z.string().min(1),
  SECRETS_KEY: z.string().min(1),
  /** Los de la API: el enlace «Verificar mi correo» del recordatorio lo firma y lo canjea Better Auth. */
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  /** El panel; con él, el esquema y el puerto de la dirección de cada clínica. */
  WEB_URL: z.string().url(),
  COOKIE_DOMAIN: z.string().min(1),
  /** El dominio de latidIA, el de la API (decisión 9 del issue 229): sus clínicas van en él. Vacío: un solo dominio. */
  MEDICAL_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]*$/, "Un dominio, p. ej. latidia72.com")
    .default(""),
  /** Versión del Graph API de Meta, la misma de la API: WhatsApp, Messenger e Instagram. */
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "Se espera la forma v25.0")
    .default("v25.0"),
  /**
   * La app de odentIA en Meta, las mismas de la API: con ellas el worker renueva
   * la clave de «Conectar con Facebook» antes de que venza. Vacías: no se renueva.
   */
  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  /** Origen del back-office: el botón «Abrir en Soporte» de los avisos de soporte. */
  ADMIN_URL: z.string().url(),
  /**
   * Buzón de soporte de odentIA: recibe «Caso nuevo» y «La clínica respondió».
   * Vacío: esos avisos quedan pendientes (el caso sigue en la bandeja de Soporte).
   */
  SUPPORT_INBOX_EMAIL: z.union([z.literal(""), z.email()]).default(""),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int(),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().min(1),
  // El remitente de los correos de latidIA (issue 229); vacío, el de SMTP_FROM con su nombre.
  MEDICAL_SMTP_FROM: z.string().optional(),
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
   * Cuenta de odentIA para el modelo del agente, uno solo (ADR 0052). Sin la
   * clave, el agente deriva y lo avisa.
   * `LLM_MODEL=fake`: modelo determinista de desarrollo y pruebas (otro valor no tiene efecto).
   */
  LLM_MODEL: z.string().optional(),
  /** La imagen lo fija en `production`; desarrollo y pruebas lo dejan vacío o en `test`. */
  NODE_ENV: z.string().optional(),
  LLM_OPENAI_API_KEY: z.string().optional().default(""),
  LLM_OPENAI_BASE_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
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
  /** Modelo de decisión de la plataforma (Jev); vacío = no está disponible. */
  JEV_API_KEY: z.string().optional().default(""),
  JEV_BASE_URL: z.string().url().optional(),
  JEV_MODEL: z.string().optional().default("jev-1.13.0"),
  /**
   * Plazo por llamada al modelo de decisión. Camino y conocimiento van uno tras
   * otro antes de responder, y todo debe caber en la visibilidad de la cola (30 s).
   */
  DECISIONS_TIMEOUT_MS: z.coerce.number().int().min(500).max(20_000).default(2_000),
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
}).superRefine((data, ctx) => {
  // Producción no arranca con el modelo de demostración (ver `fakeModelStartProblem`).
  const problem = fakeModelStartProblem(data, data.CHANNEL_SENDER_MODE === "live")
  if (problem) ctx.addIssue({ code: "custom", path: ["LLM_MODEL"], message: problem })
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

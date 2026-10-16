import { z } from "zod"

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  WEB_URL: z.string().url(),
  ADMIN_URL: z.string().url(),
  COOKIE_DOMAIN: z.string().min(1),
  TRUSTED_ORIGINS: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int(),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  SMTP_FROM: z.string().min(1),
  /**
   * Buzón de soporte de odentIA. Los avisos los envía el worker; aquí se
   * valida igual para que una dirección mal escrita falle al arrancar.
   */
  SUPPORT_INBOX_EMAIL: z.union([z.literal(""), z.email()]).default(""),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default("auto"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ATTACHMENTS_BUCKET: z.string().min(1),
  S3_PUBLIC_URL: z.string().url(),
  SECRETS_KEY: z.string().min(1),
  CHANNEL_VALIDATE_EXTERNAL: z.enum(["true", "false"]).default("true"),
  GMAIL_CLIENT_ID: z.string().default(""),
  GMAIL_CLIENT_SECRET: z.string().default(""),
  GMAIL_REDIRECT_URI: z.string().default(""),
  MICROSOFT_MAIL_CLIENT_ID: z.string().default(""),
  MICROSOFT_MAIL_CLIENT_SECRET: z.string().default(""),
  MICROSOFT_MAIL_REDIRECT_URI: z.string().default(""),
  MICROSOFT_MAIL_TENANT: z.string().default("common"),
  /**
   * «Conectar con Facebook» de WhatsApp (Embedded Signup de Meta): la app de
   * odentIA, la misma para todas las clínicas. Opcional: sin las cuatro
   * primeras el botón no existe y la conexión a mano sigue igual. Pasos del
   * trámite ante Meta en `docs/development.md`.
   */
  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  META_LOGIN_CONFIG_ID: z.string().default(""),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default(""),
  /** Versión del Graph API con la que el botón abre la ventana y el servidor llama a Meta. */
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "Se espera la forma v25.0")
    .default("v25.0"),
  /**
   * Cuentas de odentIA para los modelos que elige la clínica (ADR 0022). Sin
   * la clave del proveedor del modelo elegido, el agente deriva y lo avisa.
   * `LLM_MODEL=fake`: modelo determinista de desarrollo y pruebas (otro valor no tiene efecto).
   */
  LLM_MODEL: z.string().optional(),
  LLM_OPENAI_API_KEY: z.string().optional(),
  LLM_OPENAI_BASE_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
  LLM_ANTHROPIC_API_KEY: z.string().optional(),
  LLM_ANTHROPIC_BASE_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Modelos de decisión de la plataforma: entienden lo que se le pide al Administrador con palabras. */
  JEV_API_KEY: z.string().optional().default(""),
  JEV_BASE_URL: z.string().url().optional(),
  JEV_MODEL: z.string().optional().default("jev-1.13.0"),
  OPENAI_DECISIONS_API_KEY: z.string().optional().default(""),
  OPENAI_DECISIONS_BASE_URL: z.string().url().optional(),
  OPENAI_DECISIONS_MODEL: z.string().optional().default("gpt-6-luna"),
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
  PORT: z.coerce.number().int().default(3001),
})

function loadEnv() {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error("Variables de entorno inválidas:", parsed.error.flatten().fieldErrors)
    process.exit(1)
  }
  const { TRUSTED_ORIGINS, ...rest } = parsed.data
  return { ...rest, trustedOrigins: TRUSTED_ORIGINS.split(",").map((o) => o.trim()) }
}

export const env = loadEnv()
export type Env = typeof env

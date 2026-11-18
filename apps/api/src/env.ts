import { fakeModelStartProblem } from "@odentia/agent"
import type { ProductDomains } from "@odentia/clinical"
import type { AccountApp } from "@odentia/auth/apps"
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
  /** La clave pública VAPID de los avisos en el equipo, la misma del worker. Vacía: no se ofrecen. */
  VAPID_PUBLIC_KEY: z.string().default(""),
  /**
   * El dominio de latidIA (decisión 9 del issue 229): sus clínicas, su panel y
   * su API van en él (`<slug>.`, `app.`, `api.`), con el esquema y el puerto
   * de los de odentIA, y con su propia sesión. Vacío: un solo dominio.
   */
  MEDICAL_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]*$/, "Un dominio, p. ej. latidia72.com")
    .default(""),
  /**
   * El dominio de gestorIA (`gestoria24.com`, ADR 0201): ahí solo responde su entrada a la
   * cuenta (`api.` + `/api/auth/*`), nada de las clínicas, y sus correos llevan su marca y
   * su web en el pie. Vacío: no existe.
   */
  GESTORIA_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]*$/, "Un dominio, p. ej. gestoria24.com")
    .default(""),
  /**
   * Los avisos de la cuenta a gestorIA (ADR 0201): adónde (https) y con qué secreto
   * (`whsec_…`, Standard Webhooks). Los mismos en el worker. Vacíos: los avisos esperan.
   */
  GESTORIA_ACCOUNT_EVENTS_URL: z.string().trim().default(""),
  GESTORIA_ACCOUNT_EVENTS_SECRET: z.string().trim().default(""),
  /** El dominio de vistIA (`vistia20.com`), como el de latidIA. Vacío: sus ópticas van en el de la plataforma. */
  OPTICAL_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]*$/, "Un dominio, p. ej. vistia20.com")
    .default(""),
  /**
   * Cabecera con la IP de quien pide, para el límite de intentos de Better Auth
   * (`clientIpAddress`). Solo una que reescriba siempre quien está delante. Con
   * Cloudflare Tunnel, `cf-connecting-ip`: Cloudflare la reescribe y el túnel es la
   * única entrada. Por el borde de OpenShip, `x-real-ip`: el borde la fija con la
   * dirección que vio conectar, y ahí `cf-connecting-ip` no sirve porque el servidor
   * acepta conexiones sin Cloudflare y el borde la deja pasar tal como llega.
   * `x-forwarded-for` nunca: los proxies la alargan con lo que trajo el cliente.
   * Vacía: ninguna, y todos comparten el límite. Detalle en docs/deployment.md.
   */
  CLIENT_IP_HEADER: z
    .string()
    .trim()
    .toLowerCase()
    // Un nombre de campo (token de RFC 9110): sin comas, una sola cabecera.
    .regex(/^[!#$%&'*+.^_`|~0-9a-z-]*$/, "Una sola cabecera, p. ej. x-real-ip")
    .default(""),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int(),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  SMTP_FROM: z.string().min(1),
  // El remitente de los correos de latidIA (issue 229); vacío, el de SMTP_FROM con su nombre.
  MEDICAL_SMTP_FROM: z.string().optional(),
  // El de vistIA, igual.
  OPTICAL_SMTP_FROM: z.string().optional(),
  // El de gestorIA (su entrada a la cuenta, `GESTORIA_DOMAIN`), igual.
  GESTORIA_SMTP_FROM: z.string().optional(),
  /**
   * Un segundo usuario del mismo servidor (ZeptoMail: otro canal de envío) para
   * las conversaciones de la administración: «Escribir» y las respuestas a un
   * correo. Opcionales y van juntos: sin ellos salen por SMTP_USER/SMTP_PASS.
   */
  CONVERSATION_SMTP_USER: z.string().optional().default(""),
  CONVERSATION_SMTP_PASS: z.string().optional().default(""),
  /**
   * Correo de odentIA que recibe el aviso de cada Hoja de Reclamación (Libro de
   * Reclamaciones de la web). Opcional: sin él solo sale la copia al consumidor.
   */
  COMPLAINTS_EMAIL: z.preprocess((value) => (value === "" ? undefined : value), z.string().email().optional()),
  /**
   * Buzón de soporte de odentIA. Los avisos los envía el worker; aquí se
   * valida igual para que una dirección mal escrita falle al arrancar.
   */
  SUPPORT_INBOX_EMAIL: z.union([z.literal(""), z.email()]).default(""),
  /**
   * Secreto compartido con el worker de Cloudflare que recibe el correo de los
   * buzones (soporte@, contacto@, hola@, fundadores@) y de la dirección de cada
   * persona del equipo, y lo manda firmado (HMAC sha256) a `/api/inbound/email`.
   * Opcional: sin él esa ruta responde 503 y el correo solo se reenvía.
   */
  INBOUND_EMAIL_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32, "INBOUND_EMAIL_SECRET: 32 caracteres como mínimo").optional(),
  ),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default("auto"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ATTACHMENTS_BUCKET: z.string().min(1),
  S3_PUBLIC_URL: z.string().url(),
  SECRETS_KEY: z.string().min(1),
  CHANNEL_VALIDATE_EXTERNAL: z.enum(["true", "false"]).default("true"),
  /** Rechazar contraseñas filtradas consultando Have I Been Pwned; `false` en pruebas sin red. */
  PASSWORD_BREACH_CHECK: z.enum(["true", "false"]).default("true"),
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
  /**
   * «Conectar con Facebook» de Messenger e Instagram: otra configuración de
   * Facebook Login for Business en la misma app (permisos de páginas e
   * Instagram) y la dirección fija de la API a la que vuelve, registrada en
   * Meta. Sin las dos, el botón de páginas no existe.
   */
  META_PAGES_CONFIG_ID: z.string().default(""),
  META_PAGES_REDIRECT_URI: z.string().default(""),
  /**
   * «Conectar con Instagram»: la app de Instagram del caso de uso de Instagram
   * (su propio identificador y clave secreta, distintos de los de Facebook) y la
   * vuelta fija de la API. Sin las tres, Instagram se conecta con Facebook.
   */
  META_INSTAGRAM_APP_ID: z.string().default(""),
  META_INSTAGRAM_APP_SECRET: z.string().default(""),
  META_INSTAGRAM_REDIRECT_URI: z.string().default(""),
  /**
   * Los canales de la administración (ADR 0189): la app de Meta propia de
   * Sallca, con su número de WhatsApp, su página de Facebook (Messenger) y su
   * cuenta de Instagram. Cada canal se prende con sus variables y las dos
   * comunes (`adminChannelsFromEnv`); vacías, «Escribir» sigue con wa.me.
   */
  ADMIN_META_APP_SECRET: z.string().default(""),
  ADMIN_META_VERIFY_TOKEN: z.string().default(""),
  ADMIN_WA_PHONE_NUMBER_ID: z.string().default(""),
  ADMIN_WA_ACCESS_TOKEN: z.string().default(""),
  ADMIN_META_PAGE_ID: z.string().default(""),
  ADMIN_META_PAGE_ACCESS_TOKEN: z.string().default(""),
  ADMIN_IG_ACCOUNT_ID: z.string().default(""),
  /**
   * Solo pruebas (e2e): la Graph API de Meta de los canales de la administración
   * en un servidor local (`http://127.0.0.1:<puerto>`). Producción no arranca con ella.
   */
  ADMIN_META_GRAPH_URL: z.string().default(""),
  /** Versión del Graph API con la que el botón abre la ventana y el servidor llama a Meta. */
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "Se espera la forma v25.0")
    .default("v25.0"),
  /**
   * Cuenta de odentIA para el modelo del agente, uno solo (ADR 0052). Sin la
   * clave, el agente deriva y lo avisa.
   * `LLM_MODEL=fake`: modelo determinista de desarrollo y pruebas (otro valor no tiene efecto).
   */
  LLM_MODEL: z.string().optional(),
  /** La imagen lo fija en `production`; desarrollo y pruebas lo dejan vacío o en `test`. */
  NODE_ENV: z.string().optional(),
  LLM_OPENAI_API_KEY: z.string().optional(),
  LLM_OPENAI_BASE_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Modelo de decisión de la plataforma (Jev): entiende lo que se le pide al Administrador con palabras. */
  JEV_API_KEY: z.string().optional().default(""),
  JEV_BASE_URL: z.string().url().optional(),
  JEV_MODEL: z.string().optional().default("jev-1.13.0"),
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
  /**
   * Sugerencias de direcciones (issue 36, ADR 0077): Google Places para la
   * sede y Geoapify para el paciente. Vacías: los campos de siempre.
   */
  GOOGLE_MAPS_API_KEY: z.string().optional().default(""),
  GEOAPIFY_API_KEY: z.string().optional().default(""),
  /** El plan de Geoapify: búsquedas al día para todo odentIA (el gratis da 3 000). */
  GEOAPIFY_DAILY_LIMIT: z.coerce.number().int().min(1).default(3000),
  /**
   * Solo los subdominios de clínicas reales llegan a las pantallas (ADR 0193): un token de
   * Cloudflare con «Zone WAF: Edit» solo en las zonas de los productos, y el id de la zona
   * del dominio de cada uno. La API y el worker ponen al día la regla de hosts permitidos de
   * cada zona. Vacías: no se toca Cloudflare. vistIA no tiene su dominio ahí todavía.
   */
  CLOUDFLARE_WAF_TOKEN: z.string().trim().default(""),
  CLOUDFLARE_ZONE_ID: z.string().trim().default(""),
  MEDICAL_CLOUDFLARE_ZONE_ID: z.string().trim().default(""),
  OPTICAL_CLOUDFLARE_ZONE_ID: z.string().trim().default(""),
  PORT: z.coerce.number().int().default(3001),
}).superRefine((data, ctx) => {
  // Producción no arranca con el modelo de demostración (ver `fakeModelStartProblem`).
  const problem = fakeModelStartProblem(data, data.CHANNEL_VALIDATE_EXTERNAL !== "false")
  if (problem) ctx.addIssue({ code: "custom", path: ["LLM_MODEL"], message: problem })
  // Ni con las direcciones de demostración: un paciente real no recibe sugerencias inventadas.
  const channelsLive = data.NODE_ENV === "production" && data.CHANNEL_VALIDATE_EXTERNAL !== "false"
  for (const key of ["GOOGLE_MAPS_API_KEY", "GEOAPIFY_API_KEY"] as const) {
    if (channelsLive && data[key] === "fake") {
      ctx.addIssue({ code: "custom", path: [key], message: `${key}=fake sugiere direcciones de demostración: en producción, con canales reales, el servidor no arranca con él` })
    }
  }
  if (data.NODE_ENV === "production" && data.ADMIN_META_GRAPH_URL) {
    ctx.addIssue({ code: "custom", path: ["ADMIN_META_GRAPH_URL"], message: "ADMIN_META_GRAPH_URL es solo de pruebas: en producción los canales de la administración hablan con Meta" })
  }
})

function loadEnv() {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error("Variables de entorno inválidas:", parsed.error.flatten().fieldErrors)
    process.exit(1)
  }
  const { TRUSTED_ORIGINS, ...rest } = parsed.data
  return {
    ...rest,
    trustedOrigins: TRUSTED_ORIGINS.split(",").map((o) => o.trim()),
    // Uno por producto con dominio propio: el que se agregue tiene que decir el suyo.
    productDomains: {
      medical: rest.MEDICAL_DOMAIN || undefined,
      optical: rest.OPTICAL_DOMAIN || undefined,
    } satisfies ProductDomains,
    // El de cada app que es otro sistema (ADR 0201).
    externalAppDomains: { gestoria: rest.GESTORIA_DOMAIN || undefined } as Partial<Record<AccountApp, string>>,
  }
}

export const env = loadEnv()
export type Env = typeof env

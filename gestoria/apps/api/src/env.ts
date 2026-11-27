import { z } from "zod"
import { isSigningSecret } from "./firma.js"

/**
 * Lo que necesita el servidor de gestorIA. Sus nombres llevan `GESTORIA_` para que nunca tome
 * por error la base o la configuración de las clínicas (comparten el `.env` de desarrollo).
 */
/** Un secreto de Standard Webhooks (`whsec_` y al menos 24 bytes en base64), o vacío: apagado. */
const signingSecret = z
  .string()
  .trim()
  .default("")
  .refine(
    (value) => value === "" || isSigningSecret(value),
    "Es whsec_ y al menos 24 bytes en base64",
  )

const schema = z.object({
  /** El dueño de la base `gestoria`: migraciones, la copia de las cuentas y los avisos. */
  GESTORIA_DATABASE_URL: z.string().min(1),
  /** El rol de la aplicación (`gestoria_app`), sujeto a las reglas de cada tienda. */
  GESTORIA_APP_DATABASE_URL: z.string().min(1),
  /** La entrada a la cuenta en el dominio de gestorIA (`https://api.gestoria24.com`): emite el token. */
  GESTORIA_ACCOUNT_URL: z.string().url(),
  /** El secreto de los avisos, el mismo que tiene la cuenta. Vacío: sin avisos ni revisión diaria. */
  GESTORIA_ACCOUNT_EVENTS_SECRET: signingSecret,
  /**
   * El secreto del acuerdo con la administración (B7, ADR 0211), el mismo `GESTORIA_CONTRACT_SECRET`
   * que tiene la API de las clínicas. Vacío: no le avisa ni le pregunta nada (los avisos esperan).
   */
  GESTORIA_CONTRACT_SECRET: signingSecret,
  /** La app (`https://app.gestoria24.com`): el único origen que llama y la base de los enlaces. */
  GESTORIA_WEB_URL: z.string().url(),
  GESTORIA_PORT: z.coerce.number().int().positive().default(3201),
  /** La dirección pública de este servidor (`https://servidor.gestoria24.com`): adonde avisa el link de pago. */
  GESTORIA_API_URL: z.string().url().optional(),
  /**
   * La llave de las credenciales que pone cada tienda (el link de pago), 32 bytes en base64.
   * Vacía: el link de pago no está disponible; lo demás funciona.
   */
  GESTORIA_SECRETS_KEY: z
    .string()
    .trim()
    .default("")
    .refine(
      (value) => value === "" || Buffer.from(value, "base64").length === 32,
      "Son 32 bytes en base64 (openssl rand -base64 32)",
    ),
  /**
   * El modelo de Sofi (B5): por omisión el de las clínicas (`gpt-6-luna`); «fake» responde por
   * reglas sin red (solo en desarrollo). Sin la clave de OpenAI, Sofi no responde.
   */
  GESTORIA_LLM_MODEL: z.string().trim().default(""),
  GESTORIA_OPENAI_API_KEY: z.string().trim().default(""),
  /** Solo si no es la API pública de OpenAI. */
  GESTORIA_OPENAI_BASE_URL: z.string().trim().default(""),
  /**
   * Los avisos al celular (push web, RFC 8292): el par de claves VAPID de gestorIA, propio (no el
   * de las clínicas), y a quién escribir si un servicio de push tiene un problema (`mailto:` o
   * `https:`). Vacías: los avisos al celular no se ofrecen y no se envía nada.
   */
  GESTORIA_VAPID_PUBLIC_KEY: z.string().trim().default(""),
  GESTORIA_VAPID_PRIVATE_KEY: z.string().trim().default(""),
  GESTORIA_VAPID_SUBJECT: z
    .string()
    .trim()
    .default("")
    .refine(
      (value) => value === "" || /^(mailto:|https:\/\/)/.test(value),
      "Es mailto: o https://",
    ),
})

export type Env = z.infer<typeof schema>

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")
    throw new Error(`gestoria-api: falta configuración (${problems})`)
  }
  return parsed.data
}

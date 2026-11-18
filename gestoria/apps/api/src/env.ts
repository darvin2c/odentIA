import { z } from "zod"
import { isSigningSecret } from "./firma.js"

/**
 * Lo que necesita el servidor de gestorIA. Sus nombres llevan `GESTORIA_` para que nunca tome
 * por error la base o la configuración de las clínicas (comparten el `.env` de desarrollo).
 */
const schema = z.object({
  /** El dueño de la base `gestoria`: migraciones, la copia de las cuentas y los avisos. */
  GESTORIA_DATABASE_URL: z.string().min(1),
  /** El rol de la aplicación (`gestoria_app`), sujeto a las reglas de cada tienda. */
  GESTORIA_APP_DATABASE_URL: z.string().min(1),
  /** La entrada a la cuenta en el dominio de gestorIA (`https://api.gestoria24.com`): emite el token. */
  GESTORIA_ACCOUNT_URL: z.string().url(),
  /** El secreto de los avisos, el mismo que tiene la cuenta. Vacío: sin avisos ni revisión diaria. */
  GESTORIA_ACCOUNT_EVENTS_SECRET: z
    .string()
    .trim()
    .default("")
    .refine(
      (value) => value === "" || isSigningSecret(value),
      "Es whsec_ y al menos 24 bytes en base64",
    ),
  /** La app (`https://app.gestoria24.com`): el único origen que llama y la base de los enlaces. */
  GESTORIA_WEB_URL: z.string().url(),
  GESTORIA_PORT: z.coerce.number().int().positive().default(3201),
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

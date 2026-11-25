import { fileURLToPath } from "node:url"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { createOwnerDb } from "./index.js"

/** La carpeta de las migraciones de gestorIA, sin importar desde dónde se corra. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url))

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const url = process.env.GESTORIA_DATABASE_URL
  if (!url)
    throw new Error(
      "GESTORIA_DATABASE_URL es obligatoria para migrar (el dueño de la base de gestorIA)",
    )
  // En producción la base llega por un enlace de OpenShip que se arma después de crear el
  // contenedor: mientras no resuelve o no atiende, se reintenta hasta GESTORIA_DB_WAIT_SECONDS.
  // Cualquier otro error (una migración que falla) corta enseguida.
  const waitUntil = Date.now() + Number(process.env.GESTORIA_DB_WAIT_SECONDS ?? 0) * 1000
  for (;;) {
    const db = createOwnerDb(url, { max: 1 })
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
      break
    } catch (error) {
      if (!isUnreachable(error) || Date.now() >= waitUntil) throw error
      console.log("gestoria: la base todavía no responde; reintento en 3 s")
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }
  console.log("gestoria: migraciones aplicadas")
  process.exit(0)
}

/** La base no se alcanza todavía (nombre sin resolver, puerto cerrado), no un error de SQL. */
function isUnreachable(error: unknown): boolean {
  const codes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"])
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code
    if (typeof code === "string" && codes.has(code)) return true
  }
  return false
}

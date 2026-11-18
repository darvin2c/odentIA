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
  const db = createOwnerDb(url, { max: 1 })
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  console.log("gestoria: migraciones aplicadas")
  process.exit(0)
}

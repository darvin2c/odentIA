import { migrate } from "drizzle-orm/postgres-js/migrator"
import { createOwnerDb } from "./client.js"

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error("DATABASE_URL es obligatoria para migrar (rol owner)")
}

const db = createOwnerDb(url)
await migrate(db, { migrationsFolder: "./drizzle" })
console.log("migrations applied")
process.exit(0)

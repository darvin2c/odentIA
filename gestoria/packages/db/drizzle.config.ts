import { defineConfig } from "drizzle-kit"

// La base de gestorIA, aparte de la de las clínicas (ADR 0203): sus migraciones van solo aquí.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // El dueño de la base: migraciones; no pasa por las reglas de cada tienda.
    url: process.env.GESTORIA_DATABASE_URL ?? "",
  },
})

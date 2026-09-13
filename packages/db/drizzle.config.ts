import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema",
  out: "./drizzle",
  dbCredentials: {
    // Rol owner: migraciones; bypasea RLS.
    url: process.env.DATABASE_URL!,
  },
});

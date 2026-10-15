/**
 * Alta inicial del primer admin.
 *
 * Uso dev (con `--env-file` para entorno local):
 *   pnpm --filter @odentia/api bootstrap:admin -- correo@ejemplo.pe
 * Uso prod (entorno ya exportado, sin .env global):
 *   node --import tsx dist/cli/bootstrap-admin.js correo@ejemplo.pe
 *
 * Explícito y sin atajos: exige cuenta existente con correo verificado y solo
 * procede si no hay ningún admin activo (después, el alta es por invitación).
 * Lee el entorno normal (DATABASE_URL rol owner); jamás bypass en runtime.
 * `--help` o correo inválido salen sin tocar la base.
 */
import { createOwnerDb } from "@odentia/db"
import { bootstrapAdminStaff, normalizeStaffEmail } from "@odentia/services"
import { z } from "zod"

const emailSchema = z.string().trim().email("Correo inválido").max(160)

function usage(): string {
  return [
    "Uso: bootstrap:admin [--help] -- correo@ejemplo.pe",
    "Crea el primer admin a partir de una cuenta existente y verificada.",
  ].join("\n")
}

async function main(): Promise<void> {
  // pnpm reenvía `--` como argv literal: se descarta junto con flags.
  const positionals = process.argv.slice(2).filter((arg) => arg !== "--" && !arg.startsWith("-"))
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage())
    process.exit(0)
  }
  const parsed = emailSchema.safeParse(positionals[0] ?? "")
  if (!parsed.success) {
    console.error(usage())
    process.exit(1)
  }
  const email = normalizeStaffEmail(parsed.data)
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error("DATABASE_URL es obligatoria (rol owner)")
    process.exit(1)
  }
  const ownerDb = createOwnerDb(url)
  try {
    const actor = await bootstrapAdminStaff(ownerDb, email)
    console.log(`Admin inicial: ${actor.userId} (${email}). Enrola tu segundo factor en /security.`)
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
  process.exit(0)
}

void main()

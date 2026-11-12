/**
 * La carga de una clínica nueva desde la skill (ADR 0104), en el servidor de producción:
 * la skill copia el archivo y llama a este comando dentro del contenedor de la API, con
 * su entorno (base owner, almacenamiento y correo). Usa la misma lógica que la
 * administración (`lib/clinic-load.ts`) y deja el mismo registro.
 *
 *   tsx src/cli/carga.ts <orden> <slug> [<archivo>] --como <correo>
 *
 * Órdenes:
 *   ensayo <slug> <clinica.json>            Lo que haría la carga de la configuración, sin guardar.
 *   cargar <slug> <clinica.json>            La carga de la configuración y el correo de las invitaciones.
 *   pacientes-ensayo <slug> <plan.json>     Lo que haría la carga de pacientes, sin guardar.
 *   pacientes-cargar <slug> <plan.json>     La carga de pacientes entera, por tandas.
 *   informe-ver <slug> <informe.json>       A quién va, el asunto, las hojas y si ese número ya salió.
 *   informe-enviar <slug> <informe.json>    El informe por el correo de producción, una sola vez, con su PDF guardado.
 *   informe-registrar <slug> <informe.json> --enviado-el <ISO>
 *                                           Deja en el registro un informe que salió por otra vía.
 *   registro <slug>                         Las cargas y los informes de la clínica.
 *
 * `--como` es el correo de una persona del personal de odentIA con rol de administración:
 * el registro queda a su nombre. Imprime JSON; un error sale con código 1 y su motivo.
 */
import { readFileSync } from "node:fs"
import type { ClinicalProduct } from "@odentia/clinical"
import { createOwnerDb, withOrgContext } from "@odentia/db"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { organization, user } from "@odentia/db/schema/auth"
import { createMailer } from "@odentia/mail"
import {
  type AdminActor,
  clinicImportPlanSchema,
  clinicSetupPlanSchema,
  createStorage,
  listClinicLoads,
  onDomain,
  progressReportSchema,
  ServiceError,
} from "@odentia/services"
import { and, eq } from "drizzle-orm"
import { env } from "../env.js"
import { createClinicLoad } from "../lib/clinic-load.js"

const args = process.argv.slice(2).filter((arg) => arg !== "--")
const flag = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const positionals = args.filter(
  (arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"),
)
const [command, slug, file] = positionals

async function main() {
  const ownerDb = createOwnerDb(env.DATABASE_URL)
  const as = flag("--como")?.trim().toLowerCase()
  if (!command || !slug || !as)
    throw new Error("Uso: carga.ts <orden> <slug> [<archivo>] --como <correo>")

  // Quien carga: personal de odentIA activo con rol de administración.
  const [staff] = await ownerDb
    .select({ userId: user.id, role: adminStaff.role })
    .from(adminStaff)
    .innerJoin(user, eq(user.id, adminStaff.userId))
    .where(and(eq(user.email, as), eq(adminStaff.active, true)))
    .limit(1)
  if (!staff) throw new Error(`${as} no es personal activo de odentIA`)
  const actor: AdminActor = { userId: staff.userId, role: staff.role as AdminActor["role"] }

  const [org] = await ownerDb
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1)
  if (!org) throw new Error(`No hay una clínica con la dirección «${slug}»`)

  const domains = env.productDomains as Partial<Record<ClinicalProduct, string>>
  const load = createClinicLoad({
    ownerDb,
    storage: createStorage({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
      avatarsBucket: env.S3_BUCKET,
      publicBaseUrl: env.S3_PUBLIC_URL,
      attachmentsBucket: env.S3_ATTACHMENTS_BUCKET,
    }),
    mailer: createMailer({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER || undefined,
      pass: env.SMTP_PASS || undefined,
      from: env.SMTP_FROM,
      fromByBrand: {
        ...(env.MEDICAL_SMTP_FROM ? { latidia: env.MEDICAL_SMTP_FROM } : {}),
        ...(env.OPTICAL_SMTP_FROM ? { vistia: env.OPTICAL_SMTP_FROM } : {}),
      },
    }),
    webURL: env.WEB_URL,
    panelUrlOf: (product) => {
      const domain = domains[product]
      return domain ? onDomain(env.WEB_URL, env.COOKIE_DOMAIN, domain) : env.WEB_URL
    },
  })
  const read = () => {
    if (!file) throw new Error("Falta el archivo")
    return JSON.parse(readFileSync(file, "utf-8")) as unknown
  }

  switch (command) {
    case "ensayo":
      return load.rehearseSetup(org.id, actor, clinicSetupPlanSchema.parse(read()))
    case "cargar":
      return load.applySetup(org.id, actor, clinicSetupPlanSchema.parse(read()))
    case "pacientes-ensayo":
      return load.previewPatients(org.id, actor, clinicImportPlanSchema.parse(read()))
    case "pacientes-cargar":
      return load.applyPatients(org.id, actor, clinicImportPlanSchema.parse(read()))
    case "informe-ver": {
      const { pdf, ...shown } = await load.previewReport(
        org.id,
        actor,
        progressReportSchema.parse(read()),
      )
      return { ...shown, bytes: pdf.length }
    }
    case "informe-enviar":
      return load.sendReport(org.id, actor, progressReportSchema.parse(read()))
    case "informe-registrar": {
      const sentAt = flag("--enviado-el")
      if (!sentAt || Number.isNaN(Date.parse(sentAt)))
        throw new Error("--enviado-el va con la fecha ISO en que salió")
      return load.registerReport(
        org.id,
        actor,
        progressReportSchema.parse(read()),
        new Date(sentAt).toISOString(),
      )
    }
    case "registro":
      return {
        loads: await withOrgContext(ownerDb, org.id, (tx) => listClinicLoads(tx, org.id)),
        reports: await load.listReports(org.id, actor),
      }
    default:
      throw new Error(`Orden desconocida: ${command}`)
  }
}

main()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  })
  .catch((error: unknown) => {
    const message =
      error instanceof ServiceError
        ? `${error.message}${error.fields ? ` ${JSON.stringify(error.fields)}` : ""}`
        : error instanceof Error
          ? error.message
          : String(error)
    console.error(JSON.stringify({ error: message }))
    process.exit(1)
  })

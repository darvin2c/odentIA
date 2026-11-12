/**
 * Cargar la configuración de una clínica de odentIA (ADR 0104), con la biblioteca dental: el ensayo no guarda nada,
 * la carga crea con las operaciones de siempre, volver a cargar no duplica y lo de
 * una persona espera a que sea parte de la clínica.
 */
import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { scheduleRoom } from "@odentia/db/schema/agenda"
import { scheduleBlock } from "@odentia/db/schema/availability"
import { agentKnowledgeEntry } from "@odentia/db/schema/agent"
import { invitation, member, user } from "@odentia/db/schema/auth"
import { orgSpecialty, serviceCatalog } from "@odentia/db/schema/clinical"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "../admin-core.js"
import { ClinicSetupRehearsal, runClinicSetup } from "../clinic-setup.js"
import { type ClinicSetupPlanInput, clinicSetupPlanSchema } from "../clinic-setup-plan.js"
import { seedOdentiaCatalog } from "@odentia/db/dental"
import { insertOrg, ownerDb, setupTestDb } from "../test-setup.js"

setupTestDb()

const ORG = "org_setup"
const admin: AdminActor = { userId: "t-setup-admin", role: "admin" }
// De la biblioteca real, con su código CPMS (D0160).
const templateKey = "consulta-odontologica-especializada"

const raw: ClinicSetupPlanInput = {
  kind: "clinica",
  version: 1,
  product: "dental",
  countryCode: "PE",
  clinic: "Dra. Prueba",
  slug: "carga-config",
  identity: {
    tradeName: "Dra. Prueba",
    legalName: "Prueba Dental E.I.R.L.",
    fiscalDocType: "RUC",
    fiscalDocNumber: "20542830752",
    fiscalAddress: "Av. Mariscal José de la Mar 352, Of. 425, Miraflores",
  },
  papers: { budgetValidDays: 180 },
  brand: { color: "#CE6921" },
  branches: [{ key: "principal", name: "Miraflores", addressLine1: "Av. Mariscal José de la Mar 352, Of. 425", district: "Miraflores", city: "Lima", rooms: ["Unidad dental 1"] }],
  services: [
    { template: templateKey, priceCents: 15_000, currency: "PEN" },
    { name: "Ortodoncia con alineadores", specialty: "Ortodoncia de prueba", officialCode: "D8090", priceCents: 300_000, currency: "PEN", priceDisclosure: "desde" },
  ],
  paymentMethods: [{ name: "Plin de prueba", typeCode: "68" }],
  recurringExpenses: [{ key: "internet", branch: "principal", category: "Servicios", concept: "Internet", amountCents: 8_000, everyMonths: 1, day: 5 }],
  knowledge: [{ basicKey: "estacionamiento", body: "Estacionamiento Aparka en el sótano; lo paga el paciente." }],
  team: [
    {
      email: "dra.prueba@example.com",
      name: "Dra. Prueba",
      role: "owner",
      profile: { professionalTitle: "Cirujano dentista", registrationBody: "COP", registrationNumber: "24489" },
      schedule: [{ branch: "principal", weekday: 1, start: "09:30", end: "11:30" }],
      absences: [{ branch: "principal", from: "2026-12-24", to: "2026-12-26", reason: "Fiestas" }],
    },
    { email: "recepcion.prueba@example.com", name: "Recepción", role: "reception" },
    // «Taller» es de vistIA: en odentIA no se invita.
    { email: "taller.prueba@example.com", name: "Taller", role: "workshop" },
  ],
}
const plan = clinicSetupPlanSchema.parse(raw)

const run = (mode: "ensayo" | "carga", actor: AdminActor = admin) =>
  withOrgContext(ownerDb, ORG, (tx: Db) => runClinicSetup(tx, ORG, actor, plan, {}, mode))

const rehearse = async () => {
  try {
    await withOrgContext(ownerDb, ORG, async (tx: Db) => {
      throw new ClinicSetupRehearsal(await runClinicSetup(tx, ORG, admin, plan, {}, "ensayo"))
    })
  } catch (error) {
    if (error instanceof ClinicSetupRehearsal) return error.result
    throw error
  }
  throw new Error("sin resultado")
}

describe("carga de la configuración de una clínica", () => {
  beforeAll(async () => {
    await insertOrg(ownerDb, ORG, "carga-config")
    await ownerDb.insert(user).values({ id: admin.userId, name: "Implementación", email: "implementacion@example.test" }).onConflictDoNothing()
    await seedOdentiaCatalog(ownerDb)
    await ownerDb.insert(orgSpecialty).values({ organizationId: ORG, key: "ortodoncia-prueba", name: "Ortodoncia de prueba" })
  })

  it("solo administración carga", async () => {
    await expect(run("ensayo", { userId: admin.userId, role: "support" } as AdminActor)).rejects.toMatchObject({ status: 403 })
  })

  it("el ensayo dice lo que haría y no guarda nada", async () => {
    const result = await rehearse()
    const byLabel = (text: string) => result.items.find((item) => item.label.includes(text))
    expect(byLabel("Miraflores")?.status).toBe("nueva")
    expect(byLabel("Consulta odontológica especializada")?.status).toBe("nueva")
    expect(byLabel("Ortodoncia con alineadores")).toMatchObject({ status: "nueva", detail: "Servicio propio (excepción)" })
    expect(byLabel("Estacionamiento")?.status).toBe("nueva")
    expect(byLabel("recepcion.prueba@example.com")?.status).toBe("nueva")
    // La propietaria no es parte todavía: su perfil y su horario esperan.
    expect(result.items.find((item) => item.area === "Profesionales")).toMatchObject({ status: "espera" })
    expect(byLabel("taller.prueba@example.com")).toMatchObject({ status: "error", detail: "«workshop» no es un rol de este producto" })
    expect(result.totals.error).toBe(1)
    const branches = await ownerDb.select().from(branch).where(eq(branch.organizationId, ORG))
    expect(branches).toHaveLength(0)
  })

  it("la carga crea con las operaciones de siempre y volver a cargar no duplica", async () => {
    const first = await run("carga")
    expect(first.totals.error).toBe(1)
    expect(first.invitations.map((i) => i.email)).toEqual(["recepcion.prueba@example.com"])
    const [profile] = await ownerDb.select().from(orgProfile).where(eq(orgProfile.organizationId, ORG))
    expect(profile).toMatchObject({ tradeName: "Dra. Prueba", fiscalDocNumber: "20542830752", budgetValidDays: 180, brandColor: "#ce6921" })
    const [site] = await ownerDb.select().from(branch).where(eq(branch.organizationId, ORG))
    const rooms = await ownerDb.select().from(scheduleRoom).where(eq(scheduleRoom.branchId, site!.id))
    // La sede nace con su «Unidad dental 1»: no se crea otra igual.
    expect(rooms.map((r) => r.name)).toEqual(["Unidad dental 1"])
    const services = await ownerDb.select().from(serviceCatalog).where(eq(serviceCatalog.organizationId, ORG))
    expect(services).toHaveLength(2)
    expect(services.find((s) => s.name === "Ortodoncia con alineadores")?.priceDisclosure).toBe("desde")
    const [entry] = await ownerDb.select().from(agentKnowledgeEntry).where(eq(agentKnowledgeEntry.organizationId, ORG))
    expect(entry).toMatchObject({ basicKey: "estacionamiento", status: "publicada" })

    const again = await run("carga")
    expect(again.invitations).toHaveLength(0)
    expect(again.items.filter((item) => item.status === "nueva")).toEqual([])
    expect(await ownerDb.select().from(serviceCatalog).where(eq(serviceCatalog.organizationId, ORG))).toHaveLength(2)
    expect(await ownerDb.select().from(invitation).where(eq(invitation.organizationId, ORG))).toHaveLength(1)
  })

  it("lo de la propietaria se carga cuando ya es parte de la clínica", async () => {
    const id = `t-dra-${randomUUID()}`
    await ownerDb.insert(user).values({ id, name: "Dra. Prueba", email: "dra.prueba@example.com" })
    await ownerDb.insert(member).values({ id: randomUUID(), organizationId: ORG, userId: id, role: "owner", createdAt: new Date() })
    const result = await run("carga")
    const professional = result.items.filter((item) => item.area === "Profesionales")
    expect(professional.map((item) => item.status)).toEqual(["cambia", "cambia", "nueva"])
    expect(result.totals.espera).toBe(0)
    // La ausencia va de 00:00 a 23:59 en Lima (UTC−5), no en la hora del servidor.
    const [block] = await ownerDb.select().from(scheduleBlock).where(eq(scheduleBlock.organizationId, ORG))
    expect(block?.startsAt.toISOString()).toBe("2026-12-24T05:00:00.000Z")
    expect(block?.endsAt.toISOString()).toBe("2026-12-27T04:59:00.000Z")
    // Volver a cargar no la repite.
    const again = await run("carga")
    expect(again.items.filter((item) => item.area === "Profesionales").at(-1)?.status).toBe("igual")
  })
})

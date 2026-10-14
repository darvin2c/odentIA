import { withOrgContext } from "@odentia/db"
import { agentSearchItem } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { professionalSchedule, scheduleBlock } from "@odentia/db/schema/availability"
import { orgSpecialty, professionalSpecialty } from "@odentia/db/schema/clinical-forms"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import {
  formatAgentClinicData,
  formatAgentPrice,
  getAgentClinicData,
  getBranchHours,
  listAgentProfessionals,
  listAgentServices,
  SERVICES_IN_PROMPT,
  searchClinic,
} from "./agent-clinic-info.js"
import { rankByMeaning, refreshAgentSearch, type SearchEmbedder, syncSearchItems } from "./agent-search-index.js"
import { createPromotion } from "./promotions.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

/** Lo que sabe «Informar» y la búsqueda por significado (ADR 0021). */
const ORG = "org_info"
const ZONE = { locale: "es-PE", timezone: "America/Lima" }
const run = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, ORG, fn)

let branchId = ""
let dentist = ""
const ids: Record<string, string> = {}

beforeAll(async () => {
  await insertOrg(ownerDb, ORG, "org-info")
  const [sede] = await ownerDb
    .insert(branch)
    .values({ organizationId: ORG, name: "Centro", timezone: "America/Lima" })
    .returning({ id: branch.id })
  branchId = sede!.id
  dentist = `info-dentist-${Date.now()}`
  await ownerDb.insert(user).values({ id: dentist, name: "Dra. Ríos", email: `${dentist}@example.test` })
  await ownerDb.insert(member).values({ id: `m-${dentist}`, organizationId: ORG, userId: dentist, role: "dentist", createdAt: new Date() })
  // Dos turnos el lunes que se tocan y uno el sábado: el horario de la sede los une.
  await ownerDb.insert(professionalSchedule).values([
    { organizationId: ORG, branchId, dentistUserId: dentist, weekday: 1, startMin: 540, endMin: 780 },
    { organizationId: ORG, branchId, dentistUserId: dentist, weekday: 1, startMin: 780, endMin: 1080 },
    { organizationId: ORG, branchId, dentistUserId: dentist, weekday: 6, startMin: 540, endMin: 840 },
  ])
  const [specialty] = await ownerDb
    .insert(orgSpecialty)
    .values({ organizationId: ORG, key: "ortodoncia", name: "Ortodoncia" })
    .returning({ id: orgSpecialty.id })
  await ownerDb.insert(professionalSpecialty).values({ organizationId: ORG, specialtyId: specialty!.id, userId: dentist })
  const services = await ownerDb
    .insert(serviceCatalog)
    .values([
      { organizationId: ORG, name: "Evaluación", specialty: "diagnostico", scope: "general", source: "custom", priceCents: 5000, currency: "PEN", priceDisclosure: "exacto" },
      { organizationId: ORG, name: "Limpieza dental", specialty: "prevencion", scope: "general", source: "custom", priceCents: 12000, currency: "PEN", priceDisclosure: "exacto" },
      { organizationId: ORG, name: "Ortodoncia con brackets", specialty: "ortodoncia", scope: "general", source: "custom", priceCents: 250000, currency: "PEN", priceDisclosure: "desde" },
      { organizationId: ORG, name: "Implante dental", specialty: "implantes", scope: "tooth", source: "custom", priceCents: 300000, currency: "PEN", priceDisclosure: "evaluacion" },
      { organizationId: ORG, name: "Blanqueamiento dental", specialty: "estetica", scope: "arch", source: "custom", priceCents: 50000, currency: "PEN", priceDisclosure: "exacto" },
    ])
    .returning({ id: serviceCatalog.id, name: serviceCatalog.name })
  for (const row of services) ids[row.name] = row.id
  await ownerDb
    .update(serviceCatalog)
    .set({ evaluationServiceId: ids["Evaluación"] })
    .where(eq(serviceCatalog.id, ids["Ortodoncia con brackets"]!))
})

describe("lo que sabe Informar", () => {
  it("el horario de la sede es la suma de los turnos del equipo y avisa sus cierres", async () => {
    const now = new Date()
    await ownerDb.insert(scheduleBlock).values({
      organizationId: ORG,
      branchId,
      reason: "Feriado",
      startsAt: new Date(now.getTime() + 2 * 86_400_000),
      endsAt: new Date(now.getTime() + 3 * 86_400_000),
    })
    const [centro] = await run((tx) => getBranchHours(tx, ORG, now))
    expect(centro?.week).toEqual([
      { weekday: 1, ranges: [[540, 1080]] },
      { weekday: 6, ranges: [[540, 840]] },
    ])
    expect(centro?.closures).toHaveLength(1)
    expect(centro?.closures[0]?.reason).toBe("Feriado")
  })

  it("los profesionales con su especialidad y sus días; sin más datos de la persona", async () => {
    const pros = await run((tx) => listAgentProfessionals(tx, ORG))
    expect(pros).toEqual([{ id: dentist, name: "Dra. Ríos", specialties: ["Ortodoncia"], where: [{ branchName: "Centro", weekdays: [1, 6] }] }])
  })

  it("cada precio se dice como la clínica lo eligió; con evaluación no llega ningún número", async () => {
    const services = await run((tx) => listAgentServices(tx, ORG))
    const said = (name: string) => formatAgentPrice(services.find((s) => s.name === name)!.price, ZONE)
    expect(said("Limpieza dental")).toMatch(/^S\/\s?120\.00$/)
    expect(said("Ortodoncia con brackets")).toMatch(/^desde S\/\s?2,500\.00 \(es un mínimo/)
    expect(said("Ortodoncia con brackets")).toContain("Ofrece la evaluación: Evaluación")
    const implant = said("Implante dental")
    expect(implant).toContain("no digas ningún monto")
    expect(implant).not.toMatch(/3,000|3000/)
  })

  it("una clínica chica entra entera en el prompt; una grande pide buscar", async () => {
    const small = formatAgentClinicData(await run((tx) => getAgentClinicData(tx, ORG, true)), ZONE)
    expect(small.join("\n")).toContain("Limpieza dental")
    expect(small.join("\n")).toContain("sábado 09:00–14:00")
    const big = formatAgentClinicData(
      {
        hours: [],
        professionals: [],
        promotions: [],
        services: Array.from({ length: SERVICES_IN_PROMPT + 1 }, (_, i) => ({
          id: `s${i}`,
          name: `Servicio ${i}`,
          specialty: null,
          durationMin: null,
          price: { disclosure: "exacto" as const, priceCents: 100, currency: "PEN", evaluation: null },
        })),
      },
      ZONE,
    )
    expect(big.join("\n")).toContain("búscalo con buscar_en_la_clinica")
    expect(big.join("\n")).not.toContain("Servicio 0")
    // Con «Informar» apagado solo van los horarios.
    const off = await run((tx) => getAgentClinicData(tx, ORG, false))
    expect(off.services).toEqual([])
    expect(off.hours).toHaveLength(1)
  })

  it("la promoción trae precio, condiciones y fin; vencida o futura no aparece", async () => {
    const now = Date.now()
    const ortho = ids["Ortodoncia con brackets"]!
    await run((tx) =>
      createPromotion(tx, ORG, dentist, {
        name: "Sonrisa de primavera",
        startsAt: new Date(now - 86_400_000).toISOString(),
        endsAt: new Date(now + 20 * 86_400_000).toISOString(),
        conditions: "Solo pacientes nuevos",
        items: [{ serviceId: ids["Limpieza dental"]!, mode: "fixed", priceCents: 9000 }, { serviceId: ortho, mode: "from", priceCents: 200000 }],
      }),
    )
    await run((tx) =>
      createPromotion(tx, ORG, dentist, {
        name: "Promo vencida",
        startsAt: new Date(now - 30 * 86_400_000).toISOString(),
        endsAt: new Date(now - 2 * 86_400_000).toISOString(),
        items: [{ serviceId: ids["Limpieza dental"]!, mode: "fixed", priceCents: 5000 }],
      }),
    )
    const text = formatAgentClinicData(await run((tx) => getAgentClinicData(tx, ORG, true)), ZONE).join("\n")
    expect(text).toContain("Sonrisa de primavera")
    expect(text).toMatch(/Limpieza dental: S\/\s?90\.00 en vez de S\/\s?120\.00/)
    expect(text).toMatch(/Ortodoncia con brackets: desde S\/\s?2,000\.00/)
    expect(text).toContain("Condiciones: Solo pacientes nuevos.")
    expect(text).toContain("Vigente hasta el")
    expect(text).not.toContain("Promo vencida")
  })

  it("buscar por palabras encuentra servicio, su promoción y quien lo atiende", async () => {
    const found = await run((tx) => searchClinic(tx, ORG, "cuánto cuesta la ortodoncia"))
    expect(found.services.map((s) => s.name)).toEqual(["Ortodoncia con brackets"])
    expect(found.promotions.map((p) => p.name)).toEqual(["Sonrisa de primavera"])
    expect(found.professionals.map((p) => p.name)).toEqual(["Dra. Ríos"])
  })
})

describe("búsqueda por significado", () => {
  /**
   * Doble con «significado» de juguete: dos ejes, estética y ortodoncia. Basta
   * para probar que el orden por vector manda; no mide a ningún proveedor.
   */
  const toy: SearchEmbedder = {
    model: "juguete-2",
    async embed(texts) {
      return texts.map((text) => {
        const t = text.toLowerCase()
        const estetica = /blanque|amarill|estetic/.test(t) ? 1 : 0
        const orto = /ortodon|bracket|frenill/.test(t) ? 1 : 0
        return estetica || orto ? [estetica, orto] : [0.01, 0.01]
      })
    },
  }

  it("el índice guarda solo texto descriptivo y se concilia con lo que cambia", async () => {
    await run((tx) => syncSearchItems(tx, ORG))
    const rows = await run((tx) => tx.select().from(agentSearchItem).where(eq(agentSearchItem.organizationId, ORG)))
    expect(rows.some((row) => row.kind === "servicio" && row.text.startsWith("Servicio de la clínica: Blanqueamiento dental.") && row.text.includes("apariencia de la sonrisa"))).toBe(true)
    // Nunca precios en el texto.
    expect(rows.every((row) => !/\d{3,}/.test(row.text))).toBe(true)
    await ownerDb.update(serviceCatalog).set({ isActive: false }).where(eq(serviceCatalog.id, ids["Implante dental"]!))
    await run((tx) => syncSearchItems(tx, ORG))
    const after = await run((tx) => tx.select().from(agentSearchItem).where(eq(agentSearchItem.refId, ids["Implante dental"]!)))
    expect(after).toEqual([])
  })

  it("«dientes amarillos» encuentra el blanqueamiento y lo dice con su precio leído al momento", async () => {
    const summary = await refreshAgentSearch(ownerDb, appDb, toy)
    expect(summary.failed).toBe(0)
    const [query] = await toy.embed(["tengo los dientes amarillos"])
    const ranked = await run((tx) => rankByMeaning(tx, ORG, { model: toy.model, embedding: query! }))
    expect(ranked.services[0]).toBe(ids["Blanqueamiento dental"])
    // Por palabras no lo encuentra; con el orden por significado, sí.
    const byWords = await run((tx) => searchClinic(tx, ORG, "tengo los dientes amarillos"))
    expect(byWords.services).toEqual([])
    const byMeaning = await run((tx) =>
      searchClinic(tx, ORG, "tengo los dientes amarillos", { rankedServiceIds: ranked.services }),
    )
    expect(byMeaning.services[0]?.name).toBe("Blanqueamiento dental")
    // El precio sale de la tabla: cambiarlo no exige volver a vectorizar.
    await ownerDb.update(serviceCatalog).set({ priceCents: 55000 }).where(eq(serviceCatalog.id, ids["Blanqueamiento dental"]!))
    const again = await run((tx) => searchClinic(tx, ORG, "x", { rankedServiceIds: ranked.services }))
    expect(formatAgentPrice(again.services[0]!.price, ZONE)).toMatch(/550\.00/)
  })

  it("un vector de otro modelo no se compara; el proveedor que falla deja buscar por palabras", async () => {
    const [query] = await toy.embed(["frenillos"])
    const other = await run((tx) => rankByMeaning(tx, ORG, { model: "otro-modelo", embedding: query! }))
    expect(other.services).toEqual([])
    const broken: SearchEmbedder = { model: "roto", embed: async () => Promise.reject(new Error("caído")) }
    const summary = await refreshAgentSearch(ownerDb, appDb, broken)
    expect(summary.embedded).toBe(0)
    expect(summary.failed).toBeGreaterThan(0)
  })
})

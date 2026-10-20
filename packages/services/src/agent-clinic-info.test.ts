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
  type AgentServiceInfo,
  asksPriceOrAvailability,
  CLINIC_SEARCH_LIMIT,
  formatAgentClinicData,
  formatAgentPrice,
  formatClinicSearch,
  getAgentClinicData,
  identifyAskedService,
  getBranchHours,
  listAgentProfessionals,
  listAgentServices,
  resolveProfessionalRef,
  SERVICES_IN_PROMPT,
  searchClinic,
} from "./agent-clinic-info.js"
import { rankByMeaning, refreshAgentSearch, type SearchEmbedder, syncSearchItems } from "./agent-search-index.js"
import { createPromotion } from "./promotions.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

/** Servicios inventados: alternan prótesis y endodoncia, con precio exacto. */
function many(count: number): AgentServiceInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    ...service(`Servicio ${i}`),
    id: `s${i}`,
    // El nombre que la clínica le da a su especialidad: el índice lo dice tal cual.
    specialty: i % 2 === 0 ? "Prótesis" : "Endodoncia",
    kind: i % 2 === 0 ? "protesis" : "endodoncia",
  }))
}

function service(name: string): AgentServiceInfo {
  return {
    id: `id-${name}`,
    name,
    specialty: null,
    kind: null,
    durationMin: null,
    price: { disclosure: "exacto", priceCents: 100, currency: "PEN", evaluation: null },
  }
}

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
    // La del país (ADR 0067), renombrada por la clínica: el agente dice el nombre de la clínica.
    .values({ organizationId: ORG, key: "ortodoncia_ortopedia_maxilar", name: "Ortodoncia y frenillos" })
    .returning({ id: orgSpecialty.id })
  await ownerDb.insert(professionalSpecialty).values({ organizationId: ORG, specialtyId: specialty!.id, userId: dentist })
  // Renombrada por la clínica: las palabras de la calle siguen al tipo de la especialidad del país.
  const [aesthetic] = await ownerDb
    .insert(orgSpecialty)
    .values({ organizationId: ORG, key: "restauradora_estetica", name: "Sonrisa y estética" })
    .returning({ id: orgSpecialty.id })
  const services = await ownerDb
    .insert(serviceCatalog)
    .values([
      { organizationId: ORG, name: "Evaluación", scope: "general", source: "custom", priceCents: 5000, currency: "PEN", priceDisclosure: "exacto" },
      { organizationId: ORG, name: "Limpieza dental", scope: "general", source: "custom", priceCents: 12000, currency: "PEN", priceDisclosure: "exacto" },
      { organizationId: ORG, name: "Ortodoncia con brackets", specialtyId: specialty!.id, scope: "general", source: "custom", priceCents: 250000, currency: "PEN", priceDisclosure: "desde" },
      { organizationId: ORG, name: "Implante dental", scope: "tooth", source: "custom", priceCents: 300000, currency: "PEN", priceDisclosure: "evaluacion" },
      { organizationId: ORG, name: "Blanqueamiento dental", specialtyId: aesthetic!.id, scope: "arch", source: "custom", priceCents: 50000, currency: "PEN", priceDisclosure: "exacto" },
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
    expect(pros).toEqual([
      {
        id: dentist,
        ref: expect.stringMatching(/^pro-[0-9a-f]{10}$/),
        name: "Dra. Ríos",
        specialties: ["Ortodoncia y frenillos"],
        where: [{ branchName: "Centro", weekdays: [1, 6] }],
      },
    ])
    // Lo que lee el modelo: su identificador solo para pedir sus huecos, nunca su usuario.
    const line = formatAgentClinicData({ hours: [], professionals: pros, promotions: [], services: [], informs: true }, ZONE).join("\n")
    expect(line).toContain(`profesional ${pros[0]!.ref}`)
    expect(line).not.toContain(dentist)
    expect(await run((tx) => resolveProfessionalRef(tx, ORG, pros[0]!.ref))).toBe(dentist)
    expect(await run((tx) => resolveProfessionalRef(tx, ORG, "pro-0000000000"))).toBeNull()
  })

  it("cada precio se dice como la clínica lo eligió; con evaluación no llega ningún número", async () => {
    const services = await run((tx) => listAgentServices(tx, ORG))
    const said = (name: string) => formatAgentPrice(services.find((s) => s.name === name)!.price, ZONE)
    expect(said("Limpieza dental")).toMatch(/^S\/\s?120\.00$/)
    expect(said("Ortodoncia con brackets")).toMatch(/^desde S\/\s?2,500\.00 \(es un mínimo/)
    expect(said("Ortodoncia con brackets")).toContain("Ofrece la evaluación: Evaluación")
    // El servicio dice la especialidad de la clínica, con su nombre, y el tipo de la del país.
    const ortho = services.find((s) => s.name === "Ortodoncia con brackets")!
    expect(ortho.specialty).toBe("Ortodoncia y frenillos")
    expect(ortho.kind).toBe("ortodoncia")
    const implant = said("Implante dental")
    expect(implant).toContain("no digas ningún monto")
    expect(implant).not.toMatch(/3,000|3000/)
  })

  it("una clínica chica entra entera en el prompt; una grande lleva su índice y pide buscar", async () => {
    const small = formatAgentClinicData(await run((tx) => getAgentClinicData(tx, ORG, true)), ZONE)
    expect(small.join("\n")).toContain("Limpieza dental")
    expect(small.join("\n")).toContain("sábado 09:00–14:00")
    const big = formatAgentClinicData({ hours: [], professionals: [], promotions: [], services: many(SERVICES_IN_PROMPT + 1), informs: true }, ZONE)
    const text = big.join("\n")
    expect(text).toContain(`la clínica tiene ${SERVICES_IN_PROMPT + 1} y aquí va solo su índice por especialidad, sin precios ni ids`)
    expect(text).toContain("búscalo con buscar_en_la_clinica")
    // El índice: «Especialidad: servicio, servicio…», sin precio ni id.
    expect(text).toContain("- Prótesis: Servicio 0, Servicio 2,")
    expect(text).toContain("- Endodoncia: Servicio 1, Servicio 3,")
    expect(text).not.toMatch(/\(id s\d+\)/)
    expect(text).not.toMatch(/S\/\s?1\.00/)
    expect(text).not.toContain("Sin servicios publicados")
    // Con «Informar» apagado van los horarios y, para agendar, los servicios sin precio.
    const off = await run((tx) => getAgentClinicData(tx, ORG, false))
    expect(off.hours).toHaveLength(1)
    expect(off.promotions).toEqual([])
    expect(off.professionals).toEqual([])
    const offText = formatAgentClinicData(off, ZONE).join("\n")
    expect(offText).toContain("Servicios, solo para agendar")
    expect(offText).toMatch(/- Limpieza dental \(id [0-9a-f-]{36}\)/)
    expect(offText).not.toMatch(/S\/\s?\d/)
    // Nunca dice que no hay servicios cuando los hay: con Agendar también apagado, simplemente no los nombra.
    expect(offText).not.toContain("Sin servicios publicados")
    const neither = await run((tx) => getAgentClinicData(tx, ORG, false, false))
    expect(neither.services).toEqual([])
    expect(formatAgentClinicData(neither, ZONE).join("\n")).not.toContain("ervicios")
  })

  it("la búsqueda dice cuántos más coinciden; el servicio por el que pregunta se identifica solo sin empate", () => {
    const services = many(CLINIC_SEARCH_LIMIT + 3)
    const text = formatClinicSearch(
      { services: services.slice(0, CLINIC_SEARCH_LIMIT), promotions: [], professionals: [], more: { services: 3, promotions: 0, professionals: 0 } },
      ZONE,
    )
    expect(text).toContain("Y 3 servicios más que también coinciden y no van aquí")
    const catalog: AgentServiceInfo[] = [
      service("Blanqueamiento dental"), service("Limpieza dental (profilaxis)"), service("Prótesis total superior"), service("Prótesis total inferior"),
    ]
    expect(identifyAskedService("¿cuánto cuesta el blanqueamiento?", catalog)?.name).toBe("Blanqueamiento dental")
    expect(identifyAskedService("quiero una limpieza dental", catalog)?.name).toBe("Limpieza dental (profilaxis)")
    // «Prótesis total» casa con dos: no hay uno solo, no se anota nada.
    expect(identifyAskedService("cuánto sale una prótesis total", catalog)).toBeNull()
    expect(identifyAskedService("hola, buenos días", catalog)).toBeNull()
    expect(asksPriceOrAvailability("¿cuánto cuesta el blanqueamiento?")).toBe(true)
    expect(asksPriceOrAvailability("¿tienen cita el viernes para limpieza?")).toBe(true)
    expect(asksPriceOrAvailability("gracias por la atención")).toBe(false)
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
        items: [
          { serviceId: ids["Limpieza dental"]!, mode: "fixed", priceCents: 9000 },
          { serviceId: ortho, mode: "from", priceCents: 200000 },
          // Precio fijo en la promoción de un servicio que se dice «solo con evaluación».
          { serviceId: ids["Implante dental"]!, mode: "fixed", priceCents: 250000 },
        ],
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
    // La promoción no delata la tarifa de un servicio que se dice «solo con evaluación».
    expect(text).toMatch(/Implante dental: S\/\s?2,500\.00 con la promoción/)
    expect(text).not.toMatch(/3,000/)
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
    expect(rows.some((row) => row.kind === "servicio" && row.text.startsWith("Servicio de la clínica: Blanqueamiento dental. Especialidad: Sonrisa y estética.") && row.text.includes("Para: curación de caries"))).toBe(true)
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

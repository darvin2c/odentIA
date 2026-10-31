import { seedCatalog } from "@odentia/db/products"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { agentKnowledgeEntry } from "@odentia/db/schema/agent"
import { appointment } from "@odentia/db/schema/agenda"
import { member, organization, user } from "@odentia/db/schema/auth"
import { encounter, encounterDiagnosis, patient, patientContact, serviceCatalog } from "@odentia/db/schema/clinical"
import { conversation } from "@odentia/db/schema/crm"
import { commissionSettlement } from "@odentia/db/schema/finance"
import { purchaseOrder, stockMovement } from "@odentia/db/schema/inventory"
import { opportunity } from "@odentia/db/schema/opportunities"
import { orgProfile, patientRegistrationConfig } from "@odentia/db/schema/org"
import { saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, eq, inArray, like, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { listOrganizations } from "./admin-organizations.js"
import { seedDiagnosisCodes } from "./clinical-test-fixture.js"
import { advanceDemo, buildDemo, demoUserPrefix, purgeDemoOrganization } from "./demo-build.js"
import { listProducts } from "./inventory.js"
import { getPromotionMetrics, listPromotions } from "./promotions.js"
import { createSaasPlan } from "./saas-billing.js"
import { getClinicCostMargin } from "./saas-cost.js"
import {
  claimPendingDemo,
  deleteDemo,
  expiredDemos,
  failStaleDemos,
  getDemoOfOrganization,
  listDemos,
  markDemoOpened,
  requestDemo,
  resetDemo,
} from "./saas-demos.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Las demos para presentar (ADR 0096): pedirlas, armarlas, ponerlas al día y borrarlas, y nunca una clínica real. */
setupTestDb()
const admin = { userId: "demos-admin", role: "admin" as const }
const support = { userId: "demos-support", role: "support" as const }
const DAY = 86_400_000

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ana Administración", email: "admin@demos.test" },
    { id: support.userId, name: "Sol Soporte", email: "support@demos.test" },
  ])
  await ownerDb.insert(adminStaff).values([
    { userId: admin.userId, role: "admin" },
    { userId: support.userId, role: "support" },
  ])
  await seedCatalog(ownerDb)
  // Los diagnósticos de las recetas, como los carga producción (la CIE-11 oficial).
  await seedDiagnosisCodes(
    [
      "CA00",
      "CA02.Z",
      "CA03.Z",
      "1A40.Z",
      "AB00",
      "CA41.0",
      "5B5K.0",
      "QA00.Z",
      "QA00.0",
      "DA08.0",
      "DA09.0",
      "DA0A.1",
      "DA0B.1",
      "DA0E.3",
      "QA00.8",
    ].map((code) => ({ code, title: code })),
    "ICD-11",
  )
  for (const product of ["dental", "medical"] as const) {
    await createSaasPlan(ownerDb, admin.userId, {
      code: `demos-${product}`,
      name: `Plan ${product}`,
      product,
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      consultationMicros: 400_000,
      recoveryMicros: 4_000_000,
      trialCreditCents: 10_000,
      trialMaxCreditCents: 10_000,
      trialDays: 30,
      isDefault: true,
      showOnWeb: false,
    })
  }
})

const pediatria = {
  product: "medical" as const,
  kind: "pediatria",
  size: "pequeno" as const,
  months: 6,
  countryCode: "CO",
  name: "Pediatría Los Olivos",
  presenterUserId: admin.userId,
}

async function build(id: string) {
  const [row] = await ownerDb.select().from(saasDemo).where(eq(saasDemo.id, id))
  if (!row) throw new Error("falta la demo")
  const built = await ownerDb.transaction((tx) =>
    buildDemo(
      tx,
      { ...row, product: row.product as "medical" | "dental", size: row.size as "pequeno" },
      { secretsKey: Buffer.alloc(32, 3), fetch },
    ),
  )
  await ownerDb
    .update(saasDemo)
    .set({
      organizationId: built.organizationId,
      status: "lista",
      historyThrough: built.historyThrough,
      readyAt: new Date(),
    })
    .where(eq(saasDemo.id, id))
  return { ...row, organizationId: built.organizationId, historyThrough: built.historyThrough }
}

describe("pedir una demo", () => {
  it("solo la administración la pide; soporte no", async () => {
    await expect(requestDemo(ownerDb, support, pediatria)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("su dirección sale del nombre, sin «demo», y lleva un número si ya existe", async () => {
    const first = await requestDemo(ownerDb, admin, {
      ...pediatria,
      name: "Ortodoncia Bravo",
      product: "dental",
      kind: "ortodoncia",
    })
    const second = await requestDemo(ownerDb, admin, {
      ...pediatria,
      name: "Ortodoncia  Bravo",
      product: "dental",
      kind: "ortodoncia",
    })
    expect(first.slug).toBe("ortodoncia-bravo")
    expect(second.slug).toBe("ortodoncia-bravo-2")
    await ownerDb.delete(saasDemo).where(inArray(saasDemo.id, [first.id, second.id]))
  })

  it("rechaza un tipo de otro producto y a quien no es del equipo de la administración", async () => {
    await expect(
      requestDemo(ownerDb, admin, { ...pediatria, kind: "ortodoncia" }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(
      requestDemo(ownerDb, admin, { ...pediatria, presenterUserId: "nadie" }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("el worker toma la pendiente más antigua, y la que deja de latir queda fallida", async () => {
    const asked = await requestDemo(ownerDb, admin, {
      ...pediatria,
      name: "Consultorio que se corta",
    })
    const claimed = await ownerDb.transaction((tx) => claimPendingDemo(tx))
    expect(claimed?.id).toBe(asked.id)
    expect(claimed?.status).toBe("creando")
    expect(await ownerDb.transaction((tx) => claimPendingDemo(tx))).toBeNull()
    await ownerDb
      .update(saasDemo)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(saasDemo.id, asked.id))
    expect(await ownerDb.transaction((tx) => failStaleDemos(tx))).toBe(1)
    const [failed] = await ownerDb.select().from(saasDemo).where(eq(saasDemo.id, asked.id))
    expect(failed).toMatchObject({ status: "fallida", error: "Se cortó mientras se armaba" })
    await ownerDb.delete(saasDemo).where(eq(saasDemo.id, asked.id))
  })
})

describe("una demo de Pediatría en Colombia", () => {
  let demo: Awaited<ReturnType<typeof build>>

  beforeAll(async () => {
    const asked = await requestDemo(ownerDb, admin, pediatria)
    demo = await build(asked.id)
  }, 180_000)

  it("es una clínica de latidIA de Colombia, sin cobro, y la presenta quien se eligió", async () => {
    const [profile] = await ownerDb
      .select()
      .from(orgProfile)
      .where(eq(orgProfile.organizationId, demo.organizationId))
    expect(profile).toMatchObject({
      product: "medical",
      countryCode: "CO",
      currency: "COP",
      timezone: "America/Bogota",
      diagnosisSystem: "ICD-11",
    })
    const [sub] = await ownerDb
      .select()
      .from(saasSubscription)
      .where(eq(saasSubscription.organizationId, demo.organizationId))
    expect(sub?.isDemo).toBe(true)
    // Muestra lo que hicieron los agentes con el plan de su producto, pero nunca se cobra.
    const margin = await getClinicCostMargin(ownerDb, demo.organizationId)
    expect(margin).toMatchObject({ demo: true, chargedCents: 0, marginPct: null })
    const owners = await ownerDb
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, demo.organizationId), eq(member.role, "owner")))
    expect(owners.map((row) => row.userId)).toEqual([admin.userId])
    // El resto del equipo es inventado: correos de example.com y sin cuenta.
    const team = await ownerDb
      .select({ email: user.email })
      .from(user)
      .where(like(user.id, `${demoUserPrefix(demo.id)}%`))
    expect(team.length).toBeGreaterThan(0)
    expect(team.every((row) => row.email.endsWith("@example.com"))).toBe(true)
  })

  it("Sofi dice el precio de sus servicios y puede mandar el enlace con registro a quien es nuevo", async () => {
    // Auditoría del 27-oct (ADR 0097): con «solo tras evaluación» Sofi no decía ni el
    // precio de la consulta, y sin registro en línea pasaba a recepción a todo el que llegaba.
    const disclosures = await ownerDb
      .selectDistinct({ disclosure: serviceCatalog.priceDisclosure })
      .from(serviceCatalog)
      .where(eq(serviceCatalog.organizationId, demo.organizationId))
    expect(disclosures).toEqual([{ disclosure: "exacto" }])
    const [registration] = await ownerDb
      .select({ enabled: patientRegistrationConfig.enabled, notice: patientRegistrationConfig.privacyNotice })
      .from(patientRegistrationConfig)
      .where(eq(patientRegistrationConfig.organizationId, demo.organizationId))
    expect(registration?.enabled).toBe(true)
    expect(registration?.notice).toContain("usará tus datos")
  })

  it("cada niño es su propia historia y quien escribe es su responsable", async () => {
    const [patients] = await ownerDb
      .select({ n: sql<number>`count(*)::int` })
      .from(patient)
      .where(eq(patient.organizationId, demo.organizationId))
    const [guardians] = await ownerDb
      .select({ n: sql<number>`count(*)::int` })
      .from(patientContact)
      .where(
        and(
          eq(patientContact.organizationId, demo.organizationId),
          eq(patientContact.relationship, "guardian"),
          eq(patientContact.isPreferred, true),
        ),
      )
    expect(patients?.n ?? 0).toBeGreaterThan(30)
    expect(guardians?.n).toBe(patients?.n)
  })

  it("trae historia con diagnósticos CIE-11 y signos vitales, y agenda hasta dentro de dos semanas", async () => {
    const [closed] = await ownerDb
      .select({ n: sql<number>`count(*)::int` })
      .from(encounter)
      .where(
        and(
          eq(encounter.organizationId, demo.organizationId),
          eq(encounter.status, "finalizada"),
          sql`${encounter.vitals} is not null`,
        ),
      )
    expect(closed?.n ?? 0).toBeGreaterThan(50)
    const [diagnosed] = await ownerDb
      .select({ n: sql<number>`count(*)::int` })
      .from(encounterDiagnosis)
      .where(
        and(
          eq(encounterDiagnosis.organizationId, demo.organizationId),
          eq(encounterDiagnosis.diagnosisSystem, "ICD-11"),
        ),
      )
    expect(diagnosed?.n ?? 0).toBeGreaterThan(50)
    const [ahead] = await ownerDb
      .select({ n: sql<number>`count(*)::int` })
      .from(appointment)
      .where(
        and(
          eq(appointment.organizationId, demo.organizationId),
          sql`${appointment.startsAt} > now() + interval '10 days'`,
          inArray(appointment.status, ["programada", "confirmada"]),
        ),
      )
    expect(ahead?.n ?? 0).toBeGreaterThan(0)
    const [open] = await ownerDb
      .select({ n: sql<number>`count(*)::int` })
      .from(conversation)
      .where(
        and(
          eq(conversation.organizationId, demo.organizationId),
          sql`${conversation.status} <> 'closed'`,
        ),
      )
    expect(open?.n ?? 0).toBeGreaterThan(0)
  })

  it("la ficha dice lo que tiene hoy para mostrar", async () => {
    const detail = await getDemoOfOrganization(ownerDb, demo.organizationId)
    expect(detail).toMatchObject({
      kindName: "Pediatría",
      countryName: "Colombia",
      status: "lista",
    })
    expect(detail?.showcase?.controlsLabel).toBe("Control de niño sano")
    expect(detail?.showcase?.openTopics ?? 0).toBeGreaterThan(0)
  })

  it("trae lo que el equipo ya usa: inventario, promociones usadas, comisiones, oportunidades y respuestas de Sofi", async () => {
    const orgId = demo.organizationId
    // Inventario: lo que gastan los servicios que ofrece en su país, lo que vende, algo que hace
    // falta reponer, un lote vencido y otro por vencer. Un consultorio de niños no guarda DIU.
    const stock = await listProducts(ownerDb, orgId)
    expect(stock.items.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Mascarilla para nebulizar", "Termómetro digital"]),
    )
    expect(stock.items.some((item) => item.name.includes("DIU"))).toBe(false)
    expect(stock.counts.hacen_falta).toBeGreaterThan(0)
    expect(stock.items.some((item) => item.expired !== null)).toBe(true)
    expect(stock.counts.por_vencer).toBeGreaterThan(0)
    const orders = await ownerDb
      .selectDistinct({ status: purchaseOrder.status })
      .from(purchaseOrder)
      .where(eq(purchaseOrder.organizationId, orgId))
    expect(orders.map((row) => row.status).sort()).toEqual(
      ["borrador", "cancelada", "cerrada", "confirmada", "parcialmente_recibida", "recibida"].sort(),
    )
    // Las atenciones de estos días descontaron sus materiales.
    const [used] = await ownerDb
      .select({ n: sql<number>`count(*)::int` })
      .from(stockMovement)
      .where(and(eq(stockMovement.organizationId, orgId), like(stockMovement.reason, "Atención del %")))
    expect(used?.n ?? 0).toBeGreaterThan(0)

    // Las dos promociones son de servicios de su tarifario y se usaron en cobros de la historia.
    const promotions = await listPromotions(ownerDb, orgId)
    expect(promotions.map((item) => item.name).sort()).toEqual(
      ["Control del niño sano", "Nebulización a precio especial"].sort(),
    )
    for (const item of promotions) {
      expect(item.items[0]?.priceCents ?? 0).toBeLessThan(item.items[0]?.tariffCents ?? 0)
      expect((await getPromotionMetrics(ownerDb, orgId, item.id)).uses).toBeGreaterThan(0)
    }

    // Comisiones: el mes pasado pagado, con su gasto de Personal.
    const [paid] = await ownerDb
      .select({ n: sql<number>`count(*)::int` })
      .from(commissionSettlement)
      .where(eq(commissionSettlement.organizationId, orgId))
    expect(paid?.n ?? 0).toBeGreaterThan(0)

    // Oportunidades de quienes escribieron: abiertas, una ganada y una perdida.
    const opportunities = await ownerDb
      .select({ status: opportunity.status })
      .from(opportunity)
      .where(eq(opportunity.organizationId, orgId))
    expect(opportunities.map((row) => row.status).sort()).toEqual(["lost", "open", "open", "open", "won"])

    // Sofi ya tiene publicadas las de «Lo que solo tú sabes» y la de su tipo; el horario sale del
    // equipo de la demo, no de un texto (ADR 0120).
    const answers = await ownerDb
      .select({ basicKey: agentKnowledgeEntry.basicKey, title: agentKnowledgeEntry.title })
      .from(agentKnowledgeEntry)
      .where(and(eq(agentKnowledgeEntry.organizationId, orgId), eq(agentKnowledgeEntry.status, "publicada")))
    expect(answers.map((row) => row.basicKey)).toEqual(expect.arrayContaining(["sin_cita", "tardanza", "primera_cita"]))
    expect(answers.map((row) => row.basicKey)).not.toContain("horario")
    expect(answers.map((row) => row.title)).toContain("¿Atienden a niños? ¿Desde qué edad?")
  })

  it("ponerla al día cierra lo que pasó, no toca lo hecho a mano y es igual si se repite el mismo día", async () => {
    const [left, manual] = await ownerDb
      .select({ id: appointment.id })
      .from(appointment)
      .where(
        and(
          eq(appointment.organizationId, demo.organizationId),
          inArray(appointment.status, ["programada", "confirmada"]),
          sql`${appointment.startsAt} > now() + interval '2 days'`,
        ),
      )
      .limit(2)
    if (!left || !manual) throw new Error("faltan citas")
    // Una cita que ya pasó sin cerrar, y otra que alguien canceló en una presentación.
    const past = new Date(Date.now() - 3 * 3_600_000)
    await ownerDb.execute(
      sql`update appointment set starts_at = ${past.toISOString()}::timestamptz, ends_at = ${new Date(past.getTime() + 20 * 60_000).toISOString()}::timestamptz where id = ${left.id}`,
    )
    await ownerDb
      .update(appointment)
      .set({ status: "cancelada" })
      .where(eq(appointment.id, manual.id))
    const ref = { ...demo, product: "medical" as const, size: "pequeno" as const }
    await ownerDb.transaction((tx) => advanceDemo(tx, ref))
    const [closed] = await ownerDb
      .select({ status: appointment.status })
      .from(appointment)
      .where(eq(appointment.id, left.id))
    expect(["atendida", "no_asistio"]).toContain(closed?.status)
    const [kept] = await ownerDb
      .select({ status: appointment.status })
      .from(appointment)
      .where(eq(appointment.id, manual.id))
    expect(kept?.status).toBe("cancelada")
    const count = async () =>
      (
        await ownerDb
          .select({ n: sql<number>`count(*)::int` })
          .from(appointment)
          .where(eq(appointment.organizationId, demo.organizationId))
      )[0]?.n
    const before = await count()
    await ownerDb.transaction((tx) => advanceDemo(tx, ref))
    expect(await count()).toBe(before)
  })

  it("se avisa antes de borrarse sola y abrirla la conserva", async () => {
    const old = new Date(Date.now() - 56 * DAY)
    await ownerDb
      .update(saasDemo)
      .set({ readyAt: old, openedAt: old, createdAt: old })
      .where(eq(saasDemo.id, demo.id))
    await ownerDb.execute(
      sql`update session set updated_at = ${old.toISOString()}::timestamptz where active_organization_id = ${demo.organizationId}`,
    )
    expect((await listDemos(ownerDb)).find((item) => item.id === demo.id)?.expiresSoon).toBe(true)
    expect((await expiredDemos(ownerDb)).some((item) => item.id === demo.id)).toBe(false)
    await markDemoOpened(ownerDb, demo.id)
    expect((await listDemos(ownerDb)).find((item) => item.id === demo.id)?.expiresSoon).toBe(false)
  })

  it("Clínicas separa las reales de las demos", async () => {
    await insertOrg(ownerDb, "demos-real", "demos-real")
    const demos = await listOrganizations(ownerDb, admin, { kind: "demo", limit: 100 })
    const reals = await listOrganizations(ownerDb, admin, { kind: "real", limit: 100 })
    expect(demos.items.map((item) => item.id)).toContain(demo.organizationId)
    expect(reals.items.map((item) => item.id)).not.toContain(demo.organizationId)
    expect(reals.items.map((item) => item.id)).toContain("demos-real")
  })

  it("una clínica real nunca se borra, ni marcada «modo demo»", async () => {
    await ownerDb
      .update(saasSubscription)
      .set({ isDemo: true })
      .where(eq(saasSubscription.organizationId, "demos-real"))
    await expect(
      ownerDb.transaction((tx) => purgeDemoOrganization(tx, demo.id, "demos-real")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    const [still] = await ownerDb
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, "demos-real"))
    expect(still?.id).toBe("demos-real")
  })

  it("borrar la clínica para volver a armarla no bloquea la fila de la demo (el avance la escribe por otra conexión)", async () => {
    const [extra] = await ownerDb
      .insert(saasDemo)
      .values({
        ...pediatria,
        slug: `bloqueo-${Date.now()}`,
        createdBy: admin.userId,
        seed: 7,
        status: "creando",
      })
      .returning()
    if (!extra) throw new Error("falta la demo")
    const built = await build(extra.id)
    await ownerDb.transaction(async (tx) => {
      await purgeDemoOrganization(tx, extra.id, built.organizationId)
      // Mientras sigue abierta, otra conexión escribe el avance sin esperar.
      const progressed = await ownerDb.transaction(async (other) => {
        await other.execute(sql`set local lock_timeout = '2s'`)
        return other
          .update(saasDemo)
          .set({ progress: { step: "historia", done: 2, total: 5 } })
          .where(eq(saasDemo.id, extra.id))
          .returning({ id: saasDemo.id })
      })
      expect(progressed).toHaveLength(1)
      await tx.delete(saasDemo).where(eq(saasDemo.id, extra.id))
    })
  })

  it("volver a empezar la deja pendiente con la misma receta; mientras se arma no se vuelve a pedir", async () => {
    await resetDemo(ownerDb, admin, demo.id)
    const [row] = await ownerDb.select().from(saasDemo).where(eq(saasDemo.id, demo.id))
    expect(row).toMatchObject({
      status: "pendiente",
      seed: demo.seed,
      organizationId: demo.organizationId,
    })
    await expect(resetDemo(ownerDb, admin, demo.id)).rejects.toMatchObject({ code: "CONFLICT" })
    // Pendiente no se borra: el worker podría tomarla y armar una clínica sin su fila.
    await expect(deleteDemo(ownerDb, admin, demo.id, demo.name)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await ownerDb.update(saasDemo).set({ status: "lista" }).where(eq(saasDemo.id, demo.id))
  })

  it("vencer vuelve a mirar con candado: una demo que se usó no se borra sola", async () => {
    await expect(
      ownerDb.transaction((tx) => deleteDemo(tx, null, demo.id, null)),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("volver a armarla conserva la clínica: el mismo id y su ficha", async () => {
    const [row] = await ownerDb.select().from(saasDemo).where(eq(saasDemo.id, demo.id))
    if (!row?.organizationId) throw new Error("falta la clínica")
    const rebuilt = await ownerDb.transaction(async (tx) => {
      await purgeDemoOrganization(tx, row.id, row.organizationId as string)
      return buildDemo(
        tx,
        { ...row, product: "medical", size: "pequeno" },
        { secretsKey: Buffer.alloc(32, 3), fetch, organizationId: row.organizationId as string },
      )
    })
    expect(rebuilt).toMatchObject({ organizationId: row.organizationId, slug: row.slug })
    const [still] = await ownerDb
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, row.organizationId))
    expect(still?.id).toBe(row.organizationId)
  })

  it("borrarla pide su nombre y se lleva la clínica entera, sin restos", async () => {
    await expect(deleteDemo(ownerDb, admin, demo.id, "otro nombre")).rejects.toMatchObject({
      code: "VALIDATION",
    })
    await expect(deleteDemo(ownerDb, support, demo.id, demo.name)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await ownerDb.transaction((tx) => deleteDemo(tx, admin, demo.id, demo.name))
    const tables = (await ownerDb.execute(sql`
      select c.table_schema, c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.column_name = 'organization_id' and t.table_type = 'BASE TABLE' and c.table_schema not in ('admin')`)) as unknown as Array<{
      table_schema: string
      table_name: string
    }>
    for (const table of tables) {
      const [left] = (await ownerDb.execute(
        sql`select count(*)::int as n from ${sql.identifier(table.table_schema)}.${sql.identifier(table.table_name)} where organization_id = ${demo.organizationId}`,
      )) as unknown as Array<{ n: number }>
      expect({ table: table.table_name, n: left?.n }).toEqual({ table: table.table_name, n: 0 })
    }
    expect(
      await ownerDb.select().from(organization).where(eq(organization.id, demo.organizationId)),
    ).toEqual([])
    expect(
      await ownerDb
        .select()
        .from(user)
        .where(like(user.id, `${demoUserPrefix(demo.id)}%`)),
    ).toEqual([])
    expect(
      await ownerDb.select({ id: user.id }).from(user).where(eq(user.id, admin.userId)),
    ).toHaveLength(1)
    expect(await ownerDb.select().from(saasDemo).where(eq(saasDemo.id, demo.id))).toEqual([])
  })
})

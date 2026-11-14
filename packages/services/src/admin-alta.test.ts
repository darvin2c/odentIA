import {
  saasClient,
  saasClientFile,
  saasClientMilestone,
  saasOpportunity,
} from "@odentia/db/schema/admin-arm"
import { adminAudit, adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { saasPayment, saasSubscription } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  ALTA_COLUMNS,
  type AltaBoard,
  type AltaCard,
  altaBoard,
  ONBOARDING_STEP_KEYS,
  type OnboardingStepKey,
} from "./admin-onboarding.js"
import { altaReport } from "./admin-reports.js"
import { limaDate } from "./peru-business-days.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * El Embudo «Alta» y su reporte: una tarjeta por clínica que entró, en la columna de lo que le
 * falta; «Pagó» los últimos 30 días; Soporte sin lo de cobros. Cada clínica es ficticia.
 */
setupTestDb()
const admin: AdminActor = { userId: "al-admin", role: "admin" }
const support: AdminActor = { userId: "al-support", role: "support" }
const LOADER = "al-cargador"
const DAY = 86_400_000
/** Un minuto adelante: las cuentas de prueba se crean con `now()` de la base, antes de esto. */
const NOW = new Date(Date.now() + 60_000)
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)
const ids: Record<string, string> = {}
let payments = 0

const BIENVENIDA: OnboardingStepKey[] = ["entro", "contrato", "carta"]
const SUS_DATOS: OnboardingStepKey[] = [
  ...BIENVENIDA,
  "archivos",
  "configuracion",
  "pacientes",
  "informe",
]
const ANTES_DEL_PAGO = ONBOARDING_STEP_KEYS.filter((key) => key !== "primer_pago")

async function clinic(
  key: string,
  values: {
    owner?: string | null
    product?: string
    origin?: string
    enteredDaysAgo?: number
  } = {},
): Promise<{ orgId: string; clientId: string }> {
  const orgId = `al-${key}`
  await insertOrg(ownerDb, orgId, orgId)
  const [row] = await ownerDb
    .insert(saasClient)
    .values({
      name: `Clínica ${key} (ficticia)`,
      product: values.product ?? "dental",
      origin: values.origin ?? "otro",
      ownerUserId: values.owner === undefined ? admin.userId : values.owner,
      organizationId: orgId,
    })
    .returning({ id: saasClient.id })
  if (!row) throw new Error("sin cliente")
  ids[key] = row.id
  if (values.enteredDaysAgo !== undefined)
    await ownerDb.insert(saasOpportunity).values({
      clientId: row.id,
      decision: "entro",
      decidedAt: ago(values.enteredDaysAgo),
      decidedBy: admin.userId,
      createdAt: ago(values.enteredDaysAgo + 5),
    })
  return { orgId, clientId: row.id }
}

/** La primera vez guardada de cada paso (como la deja la pasada de Kairós). */
async function reach(clientId: string, steps: OnboardingStepKey[], daysAgo: number) {
  await ownerDb.insert(saasClientMilestone).values(
    steps.map((step) => ({
      clientId,
      step,
      reachedAt: ago(daysAgo),
      source: "hecho",
      createdAt: ago(daysAgo),
      updatedAt: ago(daysAgo),
    })),
  )
}

async function payment(orgId: string, status: "confirmado" | "pendiente", daysAgo: number) {
  payments += 1
  await ownerDb.insert(saasPayment).values({
    organizationId: orgId,
    amountCents: 2900,
    currency: "USD",
    methodCode: "transferencia",
    status,
    idempotencyKey: `al-${payments}`,
    confirmedAt: status === "confirmado" ? ago(daysAgo) : null,
    confirmedBy: status === "confirmado" ? admin.userId : null,
    createdAt: ago(daysAgo),
    updatedAt: ago(daysAgo),
  })
}

const cardsOf = (board: AltaBoard): AltaCard[] => board.columns.flatMap((column) => column.cards)
const cardOf = (board: AltaBoard, key: string): AltaCard | undefined =>
  cardsOf(board).find((card) => card.clientId === ids[key])
const columnOf = (board: AltaBoard, key: string) => cardOf(board, key)?.column ?? null

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Administración", email: "ada@alta.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@alta.test" },
    { id: LOADER, name: "Carla Carga", email: "carla@alta.test" },
  ])
  await ownerDb.insert(adminStaff).values([
    { userId: admin.userId, role: "admin" },
    { userId: support.userId, role: "support" },
    { userId: LOADER, role: "admin" },
  ])

  // Bienvenida: la cuenta existe y aún no tiene propietaria (nos toca a nosotros).
  await clinic("bienvenida")

  // Sus datos: configuración cargada por Carla; llegó otra tanda que se borra en 5 días.
  const datos = await clinic("datos", { owner: support.userId })
  await reach(datos.clientId, [...BIENVENIDA, "archivos", "configuracion"], 3)
  await ownerDb.insert(adminAudit).values({
    actorUserId: LOADER,
    actorRole: "admin",
    action: "org.setup_import",
    organizationId: datos.orgId,
    metadata: { nueva: 3 },
    createdAt: ago(3),
  })
  await ownerDb.insert(saasClientFile).values({
    clientId: datos.clientId,
    kind: "archivo_clinica",
    filename: "pacientes.xlsx",
    objectKey: `clients/${datos.clientId}/pacientes.xlsx`,
    contentType: "text/csv",
    sizeBytes: 1,
    createdAt: ago(1),
    receivedAt: ago(1),
    cargaAt: ago(1),
    deleteAfter: limaDate(new Date(NOW.getTime() + 5 * DAY)),
  })

  // Arranque: falta WhatsApp sin «Conectar con Facebook»; una trabada hace 10 días, otra al día.
  const meta = await clinic("meta", { owner: null, origin: "evento", enteredDaysAgo: 20 })
  await reach(meta.clientId, [...SUS_DATOS, "equipo"], 10)
  const reciente = await clinic("reciente", { product: "medical" })
  await reach(reciente.clientId, [...SUS_DATOS, "equipo"], 1)

  // Primer pago: todo listo y un comprobante por confirmar.
  const porConfirmar = await clinic("por-confirmar")
  await reach(porConfirmar.clientId, ANTES_DEL_PAGO, 2)
  await payment(porConfirmar.orgId, "pendiente", 1)

  // Pagó hace 5 días aunque le falta el equipo; otra pagó hace 40 (ya no sale).
  const pago = await clinic("pago", { enteredDaysAgo: 15 })
  await reach(
    pago.clientId,
    ANTES_DEL_PAGO.filter((key) => key !== "equipo"),
    6,
  )
  await payment(pago.orgId, "confirmado", 5)
  const antigua = await clinic("antigua", { enteredDaysAgo: 70 })
  await reach(antigua.clientId, ANTES_DEL_PAGO, 45)
  await payment(antigua.orgId, "confirmado", 40)

  // No salen: demo, cancelada, archivada y un prospecto sin cuenta.
  const demo = await clinic("demo")
  await ownerDb
    .update(saasSubscription)
    .set({ isDemo: true })
    .where(eq(saasSubscription.organizationId, demo.orgId))
  const cancelada = await clinic("cancelada")
  await ownerDb
    .update(saasSubscription)
    .set({ status: "cancelada" })
    .where(eq(saasSubscription.organizationId, cancelada.orgId))
  const archivada = await clinic("archivada")
  await ownerDb
    .update(saasClient)
    .set({ archivedAt: ago(1) })
    .where(eq(saasClient.id, archivada.clientId))
  const [prospect] = await ownerDb
    .insert(saasClient)
    .values({ name: "Clínica Prospecto (ficticia)", product: "dental" })
    .returning({ id: saasClient.id })
  ids.prospecto = prospect?.id ?? ""
})

describe("el Embudo «Alta»", () => {
  it("una tarjeta por clínica en la columna de lo que le falta; sin demos, canceladas, archivadas ni prospectos", async () => {
    const board = await altaBoard(ownerDb, admin, {}, NOW)
    expect(board.columns.map((column) => column.key)).toEqual([...ALTA_COLUMNS])
    expect(columnOf(board, "bienvenida")).toBe("bienvenida")
    expect(columnOf(board, "datos")).toBe("sus_datos")
    expect(columnOf(board, "meta")).toBe("arranque")
    expect(columnOf(board, "reciente")).toBe("arranque")
    expect(columnOf(board, "por-confirmar")).toBe("primer_pago")
    for (const key of ["antigua", "demo", "cancelada", "archivada", "prospecto"])
      expect(cardOf(board, key), key).toBeUndefined()
  })

  it("lo que falta y a quién le toca: a nosotros (el responsable o quien cargó), a la clínica o a Meta", async () => {
    const board = await altaBoard(ownerDb, admin, {}, NOW)
    expect(cardOf(board, "bienvenida")).toMatchObject({
      missing: { step: "entro" },
      who: { kind: "nosotros", person: { userId: admin.userId, name: "Ada Administración" } },
    })
    // La carga le toca a quien hizo la última, no al responsable (Sofía).
    expect(cardOf(board, "datos")).toMatchObject({
      missing: { step: "pacientes", words: "cargar sus pacientes (sus datos se borran en 5 días)" },
      who: { kind: "nosotros", person: { userId: LOADER, name: "Carla Carga" } },
    })
    expect(cardOf(board, "meta")).toMatchObject({
      missing: { step: "whatsapp" },
      who: { kind: "meta", person: null },
      daysInAlta: 20,
    })
    expect(cardOf(board, "por-confirmar")).toMatchObject({
      missing: { step: "primer_pago", words: "confirmar su pago" },
      who: { kind: "nosotros" },
    })
  })

  it("pagó aunque le falten pasos va a «Pagó», con lo que le falta y los días hasta pagar", async () => {
    const board = await altaBoard(ownerDb, admin, {}, NOW)
    const card = cardOf(board, "pago")
    expect(card).toMatchObject({
      column: "pago",
      missing: { step: "equipo" },
      who: { kind: "clinica", person: null },
      remaining: 1,
      daysInAlta: 10,
      stuck: null,
    })
    expect(card?.paidAt).toBe(ago(5).toISOString())
  })

  it("la trabada va primero, con sus días sin avanzar", async () => {
    const board = await altaBoard(ownerDb, admin, {}, NOW)
    const arranque = board.columns.find((column) => column.key === "arranque")?.cards ?? []
    expect(arranque.map((card) => card.clientId)).toEqual([ids.meta, ids.reciente])
    expect(arranque[0]?.stuck).toEqual({ days: 10, words: "Lleva 10 días sin avanzar" })
    expect(arranque[1]?.stuck).toBeNull()
  })

  it("Soporte no recibe «Primer pago» ni «Pagó», ni sus tarjetas", async () => {
    const board = await altaBoard(ownerDb, support, {}, NOW)
    expect(board.columns.map((column) => column.key)).toEqual([
      "bienvenida",
      "sus_datos",
      "arranque",
    ])
    expect(cardOf(board, "por-confirmar")).toBeUndefined()
    expect(cardOf(board, "pago")).toBeUndefined()
    expect(columnOf(board, "datos")).toBe("sus_datos")
    await expect(altaBoard(ownerDb, null, {}, NOW)).rejects.toMatchObject({ status: 403 })
  })

  it("los filtros de responsable, producto y origen son los del embudo de venta", async () => {
    const keysOf = (board: AltaBoard) =>
      new Set(
        cardsOf(board).map((card) => Object.keys(ids).find((key) => ids[key] === card.clientId)),
      )
    const mine = keysOf(await altaBoard(ownerDb, support, { owner: "mio" }, NOW))
    expect([...mine]).toEqual(["datos"])
    expect([...keysOf(await altaBoard(ownerDb, admin, { owner: "sin" }, NOW))]).toEqual(["meta"])
    expect([...keysOf(await altaBoard(ownerDb, admin, { owner: LOADER }, NOW))]).toEqual([])
    expect([...keysOf(await altaBoard(ownerDb, admin, { product: "medical" }, NOW))]).toEqual([
      "reciente",
    ])
    expect([...keysOf(await altaBoard(ownerDb, admin, { origin: "evento" }, NOW))]).toEqual([
      "meta",
    ])
  })
})

describe("el reporte del alta", () => {
  it("solo Administración, con los meses de 1 a 24", async () => {
    for (const actor of [support, null])
      await expect(altaReport(ownerDb, actor, {}, NOW)).rejects.toMatchObject({ status: 403 })
    await expect(altaReport(ownerDb, admin, { months: 0 }, NOW)).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { months: expect.any(String) },
    })
  })

  it("entraron contra pagaron, la mediana de días hasta pagar, dónde se quedan y por mes", async () => {
    const report = await altaReport(ownerDb, admin, {}, NOW)
    // Entraron: todas las de cuenta sin demo ni archivar (la cancelada cuenta como que no pagó).
    expect(report.entered.value).toBe(8)
    expect(report.paid).toMatchObject({ n: 2, m: 8, words: "2 de 8" })
    // Pago: 15 − 5 = 10 días; antigua: 70 − 40 = 30 días.
    expect(report.daysToPay).toMatchObject({ value: 20, cases: 2, words: "20 días (2 casos)" })
    expect(report.stalls).toEqual([
      { step: "entro", label: "Entró", count: 2 },
      { step: "whatsapp", label: "WhatsApp conectado", count: 2 },
      { step: "pacientes", label: "Pacientes cargados", count: 1 },
      { step: "primer_pago", label: "Primer pago confirmado", count: 1 },
    ])
    expect(report.stalledMost).toMatchObject({
      step: "entro",
      words: "Entró: 2 de 6 que no pagaron",
    })
    expect(report.cohorts).toHaveLength(6)
    expect(report.cohorts.at(-1)?.month).toBe(limaDate(NOW).slice(0, 7))
    expect(report.cohorts.reduce((sum, row) => sum + row.entered, 0)).toBe(8)
    expect(report.cohorts.reduce((sum, row) => sum + row.paid, 0)).toBe(2)
    for (const text of [
      report.entered.howCalculated,
      report.paid.howCalculated,
      report.daysToPay.howCalculated,
      report.stallsHowCalculated,
      report.cohortsHowCalculated,
    ])
      expect(text.length).toBeGreaterThan(20)
  })
})

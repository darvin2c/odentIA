import { randomUUID } from "node:crypto"
import type { AppEvent } from "@odentia/contract"
import { type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import {
  saasAction,
  saasCharge,
  saasChargeLine,
  saasNotice,
  saasSubscription,
} from "@odentia/db/schema/saas-billing"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { replyToSupportCase } from "./admin-support.js"
import { answerAppState, assignAppAccountPlan, receiveAppEvent } from "./app-contract.js"
import {
  chooseSaasPlan,
  createSaasCharge,
  createSaasPlan,
  getPublicTrialOffer,
  getSaasSubscription,
  listClinicPlans,
  listSaasCharges,
  tickSaasBilling,
} from "./saas-billing.js"
import { listSaasChargeLines } from "./saas-invoicing.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * El acuerdo con las apps que son otro sistema (ADR 0211): la administración abre, cuenta, cobra
 * y responde a una cuenta de gestorIA con las mismas tablas que a una clínica, sin tocar a
 * ninguna.
 *
 * «El ciclo de las clínicas da igual» compara lo que deja un ciclo del cobro en cada clínica
 * (suscripción, cargos con sus líneas, avisos y correos) con lo que dejaba el mismo ciclo antes de
 * este cambio: el archivo de `__snapshots__` se generó con este mismo archivo corrido sobre `main`
 * (sin la cuenta de gestorIA), y aquí corre con una cuenta de gestorIA al lado, contando y
 * cobrando en el mismo ciclo.
 */

setupTestDb()

const NOW = new Date("2026-11-20T15:00:00Z")
const DAY = 86_400_000
const ADMIN = "contrato-admin"
const GESTORIA = "gestoria" as const

const C = {
  conPlan: "dorada-prueba-con-plan",
  sinPlan: "dorada-prueba-sin-plan",
  cobro: "dorada-cobro",
  vencido: "dorada-vencido",
  graciaVencida: "dorada-gracia-vencida",
  demo: "dorada-demo",
  porTerminar: "dorada-por-terminar",
} as const
const CLINICS: string[] = Object.values(C)

const days = (n: number) => new Date(NOW.getTime() + n * DAY)

async function clinic(id: string): Promise<void> {
  await insertOrg(ownerDb, id, id)
  const owner = `${id}-owner`
  await ownerDb
    .insert(user)
    .values({ id: owner, name: "Propietaria", email: `${owner}@contrato.test` })
  await ownerDb
    .insert(member)
    .values({ id: randomUUID(), organizationId: id, userId: owner, role: "owner", createdAt: NOW })
}

async function planId(code: string): Promise<string> {
  const [row] = (await ownerDb.execute(
    sql`select id from saas_plan where code = ${code}`,
  )) as unknown as { id: string }[]
  return row!.id
}

async function setSub(orgId: string, values: Partial<typeof saasSubscription.$inferInsert>) {
  await ownerDb
    .update(saasSubscription)
    .set({
      trialStartedAt: null,
      trialEndsAt: null,
      activatedAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      graceEndsAt: null,
      ...values,
    })
    .where(eq(saasSubscription.organizationId, orgId))
}

async function conversation(
  orgId: string,
  at: Date,
  tier: "informa" | "gestiona",
  priceMicros: number,
  key: string,
) {
  await ownerDb.insert(saasAction).values({
    organizationId: orgId,
    kind: "conversacion",
    tier,
    occurredAt: at,
    detail: "Atendió una conversación por WhatsApp",
    currency: "USD",
    basePriceMicros: priceMicros,
    priceMicros,
    dedupeKey: key,
  })
}

/** Lo que deja el ciclo en una clínica, sin ids ni horas de la base. */
async function cycleOf(orgId: string) {
  const sub = await getSaasSubscription(ownerDb, orgId)
  const charges = await ownerDb
    .select()
    .from(saasCharge)
    .where(eq(saasCharge.organizationId, orgId))
    .orderBy(asc(saasCharge.periodStart))
  const lines = charges.length
    ? await ownerDb
        .select()
        .from(saasChargeLine)
        .where(
          and(
            eq(saasChargeLine.organizationId, orgId),
            inArray(
              saasChargeLine.chargeId,
              charges.map((charge) => charge.id),
            ),
          ),
        )
        .orderBy(asc(saasChargeLine.sortOrder))
    : []
  const notices = await ownerDb
    .select()
    .from(saasNotice)
    .where(eq(saasNotice.organizationId, orgId))
    .orderBy(asc(saasNotice.dedupeKey))
  return {
    subscription: sub && {
      ...sub,
      createdAt: undefined,
      updatedAt: undefined,
      planId: sub.planId ? "plan" : null,
    },
    charges: charges.map((charge) => ({
      planCode: charge.planCode,
      periodStart: charge.periodStart.toISOString(),
      periodEnd: charge.periodEnd.toISOString(),
      amountCents: charge.amountCents,
      subtotalCents: charge.subtotalCents,
      taxCents: charge.taxCents,
      taxLabel: charge.taxLabel,
      paidCents: charge.paidCents,
      currency: charge.currency,
      status: charge.status,
      dueAt: charge.dueAt?.toISOString() ?? null,
      dedupeKey: charge.dedupeKey,
      lines: lines
        .filter((line) => line.chargeId === charge.id)
        .map((line) => ({
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          unitBaseMicros: line.unitBaseMicros,
          unitPriceMicros: line.unitPriceMicros,
          amountCents: line.amountCents,
        })),
    })),
    notices: notices.map((notice) => {
      const mail = notice.metadata
        ? (JSON.parse(notice.metadata) as { subject: string; text: string })
        : null
      return {
        kind: notice.kind,
        dedupeKey: notice.dedupeKey,
        emailTo: notice.emailTo,
        subject: mail?.subject ?? null,
        text: mail?.text ?? null,
      }
    }),
  }
}

let tick: Awaited<ReturnType<typeof tickSaasBilling>>
let accountId: string

const event = (
  type: AppEvent["type"],
  data: Record<string, unknown>,
  timestamp = NOW.toISOString(),
) => ({ type, timestamp, data }) as AppEvent

beforeAll(async () => {
  await ownerDb
    .insert(user)
    .values({ id: ADMIN, name: "Administración", email: "admin@contrato.test" })
  await createSaasPlan(ownerDb, ADMIN, {
    code: "lista",
    name: "Plan odentIA",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    conversationInformMicros: 200_000,
    trialCreditCents: 5000,
    trialMaxCreditCents: 5000,
    trialDays: 14,
    trialMaxDays: 30,
    maxDiscountBps: 0,
    sellerDiscountBps: 0,
    isDefault: true,
  })
  await createSaasPlan(ownerDb, ADMIN, {
    code: "soles",
    name: "Plan en soles",
    currency: "PEN",
    priceCents: 10000,
  })
  for (const id of CLINICS) await clinic(id)
  const lista = await planId("lista")

  // La prueba con plan termina: pasa al plan y su mes empieza hoy.
  await setSub(C.conPlan, {
    status: "prueba",
    planId: lista,
    trialStartedAt: days(-15),
    trialEndsAt: days(-1),
    currentPeriodStart: days(-15),
    currentPeriodEnd: days(-1),
  })
  // La prueba sin plan termina: solo lectura, con su aviso.
  await setSub(C.sinPlan, {
    status: "prueba",
    planId: null,
    trialStartedAt: days(-15),
    trialEndsAt: days(-1),
    currentPeriodStart: days(-15),
    currentPeriodEnd: days(-1),
  })
  // Termina un mes con conversaciones por encima del crédito: el cargo con sus líneas y el IGV (Perú).
  await setSub(C.cobro, {
    status: "activa",
    planId: lista,
    activatedAt: days(-31),
    currentPeriodStart: days(-31),
    currentPeriodEnd: days(-1),
  })
  for (let index = 0; index < 120; index++)
    await conversation(
      C.cobro,
      new Date(days(-30).getTime() + index * 3_600_000),
      index % 3 === 0 ? "gestiona" : "informa",
      index % 3 === 0 ? 500_000 : 200_000,
      `dorada-${index}`,
    )
  // Un cargo vencido sin pagar: pasa a gracia, con lo que debe en el correo.
  await setSub(C.vencido, {
    status: "activa",
    planId: await planId("soles"),
    activatedAt: days(-10),
    currentPeriodStart: days(-10),
    currentPeriodEnd: days(20),
  })
  await createSaasCharge(ownerDb, C.vencido, ADMIN, {
    planCode: "soles",
    periodStart: days(-40),
    periodEnd: days(-10),
    dueAt: days(-3),
  })
  // La gracia venció sin pago: solo lectura.
  await setSub(C.graciaVencida, {
    status: "gracia",
    planId: await planId("soles"),
    activatedAt: days(-60),
    currentPeriodStart: days(-10),
    currentPeriodEnd: days(20),
    graceEndsAt: days(-1),
  })
  await createSaasCharge(ownerDb, C.graciaVencida, ADMIN, {
    planCode: "soles",
    periodStart: days(-70),
    periodEnd: days(-40),
    dueAt: days(-20),
  })
  // La demo no se cobra ni se restringe.
  await setSub(C.demo, {
    status: "prueba",
    isDemo: true,
    planId: null,
    trialStartedAt: days(-40),
    trialEndsAt: days(-10),
    currentPeriodStart: days(-40),
    currentPeriodEnd: days(-10),
  })
  // A la prueba sin plan le quedan dos días: su aviso.
  await setSub(C.porTerminar, {
    status: "prueba",
    planId: null,
    trialStartedAt: days(-12),
    trialEndsAt: days(2),
    currentPeriodStart: days(-12),
    currentPeriodEnd: days(2),
  })

  // --- gestorIA: una cuenta que cuenta y cobra en el mismo ciclo (no se corre sobre main) ---
  await createSaasPlan(ownerDb, ADMIN, {
    app: GESTORIA,
    code: "gestoria-prueba",
    name: "Plan de prueba de gestorIA",
    currency: "USD",
    priceCents: 1500,
    creditCents: 1500,
    conversationMicros: 300_000,
    conversationInformMicros: 100_000,
    trialCreditCents: 1000,
    trialMaxCreditCents: 1000,
    trialDays: 7,
    trialMaxDays: 7,
    maxDiscountBps: 0,
    sellerDiscountBps: 0,
    isDefault: true,
  })
  await ownerDb.insert(user).values({ id: "tienda-duena", name: "Rosa", email: "rosa@tienda.test" })
  await receiveAppEvent(
    ownerDb,
    GESTORIA,
    "abre-1",
    event("cuenta.abierta", {
      account: "calzados-rosa",
      name: "Calzados Rosa",
      country: "PE",
      ownerUserId: "tienda-duena",
    }),
    days(-40),
  )
  const [account] = (await ownerDb.execute(
    sql`select id from admin.saas_account where external_ref = 'calzados-rosa'`,
  )) as unknown as { id: string }[]
  accountId = account!.id
  // Ya pasó su prueba y cierra su mes en este ciclo, como la clínica que cobra.
  await setSub(accountId, {
    status: "activa",
    activatedAt: days(-31),
    currentPeriodStart: days(-31),
    currentPeriodEnd: days(-1),
  })
  for (let index = 0; index < 20; index++) {
    const conv = `conv-${index}`
    const at = new Date(days(-30).getTime() + index * 3_600_000).toISOString()
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      `uso-${index}`,
      event("uso.contado", {
        account: "calzados-rosa",
        kind: "conversacion",
        outcome: "atendida",
        conversation: conv,
        occurredAt: at,
        channel: "whatsapp",
      }),
    )
    if (index % 2 === 0)
      await receiveAppEvent(
        ownerDb,
        GESTORIA,
        `pedido-${index}`,
        event("uso.contado", {
          account: "calzados-rosa",
          kind: "conversacion",
          outcome: "pedido",
          conversation: conv,
          occurredAt: at,
          channel: "whatsapp",
        }),
      )
  }
  // --- fin de gestorIA ---

  tick = await tickSaasBilling(ownerDb, NOW, { panelUrl: "https://app.contrato.test" })
}, 240_000)

describe("el ciclo del cobro de las clínicas", () => {
  it("da igual que antes, con una cuenta de gestorIA cobrando al lado", async () => {
    const clinics = Object.fromEntries(
      await Promise.all(CLINICS.map(async (id) => [id, await cycleOf(id)] as const)),
    )
    const mails = tick.mails
      .filter((mail) => CLINICS.includes(mail.organizationId))
      .map((mail) => ({
        organizationId: mail.organizationId,
        kind: mail.kind,
        to: mail.to,
        subject: mail.subject,
        dedupeKey: mail.dedupeKey,
      }))
      .sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey))
    // Lo sembrado recorre cada paso del ciclo: si no, la comparación no diría nada.
    expect(clinics[C.conPlan]!.subscription?.status).toBe("activa")
    expect(clinics[C.sinPlan]!.subscription?.status).toBe("restringida")
    expect(clinics[C.cobro]!.charges[0]!.lines.map((line) => line.kind)).toEqual(
      expect.arrayContaining(["cuota", "conversacion", "impuesto"]),
    )
    expect(clinics[C.vencido]!.subscription?.status).toBe("gracia")
    expect(clinics[C.graciaVencida]!.subscription?.status).toBe("restringida")
    expect(clinics[C.porTerminar]!.notices.map((notice) => notice.kind)).toContain(
      "dias_prueba_alarma",
    )
    expect(mails.length).toBeGreaterThan(4)
    expect({ clinics, mails }).toMatchSnapshot()
  })
})

describe("una cuenta de gestorIA en el mismo ciclo", () => {
  it("cierra su mes con el precio de su plan, sus palabras y el impuesto de su país, sin correos de clínica", async () => {
    const [charge] = await listSaasCharges(ownerDb, accountId)
    expect(charge).toMatchObject({
      planCode: "gestoria-prueba",
      currency: "USD",
      status: "pendiente",
    })
    const lines = await listSaasChargeLines(ownerDb, accountId, [charge!.id])
    // 10 atendidas a 0,10 y 10 con pedido a 0,30: 4,00 de acciones; la cuota de 15,00 vuelve en crédito.
    expect(lines.map((line) => [line.kind, line.amountCents])).toEqual([
      ["cuota", 1500],
      ["credito", 0],
      ["impuesto", 270],
    ])
    expect(lines.find((line) => line.kind === "credito")?.description).toContain(
      "20 acciones cubiertas",
    )
    // Nada sale por correo a la cuenta de otra app: sus avisos los muestra la app.
    expect(tick.mails.filter((mail) => mail.organizationId === accountId)).toEqual([])
  })

  it("con lo usado por encima del crédito, la línea dice lo que pasó en la tienda", async () => {
    const otro = "zapatillas-luz"
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      "abre-luz",
      event("cuenta.abierta", {
        account: otro,
        name: "Zapatillas Luz",
        country: null,
        ownerUserId: "tienda-duena",
      }),
    )
    const [row] = (await ownerDb.execute(
      sql`select id from admin.saas_account where external_ref = ${otro}`,
    )) as unknown as { id: string }[]
    const id = row!.id
    await setSub(id, {
      status: "activa",
      activatedAt: days(-31),
      currentPeriodStart: days(-31),
      currentPeriodEnd: days(-1),
    })
    for (let index = 0; index < 60; index++)
      await receiveAppEvent(
        ownerDb,
        GESTORIA,
        `luz-${index}`,
        event("uso.contado", {
          account: otro,
          kind: "conversacion",
          outcome: "pedido",
          conversation: `luz-${index}`,
          occurredAt: new Date(days(-20).getTime() + index * 60_000).toISOString(),
        }),
      )
    await tickSaasBilling(ownerDb, NOW)
    const [charge] = await listSaasCharges(ownerDb, id)
    const lines = await listSaasChargeLines(ownerDb, id, [charge!.id])
    const used = lines.find((line) => line.kind === "conversacion")
    // 60 × 0,30 = 18,00: el crédito de 15,00 cubre 50 y las otras 10 se cobran, sin impuesto (sin país).
    expect(used).toMatchObject({
      description: "Sofi: 10 conversaciones (10 que tomaron un pedido) por encima del crédito",
      quantity: 10,
      unitPriceMicros: 300_000,
      amountCents: 300,
    })
    expect(lines.some((line) => line.kind === "impuesto")).toBe(false)
  })
})

describe("el acuerdo", () => {
  it("abrir una cuenta abre su prueba con el plan de lista de su app y su presupuesto", async () => {
    await ownerDb.insert(user).values({ id: "otra-duena", name: "Ana", email: "ana@tienda.test" })
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      "abre-ana",
      event("cuenta.abierta", {
        account: "tienda-ana",
        name: "Tienda Ana",
        country: "PE",
        ownerUserId: "otra-duena",
      }),
      NOW,
    )
    const state = await answerAppState(ownerDb, GESTORIA, "tienda-ana", NOW)
    expect(state).toMatchObject({
      found: true,
      access: { allowed: true, status: "prueba", trialEndsAt: days(7).toISOString() },
      plan: { code: "gestoria-prueba", priceCents: 1500 },
      budget: { capCents: 1500, spentCents: 0 },
    })
  })

  it("un aviso repetido con la misma clave se reconoce y no se cuenta dos veces", async () => {
    const usage = event("uso.contado", {
      account: "tienda-ana",
      kind: "conversacion",
      outcome: "atendida",
      conversation: "una",
      occurredAt: NOW.toISOString(),
    })
    expect(await receiveAppEvent(ownerDb, GESTORIA, "repetido-1", usage, NOW)).toEqual({
      repeated: false,
    })
    expect(await receiveAppEvent(ownerDb, GESTORIA, "repetido-1", usage, NOW)).toEqual({
      repeated: true,
    })
    // Otra clave para la misma conversación tampoco la cuenta otra vez.
    expect(await receiveAppEvent(ownerDb, GESTORIA, "repetido-2", usage, NOW)).toEqual({
      repeated: false,
    })
    const ana = await accountOf("tienda-ana")
    const rows = await ownerDb.select().from(saasAction).where(eq(saasAction.organizationId, ana))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tier: "informa",
      priceMicros: 100_000,
      detail: "Atendió una conversación",
    })
  })

  it("la conversación sube a «pedido» mientras no se haya cobrado", async () => {
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      "sube-1",
      event("uso.contado", {
        account: "tienda-ana",
        kind: "conversacion",
        outcome: "pedido",
        conversation: "una",
        occurredAt: NOW.toISOString(),
      }),
      NOW,
    )
    const ana = await accountOf("tienda-ana")
    const [row] = await ownerDb.select().from(saasAction).where(eq(saasAction.organizationId, ana))
    expect(row).toMatchObject({
      tier: "gestiona",
      priceMicros: 300_000,
      previousPriceMicros: 100_000,
      detail: "Atendió una conversación y tomó un pedido",
    })
    // Lo ya cobrado no se reescribe: en la cuenta que cerró su mes, una conversación cobrada no sube.
    const [charged] = await ownerDb
      .select()
      .from(saasAction)
      .where(
        and(
          eq(saasAction.organizationId, accountId),
          eq(saasAction.dedupeKey, "gestoria:conversacion:conv-1"),
        ),
      )
    expect(charged!.chargeId).not.toBeNull()
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      "sube-cobrada",
      event("uso.contado", {
        account: "calzados-rosa",
        kind: "conversacion",
        outcome: "pedido",
        conversation: "conv-1",
        occurredAt: charged!.occurredAt.toISOString(),
      }),
    )
    const [after] = await ownerDb.select().from(saasAction).where(eq(saasAction.id, charged!.id))
    expect(after).toMatchObject({ tier: "informa", priceMicros: charged!.priceMicros })
  })

  it("lo de una cuenta que no existe no se guarda, y la misma clave sirve después", async () => {
    const usage = event("uso.contado", {
      account: "no-existe",
      kind: "conversacion",
      outcome: "atendida",
      conversation: "x",
      occurredAt: NOW.toISOString(),
    })
    await expect(receiveAppEvent(ownerDb, GESTORIA, "sin-cuenta", usage)).rejects.toMatchObject({
      status: 404,
    })
    const [ledger] = (await ownerDb.execute(
      sql`select count(*)::int as n from admin.app_contract_message where id = 'sin-cuenta'`,
    )) as unknown as { n: number }[]
    expect(ledger!.n).toBe(0)
  })

  it("un aviso de cuenta más viejo que llega tarde no pisa lo último", async () => {
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      "renombra",
      event(
        "cuenta.abierta",
        { account: "tienda-ana", name: "Tienda Ana SAC", country: "PE", ownerUserId: "otra-duena" },
        days(1).toISOString(),
      ),
    )
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      "tarde",
      event(
        "cuenta.abierta",
        { account: "tienda-ana", name: "Nombre viejo", country: "PE", ownerUserId: "otra-duena" },
        days(-1).toISOString(),
      ),
    )
    const [row] = (await ownerDb.execute(
      sql`select name from admin.saas_account where external_ref = 'tienda-ana'`,
    )) as unknown as { name: string }[]
    expect(row!.name).toBe("Tienda Ana SAC")
  })

  it("pide soporte a nombre de quien pregunta y recibe la respuesta del equipo en su estado", async () => {
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      "ayuda-1",
      event("soporte.pedido", {
        account: "tienda-ana",
        userId: "otra-duena",
        kind: "cobro",
        question: "¿Cómo pago mi plan?",
      }),
    )
    await expect(
      receiveAppEvent(
        ownerDb,
        GESTORIA,
        "ayuda-nadie",
        event("soporte.pedido", {
          account: "tienda-ana",
          userId: "nadie",
          kind: "pregunta",
          question: "Hola",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 })
    const before = await answerAppState(ownerDb, GESTORIA, "tienda-ana", NOW)
    expect(before.support).toHaveLength(1)
    const kase = before.support[0]!
    await replyToSupportCase(
      ownerDb,
      { userId: ADMIN, role: "admin" },
      kase.id,
      "Por transferencia: te enviamos los datos.",
    )
    const after = await answerAppState(ownerDb, GESTORIA, "tienda-ana", NOW)
    expect(after.support[0]!.replies.map((reply) => reply.body)).toEqual([
      "Por transferencia: te enviamos los datos.",
    ])
  })

  it("la pregunta de cualquier rol deja su pantalla y su rol, y el estado dice quién la abrió (ADR 0221)", async () => {
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      "ayuda-ventas",
      event("soporte.pedido", {
        account: "tienda-ana",
        userId: "otra-duena",
        kind: "pregunta",
        question: "No me deja confirmar el pago",
        screen: "/pedidos?pedido=p-1",
        role: "Ventas",
      }),
    )
    const [row] = (await ownerDb.execute(
      sql`select screen, role from support_case where question = 'No me deja confirmar el pago'`,
    )) as unknown as { screen: string; role: string }[]
    expect(row).toEqual({ screen: "/pedidos?pedido=p-1", role: "Ventas" })
    const state = await answerAppState(ownerDb, GESTORIA, "tienda-ana", NOW)
    expect(
      state.support.find((kase) => kase.question === "No me deja confirmar el pago")?.userId,
    ).toBe("otra-duena")
  })

  it("una cuenta sin plan de lista se abre sin suscripción y no se cobra hasta que se le asigna uno", async () => {
    await ownerDb.execute(
      sql`update admin.saas_plan set is_default = false where code = 'gestoria-prueba'`,
    )
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      "abre-sin-plan",
      event("cuenta.abierta", {
        account: "sin-plan",
        name: "Sin plan",
        country: null,
        ownerUserId: "otra-duena",
      }),
    )
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      "uso-sin-plan",
      event("uso.contado", {
        account: "sin-plan",
        kind: "conversacion",
        outcome: "pedido",
        conversation: "s",
        occurredAt: NOW.toISOString(),
      }),
    )
    const id = await accountOf("sin-plan")
    expect(await getSaasSubscription(ownerDb, id)).toBeNull()
    // Contado sin importe: nunca con el plan de lista de las clínicas.
    const [row] = await ownerDb.select().from(saasAction).where(eq(saasAction.organizationId, id))
    expect(row).toMatchObject({ priceMicros: null, basePriceMicros: null })
    expect(await answerAppState(ownerDb, GESTORIA, "sin-plan", NOW)).toMatchObject({
      found: true,
      access: { allowed: true, status: "sin_suscripcion" },
      plan: null,
      budget: null,
    })
    // Un plan de clínicas no se le asigna; uno de su app, sí.
    await expect(assignAppAccountPlan(ownerDb, id, ADMIN, "lista", NOW)).rejects.toMatchObject({
      status: 400,
    })
    await assignAppAccountPlan(ownerDb, id, ADMIN, "gestoria-prueba", NOW)
    expect(await getSaasSubscription(ownerDb, id)).toMatchObject({
      status: "prueba",
      trialEndsAt: days(7),
    })
    await ownerDb.execute(
      sql`update admin.saas_plan set is_default = true where code = 'gestoria-prueba'`,
    )
  })

  it("lo que no conoce lo dice, sin inventar estado", async () => {
    expect(await answerAppState(ownerDb, GESTORIA, "nunca-avisada", NOW)).toMatchObject({
      found: false,
      access: null,
      charges: [],
    })
  })
})

describe("ninguna clínica alcanza una cuenta de otra app", () => {
  it("ni su suscripción, ni lo contado, ni sus cargos, ni sus casos", async () => {
    for (const org of [C.cobro, C.vencido]) {
      const seen = await withOrgContext(appDb, org, async (tx: Db) => ({
        subs: await tx.execute(
          sql`select organization_id from saas_subscription where organization_id = ${accountId}`,
        ),
        actions: await tx.execute(
          sql`select id from saas_action where organization_id = ${accountId}`,
        ),
        charges: await tx.execute(
          sql`select id from saas_charge where organization_id = ${accountId}`,
        ),
        cases: await tx.execute(
          sql`select id from support_case where organization_id = ${await accountOf("tienda-ana")}`,
        ),
      }))
      expect(seen).toEqual({ subs: [], actions: [], charges: [], cases: [] })
    }
    // El rol de la aplicación no lee las cuentas ni la clave de los avisos.
    await expect(
      appDb.execute(sql`select id from admin.app_contract_message limit 1`),
    ).rejects.toThrow()
  })

  it("los planes de gestorIA no se le ofrecen a una clínica ni le cambian la oferta", async () => {
    const plans = await withOrgContext(appDb, C.cobro, (tx: Db) => listClinicPlans(tx, C.cobro))
    expect(plans.map((plan) => plan.code)).toEqual(["lista"])
    expect(await getPublicTrialOffer(ownerDb, "dental")).toEqual({
      currency: "USD",
      creditCents: 5000,
      days: 14,
    })
    await expect(
      chooseSaasPlan(ownerDb, C.porTerminar, `${C.porTerminar}-owner`, "gestoria-prueba"),
    ).rejects.toMatchObject({ status: 409 })
  })
  it("un cargo a mano no cruza los planes de una clínica y los de una app", async () => {
    const period = { periodStart: days(-60), periodEnd: days(-30) }
    await expect(createSaasCharge(ownerDb, C.cobro, ADMIN, { planCode: "gestoria-prueba", ...period })).rejects.toMatchObject({ status: 400 })
    await expect(createSaasCharge(ownerDb, accountId, ADMIN, { planCode: "lista", ...period })).rejects.toMatchObject({ status: 400 })
    expect((await getSaasSubscription(ownerDb, C.cobro))?.planId).toBe(await planId("lista"))
  })
})

async function accountOf(ref: string): Promise<string> {
  const [row] = (await ownerDb.execute(
    sql`select id from admin.saas_account where external_ref = ${ref}`,
  )) as unknown as { id: string }[]
  return row!.id
}

import { createHash, randomUUID } from "node:crypto"
import type { AccountState, AppEvent } from "@odentia/contract"
import { isSigningSecret } from "@odentia/contract/signing"
import type { Db } from "@odentia/db"
import {
  appContractMessage,
  SAAS_ACCOUNT_EXTERNAL_APPS,
  type SaasAccountExternalApp,
  saasAccount,
} from "@odentia/db/schema/admin-accounts"
import { supportCase, supportMessage } from "@odentia/db/schema/admin-support"
import { user } from "@odentia/db/schema/auth"
import { auditEvent } from "@odentia/db/schema/org"
import { saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { openSupportCaseFromHelp } from "./admin-support.js"
import { type ExternalAccount, externalAccountOf, toExternalAccount } from "./app-accounts.js"
import { applyTeamChanged } from "./app-places.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { normalizeForSearch } from "./knowledge.js"
import {
  type ActionPricing,
  getActionPricing,
  getSaasConsumption,
  insertAction,
  planPrices,
  priceFor,
} from "./saas-actions.js"
import {
  assertSaasCurrencyChange,
  decideSaasAccess,
  getSaasSubscription,
  listSaasCharges,
  listSaasPaymentMethods,
  listSaasPayments,
  readOnlyAtOf,
  type SaasSubscriptionRow,
  setNewClinicSpendCap,
  submitSaasReceipt,
} from "./saas-billing.js"
import { addMonth, listSaasChargeLines } from "./saas-invoicing.js"
import { getSaasAlerts } from "./saas-terms.js"
import type { Storage } from "./storage.js"

/**
 * El lado de la administración en el acuerdo con las apps que son otro sistema (ADR 0211, paso 4
 * del lienzo A). La app avisa lo que pasó (abrió una cuenta, esto usó, pide soporte) y pregunta
 * el estado de una cuenta; la administración guarda y cobra con las mismas tablas que las
 * clínicas, sin tocar a ninguna. Todo con la conexión propietaria: la app no tiene clínica ni
 * sesión aquí, solo su firma.
 *
 * Reglas del acuerdo:
 * - Nada se cuenta dos veces: la clave de cada aviso (`webhook-id`) queda en
 *   `app_contract_message` en la misma transacción que su efecto. Repetido, se reconoce.
 * - La app cuenta y la administración cobra: lo usado se valora con el plan de esa cuenta.
 * - Una cuenta de otra app solo tiene suscripción con un plan de su app: sin plan de lista, se
 *   abre sin suscripción (nada que cobrar) hasta que la administración le asigna uno.
 */

/** Con qué secreto firma cada app lo que le dice a la administración. Sin él, el acuerdo no existe. */
export interface AppContractPeer {
  app: SaasAccountExternalApp
  secret: string
}

/** Lo que dice el entorno (`<APP>_CONTRACT_SECRET`); solo lo completo y válido. */
export function appContractPeersFromEnv(env: { GESTORIA_CONTRACT_SECRET?: string | undefined }): {
  peers: AppContractPeer[]
  problems: string[]
} {
  const configured: Record<SaasAccountExternalApp, string | undefined> = {
    gestoria: env.GESTORIA_CONTRACT_SECRET,
  }
  const peers: AppContractPeer[] = []
  const problems: string[] = []
  for (const app of SAAS_ACCOUNT_EXTERNAL_APPS) {
    const secret = configured[app]?.trim() ?? ""
    if (!secret) continue
    if (!isSigningSecret(secret)) {
      problems.push(
        `El secreto del acuerdo con ${app} es whsec_ y al menos 24 bytes en base64: el acuerdo queda apagado.`,
      )
      continue
    }
    peers.push({ app, secret })
  }
  return { peers, problems }
}

/** La palabra de cada resultado de una conversación en el cobro: «pedido» es lo que sube (Gestiona). */
const TIER_OF_OUTCOME = { atendida: "informa", pedido: "gestiona" } as const

const DETAIL_OF_TIER = {
  informa: "Atendió una conversación",
  gestiona: "Atendió una conversación y tomó un pedido",
} as const

const CHANNEL_NAME: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  webchat: "el chat de la web",
}

/** Lo que cobra una cuenta sin plan: nada, y se anota igual (sin importe, nunca 0). */
function unpriced(): ActionPricing {
  const prices = planPrices(undefined)
  return {
    planId: null,
    currency: null,
    creditCents: 0,
    discountBps: 0,
    maxDiscountBps: 0,
    base: { conversacion: null, consulta: null, cita: null, preguntas: null, almacenamiento: null },
    prices,
    fixed: new Set(),
    argos: { included: 0, packQuestions: 100 },
    storageIncludedGb: 0,
    informMessageLimit: null,
  }
}

async function findAccount(
  tx: Db,
  app: SaasAccountExternalApp,
  ref: string,
): Promise<ExternalAccount | null> {
  const [row] = await tx
    .select()
    .from(saasAccount)
    .where(and(eq(saasAccount.app, app), eq(saasAccount.externalRef, ref.trim())))
    .limit(1)
  return row ? toExternalAccount(row) : null
}

async function requireAccount(
  tx: Db,
  app: SaasAccountExternalApp,
  ref: string,
): Promise<ExternalAccount> {
  const account = await findAccount(tx, app, ref)
  if (!account)
    throw new ServiceError(
      "NOT_FOUND",
      404,
      "Esa cuenta no existe: avisa primero que se abrió (cuenta.abierta)",
    )
  return account
}

async function audit(
  tx: Db,
  accountId: string,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: accountId,
    actorUserId: "system",
    entity: "saas_subscription",
    entityId: accountId,
    action,
    metadata,
  })
}

/** El plan de lista de una app: con él abre y prueba una cuenta nueva suya. */
async function defaultAppPlan(tx: Db, app: SaasAccountExternalApp) {
  const [plan] = await tx
    .select()
    .from(saasPlan)
    // El plan de una app que es otro sistema lleva la app en su producto.
    .where(
      and(eq(saasPlan.product, app), eq(saasPlan.isDefault, true), eq(saasPlan.isActive, true)),
    )
    .limit(1)
  return plan ?? null
}

/** La prueba de una cuenta con un plan de su app, con los días y el saldo de ese plan (como una clínica). */
async function startAppTrial(
  tx: Db,
  accountId: string,
  plan: typeof saasPlan.$inferSelect,
  now: Date,
): Promise<void> {
  const trialEndsAt = new Date(now.getTime() + plan.trialDays * 86_400_000)
  await tx.insert(saasSubscription).values({
    organizationId: accountId,
    planId: plan.id,
    status: "prueba",
    trialStartedAt: now,
    trialEndsAt,
    currentPeriodStart: now,
    currentPeriodEnd: trialEndsAt,
  })
  await audit(tx, accountId, "saas.trial_started", {
    planCode: plan.code,
    trialEndsAt: trialEndsAt.toISOString(),
  })
  // El presupuesto del mes nace con la cuota del plan, como en una clínica (ADR 0141).
  await setNewClinicSpendCap(tx, accountId, "system")
}

/** Abrió o cambió una cuenta: la primera vez la abre (con su prueba, si hay plan de lista). */
async function applyAccountOpened(
  tx: Db,
  app: SaasAccountExternalApp,
  event: Extract<AppEvent, { type: "cuenta.abierta" }>,
  now: Date,
): Promise<string> {
  const { account: ref, name, country, ownerUserId } = event.data
  const at = new Date(event.timestamp)
  // Dos avisos de la misma cuenta a la vez no abren dos.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`app-account:${app}:${ref}`}, 0))`,
  )
  const existing = await findAccount(tx, app, ref)
  if (existing) {
    // Un aviso más viejo que llega tarde (un reintento) no pisa lo último que dijo la app.
    if (existing.syncedAt && existing.syncedAt > at) return existing.id
    await tx
      .update(saasAccount)
      .set({ name, country, ownerUserId, syncedAt: at })
      .where(eq(saasAccount.id, existing.id))
    return existing.id
  }
  // Su id nunca es el de una clínica: toda clínica ya tiene su cuenta con su mismo id (ADR 0210).
  const id = randomUUID()
  await tx
    .insert(saasAccount)
    .values({ id, app, externalRef: ref, name, country, ownerUserId, syncedAt: at })
  const plan = await defaultAppPlan(tx, app)
  if (plan) await startAppTrial(tx, id, plan, now)
  return id
}

/** Lo que usó: una conversación, que sube a «pedido» mientras no se haya cobrado. */
async function applyUsage(
  tx: Db,
  app: SaasAccountExternalApp,
  event: Extract<AppEvent, { type: "uso.contado" }>,
): Promise<string> {
  const { data } = event
  const account = await requireAccount(tx, app, data.account)
  const occurredAt = new Date(data.occurredAt)
  const tier = TIER_OF_OUTCOME[data.outcome]
  const channel = data.channel ?? null
  const detail = `${DETAIL_OF_TIER[tier]}${channel ? ` por ${CHANNEL_NAME[channel] ?? channel}` : ""}`
  const dedupeKey = `${app}:conversacion:${data.conversation}`
  const sub = await getSaasSubscription(tx, account.id)
  // Siempre con el plan de su suscripción, que es de su app: nunca el de lista de una clínica.
  const pricing = sub?.planId ? await getActionPricing(tx, account.id, occurredAt) : unpriced()
  // La misma conversación, avisada otra vez o con otro resultado, es una sola acción.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`saas-action:${account.id}:${dedupeKey}`}, 0))`,
  )
  const [current] = await tx
    .select()
    .from(saasAction)
    .where(and(eq(saasAction.organizationId, account.id), eq(saasAction.dedupeKey, dedupeKey)))
    .limit(1)
  if (!current) {
    await insertAction(
      tx,
      account.id,
      "conversacion",
      { tier, occurredAt, channel, detail, dedupeKey },
      pricing,
    )
    return account.id
  }
  // Sube de «atendida» a «pedido» si todavía no se cobró; lo cobrado no se reescribe.
  if (current.tier === "informa" && tier === "gestiona" && current.chargeId === null) {
    const price = priceFor(pricing, "gestiona")
    await tx
      .update(saasAction)
      .set({
        tier,
        detail,
        currency: pricing.currency,
        ...price,
        tierChangedAt: occurredAt,
        previousPriceMicros: current.priceMicros,
      })
      // Si el cobro la tomó mientras tanto, no se reescribe: no hace nada.
      .where(and(eq(saasAction.id, current.id), isNull(saasAction.chargeId)))
  }
  return account.id
}

/**
 * Pide soporte: el caso es de la cuenta y de quien pregunta, como el de una clínica. Pregunta
 * cualquier rol de la cuenta (ADR 0221): la pantalla y el rol que manda la app quedan en el caso,
 * como los que deja la Ayuda de una clínica.
 */
async function applySupport(
  tx: Db,
  app: SaasAccountExternalApp,
  event: Extract<AppEvent, { type: "soporte.pedido" }>,
): Promise<string> {
  const { data } = event
  const account = await requireAccount(tx, app, data.account)
  const [person] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, data.userId))
    .limit(1)
  if (!person) throw invalidField("userId", "Esa persona no tiene cuenta")
  await openSupportCaseFromHelp(tx, account.id, {
    userId: data.userId,
    kind: data.kind,
    question: data.question,
    detail: data.detail ?? null,
    screen: data.screen ?? "/",
    role: data.role ?? "",
    appVersion: null,
    dedupeKey: createHash("sha256")
      .update(normalizeForSearch(data.question))
      .digest("hex")
      .slice(0, 32),
  })
  return account.id
}

/** Lo que el aviso de un comprobante necesita para guardarlo: el almacenamiento de los comprobantes. */
export interface AppEventDeps {
  storage?: Pick<Storage, "putAttachment">
}

/**
 * Subió un comprobante de un cargo: queda por confirmar, como el que sube una clínica (las mismas
 * reglas de `submitSaasReceipt`: el cargo de la cuenta, el saldo, un solo pendiente por cargo y
 * el contenido del archivo mirado por sus bytes, nunca por lo que dice). La clave del pago es la
 * del aviso: repetido, devuelve el mismo.
 */
async function applyReceipt(
  tx: Db,
  app: SaasAccountExternalApp,
  messageId: string,
  event: Extract<AppEvent, { type: "pago.comprobante" }>,
  deps: AppEventDeps,
  now: Date,
): Promise<string> {
  const { data } = event
  if (!deps.storage)
    throw new ServiceError("UNAVAILABLE", 503, "Los comprobantes no se pueden guardar ahora")
  const account = await requireAccount(tx, app, data.account)
  const [person] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, data.userId))
    .limit(1)
  if (!person) throw invalidField("userId", "Esa persona no tiene cuenta")
  const bytes = Buffer.from(data.file.base64, "base64")
  // Un cargo o un medio de pago que ya no está es un rechazo de lo que dice el aviso (409): la app
  // no lo reintenta. El 404 queda para la cuenta que no existe, que sí se reintenta.
  await submitSaasReceipt(
    tx,
    { storage: deps.storage },
    account.id,
    data.userId,
    {
      chargeId: data.chargeId,
      methodCode: data.methodCode,
      amountCents: data.amountCents,
      receipt: { bytes, contentType: data.file.contentType, filename: "comprobante" },
      idempotencyKey: `${app}:${messageId}`.slice(0, 200),
      ...(data.note ? { notes: data.note } : {}),
    },
    now,
  ).catch((error: unknown) => {
    if (error instanceof ServiceError && error.status === 404)
      throw new ServiceError("CONFLICT", 409, error.message, error.fields)
    throw error
  })
  return account.id
}

/**
 * Quién está en una cuenta de la app: lo guarda la cuenta única (la copia de sus lugares,
 * `app-places.ts`). No hace falta que la administración ya conozca la cuenta: si la conoce,
 * la clave queda con ella.
 */
async function applyTeam(
  tx: Db,
  app: SaasAccountExternalApp,
  event: Extract<AppEvent, { type: "equipo.cambiado" }>,
): Promise<string | null> {
  await applyTeamChanged(tx, app, event)
  return (await findAccount(tx, app, event.data.account))?.id ?? null
}

/**
 * Recibe un aviso de una app. La clave (`messageId`, el `webhook-id` firmado) y su efecto van
 * juntos: si la clave ya estaba, no hace nada y lo dice. Si el efecto falla (una cuenta que no
 * existe), no queda la clave y la app puede reintentar con la misma.
 */
export async function receiveAppEvent(
  ownerDb: Db,
  app: SaasAccountExternalApp,
  messageId: string,
  event: AppEvent,
  now = new Date(),
  deps: AppEventDeps = {},
): Promise<{ repeated: boolean }> {
  return ownerDb.transaction(async (tx) => {
    const [fresh] = await tx
      .insert(appContractMessage)
      .values({ app, id: messageId, type: event.type, receivedAt: now })
      .onConflictDoNothing()
      .returning({ id: appContractMessage.id })
    if (!fresh) return { repeated: true }
    const accountId =
      event.type === "equipo.cambiado"
        ? await applyTeam(tx, app, event)
        : event.type === "cuenta.abierta"
        ? await applyAccountOpened(tx, app, event, now)
        : event.type === "uso.contado"
          ? await applyUsage(tx, app, event)
          : event.type === "pago.comprobante"
            ? await applyReceipt(tx, app, messageId, event, deps, now)
            : await applySupport(tx, app, event)
    await tx
      .update(appContractMessage)
      .set({ accountId })
      .where(and(eq(appContractMessage.app, app), eq(appContractMessage.id, messageId)))
    return { repeated: false }
  })
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null)

/**
 * El estado de una cuenta para la app: si puede seguir y su tope, su plan, sus cargos y pagos,
 * los avisos que debe mostrar y las respuestas de soporte. Solo lectura.
 */
export async function answerAppState(
  ownerDb: Db,
  app: SaasAccountExternalApp,
  ref: string,
  now = new Date(),
): Promise<AccountState> {
  const empty: AccountState = {
    account: ref,
    found: false,
    at: now.toISOString(),
    access: null,
    agents: null,
    budget: null,
    plan: null,
    charges: [],
    payments: [],
    notices: [],
    paymentMethods: [],
    support: [],
  }
  const account = await findAccount(ownerDb, app, ref)
  if (!account) return empty
  const id = account.id
  const sub = await getSaasSubscription(ownerDb, id)
  const decision = await decideSaasAccess(ownerDb, id, "operar")
  const [plan] = sub?.planId
    ? await ownerDb.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
    : []
  const consumption = plan ? await getSaasConsumption(ownerDb, id, now) : null
  const alerts = sub ? await getSaasAlerts(ownerDb, id, now) : []
  const charges = await listSaasCharges(ownerDb, id, 24)
  const lines = await listSaasChargeLines(
    ownerDb,
    id,
    charges.map((charge) => charge.id),
  )
  const payments = await listSaasPayments(ownerDb, id, 50)
  const methods = await listSaasPaymentMethods(ownerDb)
  const cases = await ownerDb
    .select({
      id: supportCase.id,
      status: supportCase.status,
      question: supportCase.question,
      createdAt: supportCase.createdAt,
      openedBy: supportCase.openedBy,
    })
    .from(supportCase)
    .where(eq(supportCase.organizationId, id))
    .orderBy(desc(supportCase.createdAt))
    .limit(20)
  const replies = cases.length
    ? await ownerDb
        .select({
          caseId: supportMessage.caseId,
          body: supportMessage.body,
          createdAt: supportMessage.createdAt,
        })
        .from(supportMessage)
        .where(
          and(
            eq(supportMessage.organizationId, id),
            inArray(
              supportMessage.caseId,
              cases.map((kase) => kase.id),
            ),
            eq(supportMessage.isInternal, false),
            eq(supportMessage.authorKind, "staff"),
          ),
        )
        .orderBy(asc(supportMessage.createdAt))
    : []
  return {
    ...empty,
    found: true,
    access: {
      allowed: decision.allowed,
      status: decision.status,
      reason: decision.reason,
      readOnlyAt: sub?.status === "gracia" ? iso(readOnlyAtOf(sub, now)) : null,
      trialEndsAt: sub?.status === "prueba" ? iso(sub.trialEndsAt) : null,
    },
    agents: {
      trialExhausted: alerts.some(
        (alert) => alert.family === "saldo_prueba" && alert.level === "limite",
      ),
      capReached: alerts.some((alert) => alert.family === "tope" && alert.level === "limite"),
    },
    budget: consumption
      ? {
          currency: consumption.currency,
          creditCents: consumption.creditCents,
          creditUsedCents: consumption.creditUsedCents,
          capCents: consumption.budget.capCents,
          spentCents: consumption.budget.spentCents,
          periodStart: consumption.period.start.toISOString(),
          periodEnd: consumption.period.end.toISOString(),
        }
      : null,
    plan: plan
      ? {
          code: plan.code,
          name: plan.name,
          currency: plan.currency,
          priceCents: plan.priceCents,
          creditCents: plan.creditCents,
        }
      : null,
    charges: charges.map((charge) => ({
      id: charge.id,
      periodStart: charge.periodStart.toISOString(),
      periodEnd: charge.periodEnd.toISOString(),
      amountCents: charge.amountCents,
      paidCents: charge.paidCents,
      currency: charge.currency,
      status: charge.status,
      dueAt: iso(charge.dueAt),
      lines: lines
        .filter((line) => line.chargeId === charge.id)
        .map((line) => ({
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          amountCents: line.amountCents,
        })),
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      chargeId: payment.chargeId,
      amountCents: payment.amountCents,
      currency: payment.currency,
      status: payment.status,
      at: payment.createdAt.toISOString(),
    })),
    paymentMethods: methods.map(({ code, name, instructions }) => ({ code, name, instructions })),
    notices: alerts.map((alert) => ({
      key: `${alert.family}:${alert.level}:${alert.periodKey}`,
      family: alert.family,
      level: alert.level,
      action: alert.action,
    })),
    support: cases.map((kase) => ({
      id: kase.id,
      status: kase.status,
      question: kase.question,
      createdAt: kase.createdAt.toISOString(),
      // Quién lo abrió: la app le muestra a cada persona solo sus preguntas.
      userId: kase.openedBy,
      replies: replies
        .filter((reply) => reply.caseId === kase.id)
        .map((reply) => ({ body: reply.body, at: reply.createdAt.toISOString() })),
    })),
  }
}

/* ---------- Lo que hace la administración con una cuenta de otra app ---------- */

/** Una fila de la lista de cuentas de otras apps, con su estado y lo que debe. */
export interface AppAccountRow extends ExternalAccount {
  status: SaasSubscriptionRow["status"] | "sin_suscripcion"
  planCode: string | null
  planName: string | null
  ownerEmail: string | null
}

/** Las cuentas de las apps que son otro sistema, de la más nueva a la más vieja. */
export async function listAppAccounts(
  tx: Db,
  query: { limit?: number } = {},
): Promise<AppAccountRow[]> {
  const rows = await tx
    .select({
      account: saasAccount,
      status: saasSubscription.status,
      planCode: saasPlan.code,
      planName: saasPlan.name,
      ownerEmail: user.email,
    })
    .from(saasAccount)
    .leftJoin(saasSubscription, eq(saasSubscription.organizationId, saasAccount.id))
    .leftJoin(saasPlan, eq(saasPlan.id, saasSubscription.planId))
    .leftJoin(user, eq(user.id, saasAccount.ownerUserId))
    .where(sql`${saasAccount.organizationId} is null`)
    .orderBy(desc(saasAccount.createdAt))
    .limit(Math.min(Math.max(query.limit ?? 100, 1), 200))
  return rows.flatMap((row) => {
    const account = toExternalAccount(row.account)
    if (!account) return []
    return [
      {
        ...account,
        status: (row.status as SaasSubscriptionRow["status"] | null) ?? "sin_suscripcion",
        planCode: row.planCode,
        planName: row.planName,
        ownerEmail: row.ownerEmail,
      },
    ]
  })
}

/** La cuenta de otra app, o 404 si es una clínica o no existe. */
export async function requireAppAccount(tx: Db, accountId: string): Promise<ExternalAccount> {
  const account = await externalAccountOf(tx, accountId)
  if (!account) throw notFound("Cuenta")
  return account
}

/**
 * La administración le asigna un plan de su app a una cuenta de otra app: sin suscripción, abre
 * su prueba con ese plan; con suscripción, cambia el plan con las reglas de siempre (la moneda no
 * cambia con saldo en otra; fuera de la prueba, el primer plan empieza su mes hoy). Un plan de
 * clínicas nunca entra aquí, ni uno de otra app.
 */
export async function assignAppAccountPlan(
  tx: Db,
  accountId: string,
  actorUserId: string,
  planCode: string,
  now = new Date(),
): Promise<SaasSubscriptionRow> {
  const account = await requireAppAccount(tx, accountId)
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.code, planCode.trim())).limit(1)
  if (!plan || !plan.isActive)
    throw invalidField("planCode", "Ese plan no existe o está archivado: elige otro.")
  if (plan.product !== account.app)
    throw invalidField("planCode", "Ese plan no es de la app de esta cuenta: elige uno de la suya.")
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`saas:${accountId}`}, 0))`)
  const current = await getSaasSubscription(tx, accountId)
  if (!current) {
    await startAppTrial(tx, accountId, plan, now)
  } else if (current.planId !== plan.id) {
    await assertSaasCurrencyChange(tx, accountId, plan.currency)
    const starts = current.status !== "prueba" && !current.activatedAt
    await tx
      .update(saasSubscription)
      .set({
        planId: plan.id,
        ...(starts
          ? { activatedAt: now, currentPeriodStart: now, currentPeriodEnd: addMonth(now) }
          : {}),
        updatedAt: now,
      })
      .where(eq(saasSubscription.organizationId, accountId))
    await tx.insert(auditEvent).values({
      organizationId: accountId,
      actorUserId,
      entity: "saas_subscription",
      entityId: accountId,
      action: "saas.plan_changed",
      metadata: { planCode: plan.code },
    })
  }
  const updated = await getSaasSubscription(tx, accountId)
  if (!updated) throw new ServiceError("INTERNAL", 409, "No se pudo leer la suscripción")
  return updated
}

/** La ficha de una cuenta de otra app para la administración: lo que sabe la app y lo que ve la administración. */
export interface AppAccountDetail {
  account: ExternalAccount & { ownerEmail: string | null; ownerName: string | null }
  subscription: SaasSubscriptionRow | null
  /** Lo mismo que la app recibe al preguntar (`answerAppState`). */
  state: AccountState
  /** Los pagos con quién rechazó cada comprobante: solo la administración lo lee. */
  payments: Awaited<ReturnType<typeof listSaasPayments>>
}

export async function getAppAccountDetail(
  tx: Db,
  accountId: string,
  now = new Date(),
): Promise<AppAccountDetail> {
  const account = await requireAppAccount(tx, accountId)
  const [owner] = account.ownerUserId
    ? await tx
        .select({ email: user.email, name: user.name })
        .from(user)
        .where(eq(user.id, account.ownerUserId))
        .limit(1)
    : []
  return {
    account: { ...account, ownerEmail: owner?.email ?? null, ownerName: owner?.name ?? null },
    subscription: await getSaasSubscription(tx, accountId),
    state: await answerAppState(tx, account.app, account.externalRef, now),
    payments: await listSaasPayments(tx, accountId, 50, { staffNames: true }),
  }
}

import { randomUUID } from "node:crypto"
import {
  type AccountCopyState,
  accountCopy,
  accountEventReceipt,
  type Db,
  storeEvent,
  storeInvitation,
  storeMember,
  withSessionLock,
} from "@gestoria/db"
import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm"
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose"
import { z } from "zod"
import { noteStoreAccount, noteStoreTeam } from "./acuerdo.js"
import { signMessage, verifyMessage } from "./firma.js"

/**
 * gestorIA y la cuenta única (ADR 0201 y 0203). La cuenta vive con las clínicas y gestorIA
 * nunca lee su base: reconoce a quien entró por el token que firma la cuenta (EdDSA, 15 min,
 * `aud` gestoria) y guarda una copia de su nombre, correo y foto. La copia se pone al día con
 * cada token, con los avisos firmados de la cuenta y con la revisión diaria.
 */

/** La app que la cuenta pone como destinatario del token en la entrada de gestorIA. */
export const ACCOUNT_AUDIENCE = "gestoria"

export interface Person {
  userId: string
  email: string
  name: string
  /**
   * La sesión que pidió el token pasó el código del personal del grupo, con la regla de la
   * administración (ADR 0219). Sin esto, soporte no mira ninguna tienda.
   */
  staffVerified?: boolean
}

export interface AccountConfig {
  /** La entrada a la cuenta en el dominio de gestorIA (`https://api.gestoria24.com`): emite el token. */
  url: string
  /** El secreto de los avisos (`whsec_…`), el mismo que tiene la cuenta; sin él no hay avisos ni revisión. */
  eventsSecret: string
  /** Las llaves públicas de la cuenta; por omisión, las de `<url>/api/auth/jwks`. */
  keys?: JWTVerifyGetKey
  /** Para las pruebas: cómo llamar a la cuenta. */
  fetch?: typeof fetch
}

export function accountKeys(config: AccountConfig): JWTVerifyGetKey {
  return config.keys ?? createRemoteJWKSet(new URL("/api/auth/jwks", config.url))
}

const claims = z.object({
  sub: z.string().min(1).max(200),
  email: z.string().email(),
  emailVerified: z.literal(true),
  name: z.string().max(200),
  image: z.string().max(2000).nullish(),
  iat: z.number().int(),
  /** Lo dice la cuenta al firmar (ADR 0219); falta en los tokens de antes, y entonces es no. */
  staffVerified: z.boolean().optional(),
})
export type AccountClaims = z.infer<typeof claims>

export class AccountError extends Error {
  constructor(
    readonly code: "UNAUTHORIZED" | "ACCOUNT_CLOSED" | "ACCOUNT_BLOCKED",
    message: string,
  ) {
    super(message)
  }
}

/** Lee y comprueba el token de la cuenta: firma, emisor, destinatario y vigencia. */
export async function readAccountToken(
  token: string,
  config: AccountConfig,
  keys: JWTVerifyGetKey,
): Promise<AccountClaims> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.url.replace(/\/$/, ""),
      audience: ACCOUNT_AUDIENCE,
      algorithms: ["EdDSA"],
      requiredClaims: ["sub", "exp", "iat"],
    })
    return claims.parse(payload)
  } catch {
    throw new AccountError("UNAUTHORIZED", "Tu sesión venció. Vuelve a entrar.")
  }
}

/** Cada cuánto se anota que alguien sigue usando gestorIA (no en cada pedido). */
const SEEN_EVERY_MS = 5 * 60_000

/**
 * Pone al día la copia de quien llega con un token y dice si puede seguir. Un token emitido
 * después de que su copia quedó bloqueada o cerrada prueba que la cuenta volvió a abrirse: la
 * cuenta no da sesión a una cuenta bloqueada ni cerrada.
 */
export async function syncAccountCopy(
  ownerDb: Db,
  who: AccountClaims,
  now = new Date(),
): Promise<Person> {
  const values = { name: who.name, email: who.email.toLowerCase(), image: who.image ?? null }
  await ownerDb
    .insert(accountCopy)
    .values({ userId: who.sub, ...values })
    .onConflictDoNothing()
  const [copy] = await ownerDb.select().from(accountCopy).where(eq(accountCopy.userId, who.sub))
  if (!copy) throw new AccountError("UNAUTHORIZED", "Tu sesión venció. Vuelve a entrar.")
  const issuedAt = who.iat * 1000
  const reopened = copy.state !== "activa" && issuedAt > copy.stateChangedAt.getTime()
  if (copy.state !== "activa" && !reopened)
    throw copy.state === "cerrada"
      ? new AccountError("ACCOUNT_CLOSED", "Esta cuenta está cerrada.")
      : new AccountError(
          "ACCOUNT_BLOCKED",
          "Tu cuenta está bloqueada. Escribe a soporte para revisarla.",
        )
  const changed =
    copy.name !== values.name || copy.email !== values.email || copy.image !== values.image
  if (reopened || changed || now.getTime() - copy.seenAt.getTime() > SEEN_EVERY_MS) {
    const updated = await ownerDb
      .update(accountCopy)
      .set({
        ...values,
        seenAt: now,
        ...(changed || reopened ? { updatedAt: now } : {}),
        ...(reopened ? { state: "activa" as const, stateChangedAt: now } : {}),
      })
      // Si el estado cambió entre medio (un aviso o la revisión lo bloqueó), no se pisa. Se
      // compara en milisegundos: la base guarda microsegundos y la fecha leída no los trae, y
      // compararla entera no coincidía nunca (el pedido se quedaba dando vueltas).
      .where(
        and(
          eq(accountCopy.userId, who.sub),
          sql`date_trunc('milliseconds', ${accountCopy.stateChangedAt}) = ${copy.stateChangedAt.toISOString()}::timestamptz`,
        ),
      )
      .returning({ userId: accountCopy.userId })
    if (updated.length === 0) return syncAccountCopy(ownerDb, who, now)
  }
  return { userId: who.sub, email: values.email, name: values.name }
}

/* ---------- Lo que la cuenta dice de las personas que gestorIA ya conoce ---------- */

const reviewed = z.object({
  accounts: z.array(
    z.object({
      userId: z.string(),
      found: z.boolean(),
      blocked: z.boolean(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      emailVerified: z.boolean(),
      image: z.string().nullable(),
    }),
  ),
})
export type ReviewedAccount = z.infer<typeof reviewed>["accounts"][number]

/** Lo más que se pregunta de una vez (lo mismo que acepta la cuenta). */
export const REVIEW_BATCH = 500

/** Le pregunta a la cuenta por estas personas, firmando con el secreto de los avisos. */
export async function askAccount(
  config: AccountConfig,
  userIds: string[],
): Promise<ReviewedAccount[]> {
  if (!config.eventsSecret)
    throw new Error("Sin el secreto de los avisos no se puede preguntar a la cuenta")
  const body = JSON.stringify({ userIds })
  const response = await (config.fetch ?? fetch)(new URL("/api/account-apps/review", config.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signMessage({ secret: config.eventsSecret, id: `rev_${randomUUID()}`, body }),
    },
    body,
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  })
  if (!response.ok) throw new Error(`La cuenta respondió ${response.status} a la revisión`)
  return reviewed.parse(await response.json()).accounts
}

/** Lo que dice la cuenta, en la copia. Una que la cuenta no conoce no se toca: sería un error de configuración. */
async function applyReview(tx: Db, account: ReviewedAccount, now: Date): Promise<void> {
  if (!account.found || !account.name || !account.email) {
    await tx
      .update(accountCopy)
      .set({ reviewedAt: now })
      .where(eq(accountCopy.userId, account.userId))
    return
  }
  const [copy] = await tx.select().from(accountCopy).where(eq(accountCopy.userId, account.userId))
  if (!copy || copy.state === "cerrada") {
    if (copy)
      await tx
        .update(accountCopy)
        .set({ reviewedAt: now })
        .where(eq(accountCopy.userId, account.userId))
    return
  }
  const state: AccountCopyState = account.blocked ? "bloqueada" : "activa"
  await tx
    .update(accountCopy)
    .set({
      name: account.name,
      email: account.email.toLowerCase(),
      image: account.image,
      reviewedAt: now,
      updatedAt: now,
      ...(state !== copy.state ? { state, stateChangedAt: now } : {}),
    })
    .where(eq(accountCopy.userId, account.userId))
}

/**
 * Cierra la copia y saca a la persona de todos sus equipos, dejándolo anotado en cada tienda.
 * Sus invitaciones pendientes se anulan. Si era el único Dueño de una tienda, el Administrador
 * más antiguo pasa a Dueño (anotado): una tienda nunca se queda sin quien decida el plan. Sin
 * Administrador, la tienda queda sin Dueño y lo dice su registro.
 */
async function closeCopy(tx: Db, userId: string, now: Date): Promise<void> {
  await tx
    .update(accountCopy)
    .set({ state: "cerrada", stateChangedAt: now, updatedAt: now })
    .where(and(eq(accountCopy.userId, userId), ne(accountCopy.state, "cerrada")))
  await tx
    .update(storeInvitation)
    .set({ revokedAt: now, revokedBy: userId })
    .where(
      and(
        eq(storeInvitation.invitedBy, userId),
        isNull(storeInvitation.acceptedAt),
        isNull(storeInvitation.revokedAt),
      ),
    )
  const memberships = await tx
    .delete(storeMember)
    .where(eq(storeMember.userId, userId))
    .returning({ storeId: storeMember.storeId, role: storeMember.role })
  for (const m of memberships) {
    // eslint-disable-next-line no-await-in-loop
    await tx.insert(storeEvent).values({
      storeId: m.storeId,
      actorUserId: null,
      action: "cuenta.cerrada",
      subject: userId,
      detail: { role: m.role },
    })
    if (m.role !== "owner") continue
    // eslint-disable-next-line no-await-in-loop
    const [owner] = await tx
      .select({ userId: storeMember.userId })
      .from(storeMember)
      .where(and(eq(storeMember.storeId, m.storeId), eq(storeMember.role, "owner")))
      .limit(1)
    if (owner) {
      // Otro Dueño sigue: la administración sabe quién es ahora (el acuerdo, B7).
      // eslint-disable-next-line no-await-in-loop
      await noteStoreAccount(tx, m.storeId, now)
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    const [admin] = await tx
      .select({ userId: storeMember.userId })
      .from(storeMember)
      .where(and(eq(storeMember.storeId, m.storeId), eq(storeMember.role, "admin")))
      .orderBy(asc(storeMember.createdAt), asc(storeMember.userId))
      .limit(1)
    if (!admin) {
      console.warn(
        `gestoria-api: la tienda ${m.storeId} quedó sin Dueño al cerrarse la cuenta de su único Dueño`,
      )
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    await tx
      .update(storeMember)
      .set({ role: "owner" })
      .where(and(eq(storeMember.storeId, m.storeId), eq(storeMember.userId, admin.userId)))
    // eslint-disable-next-line no-await-in-loop
    await tx.insert(storeEvent).values({
      storeId: m.storeId,
      actorUserId: null,
      action: "equipo.rol",
      subject: admin.userId,
      detail: { from: "admin", to: "owner", motivo: "El único Dueño cerró su cuenta" },
    })
    // eslint-disable-next-line no-await-in-loop
    await noteStoreAccount(tx, m.storeId, now)
  }
  // La cuenta sabe quién quedó en cada tienda (ADR 0217).
  for (const m of memberships) {
    // eslint-disable-next-line no-await-in-loop
    await noteStoreTeam(tx, m.storeId)
  }
}

/* ---------- Los avisos de la cuenta ---------- */

const event = z.object({
  type: z.string().min(1).max(100),
  timestamp: z.string(),
  data: z.object({ userId: z.string().min(1).max(200) }),
})

export type ReceiveResult = { status: 200 | 401 | 400 | 503; message: string }

/**
 * Recibe un aviso firmado de la cuenta. Un repetido (mismo `webhook-id`) no se vuelve a aplicar.
 * `cuenta.cerrada` cierra la copia y saca a la persona de sus equipos. Cualquier otro aviso
 * (bloqueo, reapertura, un cambio de nombre o correo) se resuelve preguntándole a la cuenta lo
 * vigente de esa persona: así un aviso nuevo de la cuenta funciona sin cambiar gestorIA.
 * Si algo falla, responde 503 y la cuenta lo reintenta.
 */
export async function receiveAccountEvent(
  ownerDb: Db,
  config: AccountConfig,
  request: { headers: Headers; body: string },
  now = new Date(),
): Promise<ReceiveResult> {
  if (!config.eventsSecret)
    return { status: 503, message: "Los avisos de la cuenta no están configurados" }
  const id = verifyMessage({
    secret: config.eventsSecret,
    headers: request.headers,
    body: request.body,
    now,
  })
  if (!id) return { status: 401, message: "Firma inválida" }
  let parsed: z.infer<typeof event>
  try {
    parsed = event.parse(JSON.parse(request.body))
  } catch {
    return { status: 400, message: "Aviso ilegible" }
  }
  const { userId } = parsed.data
  const [seen] = await ownerDb
    .select({ id: accountEventReceipt.webhookId })
    .from(accountEventReceipt)
    .where(eq(accountEventReceipt.webhookId, id))
  if (seen) return { status: 200, message: "Ya recibido" }
  const [known] = await ownerDb
    .select({ userId: accountCopy.userId })
    .from(accountCopy)
    .where(eq(accountCopy.userId, userId))
  // Antes de la transacción: preguntarle a la cuenta no debe dejar una transacción abierta.
  let fresh: ReviewedAccount | undefined
  if (known && parsed.type !== "cuenta.cerrada") {
    try {
      ;[fresh] = await askAccount(config, [userId])
    } catch {
      return { status: 503, message: "No se pudo consultar la cuenta; reintenta" }
    }
  }
  await ownerDb.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(accountEventReceipt)
      .values({ webhookId: id, type: parsed.type, userId })
      .onConflictDoNothing()
      .returning({ id: accountEventReceipt.webhookId })
    if (!inserted || !known) return
    if (parsed.type === "cuenta.cerrada") await closeCopy(tx, userId, now)
    else if (fresh) await applyReview(tx, fresh, now)
  })
  return { status: 200, message: "Recibido" }
}

/* ---------- La revisión diaria ---------- */

/** Una copia se revisa una vez al día: la revisión corre cada hora y toma las que tocan. */
export const REVIEW_EVERY_MS = 24 * 3_600_000

export interface ReviewRun {
  reviewed: number
  failed: boolean
}

/**
 * La última red de los avisos (decisión 11 del lienzo A): compara con la cuenta cada copia que
 * no se revisó en el día. Corre en un solo proceso a la vez (candado de la base) y, si la cuenta
 * no responde, lo intenta en la vuelta siguiente.
 */
export async function reviewAccountCopies(
  ownerDb: Db,
  config: AccountConfig,
  now = new Date(),
): Promise<ReviewRun> {
  if (!config.eventsSecret) return { reviewed: 0, failed: false }
  // Un solo proceso a la vez, sin dejar una transacción abierta mientras se espera a la cuenta.
  const run = await withSessionLock(ownerDb, "gestoria_revision_de_cuentas", () =>
    reviewDue(ownerDb, config, now),
  )
  return run ?? { reviewed: 0, failed: false }
}

async function reviewDue(ownerDb: Db, config: AccountConfig, now: Date): Promise<ReviewRun> {
  {
    const due = new Date(now.getTime() - REVIEW_EVERY_MS)
    let reviewedCount = 0
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await ownerDb
        .select({ userId: accountCopy.userId })
        .from(accountCopy)
        .where(
          and(
            ne(accountCopy.state, "cerrada"),
            or(isNull(accountCopy.reviewedAt), lt(accountCopy.reviewedAt, due)),
          ),
        )
        .orderBy(sql`${accountCopy.reviewedAt} asc nulls first`, asc(accountCopy.userId))
        .limit(REVIEW_BATCH)
      if (batch.length === 0) return { reviewed: reviewedCount, failed: false }
      let answers: ReviewedAccount[]
      try {
        // eslint-disable-next-line no-await-in-loop
        answers = await askAccount(
          config,
          batch.map((row) => row.userId),
        )
      } catch {
        return { reviewed: reviewedCount, failed: true }
      }
      const asked = new Set(batch.map((row) => row.userId))
      // eslint-disable-next-line no-await-in-loop
      await ownerDb.transaction(async (tx) => {
        for (const answer of answers) {
          if (!asked.has(answer.userId)) continue
          asked.delete(answer.userId)
          // eslint-disable-next-line no-await-in-loop
          await applyReview(tx, answer, now)
        }
        // Las que la cuenta no nombró también quedan revisadas: no se pregunta por ellas en bucle.
        // eslint-disable-next-line no-await-in-loop
        for (const userId of asked)
          await tx
            .update(accountCopy)
            .set({ reviewedAt: now })
            .where(eq(accountCopy.userId, userId))
      })
      reviewedCount += batch.length
    }
  }
}

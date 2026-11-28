import {
  conversation,
  conversationMessage,
  type Db,
  productVariant,
  SETUP_STEPS,
  type SetupStep,
  store,
  storeDeliveryMethod,
  storeInvitation,
  storeMember,
  storePaymentLink,
  storePaymentMethod,
  storeSetup,
} from "@gestoria/db"
import { and, asc, count, countDistinct, eq, gt, isNull, ne, sql } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Los primeros pasos de una tienda nueva (lienzo «gestorIA como odentIA», tablero 16; ADR 0227):
 * «Tu tienda está casi lista», arriba de Inicio, para quien configura la tienda (`configuracion`:
 * Dueño y Administrador). Siete pasos, cada uno marcado solo con lo que ya está guardado en su
 * apartado: nadie marca «hecho» a mano. Nada obliga: se vende sin terminarlos.
 *
 * - Lo que no aplica a toda tienda se salta («No lo necesito»): trabajar sin equipo y vender sin
 *   Sofi. Lo demás lo necesita toda tienda para vender: no se salta, solo se deja para después.
 * - Los chats esperan la app de Meta: mientras tanto, el paso dice «Muy pronto» y no cuenta.
 * - Con todos hechos o saltados, la lista queda lista (`store_setup.finished_at`) y no vuelve,
 *   aunque después se apague un medio de pago.
 */

/** Los pasos que se pueden saltar porque no aplican a toda tienda. */
export const SKIPPABLE_STEPS: readonly SetupStep[] = ["sofi", "equipo"]

/**
 * Los pasos que no frenan la venta: con o sin equipo se vende. Se muestran, pero no se cuentan
 * como falta (ni en Inicio ni en «Lo que falta» de Configuración) y no impiden que la lista quede
 * lista.
 */
const NOT_SELLING_STEPS: readonly SetupStep[] = ["equipo"]

/**
 * Si ya se pueden conectar los chats. Mientras la Bandeja espera la app de Meta, no: el paso dice
 * «Muy pronto» y no cuenta para terminar. La entrega de la Bandeja lo enciende y dice cuándo un
 * canal queda conectado (`chats` de `SetupFacts`).
 */
export const CHATS_READY = false

/** Lo guardado que marca cada paso, y lo que la lista cuenta de él. */
export interface SetupFacts {
  /** El país de la tienda (Datos de la tienda): con él queda hecho. */
  country: string | null
  /** Los productos con alguna variante con stock. */
  productsWithStock: number
  /**
   * Los medios de pago encendidos con los que se cobra, por su nombre. El link de pago sin pasarela
   * conectada no cobra: no cuenta.
   */
  payments: string[]
  /** Las formas de entrega encendidas, por su nombre. */
  deliveries: string[]
  /** Un canal conectado; null mientras no se pueden conectar. */
  chats: boolean | null
  /** Le escribió a Sofi en «Probar a Sofi». */
  triedSofi: boolean
  /** Quienes son del equipo, y las invitaciones vigentes sin aceptar. */
  members: number
  invitations: number
}

export type SetupStepState = "hecho" | "falta" | "saltado" | "pronto"

export interface SetupStepView {
  step: SetupStep
  state: SetupStepState
  /** Se puede saltar con «No lo necesito». */
  skippable: boolean
  /** Frena la venta mientras falta: se cuenta en «3 de 5». */
  sells: boolean
}

function isDone(step: SetupStep, facts: SetupFacts): boolean | null {
  switch (step) {
    case "datos":
      return facts.country !== null
    case "catalogo":
      return facts.productsWithStock > 0
    case "pagos":
      return facts.payments.length > 0
    case "entregas":
      return facts.deliveries.length > 0
    case "chats":
      return facts.chats
    case "sofi":
      return facts.triedSofi
    case "equipo":
      return facts.members > 1 || facts.invitations > 0
  }
}

/** Cómo va cada paso, en su orden: hecho por lo guardado, saltado, falta o muy pronto. */
export function setupSteps(facts: SetupFacts, skipped: readonly SetupStep[]): SetupStepView[] {
  return SETUP_STEPS.map((step) => {
    const done = isDone(step, facts)
    const skippable = SKIPPABLE_STEPS.includes(step)
    const state: SetupStepState =
      done === null
        ? "pronto"
        : done
          ? "hecho"
          : skippable && skipped.includes(step)
            ? "saltado"
            : "falta"
    return { step, state, skippable, sells: !NOT_SELLING_STEPS.includes(step) }
  })
}

/** Lista: no falta nada que frene la venta (lo que todavía no se puede hacer no cuenta). */
export function setupFinished(steps: readonly SetupStepView[]): boolean {
  return steps.every((s) => s.state !== "falta" || !s.sells)
}

/**
 * Los medios de pago encendidos con los que se cobra, y la pasarela si está conectada (solo con
 * qué: sus llaves no salen de aquí). Un link de pago sin pasarela no cobra: no viene. Lo leen los
 * primeros pasos, «Lo que falta» de Configuración (`configOverview`) y Sofi (lo que ofrece y el
 * medio que elige), así cuentan lo mismo. Vienen enteros: quien responde al navegador elige qué
 * manda (nunca los datos de cobro).
 */
export async function chargingPaymentsIn(tx: Db, storeId: string) {
  const [gateway] = await tx
    .select({ provider: storePaymentLink.provider })
    .from(storePaymentLink)
    .where(eq(storePaymentLink.storeId, storeId))
  const payments = await tx
    .select()
    .from(storePaymentMethod)
    .where(
      and(
        eq(storePaymentMethod.storeId, storeId),
        eq(storePaymentMethod.isActive, true),
        gateway ? undefined : ne(storePaymentMethod.collection, "link"),
      ),
    )
    .orderBy(asc(storePaymentMethod.createdAt))
  return { payments, gateway: gateway ?? null }
}

/**
 * Lo guardado en cada apartado que marca los pasos. También lo lee «Lo que falta» de
 * Configuración (`configuracion.ts`): las dos listas miran lo mismo y no lo vuelven a contar.
 */
export async function setupFactsIn(tx: Db, storeId: string, now: Date): Promise<SetupFacts> {
  const [shop] = await tx
    .select({ country: store.country })
    .from(store)
    .where(eq(store.id, storeId))
  const [stocked] = await tx
    .select({ n: countDistinct(productVariant.productId) })
    .from(productVariant)
    .where(
      and(
        eq(productVariant.storeId, storeId),
        isNull(productVariant.removedAt),
        gt(productVariant.stock, 0),
      ),
    )
  const { payments } = await chargingPaymentsIn(tx, storeId)
  const deliveries = await tx
    .select({ name: storeDeliveryMethod.name })
    .from(storeDeliveryMethod)
    .where(and(eq(storeDeliveryMethod.storeId, storeId), eq(storeDeliveryMethod.isActive, true)))
    .orderBy(asc(storeDeliveryMethod.createdAt))
  const [tried] = await tx
    .select({ n: count() })
    .from(conversationMessage)
    .innerJoin(conversation, eq(conversation.id, conversationMessage.conversationId))
    .where(
      and(
        eq(conversation.storeId, storeId),
        eq(conversation.channel, "prueba"),
        eq(conversationMessage.author, "cliente"),
      ),
    )
  const [members] = await tx
    .select({ n: count() })
    .from(storeMember)
    .where(eq(storeMember.storeId, storeId))
  const [invited] = await tx
    .select({ n: count() })
    .from(storeInvitation)
    .where(
      and(
        eq(storeInvitation.storeId, storeId),
        isNull(storeInvitation.acceptedAt),
        isNull(storeInvitation.revokedAt),
        gt(storeInvitation.expiresAt, now),
      ),
    )
  return {
    country: shop?.country ?? null,
    productsWithStock: Number(stocked?.n ?? 0),
    payments: payments.map((p) => p.name),
    deliveries: deliveries.map((d) => d.name),
    chats: CHATS_READY ? false : null,
    triedSofi: Number(tried?.n ?? 0) > 0,
    members: Number(members?.n ?? 0),
    invitations: Number(invited?.n ?? 0),
  }
}

/**
 * La lista de una tienda que empieza, o null si ya quedó lista. La primera vez que la ve completa,
 * la anota como lista (sin nombre: lo anota el sistema) y desde entonces no vuelve.
 */
export async function setupIn(tx: Db, storeId: string, now = new Date()) {
  const [saved] = await tx.select().from(storeSetup).where(eq(storeSetup.storeId, storeId))
  if (saved?.finishedAt) return null
  const facts = await setupFactsIn(tx, storeId, now)
  const steps = setupSteps(facts, saved?.skipped ?? [])
  if (setupFinished(steps)) {
    await tx
      .insert(storeSetup)
      .values({ storeId, finishedAt: now, updatedBy: null, updatedAt: now })
      .onConflictDoUpdate({
        target: storeSetup.storeId,
        set: { finishedAt: now, updatedBy: null, updatedAt: now },
      })
    return null
  }
  return { steps, facts }
}

/** Los pasos que la tienda dijo que no necesita («No lo necesito»). */
export async function skippedStepsIn(tx: Db, storeId: string): Promise<SetupStep[]> {
  const [saved] = await tx
    .select({ skipped: storeSetup.skipped })
    .from(storeSetup)
    .where(eq(storeSetup.storeId, storeId))
  return saved?.skipped ?? []
}

export const skipInput = z.object({
  step: z.enum(SETUP_STEPS, { error: "Ese paso no existe" }),
})

/** «No lo necesito»: un paso que no aplica a la tienda deja de faltar. Lo salta quien configura. */
export async function skipStep(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof skipInput>,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    if (!SKIPPABLE_STEPS.includes(input.step))
      throw new StoreError(
        400,
        "VALIDATION_ERROR",
        "Este paso lo necesita toda tienda para vender: déjalo para después",
      )
    const now = new Date()
    await tx
      .insert(storeSetup)
      .values({ storeId, skipped: [input.step], updatedBy: person.userId, updatedAt: now })
      .onConflictDoUpdate({
        target: storeSetup.storeId,
        set: {
          skipped: sql`array(select distinct unnest(${storeSetup.skipped} || array[${input.step}]::text[]) order by 1)`,
          updatedBy: person.userId,
          updatedAt: now,
        },
      })
    return { ok: true }
  })
}

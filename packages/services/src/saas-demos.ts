import { randomInt } from "node:crypto"
import { CLINICAL_PRODUCTS, type ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { adminStaff } from "@odentia/db/schema/admin-core"
import {
  DEMO_MONTHS,
  DEMO_SIZES,
  type DemoProgress,
  type DemoSize,
  type DemoStatus,
  saasDemo,
} from "@odentia/db/schema/admin-demos"
import { appointment } from "@odentia/db/schema/agenda"
import { organization, session, user } from "@odentia/db/schema/auth"
import { clinicalFollowUp } from "@odentia/db/schema/clinical"
import { conversation, crmTask } from "@odentia/db/schema/crm"
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { RESERVED_ORG_SLUGS } from "./admin-organizations.js"
import {
  DEMO_BUILD_STEPS,
  type DemoPurgeResult,
  demoCountryOf,
  demoKindOf,
  purgeDemoOrganization,
} from "./demo-build.js"
import { DEMO_COUNTRIES, DEMO_SIZE_RECIPES } from "./demo-recipes.js"
import { invalidField, ServiceError } from "./errors.js"
import { getOrgLocale } from "./locale.js"
import { demoKindsFor } from "./products.js"
import { dayStart, reportDayOf } from "./report-periods.js"

/**
 * Las demos para presentar desde la administración (ADR 0096): pedirlas,
 * verlas, volver a empezar y borrarlas. Las arma el worker (`demo-build.ts`);
 * aquí solo se escribe la receta y se lee cómo va. Solo la administración
 * crea, vuelve a empezar y borra (decisión 11); soporte las ve.
 */

/** Días sin abrirse tras los que una demo se borra sola (decisión 7), y el aviso antes. */
export const DEMO_IDLE_DAYS = 60
export const DEMO_WARN_DAYS = 7
const DAY = 86_400_000

function requireManager(actor: AdminActor): void {
  if (actor.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Solo la administración crea y borra demos")
}

/** Lo que se elige al crear una demo: tipos por producto, tamaños, meses, países y quién presenta. */
export async function getDemoOptions(tx: Db) {
  const presenters = await tx
    .select({ id: user.id, name: user.name, email: user.email })
    .from(adminStaff)
    .innerJoin(user, eq(user.id, adminStaff.userId))
    .where(eq(adminStaff.active, true))
    .orderBy(user.name)
  return {
    products: CLINICAL_PRODUCTS.map((product) => ({
      product,
      kinds: demoKindsFor(product).map((kind) => ({
        key: kind.key,
        name: kind.name,
        hint: kind.hint,
        // Nombres de ejemplo de cada país, para el botón «Otro».
        names: Object.fromEntries(
          Object.values(DEMO_COUNTRIES).map((country) => [
            country.code,
            kind.clinicNames.flatMap((pattern) =>
              country.places.map((place) => pattern.replace("{lugar}", place)),
            ),
          ]),
        ) as Record<string, string[]>,
      })),
    })),
    sizes: DEMO_SIZES.map((size) => ({ key: size, ...DEMO_SIZE_RECIPES[size] })),
    months: [...DEMO_MONTHS],
    countries: Object.values(DEMO_COUNTRIES).map((country) => ({
      code: country.code,
      name: country.name,
    })),
    presenters,
  }
}

export interface DemoRequestInput {
  product: ClinicalProduct
  kind: string
  size: DemoSize
  months: number
  countryCode: string
  name: string
  presenterUserId: string
}

/** El subdominio sale del nombre y nunca dice «demo» (decisión 10); si ya existe, lleva un número. */
async function freeSlug(tx: Db, name: string): Promise<string> {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/g, "") || "clinica"
  for (let index = 1; index < 200; index += 1) {
    const slug = index === 1 ? base : `${base}-${index}`
    if (RESERVED_ORG_SLUGS[slug] || slug.length < 2) continue
    const [taken] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, slug))
      .limit(1)
    const [planned] = await tx
      .select({ id: saasDemo.id })
      .from(saasDemo)
      .where(eq(saasDemo.slug, slug))
      .limit(1)
    if (!taken && !planned) return slug
  }
  const message = "No hay un subdominio libre para ese nombre: prueba con otro"
  throw new ServiceError("CONFLICT", 409, message, { name: message })
}

/** Pide una demo: queda «pendiente» y el worker la arma. */
export async function requestDemo(tx: Db, actor: AdminActor, input: DemoRequestInput) {
  requireManager(actor)
  if (!CLINICAL_PRODUCTS.includes(input.product)) throw invalidField("product", "Elige el producto")
  demoKindOf(input.product, input.kind)
  demoCountryOf(input.countryCode)
  if (!DEMO_SIZES.includes(input.size)) throw invalidField("size", "Elige el tamaño")
  if (!(DEMO_MONTHS as readonly number[]).includes(input.months))
    throw invalidField("months", "La historia es de 6, 12 o 24 meses")
  const name = input.name.trim().replace(/\s+/g, " ")
  if (name.length < 3 || name.length > 80) throw invalidField("name", "El nombre va de 3 a 80 letras")
  const [presenter] = await tx
    .select({ id: adminStaff.userId })
    .from(adminStaff)
    .where(and(eq(adminStaff.userId, input.presenterUserId), eq(adminStaff.active, true)))
    .limit(1)
  if (!presenter)
    throw invalidField("presenterUserId", "Quien presenta es alguien del equipo de la administración")
  const slug = await freeSlug(tx, name)
  const [row] = await tx
    .insert(saasDemo)
    .values({
      product: input.product,
      kind: input.kind,
      size: input.size,
      months: input.months,
      countryCode: input.countryCode,
      name,
      slug,
      presenterUserId: input.presenterUserId,
      createdBy: actor.userId,
      seed: randomInt(1, 2_147_483_647),
      status: "pendiente",
      progress: { step: "pendiente", done: 0, total: DEMO_BUILD_STEPS },
    })
    .returning({ id: saasDemo.id, slug: saasDemo.slug })
  await writeAdminAudit(tx, actor, {
    action: "demo.requested",
    entityId: row?.id,
    metadata: {
      product: input.product,
      kind: input.kind,
      size: input.size,
      months: input.months,
      country: input.countryCode,
      slug,
    },
  })
  return row as { id: string; slug: string }
}

export interface DemoView {
  id: string
  organizationId: string | null
  product: ClinicalProduct
  kind: string
  kindName: string
  size: DemoSize
  sizeName: string
  months: number
  countryCode: string
  countryName: string
  name: string
  slug: string
  presenter: { id: string; name: string }
  status: DemoStatus
  progress: DemoProgress | null
  error: string | null
  createdAt: Date
  readyAt: Date | null
  /** La última vez que alguien la usó: abrirla desde aquí o entrar a la clínica. */
  lastUsedAt: Date
  /** Cuándo se borra sola si nadie la abre (decisión 7). */
  expiresAt: Date
  expiresSoon: boolean
}

type DemoRow = typeof saasDemo.$inferSelect

async function viewsOf(tx: Db, rows: DemoRow[]): Promise<DemoView[]> {
  if (rows.length === 0) return []
  const people = new Map(
    (
      await tx
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(inArray(user.id, [...new Set(rows.map((row) => row.presenterUserId))]))
    ).map((row) => [row.id, row.name]),
  )
  const orgIds = rows.flatMap((row) => (row.organizationId ? [row.organizationId] : []))
  const sessions = new Map(
    orgIds.length === 0
      ? []
      : (
          await tx
            .select({
              orgId: session.activeOrganizationId,
              at: sql<Date | null>`max(${session.updatedAt})`,
            })
            .from(session)
            .where(inArray(session.activeOrganizationId, orgIds))
            .groupBy(session.activeOrganizationId)
        ).map((row) => [row.orgId, row.at ? new Date(row.at) : null]),
  )
  const now = Date.now()
  return rows.map((row) => {
    const product = row.product as ClinicalProduct
    const kind = demoKindsFor(product).find((item) => item.key === row.kind)
    const country = DEMO_COUNTRIES[row.countryCode as keyof typeof DEMO_COUNTRIES]
    const used = [
      row.openedAt,
      row.readyAt,
      row.organizationId ? sessions.get(row.organizationId) : null,
      row.createdAt,
    ]
      .filter((value): value is Date => value instanceof Date)
      .reduce((latest, value) => (value > latest ? value : latest))
    const expiresAt = new Date(used.getTime() + DEMO_IDLE_DAYS * DAY)
    return {
      id: row.id,
      organizationId: row.organizationId,
      product,
      kind: row.kind,
      kindName: kind?.name ?? row.kind,
      size: row.size as DemoSize,
      sizeName: DEMO_SIZE_RECIPES[row.size as DemoSize]?.name ?? row.size,
      months: row.months,
      countryCode: row.countryCode,
      countryName: country?.name ?? row.countryCode,
      name: row.name,
      slug: row.slug,
      presenter: { id: row.presenterUserId, name: people.get(row.presenterUserId) ?? "" },
      status: row.status as DemoStatus,
      progress: row.progress ?? null,
      error: row.error,
      createdAt: row.createdAt,
      readyAt: row.readyAt,
      lastUsedAt: used,
      expiresAt,
      expiresSoon: row.status === "lista" && expiresAt.getTime() - now < DEMO_WARN_DAYS * DAY,
    }
  })
}

/** Todas las demos, las más nuevas primero (Clínicas, «Clase: Demos»). */
export async function listDemos(tx: Db): Promise<DemoView[]> {
  return viewsOf(tx, await tx.select().from(saasDemo).orderBy(desc(saasDemo.createdAt)))
}

async function requireDemo(tx: Db, id: string, lock = false): Promise<DemoRow> {
  const query = tx.select().from(saasDemo).where(eq(saasDemo.id, id)).limit(1)
  // Con candado: el worker la toma con `skip locked`, así que no puede armarla
  // mientras se vuelve a empezar o se borra.
  const [row] = lock ? await query.for("update") : await query
  if (!row) throw new ServiceError("NOT_FOUND", 404, "Esa demo no existe")
  return row
}

/** Lo que la demo tiene hoy para mostrar (tablero 2): agenda, Bandeja y controles. */
async function demoShowcase(tx: Db, row: DemoRow & { organizationId: string }) {
  const { timezone } = await getOrgLocale(tx, row.organizationId)
  const today = reportDayOf(timezone, new Date())
  const [year, month, date] = today.split("-").map(Number) as [number, number, number]
  const start = dayStart(timezone, year, month, date)
  const end = new Date(start.getTime() + DAY)
  const tomorrowEnd = new Date(end.getTime() + DAY)
  const monthStart = dayStart(timezone, year, month, 1)
  const [nextYear, nextMonth] = month === 12 ? [year + 1, 1] : [year, month + 1]
  const monthEnd = dayStart(timezone, nextYear, nextMonth, 1)
  const org = row.organizationId
  const count = sql<number>`count(*)::int`
  const [agenda] = await tx
    .select({ total: count })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, org),
        gte(appointment.startsAt, start),
        lt(appointment.startsAt, end),
        inArray(appointment.status, ["programada", "confirmada", "atendida"]),
      ),
    )
  const [unconfirmed] = await tx
    .select({ total: count })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, org),
        gte(appointment.startsAt, start),
        lt(appointment.startsAt, tomorrowEnd),
        eq(appointment.status, "programada"),
      ),
    )
  const [topics] = await tx
    .select({ total: count })
    .from(crmTask)
    .where(
      and(
        eq(crmTask.organizationId, org),
        eq(crmTask.status, "open"),
        sql`${crmTask.conversationId} is not null`,
      ),
    )
  const [byAgent] = await tx
    .select({ total: count })
    .from(conversation)
    .where(
      and(
        eq(conversation.organizationId, org),
        sql`${conversation.status} <> 'closed'`,
        eq(conversation.agentStatus, "on"),
      ),
    )
  const [controls] = await tx
    .select({ total: count })
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, org),
        eq(clinicalFollowUp.status, "pendiente"),
        gte(clinicalFollowUp.dueAt, monthStart),
        lt(clinicalFollowUp.dueAt, monthEnd),
      ),
    )
  const kind = demoKindOf(row.product as ClinicalProduct, row.kind)
  return {
    today,
    agendaToday: agenda?.total ?? 0,
    unconfirmed: unconfirmed?.total ?? 0,
    openTopics: topics?.total ?? 0,
    byAgent: byAgent?.total ?? 0,
    controlsDue: controls?.total ?? 0,
    controlsLabel: kind.followUp?.title ?? "Controles",
    agendaThrough: row.historyThrough,
  }
}

/** La demo de una clínica, para su ficha (franja y «Lo que tiene hoy para mostrar»); null si es real. */
export async function getDemoOfOrganization(tx: Db, organizationId: string) {
  const [row] = await tx
    .select()
    .from(saasDemo)
    .where(eq(saasDemo.organizationId, organizationId))
    .limit(1)
  if (!row) return null
  const [view] = await viewsOf(tx, [row])
  const showcase =
    row.status === "lista" ? await demoShowcase(tx, { ...row, organizationId }) : null
  return { ...(view as DemoView), showcase }
}

/** Volver a empezar: el worker la arma de nuevo con la misma receta y la misma semilla. */
export async function resetDemo(tx: Db, actor: AdminActor, id: string) {
  requireManager(actor)
  const row = await requireDemo(tx, id, true)
  if (row.status === "pendiente" || row.status === "creando")
    throw new ServiceError("CONFLICT", 409, "La demo se está armando: espera a que termine")
  await tx
    .update(saasDemo)
    .set({
      status: "pendiente",
      // Volver a empezar cuenta como uso: no se borra sola mientras se vuelve a armar.
      openedAt: new Date(),
      progress: { step: "pendiente", done: 0, total: DEMO_BUILD_STEPS },
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(saasDemo.id, id))
  await writeAdminAudit(tx, actor, {
    action: "demo.reset",
    organizationId: row.organizationId,
    entityId: id,
    metadata: { slug: row.slug },
  })
  return { id }
}

/**
 * Borra la demo y su clínica entera. Pide el nombre escrito (tablero 4b). Lo
 * que haya en el almacenamiento lo quita quien llama, ya confirmada la transacción.
 */
export async function deleteDemo(
  tx: Db,
  actor: AdminActor | null,
  id: string,
  confirmName: string | null,
): Promise<DemoPurgeResult> {
  if (actor) requireManager(actor)
  const row = await requireDemo(tx, id, true)
  if (actor && (confirmName ?? "").trim() !== row.name)
    throw invalidField("confirmName", "Escribe el nombre de la demo para borrarla")
  // Pendiente también: el worker podría tomarla en cualquier momento. Una que
  // falló sí se borra (lo que quedó es la clínica de antes, entera).
  if (row.status === "creando" || row.status === "pendiente")
    throw new ServiceError("CONFLICT", 409, "La demo se está armando: espera a que termine")
  // Sin quien borra, es el vencimiento: se vuelve a mirar con el candado puesto.
  if (!actor) {
    const [view] = await viewsOf(tx, [row])
    if (row.status !== "lista" || !view || view.expiresAt.getTime() >= Date.now())
      throw new ServiceError("CONFLICT", 409, "La demo se usó: ya no vence")
  }
  const purged = row.organizationId
    ? await purgeDemoOrganization(tx, id, row.organizationId)
    : { storageKeys: [] }
  await tx.delete(saasDemo).where(eq(saasDemo.id, id))
  await writeAdminAudit(tx, actor, {
    action: actor ? "demo.deleted" : "demo.expired",
    entityId: id,
    metadata: { slug: row.slug, name: row.name },
  })
  return purged
}

/** «Abrir la demo»: cuenta como uso, así no se borra sola. */
export async function markDemoOpened(tx: Db, id: string): Promise<void> {
  await requireDemo(tx, id)
  await tx
    .update(saasDemo)
    .set({ openedAt: new Date(), updatedAt: new Date() })
    .where(eq(saasDemo.id, id))
}

/** Lo que el worker toma: la demo pendiente más antigua, marcada «creando». */
export async function claimPendingDemo(tx: Db): Promise<DemoRow | null> {
  const rows = (await tx.execute(sql`
    update admin.saas_demo set status = 'creando', heartbeat_at = now(), updated_at = now()
    where id = (select id from admin.saas_demo where status = 'pendiente' order by created_at for update skip locked limit 1)
    returning id`)) as unknown as Array<{ id: string }>
  const id = rows[0]?.id
  return id ? requireDemo(tx, id) : null
}

/** Una demo que dejó de latir mientras se armaba (el worker se reinició): fallida, con «Intentar de nuevo». */
export async function failStaleDemos(tx: Db, staleMs = 5 * 60_000): Promise<number> {
  const rows = await tx
    .update(saasDemo)
    .set({ status: "fallida", error: "Se cortó mientras se armaba", updatedAt: new Date() })
    .where(
      and(
        eq(saasDemo.status, "creando"),
        or(
          lt(saasDemo.heartbeatAt, new Date(Date.now() - staleMs)),
          sql`${saasDemo.heartbeatAt} is null`,
        ),
      ),
    )
    .returning({ id: saasDemo.id })
  return rows.length
}

/** Las demos listas que hoy (en su zona) todavía no se pusieron al día. */
export async function demosToAdvance(tx: Db, limit = 1): Promise<DemoRow[]> {
  const rows = (await tx.execute(sql`
    select d.id from admin.saas_demo d
    join org_profile p on p.organization_id = d.organization_id
    where d.status = 'lista' and (d.advanced_on is null or d.advanced_on < (now() at time zone p.timezone)::date)
    order by d.advanced_on nulls first
    limit ${limit}`)) as unknown as Array<{ id: string }>
  if (rows.length === 0) return []
  return tx
    .select()
    .from(saasDemo)
    .where(
      inArray(
        saasDemo.id,
        rows.map((row) => row.id),
      ),
    )
}

/** Las que nadie abrió en 60 días: se borran solas (decisión 7). */
export async function expiredDemos(tx: Db): Promise<DemoView[]> {
  const ready = await tx.select().from(saasDemo).where(eq(saasDemo.status, "lista"))
  return (await viewsOf(tx, ready)).filter((view) => view.expiresAt.getTime() < Date.now())
}

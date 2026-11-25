import { randomUUID } from "node:crypto"
import {
  accountCopy,
  type Db,
  enterStore,
  STORE_ROLES,
  type StoreRole,
  store,
  storeEvent,
  storeInvitation,
  storeMember,
  withPerson,
} from "@gestoria/db"
import { and, asc, count, desc, eq, gt, isNull } from "drizzle-orm"
import { z } from "zod"
import { noteStoreAccount, noteStoreTeam } from "./acuerdo.js"
import type { Person } from "./cuenta.js"
import {
  can,
  canAssign,
  ROLE_PERMISSIONS,
  type StorePermission,
  type StoreSeat,
} from "./permisos.js"
import {
  activeSupportOf,
  answerSupportIn,
  endSupportIn,
  noteSupportEntry,
  supportForTeam,
  supportStoresOf,
} from "./soporte.js"

/**
 * Las tiendas y su equipo (paso B1 del lienzo B). Cada operación corre con el rol de la
 * aplicación, dentro de las reglas de la tienda (`withPerson`), y comprueba el permiso del
 * rol en el servidor: la pantalla solo deja de ofrecer lo que no se puede.
 */

export class StoreError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message)
  }
}

/**
 * Lo que una regla de la base rechaza, dicho a la persona: el índice o el control decide (dos
 * pedidos a la vez incluidos) y aquí solo se traduce. Lo que no está en la tabla sigue su curso.
 */
const CONSTRAINT_ERRORS: Record<string, () => StoreError> = {
  product_store_name_uidx: () =>
    new StoreError(409, "NAME_TAKEN", "Ya hay un producto con ese nombre", {
      name: "Ya hay un producto con ese nombre",
    }),
  product_variant_sku_uidx: () =>
    new StoreError(409, "SKU_TAKEN", "Ese código ya es de otra variante", {
      sku: "Ese código ya es de otra variante",
    }),
  product_variant_stock_check: () =>
    new StoreError(409, "NOT_ENOUGH_STOCK", "No alcanza el stock para ese movimiento"),
  stock_movement_removed_check: () =>
    new StoreError(409, "VARIANT_REMOVED", "Esa variante ya no se vende"),
  // Un producto que ya estuvo en un pedido no se borra: el pedido lo sigue nombrando.
  sale_order_line_variant_fkey: () =>
    new StoreError(
      409,
      "HAS_ORDERS",
      "Este producto ya está en pedidos: no se borra. Quita sus variantes para dejar de venderlo.",
    ),
}

/** El error de la base como `StoreError`, si es una regla conocida; si no, null. */
export function constraintError(error: unknown): StoreError | null {
  const e = error as { constraint_name?: string; cause?: { constraint_name?: string } }
  const name = e.constraint_name ?? e.cause?.constraint_name
  return name && CONSTRAINT_ERRORS[name] ? CONSTRAINT_ERRORS[name]() : null
}

/** Cuánto vale una invitación. */
export const INVITATION_DAYS = 7
/** Lo más que una tienda puede tener pendiente de una vez. */
export const MAX_PENDING_INVITATIONS = 50

/** Las monedas de ISO 4217 que conoce el entorno (decisión 9: una sola por tienda). */
export function isCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && Intl.supportedValuesOf("currency").includes(code)
}

export const newStoreInput = z.object({
  name: z.string().trim().min(1, "Escribe el nombre de tu tienda").max(80, "Máximo 80 caracteres"),
  currency: z.string().trim().toUpperCase().refine(isCurrency, "Elige una moneda de la lista"),
  /** ISO 3166-1 alfa-2; opcional (la administración cobra con su impuesto). */
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Elige un país de la lista")
    .nullish(),
})

export const invitationInput = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Escribe un correo válido, como nombre@tienda.com")
    .max(254),
  role: z.enum(STORE_ROLES),
})

export const roleInput = z.object({ role: z.enum(STORE_ROLES) })

/** Lo que la persona ve al entrar: sus tiendas y las invitaciones a su correo. */
export async function myStores(appDb: Db, person: Person) {
  return withPerson(appDb, person, async (tx) => {
    const stores = await tx
      .select({ id: store.id, name: store.name, currency: store.currency, role: storeMember.role })
      .from(storeMember)
      .innerJoin(store, eq(store.id, storeMember.storeId))
      .where(eq(storeMember.userId, person.userId))
      .orderBy(asc(store.name))
    const invitations = await tx
      .select({
        id: storeInvitation.id,
        role: storeInvitation.role,
        expiresAt: storeInvitation.expiresAt,
        storeId: store.id,
        storeName: store.name,
        invitedBy: accountCopy.name,
      })
      .from(storeInvitation)
      .innerJoin(store, eq(store.id, storeInvitation.storeId))
      .leftJoin(accountCopy, eq(accountCopy.userId, storeInvitation.invitedBy))
      .where(
        and(
          eq(storeInvitation.email, person.email),
          isNull(storeInvitation.acceptedAt),
          isNull(storeInvitation.revokedAt),
          gt(storeInvitation.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(storeInvitation.createdAt))
    const mine = new Set(stores.map((s) => s.id))
    // Las que soporte de gestorIA puede mirar ahora (la tienda la dejó entrar), solo a mirar.
    const support = (await supportStoresOf(tx, person.userId)).filter((s) => !mine.has(s.id))
    return {
      stores: [
        ...stores.map((s) => ({
          ...s,
          permissions: ROLE_PERMISSIONS[s.role],
          supportUntil: null as Date | null,
        })),
        ...support.map(({ until, ...s }) => ({
          ...s,
          role: "support" as const,
          permissions: ROLE_PERMISSIONS.support,
          supportUntil: until,
        })),
      ],
      // Una invitación a una tienda donde ya está no se ofrece.
      invitations: invitations.filter((i) => !mine.has(i.storeId)),
    }
  })
}

/** Crea una tienda: quien la crea es su Dueño. */
/**
 * Abre una tienda con su Dueño, lo anota y se lo avisa a la administración (el acuerdo, B7). La
 * usan quien la crea y la administración cuando la abre para un cliente (ADR 0214).
 */
export async function openStoreIn(
  tx: Db,
  input: {
    id: string
    name: string
    currency: string
    country: string | null
    ownerId: string
    /** Quién lo hizo: nulo si fue la administración. */
    actorUserId: string | null
    detail: Record<string, unknown>
  },
): Promise<void> {
  await tx.insert(store).values({
    id: input.id,
    name: input.name,
    currency: input.currency,
    country: input.country,
    createdBy: input.ownerId,
  })
  await tx.insert(storeMember).values({ storeId: input.id, userId: input.ownerId, role: "owner" })
  await tx.insert(storeEvent).values({
    storeId: input.id,
    actorUserId: input.actorUserId,
    action: "tienda.creada",
    ...(input.actorUserId ? {} : { subject: input.ownerId }),
    detail: input.detail,
  })
  await noteStoreAccount(tx, input.id)
  // La cuenta sabe que es suya: la tienda aparece en su selector de lugares.
  await noteStoreTeam(tx, input.id)
}

export async function createStore(appDb: Db, person: Person, input: z.infer<typeof newStoreInput>) {
  const id = randomUUID()
  await withPerson(appDb, person, async (tx) => {
    await enterStore(tx, id)
    await openStoreIn(tx, {
      id,
      name: input.name,
      currency: input.currency,
      country: input.country ?? null,
      ownerId: person.userId,
      actorUserId: person.userId,
      detail: input,
    })
  })
  return {
    id,
    name: input.name,
    currency: input.currency,
    role: "owner" as const,
    permissions: ROLE_PERMISSIONS.owner,
  }
}

/**
 * El lugar de la persona en una tienda: su rol en el equipo o, si no es del equipo, soporte con una
 * entrada vigente. Si no, 404 (no se dice si existe).
 */
async function seatIn(tx: Db, person: Person, storeId: string) {
  const [row] = await tx
    .select({ role: storeMember.role })
    .from(storeMember)
    .where(and(eq(storeMember.storeId, storeId), eq(storeMember.userId, person.userId)))
  if (row) return { role: row.role as StoreSeat, support: null }
  const support = await activeSupportOf(tx, storeId, person.userId)
  if (support) return { role: "support" as const, support }
  throw new StoreError(404, "NOT_FOUND", "No encontramos esa tienda en tu cuenta")
}

/**
 * Corre `fn` dentro de una tienda de la persona, con su rol. La tienda sale de su equipo (o de la
 * entrada vigente de soporte), nunca de lo que diga el navegador: sin estar, 404; sin el
 * permiso, 403.
 */
export async function inStore<T>(
  appDb: Db,
  person: Person,
  storeId: string,
  permission: StorePermission,
  fn: (tx: Db, role: StoreSeat) => Promise<T>,
): Promise<T> {
  if (!z.uuid().safeParse(storeId).success)
    throw new StoreError(404, "NOT_FOUND", "No encontramos esa tienda en tu cuenta")
  return withPerson(appDb, person, async (tx) => {
    const seat = await seatIn(tx, person, storeId)
    if (!can(seat.role, permission))
      throw new StoreError(403, "FORBIDDEN", "Tu rol en esta tienda no permite hacerlo")
    await enterStore(tx, storeId)
    if (seat.support) await noteSupportEntry(tx, storeId, seat.support)
    return fn(tx, seat.role)
  })
}

export async function storeSummary(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "tienda.ver", async (tx, role) => {
    const [row] = await tx
      .select({ id: store.id, name: store.name, currency: store.currency })
      .from(store)
      .where(eq(store.id, storeId))
    if (!row) throw new StoreError(404, "NOT_FOUND", "No encontramos esa tienda en tu cuenta")
    return { ...row, role, permissions: ROLE_PERMISSIONS[role] }
  })
}

export async function storeTeam(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "equipo.ver", async (tx) => {
    const members = await tx
      .select({
        userId: storeMember.userId,
        role: storeMember.role,
        since: storeMember.createdAt,
        name: accountCopy.name,
        email: accountCopy.email,
        image: accountCopy.image,
      })
      .from(storeMember)
      .innerJoin(accountCopy, eq(accountCopy.userId, storeMember.userId))
      .where(eq(storeMember.storeId, storeId))
      .orderBy(asc(accountCopy.name))
    const invitations = await tx
      .select({
        id: storeInvitation.id,
        email: storeInvitation.email,
        role: storeInvitation.role,
        expiresAt: storeInvitation.expiresAt,
        createdAt: storeInvitation.createdAt,
      })
      .from(storeInvitation)
      .where(
        and(
          eq(storeInvitation.storeId, storeId),
          isNull(storeInvitation.acceptedAt),
          isNull(storeInvitation.revokedAt),
        ),
      )
      .orderBy(desc(storeInvitation.createdAt))
    const now = Date.now()
    return {
      members,
      invitations: invitations.map((i) => ({ ...i, expired: i.expiresAt.getTime() <= now })),
      support: await supportForTeam(tx, storeId),
    }
  })
}

/** El Dueño o un Administrador deja entrar a soporte, o no. */
export async function answerSupport(
  appDb: Db,
  person: Person,
  storeId: string,
  accessId: string,
  accept: boolean,
) {
  return inStore(appDb, person, storeId, "equipo.gestionar", (tx) =>
    answerSupportIn(tx, storeId, person.userId, accessId, accept),
  )
}

/** El Dueño o un Administrador saca a soporte antes de que venza. */
export async function endSupport(appDb: Db, person: Person, storeId: string, accessId: string) {
  return inStore(appDb, person, storeId, "equipo.gestionar", (tx) =>
    endSupportIn(tx, storeId, person.userId, accessId),
  )
}

/**
 * Invita a alguien por su correo. Si ya hay una pendiente para ese correo, vence o no, se
 * renueva con el rol nuevo: así «invitar otra vez» siempre funciona. Devuelve el id; el enlace
 * lo arma quien llama con la dirección de la app.
 */
export async function inviteToStore(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof invitationInput>,
  now = new Date(),
) {
  return inStore(appDb, person, storeId, "equipo.gestionar", async (tx, role) => {
    if (!canAssign(role, input.role))
      throw new StoreError(403, "FORBIDDEN", "Solo el dueño puede invitar a otro dueño", {
        role: "Solo el dueño puede invitar a otro dueño",
      })
    const [already] = await tx
      .select({ userId: storeMember.userId })
      .from(storeMember)
      .innerJoin(accountCopy, eq(accountCopy.userId, storeMember.userId))
      .where(and(eq(storeMember.storeId, storeId), eq(accountCopy.email, input.email)))
    if (already)
      throw new StoreError(409, "ALREADY_MEMBER", "Esa persona ya es parte del equipo", {
        email: "Esa persona ya es parte del equipo",
      })
    const expiresAt = new Date(now.getTime() + INVITATION_DAYS * 86_400_000)
    const [pending] = await tx
      .select({ id: storeInvitation.id })
      .from(storeInvitation)
      .where(
        and(
          eq(storeInvitation.storeId, storeId),
          eq(storeInvitation.email, input.email),
          isNull(storeInvitation.acceptedAt),
          isNull(storeInvitation.revokedAt),
        ),
      )
    if (pending) {
      // Una invitación no cambia lo que dice: se anula y se hace otra.
      await tx
        .update(storeInvitation)
        .set({ revokedAt: now, revokedBy: person.userId })
        .where(eq(storeInvitation.id, pending.id))
    } else {
      const [{ value }] = (await tx
        .select({ value: count() })
        .from(storeInvitation)
        .where(
          and(
            eq(storeInvitation.storeId, storeId),
            isNull(storeInvitation.acceptedAt),
            isNull(storeInvitation.revokedAt),
          ),
        )) as [{ value: number }]
      if (value >= MAX_PENDING_INVITATIONS)
        throw new StoreError(
          409,
          "TOO_MANY_INVITATIONS",
          "Hay demasiadas invitaciones pendientes. Anula las que ya no sirven.",
        )
    }
    const id = randomUUID()
    await tx.insert(storeInvitation).values({
      id,
      storeId,
      email: input.email,
      role: input.role,
      invitedBy: person.userId,
      expiresAt,
    })
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "invitacion.creada",
      subject: input.email,
      detail: { role: input.role, ...(pending ? { replaces: pending.id } : {}) },
    })
    return { id, email: input.email, role: input.role, expiresAt }
  })
}

export async function revokeInvitation(
  appDb: Db,
  person: Person,
  storeId: string,
  invitationId: string,
  now = new Date(),
) {
  return inStore(appDb, person, storeId, "equipo.gestionar", async (tx, role) => {
    if (!z.uuid().safeParse(invitationId).success)
      throw new StoreError(404, "NOT_FOUND", "Esa invitación ya no está")
    const [row] = await tx
      .select({ email: storeInvitation.email, role: storeInvitation.role })
      .from(storeInvitation)
      .where(
        and(
          eq(storeInvitation.id, invitationId),
          eq(storeInvitation.storeId, storeId),
          isNull(storeInvitation.acceptedAt),
          isNull(storeInvitation.revokedAt),
        ),
      )
    if (!row) throw new StoreError(404, "NOT_FOUND", "Esa invitación ya no está")
    if (!canAssign(role, row.role))
      throw new StoreError(403, "FORBIDDEN", "Solo el dueño puede anular la invitación de un dueño")
    await tx
      .update(storeInvitation)
      .set({ revokedAt: now, revokedBy: person.userId })
      .where(eq(storeInvitation.id, invitationId))
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "invitacion.anulada",
      subject: row.email,
    })
  })
}

/**
 * Acepta una invitación: solo quien entró con la cuenta del correo invitado (el token trae el
 * correo que la cuenta verificó). El enlace solo lleva hasta aquí; no basta para entrar.
 */
export async function acceptInvitation(
  appDb: Db,
  person: Person,
  invitationId: string,
  now = new Date(),
) {
  if (!z.uuid().safeParse(invitationId).success)
    throw new StoreError(
      404,
      "NOT_FOUND",
      "Esta invitación ya no está vigente o es para otro correo",
    )
  return withPerson(appDb, person, async (tx) => {
    const [invitation] = await tx
      .select()
      .from(storeInvitation)
      .where(
        and(
          eq(storeInvitation.id, invitationId),
          eq(storeInvitation.email, person.email),
          isNull(storeInvitation.acceptedAt),
          isNull(storeInvitation.revokedAt),
          gt(storeInvitation.expiresAt, now),
        ),
      )
    if (!invitation)
      throw new StoreError(
        404,
        "NOT_FOUND",
        "Esta invitación ya no está vigente o es para otro correo",
      )
    await enterStore(tx, invitation.storeId)
    // Quien invitó tiene que seguir pudiendo dar ese rol: si lo quitaron o bajó de rol, su
    // invitación ya no vale.
    const [inviter] = await tx
      .select({ role: storeMember.role })
      .from(storeMember)
      .where(
        and(
          eq(storeMember.storeId, invitation.storeId),
          eq(storeMember.userId, invitation.invitedBy),
        ),
      )
    if (!inviter || !canAssign(inviter.role, invitation.role))
      throw new StoreError(
        404,
        "NOT_FOUND",
        "Esta invitación ya no está vigente: quien te invitó ya no puede dar ese rol. Pide otra.",
      )
    const [member] = await tx
      .select({ role: storeMember.role })
      .from(storeMember)
      .where(
        and(eq(storeMember.storeId, invitation.storeId), eq(storeMember.userId, person.userId)),
      )
    if (!member)
      await tx.insert(storeMember).values({
        storeId: invitation.storeId,
        userId: person.userId,
        role: invitation.role,
        addedBy: invitation.invitedBy,
      })
    await tx
      .update(storeInvitation)
      .set({ acceptedAt: now, acceptedBy: person.userId })
      .where(eq(storeInvitation.id, invitationId))
    await tx.insert(storeEvent).values({
      storeId: invitation.storeId,
      actorUserId: person.userId,
      action: "invitacion.aceptada",
      subject: person.email,
      detail: { role: member?.role ?? invitation.role },
    })
    // La cuenta sabe que entró: la tienda aparece en su selector de lugares.
    await noteStoreTeam(tx, invitation.storeId)
    return { storeId: invitation.storeId }
  })
}

/** Lo que exige tocar a alguien del equipo: el permiso, el rol y que la tienda no se quede sin dueño. */
async function targetMember(tx: Db, storeId: string, userId: string) {
  const [row] = await tx
    .select({ role: storeMember.role })
    .from(storeMember)
    .where(and(eq(storeMember.storeId, storeId), eq(storeMember.userId, userId)))
  if (!row) throw new StoreError(404, "NOT_FOUND", "Esa persona ya no es parte del equipo")
  return row
}

async function keepsAnOwner(tx: Db, storeId: string): Promise<void> {
  const [{ value }] = (await tx
    .select({ value: count() })
    .from(storeMember)
    .where(and(eq(storeMember.storeId, storeId), eq(storeMember.role, "owner")))) as [
    { value: number },
  ]
  if (value < 1)
    throw new StoreError(
      409,
      "LAST_OWNER",
      "La tienda necesita al menos un dueño. Antes, haz dueño a otra persona.",
    )
}

export async function changeRole(
  appDb: Db,
  person: Person,
  storeId: string,
  userId: string,
  role: StoreRole,
) {
  return inStore(appDb, person, storeId, "equipo.gestionar", async (tx, actor) => {
    const target = await targetMember(tx, storeId, userId)
    if (!canAssign(actor, target.role) || !canAssign(actor, role))
      throw new StoreError(403, "FORBIDDEN", "Solo el dueño puede dar o quitar el rol de dueño")
    if (target.role === role) return
    // Se toma la fila de cada dueño antes de contar: dos cambios a la vez no dejan la tienda sin dueño.
    await tx
      .select()
      .from(storeMember)
      .where(and(eq(storeMember.storeId, storeId), eq(storeMember.role, "owner")))
      .for("update")
    await tx
      .update(storeMember)
      .set({ role })
      .where(and(eq(storeMember.storeId, storeId), eq(storeMember.userId, userId)))
    await keepsAnOwner(tx, storeId)
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "equipo.rol",
      subject: userId,
      detail: { from: target.role, to: role },
    })
    // Si cambió quién es el Dueño, la administración lo sabe.
    if (target.role === "owner" || role === "owner") await noteStoreAccount(tx, storeId)
    await noteStoreTeam(tx, storeId)
  })
}

/**
 * Quita a alguien del equipo sin dejar la tienda sin Dueño (`LAST_OWNER`), lo anota y, si era
 * Dueño, se lo avisa a la administración. La usan el equipo y la administración (ADR 0214).
 */
export async function removeMemberIn(
  tx: Db,
  storeId: string,
  userId: string,
  actorUserId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  // Se toma la fila de cada dueño antes de contar: dos cambios a la vez no dejan la tienda sin dueño.
  await tx
    .select()
    .from(storeMember)
    .where(and(eq(storeMember.storeId, storeId), eq(storeMember.role, "owner")))
    .for("update")
  const target = await targetMember(tx, storeId, userId)
  await tx
    .delete(storeMember)
    .where(and(eq(storeMember.storeId, storeId), eq(storeMember.userId, userId)))
  await keepsAnOwner(tx, storeId)
  await tx.insert(storeEvent).values({
    storeId,
    actorUserId,
    action: "equipo.quitado",
    subject: userId,
    detail: { role: target.role, ...detail },
  })
  if (target.role === "owner") await noteStoreAccount(tx, storeId)
  await noteStoreTeam(tx, storeId)
}

export async function removeMember(appDb: Db, person: Person, storeId: string, userId: string) {
  return inStore(appDb, person, storeId, "equipo.gestionar", async (tx, actor) => {
    const target = await targetMember(tx, storeId, userId)
    if (!canAssign(actor, target.role))
      throw new StoreError(403, "FORBIDDEN", "Solo el dueño puede quitar a otro dueño")
    await removeMemberIn(tx, storeId, userId, person.userId)
  })
}

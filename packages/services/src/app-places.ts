import type { AppEvent, TeamRole } from "@odentia/contract"
import type { Db } from "@odentia/db"
import { userGlobalBlock } from "@odentia/db/schema/admin-organizations"
import { type AppPlaceApp, appPlace, appPlaceMember } from "@odentia/db/schema/auth"
import { and, asc, eq, isNull, ne, notExists, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { ServiceError } from "./errors.js"

/**
 * Los lugares de la persona en las apps que son otro sistema (ADR 0217): las tiendas de gestorIA.
 * La cuenta no lee la base de gestorIA: guarda la copia de lo que gestorIA le avisa por el
 * acuerdo (`equipo.cambiado`, el equipo entero de una tienda) y con ella arma el selector de
 * lugares de las clínicas y frena el cierre de la cuenta del único Dueño de una tienda.
 *
 * La copia puede ir unos segundos detrás de la app (el aviso sale de su bandeja cada 30
 * segundos): es la misma espera que con cualquier aviso, y la app la repite si algo se perdió.
 */

/** El rol de cada persona en una tienda, con las palabras de gestorIA. */
const ROLE_WORDS: Record<AppPlaceApp, Record<TeamRole, string>> = {
  gestoria: { owner: "Dueño", admin: "Administrador", sales: "Ventas" },
}

/** Lo que es cada lugar en palabras («la tienda») y el nombre de su app. */
const PLACE_WORDS: Record<AppPlaceApp, { one: string; many: string; app: string }> = {
  gestoria: { one: "tienda", many: "tiendas", app: "gestorIA" },
}

/**
 * Guarda el equipo entero de un lugar de la app. Uno más viejo que lo último guardado no lo
 * pisa (llegan en desorden si se reintentan); el más nuevo reemplaza a todo el equipo.
 */
export async function applyTeamChanged(
  tx: Db,
  app: AppPlaceApp,
  event: Extract<AppEvent, { type: "equipo.cambiado" }>,
): Promise<void> {
  const { account: ref, name, members } = event.data
  const at = new Date(event.timestamp)
  // Dos avisos del mismo lugar a la vez: uno después del otro.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`app-place:${app}:${ref}`}, 0))`,
  )
  const [current] = await tx
    .select({ syncedAt: appPlace.syncedAt })
    .from(appPlace)
    .where(and(eq(appPlace.app, app), eq(appPlace.ref, ref)))
    .limit(1)
  if (current && current.syncedAt > at) return
  await tx
    .insert(appPlace)
    .values({ app, ref, name, syncedAt: at })
    .onConflictDoUpdate({ target: [appPlace.app, appPlace.ref], set: { name, syncedAt: at } })
  await tx
    .delete(appPlaceMember)
    .where(and(eq(appPlaceMember.app, app), eq(appPlaceMember.ref, ref)))
  if (members.length > 0)
    await tx
      .insert(appPlaceMember)
      .values(members.map((member) => ({ app, ref, userId: member.userId, role: member.role })))
}

export interface MyAppPlace {
  app: AppPlaceApp
  /** El id del lugar en su app (en gestorIA, el de la tienda). */
  id: string
  name: string
  role: TeamRole
  /** El rol en palabras de su app («Dueño», «Ventas»). */
  roleLabel: string
}

/** Los lugares de la persona en las otras apps, por nombre. */
export async function listMyAppPlaces(tx: Db, userId: string): Promise<MyAppPlace[]> {
  const rows = await tx
    .select({ app: appPlace.app, id: appPlace.ref, name: appPlace.name, role: appPlaceMember.role })
    .from(appPlaceMember)
    .innerJoin(
      appPlace,
      and(eq(appPlace.app, appPlaceMember.app), eq(appPlace.ref, appPlaceMember.ref)),
    )
    .where(eq(appPlaceMember.userId, userId))
    .orderBy(asc(appPlace.name), asc(appPlace.ref))
  return rows.map((row) => {
    const app = row.app as AppPlaceApp
    const role = row.role as TeamRole
    return { app, id: row.id, name: row.name, role, roleLabel: ROLE_WORDS[app][role] }
  })
}

/**
 * Antes de cerrar la cuenta: un lugar de otra app nunca se queda sin dueño, como una clínica sin
 * Propietario. Si la persona es la única dueña de alguno, no se cierra y se dice cuál.
 *
 * Toma el candado de cada lugar donde es dueña (el mismo de `applyTeamChanged`, en orden) hasta
 * el final de la transacción del cierre: dos dueñas que cierran a la vez no se ven la una a la
 * otra como la que queda.
 */
export async function assertKeepsAppPlaceOwners(tx: Db, userId: string): Promise<void> {
  const owned = await tx
    .select({ app: appPlaceMember.app, ref: appPlaceMember.ref })
    .from(appPlaceMember)
    .where(and(eq(appPlaceMember.userId, userId), eq(appPlaceMember.role, "owner")))
    .orderBy(asc(appPlaceMember.app), asc(appPlaceMember.ref))
  if (owned.length === 0) return
  for (const place of owned)
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`app-place:${place.app}:${place.ref}`}, 0))`,
    )
  const other = alias(appPlaceMember, "other")
  const names = await tx
    .select({ app: appPlace.app, name: appPlace.name })
    .from(appPlaceMember)
    .innerJoin(
      appPlace,
      and(eq(appPlace.app, appPlaceMember.app), eq(appPlace.ref, appPlaceMember.ref)),
    )
    .where(
      and(
        eq(appPlaceMember.userId, userId),
        eq(appPlaceMember.role, "owner"),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(other)
            .where(
              and(
                eq(other.app, appPlaceMember.app),
                eq(other.ref, appPlaceMember.ref),
                eq(other.role, "owner"),
                ne(other.userId, appPlaceMember.userId),
                // Quien ya cerró su cuenta (o la tiene bloqueada sin fecha) no cuenta, aunque la
                // app todavía no haya avisado que salió del equipo.
                notExists(
                  tx
                    .select({ one: sql`1` })
                    .from(userGlobalBlock)
                    .where(
                      and(
                        eq(userGlobalBlock.userId, other.userId),
                        eq(userGlobalBlock.active, true),
                        isNull(userGlobalBlock.expiresAt),
                      ),
                    ),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(appPlace.name))
  const first = names[0]
  if (!first) return
  const words = PLACE_WORDS[first.app as AppPlaceApp]
  const list = names.map((row) => row.name)
  const last = list.pop()
  throw new ServiceError(
    "CONFLICT",
    409,
    list.length === 0
      ? `La ${words.one} ${last} necesita al menos un Dueño y eres el único: antes, en ${words.app}, haz Dueño a otra persona.`
      : `Las ${words.many} ${list.join(", ")} y ${last} necesitan al menos un Dueño y eres el único: antes, en ${words.app}, haz Dueño a otra persona en cada una.`,
  )
}

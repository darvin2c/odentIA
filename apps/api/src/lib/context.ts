import type { Auth } from "@odentia/auth"
import type { Db } from "@odentia/db"
import { member, organization } from "@odentia/db/schema/auth"
import { and, eq } from "drizzle-orm"
import type { Context, Next } from "hono"
import { errorBody } from "./error.js"

export interface OrgContext {
  orgId: string
  userId: string
  memberRole: string
}

export interface SessionVariables {
  userId: string
  orgId: string
  memberRole: string
}

export interface ApiDeps {
  auth: Auth
  db: Db
  cookieDomain: string
}

/** 401 si no hay sesión válida. */
export function requireSession({ auth }: Pick<ApiDeps, "auth">) {
  return async (c: Context, next: Next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) {
      return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
    }
    c.set("userId", session.user.id)
    c.set("userImage", session.user.image ?? null)
    c.set("activeOrganizationId", session.session.activeOrganizationId ?? null)
    await next()
  }
}

/**
 * Resuelve la organización del request:
 *  1. Header `x-odentia-org` (slug).
 *  2. Query param `org` (EventSource no puede enviar headers; lo usa
 *     `/api/notifications/stream`).
 *  3. Si no, activeOrganizationId de la sesión (lo usa el onboarding del
 *     panel: `organization.create` deja la org recién creada como activa).
 * El slug se resuelve a id vía lookup por `organization.slug`; la membresía
 * en `member` siempre se verifica; fija orgId/userId/memberRole.
 * Invariante: el contexto NUNCA sale de un id crudo del cliente sin verificar.
 */
export function requireOrgContext({ db }: Pick<ApiDeps, "db">) {
  return async (c: Context, next: Next) => {
    const userId = c.get("userId") as string
    let orgId: string | null = null

    const slug = c.req.header("x-odentia-org") ?? c.req.query("org") ?? null
    if (slug) {
      const [org] = await db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.slug, slug))
        .limit(1)
      if (!org) {
        return c.json(errorBody(c, "ORG_NOT_FOUND", "Organización no encontrada"), 404)
      }
      orgId = org.id
    }
    orgId ??= (c.get("activeOrganizationId") as string | null) ?? null

    if (!orgId) {
      return c.json(errorBody(c, "ORG_REQUIRED", "No hay organización activa"), 403)
    }

    const [membership] = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
      .limit(1)
    if (!membership) {
      return c.json(errorBody(c, "FORBIDDEN", "No eres miembro de esta organización"), 403)
    }

    c.set("orgId", orgId)
    c.set("memberRole", membership.role)
    await next()
  }
}

export function orgContextOf(c: Context): OrgContext {
  return {
    orgId: c.get("orgId") as string,
    userId: c.get("userId") as string,
    memberRole: c.get("memberRole") as string,
  }
}

export function canWrite(role: string): boolean {
  return role === "owner" || role === "admin"
}

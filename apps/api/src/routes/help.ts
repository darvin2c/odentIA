import { canAccess, canAccessAny, ORG_ROLES, type OrgRole, type Permission, platformPathPermission, ROLE_LABELS } from "@odentia/auth/permissions"
import { withOrgContext } from "@odentia/db"
import { askHelp, describeHelpAttachments, describeHelpScreen, type HelpAsker, listMyHelpRequests, markHelpRequestsSeen, rateHelp, sendHelpRequest } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const askInput = z.object({ question: z.string().trim().min(3).max(500), screen: z.string().max(200) })
const feedbackInput = z.object({ helpful: z.boolean() })
const seenInput = z.object({ id: z.uuid().optional() })
const requestInput = z.object({
  question: z.string().trim().min(3).max(500),
  screen: z.string().max(200),
  kind: z.enum(["pregunta", "problema"]).optional(),
  detail: z.string().max(500).optional(),
})

/** Quién pregunta, visto con la matriz canónica de permisos: la Ayuda no decide accesos, los lee. */
function askerOf(userId: string, memberRole: string): HelpAsker {
  const role = (ORG_ROLES as readonly string[]).includes(memberRole) ? (memberRole as OrgRole) : null
  return {
    userId,
    roleLabel: role ? ROLE_LABELS[role] : memberRole,
    canOpen: (path) => {
      const needed = platformPathPermission(path)
      return needed === null || canAccessAny(memberRole, needed)
    },
    can: (permission) => canAccess(memberRole, permission as Permission),
    whoCan: (permission) => ORG_ROLES.filter((item) => canAccess(item, permission as Permission)).map((item) => ROLE_LABELS[item]),
  }
}

/**
 * Ayuda de odentIA: para todo el equipo, sin permiso propio. No cambia nada y
 * no lee datos de pacientes; lo que responde depende del rol de quien pregunta.
 */
export function createHelpRoute(deps: CrmDeps & { appVersion?: string | null }) {
  const app = new Hono()

  /** La pantalla donde está la persona y lo que un envío a odentIA llevaría de ella. */
  app.get("/screen", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const path = (c.req.query("path") ?? "/").slice(0, 200)
    return runService(c, 200, async () => ({
      ...describeHelpScreen(path),
      attached: await withOrgContext(deps.db, orgId, (tx) =>
        describeHelpAttachments(tx, orgId, askerOf(userId, memberRole), { screen: path, appVersion: deps.appVersion ?? null }),
      ),
    }))
  })

  app.post("/ask", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = askInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => askHelp(tx, orgId, askerOf(userId, memberRole), parsed.data)))
  })

  app.post("/ask/:id/feedback", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const id = z.uuid().safeParse(c.req.param("id"))
    if (!id.success) return validationError(c, id.error.issues)
    const parsed = feedbackInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => rateHelp(tx, orgId, userId, id.data, parsed.data.helpful))
      return { ok: true }
    })
  })

  app.get("/requests", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listMyHelpRequests(tx, orgId, userId)))
  })

  /** La persona decide enviar su pregunta a odentIA: es lo único que sale con su texto. */
  app.post("/requests", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = requestInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendHelpRequest(tx, orgId, askerOf(userId, memberRole), { ...parsed.data, appVersion: deps.appVersion ?? null }),
      ),
    )
  })

  app.post("/requests/seen", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    // Sin cuerpo marca todas; con `id`, solo la respuesta que la persona abrió.
    const parsed = seenInput.safeParse((await c.req.json().catch(() => null)) ?? {})
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await withOrgContext(deps.db, orgId, (tx) => markHelpRequestsSeen(tx, orgId, userId, parsed.data.id))
      return { ok: true }
    })
  })

  return app
}

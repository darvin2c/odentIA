import { type ClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { type Mailer, teamTwoFactorRequiredTemplate } from "@odentia/mail"
import {
  getTeamTwoFactor,
  orgProduct,
  resetMemberTwoFactor,
  setTeamTwoFactorRequired,
  type TeamTwoFactorMember,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { runService, validationError } from "./helpers.js"

export interface TeamTwoFactorDeps {
  ownerDb: Db
  mailer: Mailer
  panelUrlOf: (product: ClinicalProduct) => string
}

const requiredInput = z.object({ required: z.boolean(), notify: z.boolean().optional() })
const resetInput = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Escribe el motivo con al menos 3 caracteres.")
    .max(500, "Escribe el motivo en 500 caracteres como mucho."),
})

/** Mi perfil abre el alta de la verificación con este parámetro. */
export const TWO_FACTOR_PROFILE_PATH = "/profile?edit=two-factor"

/**
 * Configuración › Equipo (ADR 0107): quién tiene la verificación en dos pasos,
 * pedirla a todo el equipo y restablecer la de alguien. Leer, `settings.read`;
 * cambiar, `settings.write` (propietario y administración).
 */
export function createTeamTwoFactorRoute(deps: TeamTwoFactorDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.read")) return c.json(errorBody(c, "FORBIDDEN", "Solo Administración ve el equipo"), 403)
    return runService(c, 200, () => getTeamTwoFactor(deps.ownerDb, orgId))
  })

  app.put("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo Administración cambia cómo entra el equipo"), 403)
    const parsed = requiredInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      const result = await setTeamTwoFactorRequired(deps.ownerDb, { orgId, actorUserId: userId, required: parsed.data.required })
      const notified = parsed.data.notify ? await notifyMissing(deps, orgId, result.missing) : 0
      return { required: result.required, missing: result.missing.length, notified }
    })
  })

  app.post("/:userId/reset", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo Administración restablece la verificación"), 403)
    const parsed = resetInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await resetMemberTwoFactor(deps.ownerDb, {
        orgId,
        actorUserId: userId,
        actorRole: memberRole,
        targetUserId: c.req.param("userId"),
        reason: parsed.data.reason,
      })
      return { ok: true }
    })
  })

  return app
}

/**
 * Avisa por correo a quien le falta activarla. La exigencia ya quedó guardada:
 * un correo que no sale no la deshace, solo no cuenta como avisado.
 */
async function notifyMissing(deps: TeamTwoFactorDeps, orgId: string, missing: TeamTwoFactorMember[]): Promise<number> {
  if (missing.length === 0) return 0
  const product = await orgProduct(deps.ownerDb, orgId)
  const [org] = await deps.ownerDb.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId)).limit(1)
  const url = `${deps.panelUrlOf(product)}${TWO_FACTOR_PROFILE_PATH}`
  let sent = 0
  for (const person of missing) {
    try {
      const template = teamTwoFactorRequiredTemplate({
        firstName: person.name.split(" ")[0] || undefined,
        organizationName: org?.name ?? "Tu clínica",
        url,
        brand: productWords(product).brand,
      })
      await deps.mailer.send({ to: person.email, ...template })
      sent++
    } catch (error) {
      console.error("[two-factor] no se pudo avisar a un miembro", error)
    }
  }
  return sent
}

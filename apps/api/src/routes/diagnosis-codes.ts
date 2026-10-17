import { withOrgContext } from "@odentia/db"
import { getDiagnosisSuggestions, searchDiagnosisCodes } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const suggestionsQuery = z
  .object({
    patientId: z.uuid().optional(),
    encounterId: z.uuid().optional(),
    condition: z.string().trim().min(1).max(80).optional(),
    variant: z.string().trim().max(80).optional(),
    toothNumber: z.coerce.number().int().optional(),
  })
  .strict()

/**
 * La lista de diagnósticos de la clínica (ADR 0041): el buscador de toda la
 * lista y los pasos 1 y 2 del diagnóstico (lo que propone el odontograma y lo
 * más usado en la clínica).
 */
export function createDiagnosisCodesRoute(deps: CrmDeps) {
  const app = new Hono()
  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "No tienes permiso para ver el catálogo clínico"),
        403,
      )
    }
    const q = c.req.query("q") ?? ""
    if (q.trim().length < 1) {
      return validationError(c, [
        { message: "q es requerido", code: "custom", path: ["q"] },
      ] as never)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => searchDiagnosisCodes(tx, orgId, q.trim())),
    )
  })
  app.get("/suggestions", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "clinical.read")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "No tienes permiso para ver el catálogo clínico"),
        403,
      )
    }
    const parsed = suggestionsQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { patientId, encounterId, condition, variant, toothNumber } = parsed.data
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getDiagnosisSuggestions(tx, orgId, {
          patientId: patientId ?? null,
          encounterId: encounterId ?? null,
          finding: condition
            ? { condition, variant: variant || null, toothNumber: toothNumber ?? null }
            : null,
        }),
      ),
    )
  })
  return app
}

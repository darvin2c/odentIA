import { SURFACES } from "@odentia/dental"
import { withOrgContext } from "@odentia/db"
import {
  addOdontogramEntries,
  createOdontogramAssessment,
  getOdontogram,
  getOdontogramPrint,
  getSignedOdontogramPrint,
  getToothHistory,
  listOdontogramAssessments,
  registerToothFinding,
  reviewLegacyEntry,
  voidOdontogramEntry,
} from "@odentia/services/dental"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../../lib/context.js"
import { type CrmDeps, runService, validationError } from "../helpers.js"

/**
 * Odontograma (ADR 0079: lo dental de la ficha). Va bajo
 * `/patients/:id/odontogram`, subruta clínica: la ficha exige
 * `clinical.read`/`.write` y deja cada lectura en la bitácora de consultas.
 */

// NTS 188: la validación normativa real la hace el servicio (dominio
// compartido, fail closed); aquí solo forma/tipos. Superficies canónicas del
// paquete (facial en anterior, buccal solo en posterior: el servicio rechaza
// el cruce). strict arriba: un `status` legado se rechaza, nunca se ignora.
const odontogramSurface = z.enum(SURFACES as unknown as [string, ...string[]])
const findingDetailsInput = z
  .object({
    variant: z.string().max(80).optional(),
    quality: z.enum(["good", "poor"]).optional(),
    grade: z.number().int().optional(),
    direction: z.enum(["clockwise", "counterclockwise"]).optional(),
    positions: z.array(z.string().max(30)).max(16).optional(),
    relatedTeeth: z.array(z.number().int()).max(52).optional(),
    abutmentTeeth: z.array(z.number().int()).max(52).optional(),
    clinicallyObserved: z.boolean().optional(),
    drawing: z
      .array(z.array(z.tuple([z.number(), z.number()])).min(1))
      .max(64)
      .optional(),
    specifications: z.string().max(2000).optional(),
    observations: z.string().max(2000).optional(),
  })
  .catchall(z.unknown())
// Los hallazgos se registran dentro de una atención: sin ella, 400.
const odontogramInput = z
  .object({
    toothNumber: z.number().int(),
    condition: z.string().trim().min(1).max(80),
    surfaces: z.array(odontogramSurface).max(8).default([]),
    details: findingDetailsInput.optional(),
    note: z.string().max(2000).nullish(),
    diagnosisCode: z.string().max(10).nullish(),
    diagnosisSystem: z.string().max(20).nullish(),
    encounterId: z.uuid(),
  })
  .strict()
// El panel de la pieza: hallazgo, diagnóstico de la lista de la clínica con su tipo y
// tratamiento en una sola operación (`registerToothFinding`).
const toothFindingInput = z
  .object({
    encounterId: z.uuid(),
    toothNumbers: z.array(z.number().int()).min(1).max(52),
    condition: z.string().trim().min(1).max(80),
    surfaces: z.array(odontogramSurface).max(8).default([]),
    details: findingDetailsInput.optional(),
    note: z.string().max(2000).nullish(),
    diagnosis: z
      .object({
        diagnosisCode: z.string().trim().min(1).max(10),
        diagnosisSystem: z.string().max(20).nullish(),
        diagnosisType: z.string().max(20),
      })
      .strict()
      .nullish(),
    treatment: z
      .object({ serviceId: z.uuid(), detail: z.string().max(4000).nullish() })
      .strict()
      .nullish(),
  })
  .strict()
const voidInput = z.object({ reason: z.string().trim().min(1).max(2000) })
// «Firmar odontograma» (solo en clínicas de Perú): quién firma no se escribe y
// no hay trazo; nombre, título y colegiatura salen del perfil de quien firma.
// Un cuerpo que los trae se rechaza (`strict`). El servicio admite aquí solo
// lo judicial, lo personal y el reingreso.
const assessmentInput = z.strictObject({
  purpose: z.enum(["initial", "new_findings", "completion", "reentry", "legal", "personal"]),
  specifications: z.string().trim().max(4000).nullish(),
  observations: z.string().trim().max(4000).nullish(),
})

export function createPatientOdontogramRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/:id/odontogram", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getOdontogram(tx, orgId, c.req.param("id"))),
    )
  })
  // Historia de una pieza: hallazgos, diagnósticos, actos, controles y documentos.
  app.get("/:id/odontogram/teeth/:tooth/history", async (c) => {
    const { orgId } = orgContextOf(c)
    const tooth = Number(c.req.param("tooth"))
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getToothHistory(tx, orgId, c.req.param("id"), tooth)),
    )
  })
  app.post("/:id/odontogram/entries", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = odontogramInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addOdontogramEntries(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })
  // Panel de la pieza: «Registrar y agregar al plan», todo o nada.
  app.post("/:id/odontogram/findings", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = toothFindingInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        registerToothFinding(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })
  // Hoja neutra para imprimir (donde el odontograma no se firma).
  app.get("/:id/odontogram/print", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getOdontogramPrint(tx, orgId, c.req.param("id"))),
    )
  })
  app.post("/:id/odontogram/entries/:entryId/void", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = voidInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidOdontogramEntry(
          tx,
          orgId,
          userId,
          c.req.param("entryId"),
          c.req.param("id"),
          parsed.data.reason,
        ),
      ),
    )
  })
  app.post("/:id/odontogram/entries/:entryId/review", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = voidInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        reviewLegacyEntry(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("entryId"),
          parsed.data.reason,
        ),
      ),
    )
  })
  app.get("/:id/odontogram/assessments", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listOdontogramAssessments(tx, orgId, c.req.param("id")),
      ),
    )
  })
  // Un odontograma firmado para ver e imprimir (gráfico de la norma, en negro).
  app.get("/:id/odontogram/assessments/:assessmentId/print", async (c) => {
    const { orgId } = orgContextOf(c)
    const assessmentId = z.uuid().safeParse(c.req.param("assessmentId"))
    if (!assessmentId.success) return validationError(c, assessmentId.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getSignedOdontogramPrint(tx, orgId, c.req.param("id"), assessmentId.data),
      ),
    )
  })
  app.post("/:id/odontogram/assessments", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = assessmentInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createOdontogramAssessment(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  return app
}

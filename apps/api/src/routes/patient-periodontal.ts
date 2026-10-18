import {
  FURCATION_ENTRIES,
  PERI_IMPLANT_CONDITIONS,
  PERIODONTAL_DIAGNOSES,
  PERIODONTAL_EXTENTS,
  PERIODONTITIS_GRADES,
  PERIODONTITIS_STATUSES,
} from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import {
  classifyPeriodontalChart,
  comparePeriodontalCharts,
  getPeriodontalChart,
  listPeriodontalCharts,
  savePeriodontalTooth,
  startPeriodontalChart,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/**
 * Periodontograma (issue 49, ADR 0054). Va bajo `/patients/:id/periodontal`,
 * subruta clínica: exige `clinical.read`/`.write` y cada lectura queda en la
 * bitácora de consultas como «periodontograma». Los rangos y las formas los
 * valida el servicio con las reglas de `@odentia/clinical`.
 */
const sites = <T extends z.ZodType>(item: T) => z.array(item).length(6)
const toothInput = z
  .object({
    skipped: z.boolean().optional(),
    probingDepth: sites(z.number().int().nullable()).optional(),
    recession: sites(z.number().int().nullable()).optional(),
    bleeding: sites(z.boolean()).optional(),
    suppuration: sites(z.boolean()).optional(),
    mobility: z.number().int().nullable().optional(),
    furcation: z.partialRecord(z.enum(FURCATION_ENTRIES), z.union([z.literal(1), z.literal(2), z.literal(3)])).optional(),
    plaque: z.array(z.boolean()).length(4).nullable().optional(),
    periImplant: z.enum(PERI_IMPLANT_CONDITIONS).nullable().optional(),
  })
  .strict()
const startInput = z.object({ encounterId: z.uuid() }).strict()
const classifyInput = z
  .object({
    diagnosis: z.enum(PERIODONTAL_DIAGNOSES),
    stage: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullish(),
    grade: z.enum(PERIODONTITIS_GRADES).nullish(),
    extent: z.enum(PERIODONTAL_EXTENTS).nullish(),
    status: z.enum(PERIODONTITIS_STATUSES).nullish(),
    boneLossPercent: z.number().int().nullish(),
    teethLostToPeriodontitis: z.number().int().nullish(),
    cigarettesPerDay: z.number().int().nullish(),
    diabetes: z.boolean().nullish(),
    hba1c: z.number().nullish(),
    implants: z
      .array(z.object({ toothNumber: z.number().int(), condition: z.enum(PERI_IMPLANT_CONDITIONS) }).strict())
      .max(32)
      .optional(),
  })
  .strict()
const compareQuery = z.object({ before: z.uuid(), after: z.uuid() }).strict()
const chartParams = z.object({ id: z.uuid(), chartId: z.uuid() })

export function createPatientPeriodontalRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.get("/:id/periodontal", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listPeriodontalCharts(tx, orgId, params.data.id)),
    )
  })
  // Antes que `/:chartId`: dos visitas lado a lado.
  app.get("/:id/periodontal/compare", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const query = compareQuery.safeParse(c.req.query())
    if (!query.success) return validationError(c, query.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        comparePeriodontalCharts(tx, orgId, params.data.id, query.data.before, query.data.after),
      ),
    )
  })
  app.get("/:id/periodontal/:chartId", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = chartParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getPeriodontalChart(tx, orgId, params.data.id, params.data.chartId)),
    )
  })
  app.post("/:id/periodontal", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = startInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => startPeriodontalChart(tx, orgId, userId, params.data.id, parsed.data)),
    )
  })
  app.put("/:id/periodontal/:chartId/teeth/:tooth", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = chartParams.extend({ tooth: z.coerce.number().int() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = toothInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        savePeriodontalTooth(tx, orgId, userId, params.data.id, params.data.chartId, {
          ...parsed.data,
          toothNumber: params.data.tooth,
        }),
      ),
    )
  })
  app.post("/:id/periodontal/:chartId/classification", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = chartParams.safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = classifyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        classifyPeriodontalChart(tx, orgId, userId, params.data.id, params.data.chartId, parsed.data),
      ),
    )
  })
  return app
}

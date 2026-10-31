import type { Db } from "@odentia/db"
import { pipeline, pipelineStage } from "@odentia/db/schema/crm"
import { and, asc, eq } from "drizzle-orm"
import { invalidField, isUniqueViolation, notFound } from "./errors.js"

/**
 * Los cuatro pasos fijos de una venta (ADR 0028). Cada uno tiene su «momento»:
 * lo que hace que la oportunidad llegue sola. La clínica puede cambiarles el
 * nombre, nunca añadir ni quitar pasos, porque entonces ya no podrían avanzar
 * solos.
 *
 * - `interesado`: la persona pidió algo concreto (precio, tratamiento, evaluación).
 * - `evaluacion_agendada`: agendó una cita.
 * - `presupuesto_enviado`: se le presentó un presupuesto.
 * - `decidio`: aceptó (ganada) o no (perdida).
 */
export const SALE_MOMENTS = ["interesado", "evaluacion_agendada", "presupuesto_enviado", "decidio"] as const
export type SaleMoment = (typeof SALE_MOMENTS)[number]

/** El nombre con que nace cada paso. */
export const SALE_MOMENT_NAMES: Record<SaleMoment, string> = {
  interesado: "Interesado",
  evaluacion_agendada: "Evaluación agendada",
  presupuesto_enviado: "Presupuesto enviado",
  decidio: "Decidió",
}

/** Orden de los pasos: una oportunidad avanza sola solo hacia adelante. */
export function momentRank(moment: string): number {
  const index = (SALE_MOMENTS as readonly string[]).indexOf(moment)
  return index < 0 ? 0 : index
}

export function isSaleMoment(value: string): value is SaleMoment {
  return (SALE_MOMENTS as readonly string[]).includes(value)
}

export interface Stage {
  id: string
  pipelineId: string
  name: string
  position: number
  moment: SaleMoment
}

function toStage(row: typeof pipelineStage.$inferSelect): Stage {
  return {
    id: row.id,
    pipelineId: row.pipelineId,
    name: row.name,
    position: row.position,
    moment: isSaleMoment(row.moment) ? row.moment : "interesado",
  }
}

async function stagesOf(tx: Db, pipelineId: string): Promise<Stage[]> {
  const rows = await tx
    .select()
    .from(pipelineStage)
    .where(eq(pipelineStage.pipelineId, pipelineId))
    .orderBy(asc(pipelineStage.position))
  return rows.map(toStage)
}

/**
 * Devuelve el embudo de la organización, creándolo con sus cuatro pasos si no
 * existe. Idempotente ante carreras (único parcial en `is_default`).
 */
export async function ensureDefaultPipeline(
  tx: Db,
  orgId: string,
): Promise<{ pipelineId: string; stages: Stage[] }> {
  const existing = await tx
    .select()
    .from(pipeline)
    .where(eq(pipeline.organizationId, orgId))
    .orderBy(asc(pipeline.createdAt))
    .limit(1)
  let pipe = existing[0]
  if (!pipe) {
    try {
      const [created] = await tx
        .insert(pipeline)
        .values({ organizationId: orgId, name: "Ventas", isDefault: true })
        .returning()
      if (!created) throw new Error("No se pudo crear el embudo")
      await tx.insert(pipelineStage).values(
        SALE_MOMENTS.map((moment, position) => ({
          organizationId: orgId,
          pipelineId: created.id,
          name: SALE_MOMENT_NAMES[moment],
          position,
          moment,
        })),
      )
      pipe = created
    } catch (error) {
      // Carrera: otro proceso creó el embudo; releer.
      if (!isUniqueViolation(error)) throw error
      const [retry] = await tx
        .select()
        .from(pipeline)
        .where(eq(pipeline.organizationId, orgId))
        .orderBy(asc(pipeline.createdAt))
        .limit(1)
      if (!retry) throw error
      pipe = retry
    }
  }
  return { pipelineId: pipe.id, stages: await stagesOf(tx, pipe.id) }
}

export interface PipelineWithStages {
  id: string
  name: string
  isDefault: boolean
  stages: Stage[]
}

export async function listPipelines(tx: Db, orgId: string): Promise<PipelineWithStages[]> {
  const pipes = await tx
    .select()
    .from(pipeline)
    .where(eq(pipeline.organizationId, orgId))
    .orderBy(asc(pipeline.createdAt))
  if (pipes.length === 0) {
    const ensured = await ensureDefaultPipeline(tx, orgId)
    const [created] = await tx
      .select()
      .from(pipeline)
      .where(eq(pipeline.id, ensured.pipelineId))
      .limit(1)
    if (!created) throw new Error("No se pudo crear el embudo")
    return [
      { id: created.id, name: created.name, isDefault: created.isDefault, stages: ensured.stages },
    ]
  }
  const stageRows = await tx
    .select()
    .from(pipelineStage)
    .where(eq(pipelineStage.organizationId, orgId))
    .orderBy(asc(pipelineStage.position))
  return pipes.map((p) => ({
    id: p.id,
    name: p.name,
    isDefault: p.isDefault,
    stages: stageRows.filter((s) => s.pipelineId === p.id).map(toStage),
  }))
}

/** El paso de un embudo por su momento. */
export async function stageOfMoment(
  tx: Db,
  orgId: string,
  pipelineId: string,
  moment: SaleMoment,
): Promise<Stage> {
  const [row] = await tx
    .select()
    .from(pipelineStage)
    .where(
      and(
        eq(pipelineStage.organizationId, orgId),
        eq(pipelineStage.pipelineId, pipelineId),
        eq(pipelineStage.moment, moment),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Etapa")
  return toStage(row)
}

/**
 * Cambiar el nombre de un paso: lo único que la clínica ajusta. El paso, su
 * orden y su momento no cambian.
 */
export async function renameStage(
  tx: Db,
  orgId: string,
  stageId: string,
  input: { name: string },
): Promise<Stage> {
  const name = input.name.trim()
  if (!name) throw invalidField("name", "Escribe el nombre del paso")
  if (name.length > 120) throw invalidField("name", "El nombre del paso no puede superar 120 caracteres")
  const [updated] = await tx
    .update(pipelineStage)
    .set({ name })
    .where(and(eq(pipelineStage.id, stageId), eq(pipelineStage.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Etapa")
  return toStage(updated)
}

import type { Db } from "@odentia/db";
import { contact, pipeline, pipelineStage } from "@odentia/db/schema/crm";
import { and, asc, eq } from "drizzle-orm";
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js";

export type StageKind = "open" | "won" | "lost";

const STAGE_KINDS: StageKind[] = ["open", "won", "lost"];

/** Etapas por defecto (es-PE) del pipeline "Ventas". */
const DEFAULT_STAGES: { name: string; kind: StageKind }[] = [
  { name: "Nuevo", kind: "open" },
  { name: "Contactado", kind: "open" },
  { name: "Cita agendada", kind: "open" },
  { name: "Ganado", kind: "won" },
  { name: "Perdido", kind: "lost" },
];

export interface Stage {
  id: string;
  pipelineId: string;
  name: string;
  position: number;
  kind: string;
}

function toStage(row: typeof pipelineStage.$inferSelect): Stage {
  return { id: row.id, pipelineId: row.pipelineId, name: row.name, position: row.position, kind: row.kind };
}

/**
 * Devuelve el pipeline default de la org, creándolo con sus etapas si no
 * existe. Idempotente ante carreras (unique parcial en is_default).
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
    .limit(1);
  let pipe = existing[0];
  if (!pipe) {
    try {
      const [created] = await tx
        .insert(pipeline)
        .values({ organizationId: orgId, name: "Ventas", isDefault: true })
        .returning();
      if (!created) throw new Error("No se pudo crear el pipeline");
      await tx.insert(pipelineStage).values(
        DEFAULT_STAGES.map((s, position) => ({
          organizationId: orgId,
          pipelineId: created.id,
          name: s.name,
          position,
          kind: s.kind,
        })),
      );
      pipe = created;
    } catch (error) {
      // Carrera: otro worker creó el default; releer.
      if (!isUniqueViolation(error)) throw error;
      const [retry] = await tx
        .select()
        .from(pipeline)
        .where(eq(pipeline.organizationId, orgId))
        .orderBy(asc(pipeline.createdAt))
        .limit(1);
      if (!retry) throw error;
      pipe = retry;
    }
  }
  const rows = await tx
    .select()
    .from(pipelineStage)
    .where(eq(pipelineStage.pipelineId, pipe.id))
    .orderBy(asc(pipelineStage.position));
  return { pipelineId: pipe.id, stages: rows.map(toStage) };
}

export interface PipelineWithStages {
  id: string;
  name: string;
  isDefault: boolean;
  stages: Stage[];
}

export async function listPipelines(tx: Db, orgId: string): Promise<PipelineWithStages[]> {
  const pipes = await tx
    .select()
    .from(pipeline)
    .where(eq(pipeline.organizationId, orgId))
    .orderBy(asc(pipeline.createdAt));
  if (pipes.length === 0) {
    const ensured = await ensureDefaultPipeline(tx, orgId);
    const [created] = await tx.select().from(pipeline).where(eq(pipeline.id, ensured.pipelineId)).limit(1);
    if (!created) throw new Error("No se pudo crear el pipeline");
    return [{ id: created.id, name: created.name, isDefault: created.isDefault, stages: ensured.stages }];
  }
  const stageRows = await tx
    .select()
    .from(pipelineStage)
    .where(eq(pipelineStage.organizationId, orgId))
    .orderBy(asc(pipelineStage.position));
  return pipes.map((p) => ({
    id: p.id,
    name: p.name,
    isDefault: p.isDefault,
    stages: stageRows.filter((s) => s.pipelineId === p.id).map(toStage),
  }));
}

export async function createPipeline(tx: Db, orgId: string, input: { name: string }): Promise<PipelineWithStages> {
  const name = input.name.trim();
  if (!name) throw validation("El nombre del pipeline es obligatorio");
  const existing = await tx.select({ id: pipeline.id }).from(pipeline).where(eq(pipeline.organizationId, orgId)).limit(1);
  const [created] = await tx
    .insert(pipeline)
    .values({ organizationId: orgId, name, isDefault: existing.length === 0 })
    .returning();
  if (!created) throw new Error("No se pudo crear el pipeline");
  return { id: created.id, name: created.name, isDefault: created.isDefault, stages: [] };
}

export async function renamePipeline(tx: Db, orgId: string, id: string, input: { name: string }): Promise<void> {
  const name = input.name.trim();
  if (!name) throw validation("El nombre del pipeline es obligatorio");
  const updated = await tx
    .update(pipeline)
    .set({ name })
    .where(and(eq(pipeline.id, id), eq(pipeline.organizationId, orgId)))
    .returning({ id: pipeline.id });
  if (updated.length === 0) throw notFound("Pipeline");
}

async function requirePipeline(tx: Db, orgId: string, pipelineId: string): Promise<void> {
  const [found] = await tx
    .select({ id: pipeline.id })
    .from(pipeline)
    .where(and(eq(pipeline.id, pipelineId), eq(pipeline.organizationId, orgId)))
    .limit(1);
  if (!found) throw notFound("Pipeline");
}

async function requireStage(tx: Db, orgId: string, stageId: string): Promise<Stage> {
  const [found] = await tx
    .select()
    .from(pipelineStage)
    .where(and(eq(pipelineStage.id, stageId), eq(pipelineStage.organizationId, orgId)))
    .limit(1);
  if (!found) throw notFound("Etapa");
  return toStage(found);
}

export async function createStage(
  tx: Db,
  orgId: string,
  pipelineId: string,
  input: { name: string; kind?: string },
): Promise<Stage> {
  const name = input.name.trim();
  if (!name) throw validation("El nombre de la etapa es obligatorio");
  const kind = input.kind ?? "open";
  if (!STAGE_KINDS.includes(kind as StageKind)) throw validation("kind inválido (open|won|lost)");
  const siblings = await tx
    .select({ position: pipelineStage.position })
    .from(pipelineStage)
    .where(eq(pipelineStage.pipelineId, pipelineId));
  const position = siblings.reduce((max, s) => Math.max(max, s.position), -1) + 1;
  // position es unique por pipeline: reintentar una vez ante carreras.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [created] = await tx
        .insert(pipelineStage)
        .values({ organizationId: orgId, pipelineId, name, position: position + attempt, kind })
        .returning();
      if (!created) throw new Error("No se pudo crear la etapa");
      return toStage(created);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 1) throw error;
    }
  }
  throw new Error("No se pudo crear la etapa");
}

export async function updateStage(
  tx: Db,
  orgId: string,
  stageId: string,
  input: { name?: string; kind?: string },
): Promise<Stage> {
  const stage = await requireStage(tx, orgId, stageId);
  const patch: { name?: string; kind?: string } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw validation("El nombre de la etapa es obligatorio");
    patch.name = name;
  }
  if (input.kind !== undefined) {
    if (!STAGE_KINDS.includes(input.kind as StageKind)) throw validation("kind inválido (open|won|lost)");
    patch.kind = input.kind;
  }
  if (Object.keys(patch).length === 0) return stage;
  const [updated] = await tx
    .update(pipelineStage)
    .set(patch)
    .where(and(eq(pipelineStage.id, stageId), eq(pipelineStage.organizationId, orgId)))
    .returning();
  if (!updated) throw notFound("Etapa");
  return toStage(updated);
}

/** Reasigna posiciones en dos fases (negativos temporales) para no violar el unique. */
async function reassignPositions(tx: Db, orderedIds: string[]): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await tx.update(pipelineStage).set({ position: -(index + 1) }).where(eq(pipelineStage.id, id));
  }
  for (const [index, id] of orderedIds.entries()) {
    await tx.update(pipelineStage).set({ position: index }).where(eq(pipelineStage.id, id));
  }
}

export async function deleteStage(tx: Db, orgId: string, stageId: string): Promise<void> {
  const stage = await requireStage(tx, orgId, stageId);
  const [used] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.stageId, stageId), eq(contact.organizationId, orgId)))
    .limit(1);
  if (used) {
    throw new ServiceError("STAGE_IN_USE", 409, "La etapa tiene contactos y no se puede eliminar");
  }
  await tx
    .delete(pipelineStage)
    .where(and(eq(pipelineStage.id, stageId), eq(pipelineStage.organizationId, orgId)));
  // Compactar posiciones restantes.
  const siblings = await tx
    .select({ id: pipelineStage.id })
    .from(pipelineStage)
    .where(eq(pipelineStage.pipelineId, stage.pipelineId))
    .orderBy(asc(pipelineStage.position));
  await reassignPositions(tx, siblings.map((s) => s.id));
}

export async function reorderStages(tx: Db, orgId: string, pipelineId: string, stageIds: string[]): Promise<Stage[]> {
  await requirePipeline(tx, orgId, pipelineId);
  const rows = await tx
    .select()
    .from(pipelineStage)
    .where(and(eq(pipelineStage.pipelineId, pipelineId), eq(pipelineStage.organizationId, orgId)));
  const current = new Set(rows.map((r) => r.id));
  if (stageIds.length !== rows.length || !stageIds.every((id) => current.has(id))) {
    throw validation("stageIds debe contener exactamente las etapas del pipeline");
  }
  await reassignPositions(tx, stageIds);
  const updated = await tx
    .select()
    .from(pipelineStage)
    .where(eq(pipelineStage.pipelineId, pipelineId))
    .orderBy(asc(pipelineStage.position));
  return updated.map(toStage);
}

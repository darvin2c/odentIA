import type { Db } from "@odentia/db";
import { clinicalNote, encounter, encounterProcedure, encounterTooth, odontogramEntry, patientAnamnesis, patientDocument, treatmentPlanItem } from "@odentia/db/schema/clinical";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getOdontogram, VALID_FDI_TEETH } from "./clinical.js";
import { decodeCursor, encodeCursor } from "./cursors.js";
import { validation } from "./errors.js";
import { requirePatient } from "./patients.js";

export async function getPatientSummary(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId);
  const [lastEncounter] = await tx.select().from(encounter)
    .where(and(eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId), eq(encounter.status, "finalizada")))
    .orderBy(desc(encounter.finalizedAt), desc(encounter.id)).limit(1);
  const [draft] = await tx.select({ id: encounter.id }).from(encounter)
    .where(and(eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId), eq(encounter.status, "borrador"))).limit(1);
  const pending = await tx.select({ priceCents: treatmentPlanItem.priceCents, currency: treatmentPlanItem.currency }).from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.patientId, patientId), inArray(treatmentPlanItem.status, ["pendiente", "programado"])));
  const totals = new Map<string, { currency: string; count: number; totalCents: number }>();
  for (const item of pending) {
    const total = totals.get(item.currency) ?? { currency: item.currency, count: 0, totalCents: 0 };
    total.count++;
    total.totalCents += item.priceCents ?? 0;
    totals.set(item.currency, total);
  }
  const amounts = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  const odontogram = await getOdontogram(tx, orgId, patientId);
  return {
    lastEncounter: lastEncounter ?? null,
    openEncounterId: draft?.id ?? null,
    nextAppointmentAt: lastEncounter?.nextAppointmentAt ?? null,
    // Nunca sumar monedas distintas: la UI muestra un total por moneda.
    planPending: { count: pending.length, totalCents: amounts.length > 1 ? null : amounts[0]?.totalCents ?? 0, currency: amounts.length > 1 ? null : amounts[0]?.currency ?? "PEN", totals: amounts },
    activeDiagnoses: Object.entries(odontogram.teeth).filter(([, tooth]) => tooth.condition !== "sano")
      .slice(0, 20).map(([toothNumber, tooth]) => ({ toothNumber: Number(toothNumber), condition: tooth.condition, status: tooth.status })),
  };
}

export const TIMELINE_TYPES = ["encounter", "note", "anamnesis", "document", "odontogram"] as const;
export type TimelineType = typeof TIMELINE_TYPES[number];
export interface TimelineItem {
  id: string;
  type: TimelineType;
  createdAt: Date;
  title: string;
  detail?: string | null;
  toothNumbers: number[];
  authorId?: string | null;
  refId: string;
  diagnosisCode?: string | null;
  category?: string;
  version?: number;
  condition?: string;
  surface?: string | null;
  status?: string;
  procedures?: string[];
  documentsCount?: number;
  nextStep?: string | null;
  nextAppointmentAt?: Date | null;
}

export async function getTimeline(tx: Db, orgId: string, patientId: string, input: {
  cursor?: string; limit?: number; types?: readonly TimelineType[]; toothNumber?: number;
  documentCategory?: "radiografia" | "foto_clinica";
} = {}): Promise<{ data: TimelineItem[]; nextCursor: string | null }> {
  await requirePatient(tx, orgId, patientId);
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const types = input.types ?? TIMELINE_TYPES;
  if (types.some((type) => !TIMELINE_TYPES.includes(type))) throw validation("Tipo de historia inválido");
  if (input.toothNumber != null && !VALID_FDI_TEETH.includes(input.toothNumber)) throw validation("Pieza FDI inválida");
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (input.cursor && (!cursor || Number.isNaN(Date.parse(cursor.ts)) || !/^[0-9a-f-]{36}$/i.test(cursor.id))) throw validation("Cursor inválido");
  const tooth = input.toothNumber;
  const branches: SQL[] = [];
  if (types.includes("encounter")) branches.push(sql`select id, 'encounter'::text as kind, created_at from encounter where organization_id = ${orgId} and patient_id = ${patientId}::uuid and status = 'finalizada'
    ${tooth == null ? sql`` : sql`and exists (select 1 from encounter_tooth et where et.encounter_id = encounter.id and et.organization_id = ${orgId} and et.tooth_number = ${tooth})`}`);
  if (types.includes("note") && tooth == null) branches.push(sql`select id, 'note'::text as kind, created_at from clinical_note where organization_id = ${orgId} and patient_id = ${patientId}::uuid and encounter_id is null`);
  if (types.includes("anamnesis") && tooth == null) branches.push(sql`select id, 'anamnesis'::text as kind, created_at from patient_anamnesis where organization_id = ${orgId} and patient_id = ${patientId}::uuid`);
  if (types.includes("odontogram")) branches.push(sql`select id, 'odontogram'::text as kind, created_at from odontogram_entry where organization_id = ${orgId} and patient_id = ${patientId}::uuid and encounter_id is null and status <> 'anulado' ${tooth == null ? sql`` : sql`and tooth_number = ${tooth}`}`);
  if (types.includes("document")) branches.push(sql`select id, 'document'::text as kind, created_at from patient_document where organization_id = ${orgId} and patient_id = ${patientId}::uuid and encounter_id is null ${tooth == null ? sql`` : sql`and tooth_number = ${tooth}`} ${input.documentCategory ? sql`and category = ${input.documentCategory}` : sql``}`);
  if (!branches.length) return { data: [], nextCursor: null };
  const rows = await tx.execute<{ id: string; kind: TimelineType; cursor_ts: string }>(sql`
    select id, kind, created_at::text as cursor_ts from (${sql.join(branches, sql` union all `)}) events
    ${cursor ? sql`where (created_at, id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : sql``}
    order by created_at desc, id desc limit ${limit + 1}`);
  const page = rows.slice(0, limit);
  if (!page.length) return { data: [], nextCursor: null };
  const ids = (type: TimelineType) => page.filter((row) => row.kind === type).map((row) => row.id);
  const hydrated = new Map<string, TimelineItem>();
  const encounters = ids("encounter");
  if (encounters.length) {
    const records = await tx.select().from(encounter).where(and(eq(encounter.organizationId, orgId), inArray(encounter.id, encounters)));
    const teeth = await tx.select().from(encounterTooth).where(and(eq(encounterTooth.organizationId, orgId), inArray(encounterTooth.encounterId, encounters)));
    const procedures = await tx.select().from(encounterProcedure).where(and(eq(encounterProcedure.organizationId, orgId), inArray(encounterProcedure.encounterId, encounters)));
    const docs = await tx.select({ encounterId: patientDocument.encounterId }).from(patientDocument).where(and(eq(patientDocument.organizationId, orgId), inArray(patientDocument.encounterId, encounters)));
    for (const row of records) hydrated.set(row.id, {
      id: row.id, refId: row.id, type: "encounter", createdAt: row.createdAt, title: row.reason || "Atención", detail: row.evolution,
      toothNumbers: teeth.filter((t) => t.encounterId === row.id).map((t) => t.toothNumber).sort((a, b) => a - b),
      authorId: row.dentistUserId, status: row.status, nextStep: row.nextStep, nextAppointmentAt: row.nextAppointmentAt,
      procedures: procedures.filter((p) => p.encounterId === row.id).map((p) => p.description), documentsCount: docs.filter((d) => d.encounterId === row.id).length,
    });
  }
  const notes = ids("note");
  if (notes.length) for (const row of await tx.select().from(clinicalNote).where(and(eq(clinicalNote.organizationId, orgId), inArray(clinicalNote.id, notes)))) {
    hydrated.set(row.id, { id: row.id, refId: row.id, type: "note", createdAt: row.createdAt, title: "Nota clínica", detail: row.note, diagnosisCode: row.diagnosisCode, toothNumbers: [], authorId: row.authorUserId });
  }
  const anamneses = ids("anamnesis");
  if (anamneses.length) for (const row of await tx.select().from(patientAnamnesis).where(and(eq(patientAnamnesis.organizationId, orgId), inArray(patientAnamnesis.id, anamneses)))) {
    const answers = row.answers as Record<string, unknown>;
    hydrated.set(row.id, { id: row.id, refId: row.id, type: "anamnesis", createdAt: row.createdAt, title: `Anamnesis v${row.version}`, detail: typeof answers.motivoConsulta === "string" ? answers.motivoConsulta : null, version: row.version, toothNumbers: [], authorId: row.createdBy });
  }
  const documents = ids("document");
  if (documents.length) for (const row of await tx.select().from(patientDocument).where(and(eq(patientDocument.organizationId, orgId), inArray(patientDocument.id, documents)))) {
    hydrated.set(row.id, { id: row.id, refId: row.id, type: "document", createdAt: row.createdAt, title: row.label, category: row.category, toothNumbers: row.toothNumber == null ? [] : [row.toothNumber], authorId: row.uploadedBy });
  }
  const entries = ids("odontogram");
  if (entries.length) for (const row of await tx.select().from(odontogramEntry).where(and(eq(odontogramEntry.organizationId, orgId), inArray(odontogramEntry.id, entries)))) {
    hydrated.set(row.id, { id: row.id, refId: row.id, type: "odontogram", createdAt: row.createdAt, title: `Pieza ${row.toothNumber}`, detail: row.note, condition: row.condition, surface: row.surface, status: row.status, diagnosisCode: row.diagnosisCode, toothNumbers: [row.toothNumber], authorId: row.createdBy });
  }
  const last = page[page.length - 1]!;
  return { data: page.map((row) => hydrated.get(row.id)!), nextCursor: rows.length > limit ? encodeCursor(last.cursor_ts, last.id) : null };
}

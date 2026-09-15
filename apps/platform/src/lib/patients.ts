/** Tipos espejo de la API de pacientes + helpers puros para la UI. */
import { activeFindingsAsOf, type FindingDetails } from "@odentia/clinical";

export interface Patient {
  id: string;
  organizationId?: string;
  contactId: string;
  patientNumber: number;
  displayName?: string | null;
  docType?: string | null;
  docNumber?: string | null;
  birthDate?: string | null;
  sex?: string | null;
  phone?: string | null;
  email?: string | null;
  avatarStorageKey?: string | null;
  maritalStatus?: string | null;
  educationLevel?: string | null;
  occupation?: string | null;
  address?: string | null;
  origin?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  insuranceType?: string | null;
  insuranceDetail?: string | null;
  referralSource?: string | null;
  guardianContactId?: string | null;
  registeredBranchId?: string | null;
  isActive: boolean;
  dataConsentAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface Allergy {
  id: string;
  substance: string;
  reaction?: string | null;
  severity: string;
  isActive: boolean;
  createdAt?: string;
}

export interface Condition {
  id: string;
  name: string;
  status: string;
  startDate?: string | null;
  endDate?: string | null;
  notes?: string | null;
  isActive?: boolean;
  createdAt?: string;
}

export interface Medication {
  id: string;
  name: string;
  dose?: string | null;
  frequency?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  notes?: string | null;
  createdAt?: string;
}

export interface AnamnesisAnswers {
  [key: string]: unknown;
  motivoConsulta?: string;
  tiempoEnfermedad?: string;
  observaciones?: string;
  diagnosticoPresuntivo?: string;
}

export interface ClinicalNote {
  id: string;
  note: string;
  diagnosisCode?: string | null;
  authorUserId?: string;
  encounterId?: string | null;
  kind?: string;
  createdAt: string;
}

export interface PatientDocument {
  id: string;
  category: string;
  label: string;
  storageKey?: string;
  contentType: string;
  sizeBytes: number;
  encounterId?: string | null;
  toothNumber?: number | null;
  createdAt: string;
}

export interface OdontogramEntry {
  id: string;
  toothNumber: number;
  surface?: string | null;
  condition: string;
  status: string;
  diagnosisCode?: string | null;
  note?: string | null;
  encounterId?: string | null;
  createdAt?: string;
  details?: FindingDetails;
  needsReview?: boolean;
  legacyData?: Record<string, unknown> | null;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
}

export type ToothState = {
  condition: string;
  status: string;
  surfaces: string[];
  entries: string[];
};

export interface OdontogramState {
  teeth: Record<string, ToothState>;
  history: OdontogramEntry[];
}

export interface OdontogramAssessment {
  id: string;
  patientId: string;
  patientName: string;
  patientNumber: number;
  authorUserId: string;
  createdAt: string;
  purpose: "initial" | "new_findings" | "completion" | "reentry" | "legal" | "personal";
  standard: string;
  specifications: string;
  observations: string;
  examinerName: string;
  registrationNumber: string;
  signature: number[][][];
  entries: OdontogramEntry[];
}

/** Atención clínica (borrador editable / finalizada inmutable). Fechas como ISO string. */
export interface Encounter {
  id: string;
  organizationId?: string;
  patientId?: string;
  branchId: string | null;
  dentistUserId: string;
  status: string;
  reason: string | null;
  evolution: string | null;
  indications: string | null;
  nextStep: string | null;
  nextAppointmentAt: string | null;
  finalizedAt: string | null;
  finalizedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Procedimiento realizado durante una atención. Fechas como ISO string. */
export interface ProcedureItem {
  id: string;
  organizationId?: string;
  encounterId: string;
  toothNumber: number | null;
  description: string;
  diagnosisCode: string | null;
  planItemId: string | null;
  createdBy?: string | null;
  createdAt: string;
}

/** Ítem del plan de tratamiento. Fechas como ISO string. */
export interface PlanItem {
  id: string;
  organizationId?: string;
  patientId?: string;
  toothNumber: number | null;
  title: string;
  detail: string | null;
  diagnosisCode: string | null;
  priceCents: number | null;
  currency: string;
  status: string;
  encounterId: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt?: string;
}

/** Detalle de una atención: encuentro + piezas, procedimientos, notas, odontograma, documentos y adendas. */
export interface EncounterDetail {
  encounter: Encounter;
  teeth: number[];
  procedures: ProcedureItem[];
  /** Notas de evolución (kind='evolucion'), orden ascendente. */
  notes: ClinicalNote[];
  odontogramEntries: OdontogramEntry[];
  documents: PatientDocument[];
  /** Correcciones posteriores al cierre (kind='adenda'), orden ascendente. */
  addenda: ClinicalNote[];
}

export type TimelineType = "encounter" | "note" | "anamnesis" | "document" | "odontogram";

/** Evento de la historia clínica unificada. Fechas como ISO string. */
export interface TimelineItem {
  id: string;
  type: TimelineType;
  createdAt: string;
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
  nextAppointmentAt?: string | null;
}

export interface PlanPendingTotal {
  currency: string;
  count: number;
  totalCents: number;
}

/** Resumen del paciente: última atención finalizada, borrador abierto y plan pendiente. */
export interface PatientSummary {
  lastEncounter: Encounter | null;
  openEncounterId: string | null;
  nextAppointmentAt: string | null;
  planPending: {
    count: number;
    /** null cuando hay más de una moneda (ver totals); nunca se suman monedas distintas. */
    totalCents: number | null;
    /** null cuando hay más de una moneda (ver totals). */
    currency: string | null;
    totals: PlanPendingTotal[];
  };
  activeDiagnoses: Array<{ toothNumber: number; condition: string; status: string }>;
}

export interface PatientFull {
  patient: Patient & Record<string, unknown>;
  displayName: string;
  guardian: { id: string; displayName: string } | null;
  activeAllergies: Allergy[];
  activeConditions: Condition[];
  currentMedications: Medication[];
}

/** Etiqueta de historia clínica: HC-000123 (padding 6). */
export function hcLabel(n: number): string {
  return `HC-${String(n).padStart(6, "0")}`;
}

/** Edad en años desde fecha de nacimiento ISO; "" si ausente/inválida. */
export function ageFrom(birthDate: string | null | undefined): string {
  if (!birthDate) return "";
  const born = new Date(birthDate).getTime();
  if (Number.isNaN(born)) return "";
  const now = new Date();
  const b = new Date(born);
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1;
  if (age < 0) return "";
  return `${age}`;
}

export function statusLabel(status: string): string {
  if (status === "recorded") return "Registrado";
  if (status === "voided") return "Anulado por corrección";
  return status;
}


/** Etiqueta en español del tipo de pieza: "incisor" → "Incisivo". */
export function toothTypeLabel(type: "incisor" | "canine" | "premolar" | "molar"): string {
  switch (type) {
    case "incisor":
      return "Incisivo";
    case "canine":
      return "Canino";
    case "premolar":
      return "Premolar";
    default:
      return "Molar";
  }
}


/**
 * Convierte un monto decimal en soles/unidades (ej. "150.50", "150,50") a
 * centavos enteros. Vacío = sin precio (null), nunca 0.
 */
export function parsePriceToCents(raw: string): { ok: true; cents: number | null } | { ok: false } {
  const text = raw.trim().replace(",", ".");
  if (text === "") return { ok: true, cents: null };
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return { ok: false };
  const cents = Math.round(Number(text) * 100);
  if (!Number.isFinite(cents) || cents < 0 || cents > 2147483647) return { ok: false };
  return { ok: true, cents };
}

export function planStatusLabel(status: string): string {
  switch (status) {
    case "pendiente":
      return "Pendiente";
    case "programado":
      return "Programado";
    case "realizado":
      return "Realizado";
    case "cancelado":
      return "Cancelado";
    default:
      return status;
  }
}

export function encounterStatusLabel(status: string): string {
  switch (status) {
    case "borrador":
      return "Borrador";
    case "finalizada":
      return "Finalizada";
    default:
      return status;
  }
}

export function timelineTypeLabel(type: string): string {
  switch (type) {
    case "encounter":
      return "Atención";
    case "note":
      return "Nota clínica";
    case "anamnesis":
      return "Anamnesis";
    case "document":
      return "Documento";
    case "odontogram":
      return "Odontograma";
    default:
      return type;
  }
}

/** Proyección por pieza de hallazgos coexistentes; el historial original no se modifica. */
export function winnersAsOf(history: OdontogramEntry[], iso?: string): OdontogramState {
  const byTooth = new Map<number, OdontogramEntry[]>();
  for (const entry of activeFindingsAsOf(history, iso)) {
    for (const tooth of entry.details?.relatedTeeth?.length ? entry.details.relatedTeeth : [entry.toothNumber]) {
      const entries = byTooth.get(tooth) ?? [];
      entries.push(entry);
      byTooth.set(tooth, entries);
    }
  }
  const teeth: Record<string, ToothState> = {};
  for (const [tooth, entries] of byTooth) {
    const latest = entries.at(-1)!;
    teeth[String(tooth)] = {
      condition: latest.condition,
      status: latest.status,
      surfaces: [...new Set(entries.flatMap((entry) => entry.surface ? [entry.surface] : []))].sort(),
      entries: entries.map((entry) => entry.id),
    };
  }
  return { teeth, history };
}

/** Tipos espejo de la API de pacientes + helpers puros para la UI. */

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

/** Piezas FDI permanentes 11-18, 21-28, 31-38, 41-48. */
export const FDI_ADULT: number[] = [
  11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36,
  37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
];

/** Piezas FDI temporales 51-55, 61-65, 71-75, 81-85. */
export const FDI_CHILD: number[] = [
  51, 52, 53, 54, 55, 61, 62, 63, 64, 65, 71, 72, 73, 74, 75, 81, 82, 83, 84, 85,
];

/** Dentición adulta: 32 piezas FDI (cuadrantes ordenados de derecha a izquierda). */
export const FDI_ADULT_ROWS: number[][] = [
  [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
  [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38],
];

/** Dentición temporal: 20 piezas FDI. */
export const FDI_CHILD_ROWS: number[][] = [
  [55, 54, 53, 52, 51, 61, 62, 63, 64, 65],
  [85, 84, 83, 82, 81, 71, 72, 73, 74, 75],
];

export const CONDITIONS: string[] = [
  "sano",
  "caries",
  "obturacion",
  "corona",
  "ausente",
  "extraccion_indicada",
  "endodoncia",
  "implante",
  "fractura",
  "sellante",
  "protesis",
  "desgaste",
  "otro",
];

export const SURFACES: string[] = ["mesial", "distal", "vestibular", "lingual", "palatina", "oclusal", "incisal"];

export const STATUSES: string[] = ["registrado", "realizado", "planificado"];

export function conditionLabel(condition: string): string {
  switch (condition) {
    case "sano":
      return "Sano";
    case "caries":
      return "Caries";
    case "obturacion":
      return "Obturación";
    case "corona":
      return "Corona";
    case "ausente":
      return "Ausente";
    case "extraccion_indicada":
      return "Extracción indicada";
    case "endodoncia":
      return "Endodoncia";
    case "implante":
      return "Implante";
    case "fractura":
      return "Fractura";
    case "sellante":
      return "Sellante";
    case "protesis":
      return "Prótesis";
    case "desgaste":
      return "Desgaste";
    default:
      return "Otro";
  }
}

export function surfaceLabel(surface: string): string {
  switch (surface) {
    case "mesial":
      return "Mesial";
    case "distal":
      return "Distal";
    case "vestibular":
      return "Vestibular";
    case "lingual":
      return "Lingual";
    case "palatina":
      return "Palatina";
    case "oclusal":
      return "Oclusal";
    default:
      return "Incisal";
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "registrado":
      return "Registrado";
    case "realizado":
      return "Realizado";
    case "planificado":
      return "Planificado";
    default:
      return "Anulado";
  }
}

/** Tipo de pieza según el segundo dígito FDI: 1-2 incisivo, 3 canino, 4-5 premolar, 6-8 molar. */
export function toothTypeOf(toothNumber: number): "incisivo" | "canino" | "premolar" | "molar" {
  const digit = Math.abs(Math.trunc(toothNumber)) % 10;
  if (digit === 1 || digit === 2) return "incisivo";
  if (digit === 3) return "canino";
  if (digit === 4 || digit === 5) return "premolar";
  if (digit >= 6 && digit <= 8) return "molar";
  throw new RangeError("Pieza FDI inválida");
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

/** Color de pieza por estado (convención odontológica). */
export function entryColor(status: string): string {
  switch (status) {
    case "realizado":
      return "fill-blue-500";
    case "ausente":
      return "fill-gray-300";
    case "planificado":
    case "registrado":
    default:
      return "fill-red-500";
  }
}

function entryTime(entry: OdontogramEntry): number {
  if (!entry.createdAt) return 0;
  const t = new Date(entry.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function compareEntries(a: OdontogramEntry, b: OdontogramEntry): number {
  const time = entryTime(a) - entryTime(b);
  if (time !== 0) return time;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Estado del odontograma a una fecha de corte (last-writer-wins por
 * pieza+superficie, como el servicio): gana la entrada más reciente por
 * `${toothNumber}:${surface ?? ""}`; las anuladas nunca ganan y las
 * posteriores a `iso` no participan. Empates de fecha+id se resuelven
 * de forma determinista por id. Sin `iso` usa todo el historial.
 */
export function winnersAsOf(history: OdontogramEntry[], iso?: string): OdontogramState {
  const rawCutoff = iso === undefined ? Number.POSITIVE_INFINITY : new Date(iso).getTime();
  const cutoff = Number.isNaN(rawCutoff) ? Number.POSITIVE_INFINITY : rawCutoff;
  const ordered = history
    .filter((entry) => entryTime(entry) <= cutoff)
    .sort(compareEntries);
  // La última escritura gana por pieza+superficie (anuladas excluidas).
  const winners = new Map<string, OdontogramEntry>();
  for (const entry of ordered) {
    if (entry.status === "anulado") continue;
    winners.set(`${entry.toothNumber}:${entry.surface ?? ""}`, entry);
  }
  const byTooth = new Map<number, OdontogramEntry[]>();
  for (const entry of winners.values()) {
    const list = byTooth.get(entry.toothNumber) ?? [];
    list.push(entry);
    byTooth.set(entry.toothNumber, list);
  }
  const teeth: Record<string, ToothState> = {};
  for (const [tooth, entries] of byTooth) {
    entries.sort((a, b) => compareEntries(b, a));
    const latest = entries[0]!;
    teeth[String(tooth)] = {
      condition: latest.condition,
      status: latest.status,
      surfaces: entries
        .map((e) => e.surface)
        .filter((s): s is string => !!s)
        .sort(),
      entries: entries.map((e) => e.id),
    };
  }
  return { teeth, history };
}

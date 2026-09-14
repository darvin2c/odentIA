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
  createdAt: string;
}

export interface PatientDocument {
  id: string;
  category: string;
  label: string;
  storageKey?: string;
  contentType: string;
  sizeBytes: number;
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

/**
 * Biblioteca operativa de prestaciones odontológicas (plantillas globales).
 * Son prestaciones editables por la clínica, no una lista universal ni
 * recomendaciones de tratamiento. `key` es un identificador interno estable
 * (specialty:slug) y nunca se muestra como código clínico oficial.
 * `externalCodings` nace vacío: solo la revisión bibliográfica puede añadir
 * equivalencias comprobadas con sistema, código, versión, display, fuente y
 * licencia completos.
 */
import { isValidTooth, surfacesForTooth } from "./anatomy.js";

export const TREATMENT_SPECIALTIES = [
  "diagnostico",
  "prevencion",
  "restauradora",
  "endodoncia",
  "periodoncia",
  "cirugia",
  "protesis",
  "implantologia",
  "ortodoncia",
  "odontopediatria",
  "estetica",
  "disfuncion",
] as const;
export type TreatmentSpecialty = (typeof TREATMENT_SPECIALTIES)[number];

export const TREATMENT_SCOPES = ["general", "tooth", "surfaces", "quadrant", "arch"] as const;
export type TreatmentScope = (typeof TREATMENT_SCOPES)[number];

export type TreatmentArch = "upper" | "lower";

export interface ExternalCoding {
  system: string;
  code: string;
  version: string;
  display: string;
  sourceUrl: string;
  license: string;
}

export interface TreatmentTemplate {
  key: string;
  name: string;
  specialty: TreatmentSpecialty;
  scope: TreatmentScope;
  /** Rango de superficies para restauradoras; null en el resto. */
  surfaceCountMin: number | null;
  surfaceCountMax: number | null;
}

export interface TreatmentSiteInput {
  toothNumber?: number | null;
  surfaces?: string[] | null;
  quadrant?: number | null;
  arch?: string | null;
}

function slugify(name: string): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return ascii
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function t(
  specialty: TreatmentSpecialty,
  name: string,
  scope: TreatmentScope,
  surfaceCountMin: number | null = null,
  surfaceCountMax: number | null = null,
): TreatmentTemplate {
  return { key: `${specialty}:${slugify(name)}`, name, specialty, scope, surfaceCountMin, surfaceCountMax };
}

export const TREATMENT_TEMPLATES: readonly TreatmentTemplate[] = [
  // Diagnóstico
  t("diagnostico", "Consulta odontológica inicial", "general"),
  t("diagnostico", "Consulta de control", "general"),
  t("diagnostico", "Evaluación de urgencia", "general"),
  t("diagnostico", "Radiografía periapical", "tooth"),
  t("diagnostico", "Radiografía interproximal", "general"),
  t("diagnostico", "Radiografía panorámica", "general"),
  t("diagnostico", "Estudio tomográfico dental", "general"),
  // Prevención
  t("prevencion", "Profilaxis dental", "general"),
  t("prevencion", "Aplicación tópica de flúor", "general"),
  t("prevencion", "Sellante de fosas y fisuras", "tooth"),
  t("prevencion", "Educación e instrucciones de higiene oral", "general"),
  // Restauradora
  t("restauradora", "Restauración de resina de una superficie", "surfaces", 1, 1),
  t("restauradora", "Restauración de resina de dos superficies", "surfaces", 2, 2),
  t("restauradora", "Restauración de resina de tres superficies", "surfaces", 3, 3),
  t("restauradora", "Restauración de resina de cuatro o más superficies", "surfaces", 4, 5),
  t("restauradora", "Restauración con ionómero de vidrio", "surfaces", 1, 5),
  t("restauradora", "Restauración temporal", "tooth"),
  t("restauradora", "Reconstrucción coronaria", "tooth"),
  t("restauradora", "Incrustación inlay", "tooth"),
  t("restauradora", "Incrustación onlay", "tooth"),
  // Endodoncia
  t("endodoncia", "Tratamiento de conductos unirradicular", "tooth"),
  t("endodoncia", "Tratamiento de conductos birradicular", "tooth"),
  t("endodoncia", "Tratamiento de conductos multirradicular", "tooth"),
  t("endodoncia", "Retratamiento de conductos unirradicular", "tooth"),
  t("endodoncia", "Retratamiento de conductos birradicular", "tooth"),
  t("endodoncia", "Retratamiento de conductos multirradicular", "tooth"),
  t("endodoncia", "Recubrimiento pulpar directo", "tooth"),
  t("endodoncia", "Recubrimiento pulpar indirecto", "tooth"),
  t("endodoncia", "Retiro de poste intrarradicular", "tooth"),
  // Periodoncia
  t("periodoncia", "Evaluación periodontal", "general"),
  t("periodoncia", "Destartraje supragingival", "general"),
  t("periodoncia", "Raspado y alisado radicular", "quadrant"),
  t("periodoncia", "Mantenimiento periodontal", "general"),
  t("periodoncia", "Gingivectomía", "tooth"),
  t("periodoncia", "Alargamiento de corona clínica", "tooth"),
  t("periodoncia", "Injerto gingival", "tooth"),
  // Cirugía
  t("cirugia", "Extracción simple", "tooth"),
  t("cirugia", "Extracción quirúrgica", "tooth"),
  t("cirugia", "Extracción de tercer molar retenido", "tooth"),
  t("cirugia", "Retiro de resto radicular", "tooth"),
  t("cirugia", "Drenaje de absceso", "general"),
  t("cirugia", "Frenectomía", "general"),
  t("cirugia", "Biopsia de tejido oral", "general"),
  t("cirugia", "Retiro de suturas", "general"),
  // Prótesis
  t("protesis", "Corona provisional", "tooth"),
  t("protesis", "Corona metal-cerámica", "tooth"),
  t("protesis", "Corona de zirconia", "tooth"),
  t("protesis", "Corona de disilicato de litio", "tooth"),
  t("protesis", "Poste de fibra", "tooth"),
  t("protesis", "Prótesis parcial removible acrílica", "arch"),
  t("protesis", "Prótesis parcial removible metálica", "arch"),
  t("protesis", "Prótesis total", "arch"),
  t("protesis", "Reparación de prótesis removible", "arch"),
  t("protesis", "Rebase de prótesis", "arch"),
  t("protesis", "Cementación de corona", "tooth"),
  // Implantología
  t("implantologia", "Evaluación implantológica", "general"),
  t("implantologia", "Colocación de implante dental", "tooth"),
  t("implantologia", "Regeneración ósea", "tooth"),
  t("implantologia", "Elevación de seno maxilar", "quadrant"),
  t("implantologia", "Pilar sobre implante", "tooth"),
  t("implantologia", "Corona sobre implante", "tooth"),
  t("implantologia", "Mantenimiento de implantes", "general"),
  // Ortodoncia
  t("ortodoncia", "Evaluación ortodóntica", "general"),
  t("ortodoncia", "Estudio ortodóntico", "general"),
  t("ortodoncia", "Instalación de aparatología fija", "arch"),
  t("ortodoncia", "Control de ortodoncia", "general"),
  t("ortodoncia", "Reposición de bracket", "tooth"),
  t("ortodoncia", "Retiro de aparatología fija", "arch"),
  t("ortodoncia", "Retenedor removible", "arch"),
  t("ortodoncia", "Retenedor fijo", "arch"),
  t("ortodoncia", "Tratamiento con alineadores", "general"),
  // Odontopediatría
  t("odontopediatria", "Consulta odontopediátrica", "general"),
  t("odontopediatria", "Pulpotomía en diente temporal", "tooth"),
  t("odontopediatria", "Pulpectomía en diente temporal", "tooth"),
  t("odontopediatria", "Corona preformada en diente temporal", "tooth"),
  t("odontopediatria", "Mantenedor de espacio", "general"),
  t("odontopediatria", "Extracción de diente temporal", "tooth"),
  // Estética
  t("estetica", "Blanqueamiento externo", "arch"),
  t("estetica", "Blanqueamiento interno", "tooth"),
  t("estetica", "Carilla de resina", "tooth"),
  t("estetica", "Carilla cerámica", "tooth"),
  t("estetica", "Microabrasión del esmalte", "tooth"),
  // Disfunción
  t("disfuncion", "Evaluación temporomandibular", "general"),
  t("disfuncion", "Férula oclusal", "arch"),
  t("disfuncion", "Ajuste de férula oclusal", "general"),
];

const BY_KEY: Record<string, TreatmentTemplate | undefined> = Object.fromEntries(
  TREATMENT_TEMPLATES.map((tpl) => [tpl.key, tpl]),
);

/** Plantilla por key o `undefined` si no existe. */
export function treatmentTemplate(key: string): TreatmentTemplate | undefined {
  return Object.hasOwn(BY_KEY, key) ? BY_KEY[key] : undefined;
}

/**
 * Valida el sitio clínico según el ámbito. No deriva anatomía de etiquetas:
 * usa `isValidTooth` y `surfacesForTooth`. Lanza Error con mensaje en español.
 */
export function assertTreatmentSite(
  scope: TreatmentScope,
  site: TreatmentSiteInput,
  surfaceLimits?: { min: number | null; max: number | null },
): void {
  const { toothNumber = null, surfaces = null, quadrant = null, arch = null } = site;
  const hasSurfaces = Array.isArray(surfaces) && surfaces.length > 0;
  if (scope === "general") {
    if (toothNumber != null || hasSurfaces || quadrant != null || arch != null) {
      throw new Error("La prestación general no lleva pieza, superficies, cuadrante ni arcada");
    }
    return;
  }
  if (scope === "tooth") {
    if (toothNumber == null || !Number.isInteger(toothNumber) || !isValidTooth(toothNumber)) {
      throw new Error("La prestación requiere una pieza FDI válida");
    }
    if (hasSurfaces || quadrant != null || arch != null) {
      throw new Error("La prestación por pieza no lleva superficies, cuadrante ni arcada");
    }
    return;
  }
  if (scope === "surfaces") {
    if (toothNumber == null || !Number.isInteger(toothNumber) || !isValidTooth(toothNumber)) {
      throw new Error("La prestación requiere una pieza FDI válida");
    }
    if (!hasSurfaces) throw new Error("La prestación requiere al menos una superficie");
    const valid = new Set(surfacesForTooth(toothNumber));
    const seen = new Set<string>();
    for (const s of surfaces!) {
      if (seen.has(s)) throw new Error("Las superficies no deben repetirse");
      seen.add(s);
      if (!valid.has(s as never)) throw new Error(`Superficie inválida para la pieza ${toothNumber}`);
    }
    const min = surfaceLimits?.min ?? null;
    const max = surfaceLimits?.max ?? null;
    if (min != null && seen.size < min) throw new Error(`La prestación requiere al menos ${min} superficie(s)`);
    if (max != null && seen.size > max) throw new Error(`La prestación admite como máximo ${max} superficie(s)`);
    if (quadrant != null || arch != null) throw new Error("La prestación por superficies no lleva cuadrante ni arcada");
    return;
  }
  if (scope === "quadrant") {
    if (!Number.isInteger(quadrant) || (quadrant as number) < 1 || (quadrant as number) > 8) {
      throw new Error("La prestación requiere un cuadrante FDI de 1 a 8");
    }
    if (toothNumber != null || hasSurfaces || arch != null) {
      throw new Error("La prestación por cuadrante no lleva pieza, superficies ni arcada");
    }
    return;
  }
  // arch
  if (arch !== "upper" && arch !== "lower") {
    throw new Error("La prestación requiere arcada superior o inferior");
  }
  if (toothNumber != null || hasSurfaces || quadrant != null) {
    throw new Error("La prestación por arcada no lleva pieza, superficies ni cuadrante");
  }
}

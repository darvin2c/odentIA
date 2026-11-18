/**
 * «Riesgos propios de su caso» en el consentimiento (reglas clínicas del 18 nov, punto 5): frases
 * cortas, en palabras de quien firma, que el sistema propone desde lo registrado en su ficha y el
 * procedimiento. El profesional las cambia o las borra mientras el documento está pendiente y no se
 * envió por su enlace; no frenan la firma. Van en la hoja que se firma (tablet, enlace y PDF), después
 * de «Riesgos y molestias». Solo las frases con fuente firme:
 * - anticoagulante o antiagregante (ATC B01A): SDCEP, *Management of Dental Patients Taking
 *   Anticoagulants or Antiplatelet Drugs*, 2.ª ed., 2022 (la exodoncia, la cirugía, el implante y
 *   el raspado sangran más; con un antagonista de la vitamina K, el INR del día);
 * - medicina para los huesos (ATC M05B), la que toma o tomó: Ruggiero SL y col., «AAOMS Position
 *   Paper on Medication-Related Osteonecrosis of the Jaws—2022 Update», *J Oral Maxillofac Surg*
 *   2022;80:920-943 (riesgo bajo en la cirugía que expone hueso y en el implante);
 * - diabetes con código (CIE-10 E10–E14; CIE-11 5A10–5A14): Little JW y col., *Little and Falace's
 *   Dental Management of the Medically Compromised Patient*, 9.ª ed., 2018, cap. de diabetes
 *   (la herida cierra más lento y se infecta más; verificar la página);
 * - alergia a un anestésico local (ATC N01B): Malamed SF, *Handbook of Local Anesthesia*, 7.ª ed.,
 *   2020 (se usa uno de otro grupo);
 * - alergia al látex: ADA, *Latex allergy* (Oral Health Topics): se atiende sin látex.
 * Sin frase, a propósito: la endodoncia con anticoagulante o con medicina para los huesos (SDCEP y
 * AAOMS la ponen entre lo de menor riesgo), el embarazo, la ASA como frase genérica y el tabaco.
 */
import {
  ALLERGENS,
  type AllergenEntry,
  allergenByCode,
  allergenName,
  codeAllergySubstance,
  HABITUAL_MEDICATIONS,
  type HabitualMedicationEntry,
  MEDICATION_CLASSES,
  matchHabitualMedication,
  medicationClassOf,
  NON_DRUG_ALLERGENS,
} from "./allergens.js"
import { isCurrentMedication } from "./catalogs.js"

/** Lo que tiene el procedimiento que cambia sus riesgos propios. Lo dice cada plantilla sugerida. */
export interface ConsentRiskProfile {
  /** Abre una herida (encía, hueso o piel): sangra y tiene que cicatrizar. */
  wound?: boolean
  /** Cirugía sobre el hueso de los maxilares: la exodoncia, el implante, la cirugía oral. */
  jawBone?: boolean
  /** Coloca un implante. */
  implant?: boolean
  /** Se hace con anestesia local. */
  localAnesthesia?: boolean
  /** Cómo se nombra en la frase: «la extracción», «la cirugía del implante». */
  words?: string
}

/** El título de la sección en la hoja: igual en la tablet, el enlace y el PDF. */
export const CONSENT_PERSONAL_RISKS_LABEL = "Riesgos propios de su caso"
/** Como mucho, estas frases y de este largo cada una. */
export const CONSENT_PERSONAL_RISKS_MAX_ITEMS = 10
export const CONSENT_PERSONAL_RISK_MAX_LENGTH = 500

/**
 * Lo escrito en el campo, una frase por línea, como se guarda: sin líneas vacías ni espacios de
 * más. Vacío es null: la hoja queda como siempre. Lanza Error con el motivo si se pasa del tope.
 */
export function parsePersonalRisks(text: string | null | undefined): string[] | null {
  const items = (text ?? "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*[•·\-*]\s*/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0)
  if (items.length === 0) return null
  if (items.length > CONSENT_PERSONAL_RISKS_MAX_ITEMS)
    throw new Error(`Escribe como mucho ${CONSENT_PERSONAL_RISKS_MAX_ITEMS} riesgos, uno por línea`)
  if (items.some((item) => item.length > CONSENT_PERSONAL_RISK_MAX_LENGTH))
    throw new Error(`Cada riesgo, hasta ${CONSENT_PERSONAL_RISK_MAX_LENGTH} caracteres`)
  return items
}

/** Lo de su ficha que se lee para proponerlos. */
export interface ConsentRiskHealth {
  medications: ReadonlyArray<{
    name: string
    genericName?: string | null
    atcCode?: string | null
    endDate?: string | null
  }>
  conditions: ReadonlyArray<{
    status: string
    diagnosisSystem?: string | null
    diagnosisCode?: string | null
  }>
  allergies: ReadonlyArray<{
    substance: string
    substanceSystem?: string | null
    substanceCode?: string | null
    isActive: boolean
    verification?: string | null
  }>
}

const VITAMIN_K_ANTAGONISTS_ATC = "B01AA"
const ANTIPLATELET_ATC = "B01AC"
const LOCAL_ANESTHETIC_ATC = "N01B"
/** El látex de la lista propia de lo que no es medicamento. */
const LATEX = NON_DRUG_ALLERGENS.find((entry) => entry.code === "latex") ?? {
  code: "latex",
  system: "",
}

/** Diabetes con su código: CIE-10 E10–E14 o CIE-11 5A10–5A14 (verificar en el navegador de la OMS). */
export function isDiabetes(
  system: string | null | undefined,
  code: string | null | undefined,
): boolean {
  if (!code) return false
  if (system === "ICD-11") return /^5A1[0-4]/.test(code)
  return /^E1[0-4]/.test(code)
}

/** El nombre por el que la persona la conoce: el que escribió (si es de la lista) o su DCI. */
function medicineName(
  row: ConsentRiskHealth["medications"][number],
  habitual: readonly HabitualMedicationEntry[],
): string | null {
  const unnamed = Object.values(MEDICATION_CLASSES).some((group) => row.name === group.unnamed)
  if (unnamed) return null
  const written = matchHabitualMedication(row.genericName ?? row.name, habitual)
  // «alendronato 70 mg semanal» → «alendronato»; «Eliquis» → «Eliquis»; elegido de la lista, su DCI.
  if (written) return written.name
  return habitual.find((entry) => entry.atc === row.atcCode)?.dci ?? null
}

const named = (names: readonly string[]) =>
  names.length > 0 ? ` (${[...new Set(names)].join(", ")})` : ""

/**
 * Las frases propuestas para ese procedimiento y esa persona, en orden: medicinas, diabetes,
 * alergias. Sin nada que decir, una lista vacía (la hoja queda como siempre). La misma función para
 * odentIA y latidIA: cada producto dice el perfil de sus procedimientos.
 */
export function consentPersonalRisks(input: {
  profile: ConsentRiskProfile
  health: ConsentRiskHealth
  today: string
  habitual?: readonly HabitualMedicationEntry[]
  allergens?: readonly AllergenEntry[]
}): string[] {
  const { profile, health, today } = input
  const habitual = input.habitual ?? HABITUAL_MEDICATIONS
  const allergens = input.allergens ?? ALLERGENS
  const after = profile.words ?? "el procedimiento"
  const lines: string[] = []
  const anticoagulants: Array<string | null> = []
  const antiplatelets: Array<string | null> = []
  let vitaminK = false
  const bones = { now: [] as Array<string | null>, before: [] as Array<string | null> }
  for (const row of health.medications) {
    const group = medicationClassOf(row.atcCode)
    if (!group) continue
    const current = isCurrentMedication(row, today)
    const name = medicineName(row, habitual)
    if (group === "boneMedicines") (current ? bones.now : bones.before).push(name)
    else if (!current) continue
    else if (row.atcCode?.startsWith(ANTIPLATELET_ATC)) antiplatelets.push(name)
    else {
      anticoagulants.push(name)
      if (row.atcCode?.startsWith(VITAMIN_K_ANTAGONISTS_ATC)) vitaminK = true
    }
  }
  const known = (names: Array<string | null>) => names.filter((name): name is string => !!name)
  if (profile.wound && anticoagulants.length > 0)
    lines.push(
      `Toma un anticoagulante${named(known(anticoagulants))}: puede sangrar más tiempo después de ${after}.${vitaminK ? " Se revisará su INR del día." : ""}`,
    )
  if (profile.wound && antiplatelets.length > 0)
    lines.push(
      `Toma un antiagregante${named(known(antiplatelets))}: puede sangrar un poco más después de ${after}; no debe dejarlo sin indicación de su médico.`,
    )
  if (profile.jawBone && bones.now.length + bones.before.length > 0) {
    const verb = bones.now.length > 0 ? "Toma" : "Tomó"
    const implant = profile.implant ? " o de que el implante se pierda" : ""
    lines.push(
      `${verb} una medicina para los huesos${named(known([...bones.now, ...bones.before]))}: hay un riesgo poco frecuente de que el hueso de la zona no cicatrice (osteonecrosis)${implant}.`,
    )
  }
  if (
    profile.wound &&
    health.conditions.some(
      (row) => row.status === "activa" && isDiabetes(row.diagnosisSystem, row.diagnosisCode),
    )
  )
    lines.push(
      "Tiene diabetes: la herida puede tardar más en cerrar y tiene más riesgo de infectarse, sobre todo si el azúcar no está controlado.",
    )
  const active = health.allergies.filter((row) => row.isActive && row.verification !== "descartada")
  const entryOf = (row: (typeof active)[number]) =>
    allergenByCode(row.substanceSystem, row.substanceCode, allergens) ??
    codeAllergySubstance(row.substance, allergens)
  if (profile.localAnesthesia) {
    const anesthetics = active.flatMap((row) => {
      const entry = entryOf(row)
      return entry?.system === "atc" && entry.code.startsWith(LOCAL_ANESTHETIC_ATC)
        ? [allergenName(entry)]
        : []
    })
    if (anesthetics.length > 0)
      lines.push(
        `Tiene alergia a ${[...new Set(anesthetics)].join(" y a ")}: se usará un anestésico de otro grupo; aun así puede haber una reacción.`,
      )
  }
  const latex = (entry: AllergenEntry | null) =>
    !!entry && entry.code === LATEX.code && entry.system === LATEX.system
  if (active.some((row) => latex(entryOf(row))))
    lines.push("Tiene alergia al látex: se le atenderá con material sin látex.")
  return lines
}

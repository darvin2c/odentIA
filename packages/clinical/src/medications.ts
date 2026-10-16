/**
 * Medicamentos de uso frecuente en odontología, por Denominación Común
 * Internacional (DCI) y código ATC de la OMS. Sirve para sugerir la DCI al
 * prescribir y para advertir alergias del mismo grupo o con reactividad
 * cruzada conocida. No es un vademécum: la DCI se escribe libremente y lo que
 * no está aquí no recibe aviso automático.
 */
export interface MedicationEntry {
  dci: string
  atc: string
  group: MedicationGroup
}

export type MedicationGroup =
  | "penicilinas"
  | "cefalosporinas"
  | "macrolidos"
  | "lincosamidas"
  | "nitroimidazoles"
  | "sulfonamidas"
  | "aine"
  | "salicilatos"
  | "pirazolonas"
  | "paracetamol"
  | "opioides"
  | "anestesicos_amida"
  | "anestesicos_ester"
  | "corticoides"
  | "antifungicos"
  | "antivirales"
  | "antisepticos"

export const MEDICATION_GROUP_LABELS: Record<MedicationGroup, string> = {
  penicilinas: "penicilinas (ATC J01C)",
  cefalosporinas: "cefalosporinas (ATC J01D)",
  macrolidos: "macrólidos (ATC J01FA)",
  lincosamidas: "lincosamidas (ATC J01FF)",
  nitroimidazoles: "nitroimidazoles (ATC P01AB)",
  sulfonamidas: "sulfonamidas (ATC J01E)",
  aine: "antiinflamatorios no esteroideos (ATC M01A)",
  salicilatos: "salicilatos (ATC N02BA)",
  pirazolonas: "pirazolonas (ATC N02BB)",
  paracetamol: "anilidas (ATC N02BE)",
  opioides: "opioides (ATC N02A)",
  anestesicos_amida: "anestésicos locales tipo amida (ATC N01BB)",
  anestesicos_ester: "anestésicos locales tipo éster (ATC N01BA)",
  corticoides: "corticoides sistémicos (ATC H02AB)",
  antifungicos: "antifúngicos",
  antivirales: "antivirales (ATC J05AB)",
  antisepticos: "antisépticos bucales (ATC A01AB)",
}

export const DENTAL_MEDICATIONS: readonly MedicationEntry[] = [
  { dci: "amoxicilina", atc: "J01CA04", group: "penicilinas" },
  { dci: "amoxicilina + ácido clavulánico", atc: "J01CR02", group: "penicilinas" },
  { dci: "ampicilina", atc: "J01CA01", group: "penicilinas" },
  { dci: "bencilpenicilina", atc: "J01CE01", group: "penicilinas" },
  { dci: "fenoximetilpenicilina", atc: "J01CE02", group: "penicilinas" },
  { dci: "dicloxacilina", atc: "J01CF01", group: "penicilinas" },
  { dci: "cefalexina", atc: "J01DB01", group: "cefalosporinas" },
  { dci: "cefadroxilo", atc: "J01DB05", group: "cefalosporinas" },
  { dci: "cefuroxima", atc: "J01DC02", group: "cefalosporinas" },
  { dci: "ceftriaxona", atc: "J01DD04", group: "cefalosporinas" },
  { dci: "azitromicina", atc: "J01FA10", group: "macrolidos" },
  { dci: "claritromicina", atc: "J01FA09", group: "macrolidos" },
  { dci: "eritromicina", atc: "J01FA01", group: "macrolidos" },
  { dci: "clindamicina", atc: "J01FF01", group: "lincosamidas" },
  { dci: "metronidazol", atc: "P01AB01", group: "nitroimidazoles" },
  { dci: "sulfametoxazol + trimetoprima", atc: "J01EE01", group: "sulfonamidas" },
  { dci: "ibuprofeno", atc: "M01AE01", group: "aine" },
  { dci: "naproxeno", atc: "M01AE02", group: "aine" },
  { dci: "ketoprofeno", atc: "M01AE03", group: "aine" },
  { dci: "diclofenaco", atc: "M01AB05", group: "aine" },
  { dci: "ketorolaco", atc: "M01AB15", group: "aine" },
  { dci: "meloxicam", atc: "M01AC06", group: "aine" },
  { dci: "celecoxib", atc: "M01AH01", group: "aine" },
  { dci: "etoricoxib", atc: "M01AH05", group: "aine" },
  { dci: "nimesulida", atc: "M01AX17", group: "aine" },
  { dci: "ácido acetilsalicílico", atc: "N02BA01", group: "salicilatos" },
  { dci: "metamizol", atc: "N02BB02", group: "pirazolonas" },
  { dci: "paracetamol", atc: "N02BE01", group: "paracetamol" },
  { dci: "tramadol", atc: "N02AX02", group: "opioides" },
  { dci: "lidocaína", atc: "N01BB02", group: "anestesicos_amida" },
  { dci: "mepivacaína", atc: "N01BB03", group: "anestesicos_amida" },
  { dci: "articaína", atc: "N01BB08", group: "anestesicos_amida" },
  { dci: "bupivacaína", atc: "N01BB01", group: "anestesicos_amida" },
  { dci: "prilocaína", atc: "N01BB04", group: "anestesicos_amida" },
  { dci: "benzocaína", atc: "N01BA05", group: "anestesicos_ester" },
  { dci: "dexametasona", atc: "H02AB02", group: "corticoides" },
  { dci: "prednisona", atc: "H02AB07", group: "corticoides" },
  { dci: "nistatina", atc: "A07AA02", group: "antifungicos" },
  { dci: "fluconazol", atc: "J02AC01", group: "antifungicos" },
  { dci: "aciclovir", atc: "J05AB01", group: "antivirales" },
  { dci: "clorhexidina", atc: "A01AB03", group: "antisepticos" },
]

/**
 * Reactividad cruzada que obliga a advertir: penicilinas y cefalosporinas
 * comparten el anillo betalactámico; los AINE, el ácido acetilsalicílico y el
 * metamizol comparten la intolerancia por inhibición de la COX.
 */
const CROSS_REACTIVE: Partial<Record<MedicationGroup, MedicationGroup[]>> = {
  penicilinas: ["cefalosporinas"],
  cefalosporinas: ["penicilinas"],
  aine: ["salicilatos", "pirazolonas"],
  salicilatos: ["aine", "pirazolonas"],
  pirazolonas: ["aine", "salicilatos"],
}

/** Palabras con las que suele registrarse la alergia a un grupo. */
const GROUP_WORDS: Partial<Record<MedicationGroup, string[]>> = {
  penicilinas: ["penicilina", "betalactam"],
  cefalosporinas: ["cefalospor"],
  macrolidos: ["macrolido"],
  sulfonamidas: ["sulfa"],
  aine: ["aine", "antiinflamatorio no esteroide", "antiinflamatorios no esteroide"],
  salicilatos: ["aspirina", "salicilato"],
  pirazolonas: ["dipirona", "pirazolona"],
  anestesicos_amida: ["anestesia local", "anestesico local", "anestesicos locales"],
}

export function normalizeDrugText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
}

export function findMedication(dci: string): MedicationEntry | null {
  const key = normalizeDrugText(dci)
  return DENTAL_MEDICATIONS.find((m) => normalizeDrugText(m.dci) === key) ?? null
}

/** Grupos que nombra una alergia registrada: por DCI conocida o por palabra de grupo. */
function groupsOfAllergy(substance: string): MedicationGroup[] {
  const text = normalizeDrugText(substance)
  const groups = new Set<MedicationGroup>()
  for (const med of DENTAL_MEDICATIONS) {
    const base = normalizeDrugText(med.dci).split(" + ")
    if (base.some((part) => text.includes(part))) groups.add(med.group)
  }
  for (const [group, words] of Object.entries(GROUP_WORDS) as [MedicationGroup, string[]][]) {
    if (words.some((word) => text.includes(word))) groups.add(group)
  }
  return [...groups]
}

export interface AllergyConflict {
  substance: string
  reason: string
}

/**
 * Alergias registradas que chocan con la DCI a prescribir: la misma sustancia,
 * el mismo grupo ATC o un grupo con reactividad cruzada conocida.
 */
export function allergyConflicts(dci: string, allergySubstances: string[]): AllergyConflict[] {
  const name = normalizeDrugText(dci)
  if (!name) return []
  const med = findMedication(dci)
  const parts = name.split(" + ")
  const conflicts: AllergyConflict[] = []
  for (const substance of allergySubstances) {
    const text = normalizeDrugText(substance)
    if (!text) continue
    if (parts.some((part) => text.includes(part) || part.includes(text))) {
      conflicts.push({ substance, reason: "misma sustancia" })
      continue
    }
    if (!med) continue
    const groups = groupsOfAllergy(substance)
    if (groups.includes(med.group)) {
      conflicts.push({ substance, reason: `mismo grupo: ${MEDICATION_GROUP_LABELS[med.group]}` })
      continue
    }
    const cross = (CROSS_REACTIVE[med.group] ?? []).find((g) => groups.includes(g))
    if (cross)
      conflicts.push({
        substance,
        reason: `reactividad cruzada: ${MEDICATION_GROUP_LABELS[med.group]} y ${MEDICATION_GROUP_LABELS[cross]}`,
      })
  }
  return conflicts
}

/** Alergia de los antecedentes, con su verificación (HL7 FHIR AllergyIntolerance). */
export interface AllergyOnRecord {
  substance: string
  /** `confirmada`, `no_confirmada` (declarada, por confirmar) o `descartada`. */
  verification?: string | null
}

/**
 * Avisos de alergia al prescribir una DCI, una línea por choque. Es la misma
 * regla para la pantalla y el servidor: una alergia descartada ya no avisa
 * (como en la cabecera de la persona) y una sin confirmar se dice declarada,
 * para que quien prescribe sepa que nadie la verificó todavía.
 */
export function allergyWarnings(dci: string, allergies: AllergyOnRecord[]): string[] {
  const name = dci.trim()
  if (!name) return []
  const considered = allergies.filter((allergy) => allergy.verification !== "descartada")
  return allergyConflicts(
    name,
    considered.map((allergy) => allergy.substance),
  ).map((conflict) => {
    const declared = considered.some(
      (allergy) =>
        allergy.substance === conflict.substance && allergy.verification === "no_confirmada",
    )
    return `${name}: alergia a ${conflict.substance}${declared ? ", declarada y por confirmar" : ""} (${conflict.reason})`
  })
}

/** Formas farmacéuticas habituales (vocabulario controlado de la receta). */
export const DOSAGE_FORMS = [
  "tableta",
  "tableta recubierta",
  "cápsula",
  "suspensión oral",
  "jarabe",
  "solución oral",
  "solución inyectable",
  "cartucho dental",
  "gel",
  "crema",
  "ungüento",
  "pasta",
  "colutorio",
  "spray",
  "gotas",
] as const

/** Vías de administración (vocabulario controlado de la receta). */
export const ADMINISTRATION_ROUTES = [
  "oral",
  "sublingual",
  "bucal tópica",
  "tópica",
  "infiltrativa",
  "intramuscular",
  "intravenosa",
  "subcutánea",
  "inhalatoria",
  "rectal",
] as const

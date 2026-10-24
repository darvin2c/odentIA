import type { AllergenSystem, DoseUnit, MedicationFrequency } from "./catalogs.js"
import {
  allergyConflicts,
  crossReacts,
  DENTAL_MEDICATIONS,
  findMedication,
  MEDICATION_GROUP_LABELS,
  type MedicationEntry,
  type MedicationGroup,
  normalizeDrugText,
} from "./medications.js"

/**
 * Las sustancias de una alergia se eligen de una lista para que el aviso al
 * recetar no dependa de cómo se escribió (issue 43, tablero 7 del lienzo de
 * Pacientes). Los medicamentos y sus grupos llevan su código ATC de la OMS,
 * el mismo de la receta; lo que no es medicamento (látex, metales, materiales
 * dentales, alimentos frecuentes) va en una lista corta propia en vez de
 * SNOMED CT, que exige licencia nacional (decisión 9, ADR 0072). Lo que no
 * está en la lista se guarda como texto, «sin codificar».
 */

/** Tipo de alérgeno, la misma lista que guarda la base (`patient_allergy_category_check`). */
export type AllergenCategory =
  | "medicamento"
  | "anestesico"
  | "material"
  | "alimento"
  | "ambiental"
  | "otro"

export interface AllergenEntry {
  system: AllergenSystem
  /** Código ATC (`J01CA04`, o el del grupo, `J01C`) o el de la lista propia (`latex`). */
  code: string
  /** Cómo se lee: «Amoxicilina», «Penicilinas (grupo)», «Látex». */
  label: string
  category: AllergenCategory
  /** Un grupo ATC abarca a todos los medicamentos cuyo código empieza por el suyo. */
  group?: boolean
  /** Otras formas de escribirla que se reconocen al registrarla («aspirina», «dipirona»). */
  synonyms?: readonly string[]
}

/**
 * Grupos ATC que suelen registrarse como alergia: la persona dice «soy alérgica
 * a la penicilina», no a la amoxicilina.
 */
export const ATC_GROUP_ALLERGENS: readonly AllergenEntry[] = [
  {
    system: "atc",
    code: "J01C",
    label: "Penicilinas (grupo)",
    category: "medicamento",
    group: true,
    synonyms: ["penicilina", "penicilinas", "penicilinicos"],
  },
  {
    system: "atc",
    code: "J01D",
    label: "Cefalosporinas (grupo)",
    category: "medicamento",
    group: true,
    synonyms: ["cefalosporina", "cefalosporinas"],
  },
  {
    system: "atc",
    code: "J01FA",
    label: "Macrólidos (grupo)",
    category: "medicamento",
    group: true,
    synonyms: ["macrolido", "macrolidos"],
  },
  {
    system: "atc",
    code: "J01E",
    label: "Sulfonamidas (grupo)",
    category: "medicamento",
    group: true,
    synonyms: ["sulfa", "sulfas", "sulfonamida", "sulfonamidas"],
  },
  {
    system: "atc",
    code: "M01A",
    label: "Antiinflamatorios no esteroideos, AINE (grupo)",
    category: "medicamento",
    group: true,
    synonyms: ["aine", "aines", "antiinflamatorios"],
  },
  {
    system: "atc",
    code: "N02BB",
    label: "Pirazolonas (grupo)",
    category: "medicamento",
    group: true,
    synonyms: ["pirazolona", "pirazolonas"],
  },
  {
    system: "atc",
    code: "N02A",
    label: "Opioides (grupo)",
    category: "medicamento",
    group: true,
    synonyms: ["opioide", "opioides", "opiaceos"],
  },
  {
    system: "atc",
    code: "N01BB",
    label: "Anestésicos locales tipo amida (grupo)",
    category: "anestesico",
    group: true,
    synonyms: ["anestesia local", "anestesico local", "anestesicos locales", "amidas"],
  },
  {
    system: "atc",
    code: "N01BA",
    label: "Anestésicos locales tipo éster (grupo)",
    category: "anestesico",
    group: true,
    synonyms: ["esteres", "anestesicos ester"],
  },
  {
    system: "atc",
    code: "H02AB",
    label: "Corticoides (grupo)",
    category: "medicamento",
    group: true,
    synonyms: ["corticoide", "corticoides"],
  },
]

/** Otras formas de escribir un medicamento de la lista dental. */
const MEDICATION_SYNONYMS: Partial<Record<string, readonly string[]>> = {
  "ácido acetilsalicílico": ["aspirina", "acido acetil salicilico"],
  metamizol: ["dipirona", "metamizol sodico"],
  bencilpenicilina: ["penicilina g", "penicilina g sodica"],
  "amoxicilina + ácido clavulánico": [
    "amoxicilina clavulanico",
    "amoxicilina con acido clavulanico",
  ],
  "sulfametoxazol + trimetoprima": ["cotrimoxazol", "bactrim"],
  lidocaína: ["xilocaina"],
}

/** Cada medicamento de una lista de receta como sustancia de alergia, con su código ATC. */
export function medicationAllergens(
  medications: readonly MedicationEntry[],
  synonyms: Partial<Record<string, readonly string[]>> = {},
): AllergenEntry[] {
  return medications.map(
    (medication): AllergenEntry => ({
      system: "atc",
      code: medication.atc,
      label: medication.dci.charAt(0).toLocaleUpperCase("es") + medication.dci.slice(1),
      category:
        medication.group === "anestesicos_amida" || medication.group === "anestesicos_ester"
          ? "anestesico"
          : "medicamento",
      synonyms: synonyms[medication.dci] ?? MEDICATION_SYNONYMS[medication.dci],
    }),
  )
}

const MEDICATIONS: readonly AllergenEntry[] = [
  ...medicationAllergens(DENTAL_MEDICATIONS),
  // La penicilina de depósito, que suele nombrarse así en una alergia.
  {
    system: "atc",
    code: "J01CE08",
    label: "Penicilina G benzatínica",
    category: "medicamento",
    synonyms: ["penicilina benzatinica", "benzatina"],
  },
]

/** La lista propia: lo que no es medicamento y importa en una consulta dental. */
export const NON_DRUG_ALLERGENS: readonly AllergenEntry[] = [
  {
    system: "odentia",
    code: "latex",
    label: "Látex",
    category: "material",
    synonyms: ["latex", "guantes de latex"],
  },
  {
    system: "odentia",
    code: "niquel",
    label: "Níquel",
    category: "material",
    synonyms: ["niquel"],
  },
  {
    system: "odentia",
    code: "metacrilato",
    label: "Metacrilato (resinas acrílicas)",
    category: "material",
    synonyms: ["metacrilato", "metilmetacrilato", "acrilico", "resina acrilica"],
  },
  {
    system: "odentia",
    code: "eugenol",
    label: "Eugenol",
    category: "material",
    synonyms: ["oxido de zinc eugenol"],
  },
  {
    system: "odentia",
    code: "yodo",
    label: "Yodo y povidona yodada",
    category: "material",
    synonyms: ["yodo", "povidona", "povidona yodada", "isodine"],
  },
  {
    system: "odentia",
    code: "mani",
    label: "Maní",
    category: "alimento",
    synonyms: ["mani", "cacahuate", "cacahuete"],
  },
  {
    system: "odentia",
    code: "frutos_secos",
    label: "Frutos secos",
    category: "alimento",
    synonyms: ["nueces", "almendras"],
  },
  {
    system: "odentia",
    code: "mariscos",
    label: "Mariscos",
    category: "alimento",
    synonyms: ["marisco", "camaron", "camarones", "crustaceos"],
  },
  { system: "odentia", code: "pescado", label: "Pescado", category: "alimento" },
  { system: "odentia", code: "huevo", label: "Huevo", category: "alimento" },
  {
    system: "odentia",
    code: "leche",
    label: "Leche de vaca",
    category: "alimento",
    synonyms: ["leche", "proteina de leche"],
  },
  { system: "odentia", code: "soya", label: "Soya", category: "alimento", synonyms: ["soja"] },
]

/** Todas las sustancias que se pueden elegir, los grupos primero. */
export const ALLERGENS: readonly AllergenEntry[] = [...ATC_GROUP_ALLERGENS, ...MEDICATIONS, ...NON_DRUG_ALLERGENS]

const CATEGORY_WORDS: Record<AllergenCategory, string> = {
  medicamento: "medicamento",
  anestesico: "anestésico",
  material: "material",
  alimento: "alimento",
  ambiental: "ambiental",
  otro: "otro",
}

/** La línea de abajo en la lista: «medicamento · ATC J01C», «material». */
export function allergenDetail(entry: AllergenEntry): string {
  const kind = CATEGORY_WORDS[entry.category]
  return entry.system === "atc" ? `${kind} · ATC ${entry.code}` : kind
}

/** Cómo se dice en una frase: «penicilinas», «látex» (sin «(grupo)»). */
export function allergenName(entry: AllergenEntry): string {
  return entry.label
    .replace(/\s*\(grupo\)$/, "")
    .replace(/, AINE$/, "")
    .toLocaleLowerCase("es")
}

export function allergenByCode(
  system: string | null | undefined,
  code: string | null | undefined,
  allergens: readonly AllergenEntry[] = ALLERGENS,
): AllergenEntry | null {
  if (!system || !code) return null
  return allergens.find((entry) => entry.system === system && entry.code === code) ?? null
}

function keysOf(entry: AllergenEntry): string[] {
  return [entry.label, entry.label.replace(/\s*\(grupo\)$/, ""), ...(entry.synonyms ?? [])].map(
    normalizeDrugText,
  )
}

/**
 * La sustancia que nombra un texto escrito tal cual («Penicilina»,
 * «AMOXICILINA», «látex»), o null si no es exactamente una de la lista. No
 * adivina: «amoxi» queda sin codificar y se elige después de la lista.
 */
export function codeAllergySubstance(
  text: string,
  allergens: readonly AllergenEntry[] = ALLERGENS,
): AllergenEntry | null {
  const key = normalizeDrugText(text)
  if (!key) return null
  return allergens.find((entry) => keysOf(entry).includes(key)) ?? null
}

/** Lo que coincide con lo escrito, en orden: igual, empieza igual, lo contiene. */
export function searchAllergens(
  query: string,
  limit = 8,
  allergens: readonly AllergenEntry[] = ALLERGENS,
): AllergenEntry[] {
  const needle = normalizeDrugText(query)
  if (!needle) return allergens.filter((entry) => entry.group).slice(0, limit)
  const scored: Array<[number, number, AllergenEntry]> = []
  allergens.forEach((entry, index) => {
    const keys = keysOf(entry)
    const rank = keys.some((key) => key === needle)
      ? 0
      : keys.some((key) => key.startsWith(needle))
        ? 1
        : keys.some((key) => key.split(" ").some((word) => word.startsWith(needle)))
          ? 2
          : keys.some((key) => key.includes(needle))
            ? 3
            : -1
    if (rank >= 0) scored.push([rank, index, entry])
  })
  return scored
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .slice(0, limit)
    .map(([, , entry]) => entry)
}

/** Prefijo ATC de cada grupo de medicamentos: el código de la receta dice a qué grupo pertenece. */
const GROUP_ATC: Partial<Record<MedicationGroup, string>> = {
  penicilinas: "J01C",
  cefalosporinas: "J01D",
  macrolidos: "J01FA",
  lincosamidas: "J01FF",
  nitroimidazoles: "P01AB",
  sulfonamidas: "J01E",
  aine: "M01A",
  salicilatos: "N02BA",
  pirazolonas: "N02BB",
  paracetamol: "N02BE",
  opioides: "N02A",
  anestesicos_amida: "N01BB",
  anestesicos_ester: "N01BA",
  corticoides: "H02AB",
  antivirales: "J05AB",
  antisepticos: "A01AB",
  quinolonas: "J01MA",
  tetraciclinas: "J01AA",
}

/** El grupo de un código ATC, por el prefijo más largo que coincide. */
export function medicationGroupOfAtc(code: string): MedicationGroup | null {
  let best: [MedicationGroup, number] | null = null
  for (const [group, prefix] of Object.entries(GROUP_ATC) as [MedicationGroup, string][]) {
    if (code.startsWith(prefix) && (!best || prefix.length > best[1])) best = [group, prefix.length]
  }
  return best?.[0] ?? null
}

/** Medicamento de uso habitual, para la medicación que el paciente ya toma. */
export interface HabitualMedicationEntry {
  dci: string
  atc: string
}

/**
 * Lo que más toman los pacientes y cambia lo que se hace en la boca
 * (anticoagulantes, antiagregantes, bifosfonatos, antidiabéticos,
 * antihipertensivos, anticonvulsivos…), además de la lista de la receta. Por
 * DCI y código ATC; lo que no está se escribe.
 */
export const HABITUAL_MEDICATIONS: readonly HabitualMedicationEntry[] = [
  { dci: "warfarina", atc: "B01AA03" },
  { dci: "acenocumarol", atc: "B01AA07" },
  { dci: "enoxaparina", atc: "B01AB05" },
  { dci: "clopidogrel", atc: "B01AC04" },
  { dci: "dabigatrán etexilato", atc: "B01AE07" },
  { dci: "rivaroxabán", atc: "B01AF01" },
  { dci: "apixabán", atc: "B01AF02" },
  { dci: "metformina", atc: "A10BA02" },
  { dci: "glibenclamida", atc: "A10BB01" },
  { dci: "insulina glargina", atc: "A10AE04" },
  { dci: "enalapril", atc: "C09AA02" },
  { dci: "captopril", atc: "C09AA01" },
  { dci: "losartán", atc: "C09CA01" },
  { dci: "valsartán", atc: "C09CA03" },
  { dci: "amlodipino", atc: "C08CA01" },
  { dci: "nifedipino", atc: "C08CA05" },
  { dci: "atenolol", atc: "C07AB03" },
  { dci: "propranolol", atc: "C07AA05" },
  { dci: "carvedilol", atc: "C07AG02" },
  { dci: "hidroclorotiazida", atc: "C03AA03" },
  { dci: "furosemida", atc: "C03CA01" },
  { dci: "atorvastatina", atc: "C10AA05" },
  { dci: "simvastatina", atc: "C10AA01" },
  { dci: "levotiroxina", atc: "H03AA01" },
  { dci: "ácido alendrónico", atc: "M05BA04" },
  { dci: "ácido zoledrónico", atc: "M05BA08" },
  { dci: "denosumab", atc: "M05BX04" },
  { dci: "omeprazol", atc: "A02BC01" },
  { dci: "salbutamol", atc: "R03AC02" },
  { dci: "sertralina", atc: "N06AB06" },
  { dci: "fluoxetina", atc: "N06AB03" },
  { dci: "alprazolam", atc: "N05BA12" },
  { dci: "clonazepam", atc: "N03AE01" },
  { dci: "carbamazepina", atc: "N03AF01" },
  { dci: "fenitoína", atc: "N03AB02" },
  { dci: "ácido valproico", atc: "N03AG01" },
  { dci: "levetiracetam", atc: "N03AX14" },
  { dci: "ciclosporina", atc: "L04AD01" },
  ...DENTAL_MEDICATIONS.map(({ dci, atc }) => ({ dci, atc })),
]

export function findHabitualMedication(
  dci: string,
  entries: readonly HabitualMedicationEntry[] = HABITUAL_MEDICATIONS,
): HabitualMedicationEntry | null {
  const key = normalizeDrugText(dci)
  return entries.find((entry) => normalizeDrugText(entry.dci) === key) ?? null
}

/** Medicamentos que coinciden con lo escrito, para elegir la DCI. */
export function searchHabitualMedications(
  query: string,
  limit = 8,
  entries: readonly HabitualMedicationEntry[] = HABITUAL_MEDICATIONS,
): HabitualMedicationEntry[] {
  const needle = normalizeDrugText(query)
  if (!needle) return []
  const starts: HabitualMedicationEntry[] = []
  const contains: HabitualMedicationEntry[] = []
  for (const entry of entries) {
    const key = normalizeDrugText(entry.dci)
    if (key.startsWith(needle)) starts.push(entry)
    else if (key.includes(needle)) contains.push(entry)
  }
  return [...starts, ...contains].slice(0, limit)
}

/**
 * Lo que un producto receta y reconoce como alergia (issue 229): su lista de
 * la receta, las sustancias de alergia que se eligen y la medicación habitual
 * que se sugiere en los antecedentes. odentIA usa la dental; latidIA, la de
 * medicina general (`@odentia/medical`).
 */
export interface MedicationCatalog {
  medications: readonly MedicationEntry[]
  allergens: readonly AllergenEntry[]
  habitual: readonly HabitualMedicationEntry[]
}

/** El de odentIA: la lista dental, como siempre. */
export const DENTAL_MEDICATION_CATALOG: MedicationCatalog = {
  medications: DENTAL_MEDICATIONS,
  allergens: ALLERGENS,
  habitual: HABITUAL_MEDICATIONS,
}

/** Alergia de los antecedentes que se compara con lo que se receta. */
export interface AllergyOnRecord {
  substance: string
  /** Lista y código de la sustancia; sin ellos, «sin codificar», se compara el texto. */
  substanceSystem?: string | null
  substanceCode?: string | null
  severity?: string | null
  /** Una «descartada» de antes del cambio no avisa; las quitadas no llegan aquí. */
  verification?: string | null
}

function capitalized(text: string): string {
  return text.charAt(0).toLocaleUpperCase("es") + text.slice(1)
}

/** El grupo en palabras, sin su código: «penicilinas». */
function groupWords(group: MedicationGroup): string {
  return MEDICATION_GROUP_LABELS[group].replace(/\s*\(ATC [^)]+\)$/, "")
}

function severityWord(severity: string | null | undefined): string {
  return severity === "leve" || severity === "moderada" || severity === "severa"
    ? ` ${severity}`
    : ""
}

/**
 * Avisos de alergia al recetar una DCI, una línea por choque. Es la misma regla
 * para la pantalla y el servidor. Con la sustancia elegida de la lista se
 * compara por código ATC: el mismo medicamento, el mismo grupo (el código de la
 * receta empieza por el del grupo) o un grupo con reacción cruzada conocida.
 * Sin codificar, por el texto, como antes. Todas avisan igual: no hay alergias
 * «por confirmar» (tablero 7, versión 4).
 */
export function allergyWarnings(
  dci: string,
  allergies: AllergyOnRecord[],
  catalog: MedicationCatalog = DENTAL_MEDICATION_CATALOG,
): string[] {
  const name = dci.trim()
  if (!name) return []
  const title = capitalized(name)
  const medication = findMedication(name, catalog.medications)
  const lines: string[] = []
  for (const allergy of allergies) {
    if (allergy.verification === "descartada") continue
    const sev = severityWord(allergy.severity)
    const entry = allergenByCode(allergy.substanceSystem, allergy.substanceCode, catalog.allergens)
    if (entry) {
      // Lo que no es medicamento (látex, alimentos) no choca con una receta.
      if (entry.system !== "atc") continue
      const what = allergenName(entry)
      if (!medication) {
        // Una DCI que no está en la lista: solo se reconoce si es la misma palabra.
        if (normalizeDrugText(name) === normalizeDrugText(entry.label))
          lines.push(`${title}: alergia${sev} a ${what}, el mismo medicamento.`)
        continue
      }
      const allergyGroup = medicationGroupOfAtc(entry.code)
      // Sin grupo de alergia («otros»), solo avisa la misma sustancia.
      const ownGroup = medication.group === "otros" ? null : medication.group
      if (!entry.group && entry.code === medication.atc) {
        lines.push(
          `${title}: alergia${sev} a ${what}, el mismo medicamento (ATC ${medication.atc}).`,
        )
      } else if (
        (entry.group && medication.atc.startsWith(entry.code)) ||
        (!entry.group && ownGroup !== null && allergyGroup === ownGroup)
      ) {
        lines.push(
          `${title}: alergia${sev} a ${what}. Es del mismo grupo, ${groupWords(medication.group)} (ATC ${medication.atc}).`,
        )
      } else if (allergyGroup && ownGroup && crossReacts(ownGroup, allergyGroup)) {
        lines.push(
          `${title}: alergia${sev} a ${what}. Puede dar reacción cruzada: ${groupWords(medication.group)} y ${groupWords(allergyGroup)} (ATC ${medication.atc}).`,
        )
      }
      continue
    }
    for (const conflict of allergyConflicts(name, [allergy.substance], catalog.medications)) {
      lines.push(`${title}: alergia${sev} a «${conflict.substance}» (${conflict.reason}).`)
    }
  }
  return lines
}

/** La frecuencia de la medicación habitual en palabras. */
export const MEDICATION_FREQUENCY_LABELS: Record<MedicationFrequency, string> = {
  cada_8_h: "Cada 8 horas",
  cada_12_h: "Cada 12 horas",
  cada_24_h: "Cada 24 horas",
  segun_necesidad: "Según necesidad",
}

/** Cada unidad UCUM como se lee, en singular y plural. */
export const DOSE_UNIT_LABELS: Record<DoseUnit, readonly [string, string]> = {
  mg: ["mg", "mg"],
  g: ["g", "g"],
  ug: ["µg", "µg"],
  mL: ["mL", "mL"],
  "[iU]": ["UI", "UI"],
  "{tbl}": ["comprimido", "comprimidos"],
  "{cap}": ["cápsula", "cápsulas"],
  "{drop}": ["gota", "gotas"],
  "{puff}": ["inhalación", "inhalaciones"],
}

/** «500 mg», «1 comprimido», «0,5 mL»: la dosis estructurada en palabras. */
export function doseText(value: number, unit: DoseUnit): string {
  const [one, many] = DOSE_UNIT_LABELS[unit]
  return `${value.toLocaleString("es", { maximumFractionDigits: 3 })} ${value === 1 ? one : many}`
}

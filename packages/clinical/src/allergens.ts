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
  /**
   * Sus otros nombres estándar, que llevan al mismo código: el nombre con que se escribe en el
   * Perú y Latinoamérica («alendronato») y su marca registrada («Fosamax»). Como los sinónimos de
   * una alergia (`AllergenEntry.synonyms`): son datos de la lista, no una regla por nombre.
   */
  names?: readonly string[]
}

/**
 * Lo que más toman los pacientes y cambia lo que se hace en la boca
 * (anticoagulantes, antiagregantes, bifosfonatos, antidiabéticos,
 * antihipertensivos, anticonvulsivos…), además de la lista de la receta. Por
 * DCI y código ATC; lo que no está se escribe.
 *
 * Los anticoagulantes, antiagregantes y las medicinas para los huesos llevan además sus otros
 * nombres (`names`), porque así los escribe quien los toma y cambian una cirugía en la boca:
 * - código ATC de la DCI: WHO Collaborating Centre for Drug Statistics Methodology, *ATC/DDD
 *   Index* (grupos B01A y M05B);
 * - qué medicinas para los huesos dan osteonecrosis de los maxilares: Ruggiero SL y col.,
 *   «AAOMS Position Paper on Medication-Related Osteonecrosis of the Jaws—2022 Update»,
 *   *J Oral Maxillofac Surg* 2022;80:920-943 (bifosfonatos, denosumab y romosozumab). Raloxifeno
 *   (G03XC01), teriparatida (H05AA02) y calcio (A12) no son del grupo M05B y no dan la marca;
 * - las marcas, las registradas de cada DCI (verificar en el registro sanitario de DIGEMID).
 */
export const HABITUAL_MEDICATIONS: readonly HabitualMedicationEntry[] = [
  { dci: "warfarina", atc: "B01AA03" },
  { dci: "acenocumarol", atc: "B01AA07", names: ["Sintrom"] },
  { dci: "enoxaparina", atc: "B01AB05" },
  { dci: "clopidogrel", atc: "B01AC04", names: ["Plavix"] },
  { dci: "dabigatrán etexilato", atc: "B01AE07", names: ["dabigatrán", "Pradaxa"] },
  { dci: "rivaroxabán", atc: "B01AF01", names: ["Xarelto"] },
  { dci: "apixabán", atc: "B01AF02", names: ["Eliquis"] },
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
  { dci: "ácido alendrónico", atc: "M05BA04", names: ["alendronato", "alendronato sódico", "Fosamax"] },
  { dci: "ácido risedrónico", atc: "M05BA07", names: ["risedronato", "risedronato sódico", "Actonel"] },
  { dci: "ácido ibandrónico", atc: "M05BA06", names: ["ibandronato", "Bonviva"] },
  { dci: "ácido zoledrónico", atc: "M05BA08", names: ["zoledronato", "Aclasta", "Zometa"] },
  { dci: "ácido pamidrónico", atc: "M05BA03", names: ["pamidronato", "Aredia"] },
  { dci: "denosumab", atc: "M05BX04", names: ["Prolia", "Xgeva"] },
  { dci: "romosozumab", atc: "M05BX06", names: ["Evenity"] },
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

/** Los nombres estándar de una medicina, sin tildes ni mayúsculas: su DCI y sus otros nombres. */
function habitualKeys(entry: HabitualMedicationEntry): string[] {
  return [entry.dci, ...(entry.names ?? [])].map(normalizeDrugText)
}

/**
 * Lo que sigue al nombre dice que es una combinación, no esa medicina sola: un «+» en cualquier
 * parte («paracetamol + codeína 500/30», «enalapril 10 mg + hidroclorotiazida»), una «/» pegada
 * al nombre y seguida de otro («ibuprofeno/paracetamol»; «500/30» y «5 mg/día» no lo son) o «y»/«e»
 * seguida de otro nombre, justo después del nombre o de su dosis («losartán y amlodipino»,
 * «losartán 50 mg e hidroclorotiazida»). La migración 0150 usa la misma regla en SQL.
 */
const COMPOUND_REST = /\+|^\s*\/\s*\p{L}|^\s*(?:[\d.,]+\s*(?:mg|g|mcg|ug|ml|ui|%)?\s*)?\b[ye]\b\s*\p{L}/u

/**
 * La medicina de la lista que nombra lo escrito y el nombre por el que se reconoció. Se reconoce
 * si lo escrito es uno de sus nombres estándar o empieza por él y sigue lo que no es una letra:
 * la dosis o la frecuencia («alendronato 70 mg semanal», «Eliquis 5mg»). Gana el nombre más largo
 * («amoxicilina + ácido clavulánico 875 mg» no es «amoxicilina»). Nunca un trozo de nombre
 * («alendro», «ácido»), un nombre dentro de otro texto ni una combinación que la lista no tiene
 * entera (`COMPOUND_REST`): no adivina.
 */
export function matchHabitualMedication(
  written: string,
  entries: readonly HabitualMedicationEntry[] = HABITUAL_MEDICATIONS,
): { entry: HabitualMedicationEntry; name: string } | null {
  const text = normalizeDrugText(written)
  if (!text) return null
  let best: { entry: HabitualMedicationEntry; name: string } | null = null
  let bestLength = 0
  for (const entry of entries) {
    const names = [entry.dci, ...(entry.names ?? [])]
    const keys = habitualKeys(entry)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] ?? ""
      if (!key || !text.startsWith(key) || /\p{L}/u.test(text.charAt(key.length))) continue
      if (COMPOUND_REST.test(text.slice(key.length))) continue
      if (key.length > bestLength) {
        best = { entry, name: names[index] ?? entry.dci }
        bestLength = key.length
      }
    }
  }
  return best
}

/** La medicina de la lista que nombra lo escrito (`matchHabitualMedication`), o null. */
export function findHabitualMedication(
  dci: string,
  entries: readonly HabitualMedicationEntry[] = HABITUAL_MEDICATIONS,
): HabitualMedicationEntry | null {
  return matchHabitualMedication(dci, entries)?.entry ?? null
}

/** La DCI de un código ATC de la lista («M05BA04» → «ácido alendrónico»), o null si no está. */
export function habitualDciOfAtc(
  atc: string | null | undefined,
  entries: readonly HabitualMedicationEntry[] = HABITUAL_MEDICATIONS,
): string | null {
  return atc ? (entries.find((entry) => entry.atc === atc)?.dci ?? null) : null
}

/**
 * Las dos clases de medicinas que cambian lo que se hace en la cita y por eso
 * llevan su marca arriba de la ficha y de la atención. Cada una es un grupo de
 * la clasificación ATC de la OMS, que es jerárquica: el código de un
 * medicamento empieza por el de su grupo (warfarina, B01AA03, es de B01A).
 * - `anticoagulants`: B01A, agentes antitrombóticos (antagonistas de la
 *   vitamina K, heparinas, antiagregantes como el clopidogrel o la aspirina
 *   diaria, e inhibidores directos de la trombina y del factor Xa).
 * - `boneMedicines`: M05B, medicamentos que afectan la estructura ósea y la
 *   mineralización (bifosfonatos y denosumab).
 *
 * La marca sale del código: lo tiene la medicina que el paciente dijo al
 * responder «Sí» a la pregunta de su clase (con el código del grupo,
 * `declaredMedicineAtc`), la que el equipo eligió de la lista y la que se
 * escribió con uno de los nombres estándar de la lista (`matchHabitualMedication`):
 * su DCI, su nombre local o su marca registrada, sola o seguida de la dosis
 * («alendronato 70 mg semanal», «Sintrom»). Esos nombres son datos de la lista,
 * con el código de su DCI; un texto libre cualquiera («la pastilla del hueso»)
 * no se reconoce ni se adivina: queda sin código y sin marca.
 */
export const MEDICATION_CLASSES = {
  anticoagulants: { atc: "B01A", label: "Anticoagulante", unnamed: "Anticoagulante (no dijo cuál)" },
  boneMedicines: { atc: "M05B", label: "Medicina para los huesos", unnamed: "Medicina para los huesos (no dijo cuál)" },
} as const
export type MedicationClass = keyof typeof MEDICATION_CLASSES

/** La clase con marca de un código ATC; null si no es de ninguna. */
export function medicationClassOf(atc: string | null | undefined): MedicationClass | null {
  if (!atc) return null
  for (const [key, group] of Object.entries(MEDICATION_CLASSES))
    if (atc.startsWith(group.atc)) return key as MedicationClass
  return null
}

/**
 * El código ATC de la medicina que alguien dijo al responder «Sí» a la pregunta
 * de una clase: el del medicamento si lo que escribió lo nombra por uno de sus
 * nombres de la lista (también con la dosis, `matchHabitualMedication`) y es de
 * esa clase; si no (lo escribió a su manera o no dijo cuál), el del grupo.
 * Nunca un código de otra clase: la respuesta manda.
 */
export function declaredMedicineAtc(
  group: MedicationClass,
  written: string | null | undefined,
  entries: readonly HabitualMedicationEntry[] = HABITUAL_MEDICATIONS,
): string {
  const found = written ? findHabitualMedication(written, entries) : null
  return found && medicationClassOf(found.atc) === group ? found.atc : MEDICATION_CLASSES[group].atc
}

/**
 * Medicamentos que coinciden con lo escrito, para elegir la DCI: por su DCI o por sus otros
 * nombres. `via` es el otro nombre por el que salió («Fosamax»), o null si salió por su DCI.
 */
export function searchHabitualMedications(
  query: string,
  limit = 8,
  entries: readonly HabitualMedicationEntry[] = HABITUAL_MEDICATIONS,
): Array<HabitualMedicationEntry & { via: string | null }> {
  const needle = normalizeDrugText(query)
  if (!needle) return []
  const starts: Array<HabitualMedicationEntry & { via: string | null }> = []
  const contains: Array<HabitualMedicationEntry & { via: string | null }> = []
  for (const entry of entries) {
    const names = [entry.dci, ...(entry.names ?? [])]
    const keys = habitualKeys(entry)
    const start = keys.findIndex((key) => key.startsWith(needle))
    const inside = start >= 0 ? start : keys.findIndex((key) => key.includes(needle))
    if (inside < 0) continue
    const found = { ...entry, via: inside === 0 ? null : (names[inside] ?? null) }
    if (start >= 0) starts.push(found)
    else contains.push(found)
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

/** Lo que ya toma, de sus antecedentes: el nombre que se ve y su código ATC, si lo tiene. */
export interface TakenMedication {
  name: string
  atcCode?: string | null
}

/**
 * Una medicina de sus antecedentes como la lee la receta: con su código, o el de la medicación
 * habitual que se llama igual. La misma regla en la pantalla y en el servidor, para que los dos
 * avisen lo mismo.
 */
export function takenMedication(
  row: { name: string; genericName?: string | null; atcCode?: string | null },
  catalog: MedicationCatalog,
): TakenMedication {
  return { name: row.name, atcCode: row.atcCode ?? findHabitualMedication(row.genericName ?? row.name, catalog.habitual)?.atc ?? null }
}

/**
 * El duplicado por código ATC (ADR 0143): lo que se receta y ya toma, o que va
 * dos veces en la receta, con el mismo principio activo (el mismo ATC) o del mismo grupo
 * (`medicationGroupOfAtc`). Solo informa: «todo lo que mostramos es informativo; decide quien
 * receta». Es la misma regla para la pantalla y el servidor; lo escrito a mano, sin ATC, no se
 * compara.
 */
export function duplicateWarnings(
  items: ReadonlyArray<{ genericName: string }>,
  taking: readonly TakenMedication[],
  catalog: MedicationCatalog = DENTAL_MEDICATION_CATALOG,
): string[] {
  const coded = items
    .map((item) => ({ name: item.genericName.trim(), atc: findMedication(item.genericName, catalog.medications)?.atc ?? null }))
    .filter((item): item is { name: string; atc: string } => item.name !== "" && item.atc !== null)
  const why = (a: string, b: string): string | null => {
    if (a === b) return `el mismo principio activo (ATC ${a})`
    const group = medicationGroupOfAtc(a)
    if (group && group !== "otros" && group === medicationGroupOfAtc(b)) return `del mismo grupo (${groupWords(group)})`
    // Fuera de los grupos con nombre, el mismo subgrupo químico (los cinco primeros caracteres del
    // ATC). Los subgrupos «X» («otros») juntan sustancias distintas: no cuentan.
    return a.length >= 5 && a.slice(0, 5) === b.slice(0, 5) && a[4] !== "X" ? `del mismo grupo (ATC ${a.slice(0, 5)})` : null
  }
  const lines: string[] = []
  coded.forEach((item, index) => {
    for (const med of taking) {
      const same = med.atcCode ? why(item.atc, med.atcCode) : null
      if (same) lines.push(`${capitalized(item.name)}: ya toma ${med.name}, ${same}.`)
    }
    for (const other of coded.slice(index + 1)) {
      if (item.atc === other.atc) {
        lines.push(`${capitalized(item.name)} va dos veces en la receta (ATC ${item.atc}).`)
        continue
      }
      const same = why(item.atc, other.atc)
      if (same) lines.push(`${capitalized(item.name)} y ${other.name} van en la misma receta: son ${same}.`)
    }
  })
  return [...new Set(lines)]
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

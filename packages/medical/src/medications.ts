import {
  type AllergenEntry,
  ATC_GROUP_ALLERGENS,
  HABITUAL_MEDICATIONS,
  type HabitualMedicationEntry,
  type MedicationCatalog,
  type MedicationEntry,
  medicationAllergens,
  NON_DRUG_ALLERGENS,
  normalizeDrugText,
} from "@odentia/clinical"

/**
 * Lo que más se receta en medicina general, familiar, interna, pediatría y
 * ginecología (issue 229, decisión 12), por Denominación Común Internacional
 * y código ATC de la OMS. Como la lista dental, no es un vademécum: sirve para
 * sugerir la DCI y avisar alergias; lo que no está se escribe y solo avisa por
 * su nombre. El grupo es el de la alergia (penicilinas, AINE…); «otros», sin
 * grupo de alergia.
 */
export const GENERAL_MEDICATIONS: readonly MedicationEntry[] = [
  // Antibióticos
  { dci: "amoxicilina", atc: "J01CA04", group: "penicilinas" },
  { dci: "amoxicilina + ácido clavulánico", atc: "J01CR02", group: "penicilinas" },
  { dci: "ampicilina", atc: "J01CA01", group: "penicilinas" },
  { dci: "dicloxacilina", atc: "J01CF01", group: "penicilinas" },
  { dci: "bencilpenicilina benzatínica", atc: "J01CE08", group: "penicilinas" },
  { dci: "cefalexina", atc: "J01DB01", group: "cefalosporinas" },
  { dci: "cefadroxilo", atc: "J01DB05", group: "cefalosporinas" },
  { dci: "cefuroxima", atc: "J01DC02", group: "cefalosporinas" },
  { dci: "ceftriaxona", atc: "J01DD04", group: "cefalosporinas" },
  { dci: "azitromicina", atc: "J01FA10", group: "macrolidos" },
  { dci: "claritromicina", atc: "J01FA09", group: "macrolidos" },
  { dci: "eritromicina", atc: "J01FA01", group: "macrolidos" },
  { dci: "clindamicina", atc: "J01FF01", group: "lincosamidas" },
  { dci: "ciprofloxacino", atc: "J01MA02", group: "quinolonas" },
  { dci: "levofloxacino", atc: "J01MA12", group: "quinolonas" },
  { dci: "doxiciclina", atc: "J01AA02", group: "tetraciclinas" },
  { dci: "sulfametoxazol + trimetoprima", atc: "J01EE01", group: "sulfonamidas" },
  { dci: "nitrofurantoína", atc: "J01XE01", group: "otros" },
  { dci: "fosfomicina", atc: "J01XX01", group: "otros" },
  { dci: "metronidazol", atc: "P01AB01", group: "nitroimidazoles" },
  // Antifúngicos y antiparasitarios
  { dci: "fluconazol", atc: "J02AC01", group: "antifungicos" },
  { dci: "nistatina", atc: "A07AA02", group: "antifungicos" },
  { dci: "clotrimazol", atc: "D01AC01", group: "antifungicos" },
  { dci: "albendazol", atc: "P02CA03", group: "otros" },
  { dci: "mebendazol", atc: "P02CA01", group: "otros" },
  { dci: "nitazoxanida", atc: "P01AX11", group: "otros" },
  { dci: "ivermectina", atc: "P02CF01", group: "otros" },
  { dci: "permetrina", atc: "P03AC04", group: "otros" },
  // Dolor, fiebre e inflamación
  { dci: "paracetamol", atc: "N02BE01", group: "paracetamol" },
  { dci: "ibuprofeno", atc: "M01AE01", group: "aine" },
  { dci: "naproxeno", atc: "M01AE02", group: "aine" },
  { dci: "diclofenaco", atc: "M01AB05", group: "aine" },
  { dci: "ketorolaco", atc: "M01AB15", group: "aine" },
  { dci: "meloxicam", atc: "M01AC06", group: "aine" },
  { dci: "celecoxib", atc: "M01AH01", group: "aine" },
  { dci: "metamizol", atc: "N02BB02", group: "pirazolonas" },
  { dci: "ácido acetilsalicílico", atc: "N02BA01", group: "salicilatos" },
  { dci: "tramadol", atc: "N02AX02", group: "opioides" },
  // Corticoides
  { dci: "prednisona", atc: "H02AB07", group: "corticoides" },
  { dci: "dexametasona", atc: "H02AB02", group: "corticoides" },
  { dci: "hidrocortisona", atc: "H02AB09", group: "corticoides" },
  { dci: "betametasona", atc: "H02AB01", group: "corticoides" },
  // Digestivo
  { dci: "omeprazol", atc: "A02BC01", group: "otros" },
  { dci: "pantoprazol", atc: "A02BC02", group: "otros" },
  { dci: "butilbromuro de hioscina", atc: "A03BB01", group: "otros" },
  { dci: "metoclopramida", atc: "A03FA01", group: "otros" },
  { dci: "domperidona", atc: "A03FA03", group: "otros" },
  { dci: "ondansetrón", atc: "A04AA01", group: "otros" },
  { dci: "loperamida", atc: "A07DA03", group: "otros" },
  { dci: "simeticona", atc: "A03AX13", group: "otros" },
  { dci: "lactulosa", atc: "A06AD11", group: "otros" },
  { dci: "misoprostol", atc: "A02BB01", group: "otros" },
  // Respiratorio y alergia
  { dci: "salbutamol", atc: "R03AC02", group: "otros" },
  { dci: "beclometasona", atc: "R03BA01", group: "otros" },
  { dci: "budesonida", atc: "R03BA02", group: "otros" },
  { dci: "bromuro de ipratropio", atc: "R03BB01", group: "otros" },
  { dci: "montelukast", atc: "R03DC03", group: "otros" },
  { dci: "loratadina", atc: "R06AX13", group: "otros" },
  { dci: "desloratadina", atc: "R06AX27", group: "otros" },
  { dci: "cetirizina", atc: "R06AE07", group: "otros" },
  { dci: "clorfenamina", atc: "R06AB04", group: "otros" },
  { dci: "ambroxol", atc: "R05CB06", group: "otros" },
  { dci: "dextrometorfano", atc: "R05DA09", group: "otros" },
  // Corazón y metabolismo
  { dci: "enalapril", atc: "C09AA02", group: "otros" },
  { dci: "captopril", atc: "C09AA01", group: "otros" },
  { dci: "losartán", atc: "C09CA01", group: "otros" },
  { dci: "valsartán", atc: "C09CA03", group: "otros" },
  { dci: "amlodipino", atc: "C08CA01", group: "otros" },
  { dci: "nifedipino", atc: "C08CA05", group: "otros" },
  { dci: "hidroclorotiazida", atc: "C03AA03", group: "otros" },
  { dci: "furosemida", atc: "C03CA01", group: "otros" },
  { dci: "espironolactona", atc: "C03DA01", group: "otros" },
  { dci: "atenolol", atc: "C07AB03", group: "otros" },
  { dci: "propranolol", atc: "C07AA05", group: "otros" },
  { dci: "carvedilol", atc: "C07AG02", group: "otros" },
  { dci: "metildopa", atc: "C02AB01", group: "otros" },
  { dci: "atorvastatina", atc: "C10AA05", group: "otros" },
  { dci: "simvastatina", atc: "C10AA01", group: "otros" },
  { dci: "metformina", atc: "A10BA02", group: "otros" },
  { dci: "glibenclamida", atc: "A10BB01", group: "otros" },
  { dci: "levotiroxina", atc: "H03AA01", group: "otros" },
  { dci: "warfarina", atc: "B01AA03", group: "otros" },
  { dci: "clopidogrel", atc: "B01AC04", group: "otros" },
  // Neurología y salud mental
  { dci: "sertralina", atc: "N06AB06", group: "otros" },
  { dci: "fluoxetina", atc: "N06AB03", group: "otros" },
  { dci: "amitriptilina", atc: "N06AA09", group: "otros" },
  { dci: "carbamazepina", atc: "N03AF01", group: "otros" },
  { dci: "ácido valproico", atc: "N03AG01", group: "otros" },
  { dci: "fenitoína", atc: "N03AB02", group: "otros" },
  { dci: "alprazolam", atc: "N05BA12", group: "otros" },
  { dci: "diazepam", atc: "N05BA01", group: "otros" },
  { dci: "lorazepam", atc: "N05BA06", group: "otros" },
  { dci: "clonazepam", atc: "N03AE01", group: "otros" },
  { dci: "zolpidem", atc: "N05CF02", group: "otros" },
  // Vitaminas, hierro y piel
  { dci: "sulfato ferroso", atc: "B03AA07", group: "otros" },
  { dci: "ácido fólico", atc: "B03BB01", group: "otros" },
  { dci: "isotretinoína", atc: "D10BA01", group: "otros" },
]

/** Las sustancias de alergia de latidIA: los grupos, sus medicamentos y lo que no es medicamento. */
const MEDICAL_ALLERGENS: readonly AllergenEntry[] = [
  ...ATC_GROUP_ALLERGENS,
  {
    system: "atc",
    code: "J01MA",
    label: "Fluoroquinolonas (grupo)",
    category: "medicamento",
    group: true,
    synonyms: ["quinolona", "quinolonas", "fluoroquinolona", "fluoroquinolonas"],
  },
  {
    system: "atc",
    code: "J01AA",
    label: "Tetraciclinas (grupo)",
    category: "medicamento",
    group: true,
    synonyms: ["tetraciclina", "tetraciclinas"],
  },
  ...medicationAllergens(GENERAL_MEDICATIONS, {
    "ácido acetilsalicílico": ["aspirina", "acido acetil salicilico"],
    metamizol: ["dipirona", "metamizol sodico"],
    "sulfametoxazol + trimetoprima": ["cotrimoxazol", "bactrim"],
    "bencilpenicilina benzatínica": ["penicilina benzatinica", "benzatina"],
  }),
  // Los materiales de la boca (resinas, eugenol) no vienen al caso en un consultorio.
  ...NON_DRUG_ALLERGENS.filter((entry) => entry.code !== "metacrilato" && entry.code !== "eugenol"),
]

/** La medicación habitual que se sugiere en los antecedentes: la de siempre más la de la receta, sin repetir. */
function habitualOf(medications: readonly MedicationEntry[]): HabitualMedicationEntry[] {
  const seen = new Set<string>()
  return [...HABITUAL_MEDICATIONS, ...medications.map(({ dci, atc }) => ({ dci, atc }))].filter(
    (entry) => {
      const key = normalizeDrugText(entry.dci)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
  )
}

/** Lo que receta latidIA y reconoce como alergia. */
export const MEDICAL_MEDICATION_CATALOG: MedicationCatalog = {
  medications: GENERAL_MEDICATIONS,
  allergens: MEDICAL_ALLERGENS,
  habitual: habitualOf(GENERAL_MEDICATIONS),
}

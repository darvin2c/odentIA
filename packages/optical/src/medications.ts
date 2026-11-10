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
 * Lo que una óptica indica en su receta de medicamentos: lubricantes y lo que
 * alivia el ojo irritado o alérgico, por Denominación Común Internacional y
 * código ATC de la OMS. No es un vademécum ni dice qué puede recetar un optómetra
 * (pendiente legal del plan): solo sugiere la DCI y avisa las alergias; lo que no
 * está se escribe. La receta de lentes va aparte.
 */
export const OPTICAL_MEDICATIONS: readonly MedicationEntry[] = [
  // Lágrimas artificiales: el ojo seco, el uso de pantallas y los lentes de contacto.
  { dci: "hialuronato de sodio", atc: "S01XA20", group: "otros" },
  { dci: "carmelosa", atc: "S01XA20", group: "otros" },
  { dci: "hipromelosa", atc: "S01XA20", group: "otros" },
  // El ojo rojo y la alergia.
  { dci: "nafazolina", atc: "S01GA01", group: "otros" },
  { dci: "olopatadina", atc: "S01GX09", group: "otros" },
  { dci: "ketotifeno", atc: "S01GX08", group: "otros" },
]

/** Las sustancias de alergia de vistIA: los grupos, sus medicamentos y lo que no es medicamento. */
const OPTICAL_ALLERGENS: readonly AllergenEntry[] = [
  ...ATC_GROUP_ALLERGENS,
  ...medicationAllergens(OPTICAL_MEDICATIONS, {
    carmelosa: ["carboximetilcelulosa", "carboximetilcelulosa sodica"],
    "hialuronato de sodio": ["acido hialuronico", "hialuronico"],
  }),
  // Los materiales de la boca (resinas, eugenol) no vienen al caso en una óptica.
  ...NON_DRUG_ALLERGENS.filter((entry) => entry.code !== "metacrilato" && entry.code !== "eugenol"),
]

/** La medicación habitual que se sugiere en los antecedentes: la de siempre más la de la receta, sin repetir. */
function habitualOf(medications: readonly MedicationEntry[]): HabitualMedicationEntry[] {
  const seen = new Set<string>()
  return [...HABITUAL_MEDICATIONS, ...medications.map(({ dci, atc }) => ({ dci, atc }))].filter((entry) => {
    const key = normalizeDrugText(entry.dci)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Lo que receta vistIA y reconoce como alergia: nada de la lista dental. */
export const OPTICAL_MEDICATION_CATALOG: MedicationCatalog = {
  medications: OPTICAL_MEDICATIONS,
  allergens: OPTICAL_ALLERGENS,
  habitual: habitualOf(OPTICAL_MEDICATIONS),
}

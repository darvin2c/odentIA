import type { ProductForms, SuggestedFormTemplate } from "../product-hooks.js"

/**
 * Las fichas de consulta con que nace una clínica de odentIA (ADR 0117): lo que
 * el odontólogo anota en la atención además del examen. Cada clínica recibe su
 * copia, ya en uso, y la cambia como cualquier otra; ninguna pregunta traba la
 * atención y solo la pieza de la endodoncia se pide al finalizar su ficha.
 *
 * Son hojas para anotar: no calculan índices (el CPOD y el IHO-S se escriben ya
 * sumados). Una sección puede mostrar la suma de sus números (`total`, el ceod). La clave es la de su título, así una ficha propia de la clínica con
 * ese mismo título no se duplica. Las claves de las preguntas no cambian: con
 * ellas la atención pone la ficha anterior al lado de la de hoy.
 */

/** Las respuestas de una prueba de sensibilidad pulpar (frío o calor). */
const PULP_TEST = ["Sin respuesta", "Normal", "Aumentada, cede al retirar el estímulo", "Aumentada, persiste"]

/**
 * Los términos de diagnóstico de la Asociación Americana de Endodoncistas (AAE, 2009), pulpar y apical
 * por separado, con el diagnóstico de la CIE-10 (OMS) que son, en la categoría K04: la pulpitis
 * (reversible o irreversible) es K04.0; la necrosis, K04.1; la periodontitis apical sintomática es la
 * aguda (K04.4) y la asintomática, la crónica (K04.5); el absceso apical agudo no drena (K04.7, sin
 * fístula) y el crónico drena por una fístula (K04.6), como lo define la AAE. Si lo dictado dice lo
 * contrario de la fístula, `reviewDiagnosis` propone el otro. Lo normal, lo ya tratado y la osteítis
 * condensante (fuera de K04) no tienen código: no van a Diagnóstico.
 */
const PULPAL: ReadonlyArray<readonly [string, string | null, string | null]> = [
  ["Pulpa normal", null, null],
  ["Pulpitis reversible", "K04.0", "reversible"],
  ["Pulpitis irreversible sintomática", "K04.0", "irreversible sintomática"],
  ["Pulpitis irreversible asintomática", "K04.0", "irreversible asintomática"],
  ["Necrosis pulpar", "K04.1", null],
  ["Previamente tratado", null, null],
  ["Tratamiento previamente iniciado", null, null],
]
const APICAL: ReadonlyArray<readonly [string, string | null, string | null]> = [
  ["Tejidos apicales normales", null, null],
  ["Periodontitis apical sintomática", "K04.4", "sintomática"],
  ["Periodontitis apical asintomática", "K04.5", "asintomática"],
  ["Absceso apical agudo", "K04.7", "agudo"],
  ["Absceso apical crónico", "K04.6", "crónico"],
  ["Osteítis condensante", null, null],
]
const PULPAL_DIAGNOSES = PULPAL.map(([option]) => option)
const APICAL_DIAGNOSES = APICAL.map(([option]) => option)
/** Las opciones que son un diagnóstico, con su código (`ProductForms.diagnoses`). */
const AAE_ICD10: Readonly<Record<string, string>> = Object.fromEntries([...PULPAL, ...APICAL].flatMap(([option, code]) => (code ? [[option, code]] : [])))
/**
 * Lo que el término de la AAE le suma al nombre de su código (`ProductForms.qualifiers`). La CIE-10
 * de la OMS no separa la pulpitis reversible de la irreversible (las dos son K04.0), y eso está bien:
 * el término ya tiene dueño, la respuesta de la ficha, y la Historia lo lee de ahí, sin otra columna
 * en el diagnóstico (estudio de la atención del 16 nov, E10b). La necrosis no le suma nada a K04.1.
 * Fuente: AAE, Glossary of Endodontic Terms, y Consensus Conference on Diagnostic Terminology (J Endod
 * 2009;35:1634). Falta verificar si la lista del MINSA usa la ICD-DA.
 */
const AAE_QUALIFIERS: Readonly<Record<string, string>> = Object.fromEntries(
  [...PULPAL, ...APICAL].flatMap(([option, code, qualifier]) => (code && qualifier ? [[option, qualifier]] : [])),
)

const ENDODONTICS: SuggestedFormTemplate = {
  key: "evaluacion-de-endodoncia",
  title: "Evaluación de endodoncia",
  description:
    "Pieza, dolor (0–10), tumefacción, fístula, movilidad y sondaje, pruebas de frío, calor, percusión y palpación, radiografía, diagnóstico pulpar y apical.",
  kind: "endodoncia",
  schema: {
    sections: [
      {
        id: "pieza",
        title: "Pieza y dolor",
        fields: [
          { id: "pieza", label: "Pieza", type: "pieza", required: true },
          { id: "dolor", label: "Dolor", type: "opcion_unica", options: ["Sin dolor", "Provocado", "Espontáneo"] },
          { id: "dolor_intensidad", label: "Intensidad del dolor", type: "escala", min: 0, max: 10, help: "0, sin dolor; 10, el peor dolor." },
        ],
      },
      {
        // Lo que separa el absceso agudo del crónico y la lesión endoperiodontal (AAE).
        id: "examen",
        title: "Examen de la pieza",
        fields: [
          { id: "tumefaccion", label: "Tumefacción", type: "opcion_unica", options: ["No tiene", "Intraoral", "Extraoral"] },
          { id: "fistula", label: "Fístula (tracto sinusal)", type: "booleano" },
          {
            id: "movilidad",
            label: "Movilidad",
            type: "opcion_unica",
            options: ["Grado 0 (fisiológica)", "Grado 1", "Grado 2", "Grado 3"],
          },
          { id: "sondaje", label: "Sondaje periodontal más profundo", type: "numero", unit: "mm", min: 0, max: 15 },
        ],
      },
      {
        id: "pruebas",
        title: "Pruebas",
        fields: [
          { id: "frio", label: "Prueba de frío", type: "opcion_unica", options: PULP_TEST },
          { id: "calor", label: "Prueba de calor", type: "opcion_unica", options: PULP_TEST },
          { id: "percusion", label: "Percusión", type: "opcion_unica", options: ["Negativa", "Positiva"] },
          { id: "palpacion", label: "Palpación", type: "opcion_unica", options: ["Negativa", "Positiva"] },
        ],
      },
      {
        id: "radiografia",
        title: "Radiografía",
        fields: [
          {
            id: "hallazgo_radiografico",
            label: "Hallazgo radiográfico periapical",
            type: "opcion_multiple",
            options: [
              "Ninguno",
              "Ensanchamiento del ligamento periodontal",
              "Radiolucidez periapical",
              "Conductos calcificados",
              "Reabsorción",
              "Tratamiento de conducto previo",
            ],
          },
        ],
      },
      {
        id: "diagnostico",
        title: "Diagnóstico",
        fields: [
          { id: "diagnostico_pulpar", label: "Diagnóstico pulpar", type: "opcion_unica", options: PULPAL_DIAGNOSES },
          { id: "diagnostico_apical", label: "Diagnóstico apical", type: "opcion_unica", options: APICAL_DIAGNOSES },
          { id: "observaciones", label: "Observaciones", type: "texto_largo" },
        ],
      },
    ],
  },
}

/** La clase de Angle, molar o canina, de un lado. */
const ANGLE = ["Clase I", "Clase II división 1", "Clase II división 2", "Clase III"]
/** La clase canina de un lado: sin divisiones. */
const CANINE = ["Clase I", "Clase II", "Clase III"]
/** La línea media de una arcada respecto a la facial. */
const MIDLINE = ["Centrada", "Desviada a la derecha", "Desviada a la izquierda"]

/** Por lado y por arcada: con un solo campo no se anota una clase II subdivisión. */
const ORTHODONTICS: SuggestedFormTemplate = {
  key: "ficha-de-ortodoncia",
  title: "Ficha de ortodoncia",
  description:
    "Clase molar y canina de cada lado, overjet y overbite en mm, línea media de cada arcada, mordidas cruzadas, hábitos.",
  kind: "ortodoncia",
  schema: {
    sections: [
      {
        id: "oclusion",
        title: "Oclusión",
        fields: [
          { id: "clase_molar_derecha", label: "Clase molar derecha (Angle)", type: "opcion_unica", options: ANGLE },
          { id: "clase_molar_izquierda", label: "Clase molar izquierda (Angle)", type: "opcion_unica", options: ANGLE },
          { id: "clase_canina_derecha", label: "Clase canina derecha", type: "opcion_unica", options: CANINE },
          { id: "clase_canina_izquierda", label: "Clase canina izquierda", type: "opcion_unica", options: CANINE },
          { id: "overjet", label: "Overjet", type: "numero", unit: "mm", min: -10, max: 20 },
          { id: "overbite", label: "Overbite", type: "numero", unit: "mm", min: -10, max: 15 },
          { id: "linea_media_superior", label: "Línea media superior", type: "opcion_unica", options: MIDLINE },
          { id: "linea_media_superior_mm", label: "Desviación de la línea media superior", type: "numero", unit: "mm", min: 0, max: 15 },
          { id: "linea_media_inferior", label: "Línea media inferior", type: "opcion_unica", options: MIDLINE },
          { id: "linea_media_inferior_mm", label: "Desviación de la línea media inferior", type: "numero", unit: "mm", min: 0, max: 15 },
          {
            id: "mordida_cruzada",
            label: "Mordida cruzada",
            type: "opcion_multiple",
            // «No tiene» como respuesta: así se puede hacer obligatoria y la anterior no dice «—».
            options: ["No tiene", "Anterior", "Posterior derecha", "Posterior izquierda"],
          },
          { id: "apinamiento", label: "Apiñamiento", type: "opcion_unica", options: ["No", "Leve", "Moderado", "Severo"] },
        ],
      },
      {
        id: "habitos",
        title: "Hábitos",
        fields: [
          {
            id: "habitos",
            label: "Hábitos",
            type: "opcion_multiple",
            options: ["Ninguno", "Succión digital", "Respiración bucal", "Deglución atípica", "Onicofagia", "Bruxismo"],
          },
          { id: "observaciones", label: "Observaciones", type: "texto_largo" },
        ],
      },
    ],
  },
}

/**
 * Con el peso, para la dosis máxima de anestésico local, que en un niño va por
 * kilo (AAPD, «Use of Local Anesthesia for Pediatric Dental Patients»); con la
 * higiene oral, porque a un menor de 12 solo se le ofrece esta ficha; y con el
 * total del ceod a la vista (revisión final del 15 nov, clínica H5 y D4). Es el
 * texto de partida para las clínicas nuevas: la que ya tiene una clínica no se
 * toca.
 */
// La letra del índice va delante y sin paréntesis: «(c)» se dibuja como «©» con la fuente de la app.
const PEDIATRIC: SuggestedFormTemplate = {
  key: "ficha-de-odontopediatria",
  title: "Ficha de odontopediatría",
  description: "Peso, ceod con su total, higiene oral, riesgo de caries, conducta (Frankl).",
  kind: "odontopediatria",
  schema: {
    sections: [
      {
        id: "peso",
        title: "Peso",
        fields: [{ id: "peso", label: "Peso", type: "numero", unit: "kg", min: 0, max: 100, help: "Para la dosis máxima de anestésico local." }],
      },
      {
        id: "ceod",
        title: "Índice ceod",
        total: "ceod",
        fields: [
          { id: "ceod_c", label: "c, cariados", type: "numero", min: 0, max: 20 },
          { id: "ceod_e", label: "e, con extracción indicada", type: "numero", min: 0, max: 20 },
          { id: "ceod_o", label: "o, obturados", type: "numero", min: 0, max: 20 },
        ],
      },
      {
        // El IHO-S simplificado, por su condición (Greene y Vermillion).
        id: "higiene",
        title: "Higiene oral",
        fields: [
          {
            id: "higiene",
            label: "Higiene oral",
            type: "opcion_unica",
            options: ["Buena", "Regular", "Mala"],
            help: "Por el IHO-S: buena de 0 a 1,2; regular de 1,3 a 3; mala de 3,1 a 6.",
          },
        ],
      },
      {
        id: "riesgo",
        title: "Riesgo y conducta",
        fields: [
          { id: "riesgo_caries", label: "Riesgo de caries", type: "opcion_unica", options: ["Bajo", "Moderado", "Alto"] },
          {
            id: "conducta",
            label: "Conducta (escala de Frankl)",
            type: "opcion_unica",
            options: ["1 · Definitivamente negativa", "2 · Negativa", "3 · Positiva", "4 · Definitivamente positiva"],
          },
          { id: "observaciones", label: "Observaciones", type: "texto_largo" },
        ],
      },
    ],
  },
}

/**
 * La evaluación estomatológica: índice de caries (CPOD de la OMS), higiene oral
 * (IHO-S), riesgo estomatológico y alta básica. El IHO-S se anota ya calculado,
 * con su condición. Se ofrece como las demás, por la especialidad que la
 * clínica le asigna.
 */
const STOMATOLOGIC: SuggestedFormTemplate = {
  key: "ficha-odontoestomatologica",
  title: "Ficha odontoestomatológica",
  description:
    "Índice de caries (CPOD o ceod), higiene oral (IHO-S), riesgo estomatológico y alta básica.",
  kind: "general",
  schema: {
    sections: [
      {
        id: "caries",
        title: "Índice de caries",
        fields: [
          { id: "cpod_c", label: "CPOD · C, cariados", type: "numero", min: 0, max: 32 },
          { id: "cpod_p", label: "CPOD · P, perdidos", type: "numero", min: 0, max: 32 },
          { id: "cpod_o", label: "CPOD · O, obturados", type: "numero", min: 0, max: 32 },
          { id: "ceod_c", label: "ceod · c, cariados", type: "numero", min: 0, max: 20, help: "Dientes de leche." },
          { id: "ceod_e", label: "ceod · e, con extracción indicada", type: "numero", min: 0, max: 20 },
          { id: "ceod_o", label: "ceod · o, obturados", type: "numero", min: 0, max: 20 },
        ],
      },
      {
        id: "higiene",
        title: "Higiene oral",
        fields: [
          {
            id: "ihos",
            label: "Índice de higiene oral simplificado (IHO-S)",
            type: "numero",
            min: 0,
            max: 6,
            help: "En las piezas 16, 11, 26, 36, 31 y 46.",
          },
          { id: "higiene", label: "Higiene oral", type: "opcion_unica", options: ["Buena", "Regular", "Mala"] },
        ],
      },
      {
        id: "riesgo",
        title: "Riesgo y alta",
        fields: [
          { id: "riesgo", label: "Riesgo estomatológico", type: "opcion_unica", options: ["Bajo", "Moderado", "Alto"] },
          { id: "alta_basica", label: "Alta básica odontológica", type: "booleano" },
          {
            id: "alta_basica_fecha",
            label: "Fecha del alta básica",
            type: "fecha",
            showIf: { field: "alta_basica", equals: true },
          },
        ],
      },
    ],
  },
}

export const DENTAL_FORMS: ProductForms = {
  suggestions: [ENDODONTICS, ORTHODONTICS, PEDIATRIC, STOMATOLOGIC],
  diagnoses: AAE_ICD10,
  qualifiers: AAE_QUALIFIERS,
}

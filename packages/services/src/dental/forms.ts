import type { ProductForms, SuggestedFormTemplate } from "../product-hooks.js"

/**
 * Las fichas de consulta con que nace una clínica de odentIA (ADR 0117): lo que
 * el odontólogo anota en la atención además del examen. Cada clínica recibe su
 * copia, ya en uso, y la cambia como cualquier otra; ninguna pregunta traba la
 * atención y solo la pieza de la endodoncia se pide al finalizar su ficha.
 *
 * Son hojas para anotar: no calculan índices (el CPOD y el IHO-S se escriben ya
 * sumados). La clave es la de su título, así una ficha propia de la clínica con
 * ese mismo título no se duplica. Las claves de las preguntas no cambian: con
 * ellas la atención pone la ficha anterior al lado de la de hoy.
 */

/** Las respuestas de una prueba de sensibilidad pulpar (frío o calor). */
const PULP_TEST = ["Sin respuesta", "Normal", "Aumentada, cede al retirar el estímulo", "Aumentada, persiste"]

/** Los términos de diagnóstico de la Asociación Americana de Endodoncistas (AAE, 2009), pulpar y apical por separado. */
const PULPAL_DIAGNOSES = [
  "Pulpa normal",
  "Pulpitis reversible",
  "Pulpitis irreversible sintomática",
  "Pulpitis irreversible asintomática",
  "Necrosis pulpar",
  "Previamente tratado",
  "Tratamiento previamente iniciado",
]
const APICAL_DIAGNOSES = [
  "Tejidos apicales normales",
  "Periodontitis apical sintomática",
  "Periodontitis apical asintomática",
  "Absceso apical agudo",
  "Absceso apical crónico",
  "Osteítis condensante",
]

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

/** Sin peso: ya está en los signos vitales de la atención. */
const PEDIATRIC: SuggestedFormTemplate = {
  key: "ficha-de-odontopediatria",
  title: "Ficha de odontopediatría",
  description: "ceod, riesgo de caries, conducta (Frankl).",
  kind: "odontopediatria",
  schema: {
    sections: [
      {
        id: "ceod",
        title: "Índice ceod",
        fields: [
          { id: "ceod_c", label: "Cariados (c)", type: "numero", min: 0, max: 20 },
          { id: "ceod_e", label: "Con extracción indicada (e)", type: "numero", min: 0, max: 20 },
          { id: "ceod_o", label: "Obturados (o)", type: "numero", min: 0, max: 20 },
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
 * La que pide la norma de historia clínica a todo establecimiento: índice de
 * caries, higiene oral, riesgo estomatológico y alta básica. El IHO-S se anota
 * ya calculado, con su condición.
 */
const STOMATOLOGIC: SuggestedFormTemplate = {
  key: "ficha-odontoestomatologica",
  title: "Ficha odontoestomatológica",
  description:
    "Índice de caries (CPOD o ceod), higiene oral (IHO-S), riesgo estomatológico, alta básica. La pide la norma de historia clínica.",
  kind: "general",
  schema: {
    sections: [
      {
        id: "caries",
        title: "Índice de caries",
        fields: [
          { id: "cpod_c", label: "CPOD · cariados (C)", type: "numero", min: 0, max: 32 },
          { id: "cpod_p", label: "CPOD · perdidos (P)", type: "numero", min: 0, max: 32 },
          { id: "cpod_o", label: "CPOD · obturados (O)", type: "numero", min: 0, max: 32 },
          { id: "ceod_c", label: "ceod · cariados (c)", type: "numero", min: 0, max: 20, help: "Dientes de leche." },
          { id: "ceod_e", label: "ceod · con extracción indicada (e)", type: "numero", min: 0, max: 20 },
          { id: "ceod_o", label: "ceod · obturados (o)", type: "numero", min: 0, max: 20 },
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
  // A un niño se le ofrecen las de odontopediatría aunque su cita no diga de qué es.
  byAge: { underYears: 12, kind: "odontopediatria" },
}

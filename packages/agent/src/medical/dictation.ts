import {
  AGENT_BASE_PRINCIPLES,
  DICTATION_KIND_LABEL,
  type DiagnosisSystemKey,
  type DictationDraft,
  operationAgentSchema,
} from "@odentia/services"
import { z } from "zod"
import {
  allergyAndDonePrompt,
  appointmentAndBudgetPrompt,
  DICTATION_TOOL,
  type DictationExtraction,
  type DictationPending,
  type DictationProfile,
  demoMaterial,
  dictationEdits,
  dictationItems,
  dictationList,
  dictationSaid,
  materialsPrompt,
} from "../dictation.js"

/**
 * Lo que Clío dicta en latidIA (issue 229, entrega 10, decisión 20): el médico
 * dicta mientras atiende y el asistente lo ordena en la consulta, los signos
 * vitales, el examen por sistemas, los diagnósticos, lo indicado, la receta,
 * los controles y el descanso médico. Sin «dónde»: la parte del cuerpo se
 * escribe (decisión 4), así que el diagnóstico y lo indicado no llevan pieza
 * ni caras, y lo indicado no trae otros caminos para elegir (no espera un
 * presupuesto, decisión 15). Lo común está en `../dictation.ts`.
 */
const WORDS = { clinician: "médico" }

const diagnosis = operationAgentSchema("atencion.diagnostico", WORDS).omit({
  toothNumber: true,
  surfaces: true,
})
const done = operationAgentSchema("atencion.procedimiento", WORDS).omit({
  toothNumber: true,
  surfaces: true,
})
const indicated = operationAgentSchema("plan.indicacion", WORDS).omit({
  toothNumber: true,
  surfaces: true,
  alternatives: true,
})

export const extraction = z.object({
  nota: operationAgentSchema("atencion.nota", WORDS)
    .extend({ dicho: dictationSaid })
    .optional()
    .describe("Los textos de la consulta que se dictaron. Omite los que no se dijeron."),
  signos: operationAgentSchema("atencion.signos")
    .extend({ dicho: dictationSaid })
    .optional()
    .describe("Los signos vitales que dijo, en una sola entrada. Omite las medidas que no dijo."),
  examen: dictationList(
    "atencion.examen",
    "Un elemento por cada sistema del examen físico que nombró, de la lista de sistemas.",
  ),
  diagnosticos: dictationItems(diagnosis, "Un elemento por cada diagnóstico que nombró el médico."),
  indicaciones: dictationItems(
    indicated.extend({
      service: indicated.shape.service.describe(
        "La prestación del consultorio tal como la nombró el médico (por ejemplo, «nebulización» o «ecografía abdominal»). El sistema la busca en los servicios de la clínica.",
      ),
    }),
    "Un elemento por cada prestación del consultorio que indicó.",
  ),
  recetas: dictationList("receta.medicamento", "Un elemento por cada medicamento que recetó."),
  controles: dictationList("control.crear", "Un elemento por cada control que pidió."),
  alergias: dictationList("alergia.dictada", "Un elemento por cada alergia del paciente que se dijo, o uno con `none` si no tiene."),
  procedimientos: dictationItems(
    done.extend({
      service: done.shape.service.describe(
        "Lo que hizo hoy, con las palabras del médico (una nebulización, un inyectable, una curación). El sistema lo busca en el plan del paciente y en los servicios de la clínica.",
      ),
      quantity: done.shape.quantity.describe("Cuántas unidades, solo si lo dijo («dos ampollas» = 2)."),
    }),
    "Un elemento por cada cosa que el médico ya hizo hoy en la atención.",
  ),
  citas: dictationList("cita.dictada", "La próxima cita, solo si pidió reservarla (normalmente una sola)."),
  presupuesto: operationAgentSchema("presupuesto.armar")
    .extend({ dicho: dictationSaid })
    .optional()
    .describe("Solo si pidió armar el presupuesto ahora."),
  descanso: operationAgentSchema("descanso.medico")
    .extend({ dicho: dictationSaid })
    .optional()
    .describe("El descanso médico, solo si lo indicó."),
  materiales: dictationList("atencion.material", "Un elemento por cada material que dijo que usó en la atención."),
  ...dictationEdits("temperatura"),
})

/** Cada parte de la respuesta, en el orden en que se guarda: los signos y el descanso, una sola entrada. */
const DRAFT_PARTS = [
  { key: "signos", kind: "signos", single: true },
  { key: "examen", kind: "examen" },
  { key: "diagnosticos", kind: "diagnostico" },
  { key: "indicaciones", kind: "plan" },
  { key: "recetas", kind: "receta" },
  { key: "controles", kind: "control" },
  { key: "alergias", kind: "alergia" },
  { key: "procedimientos", kind: "procedimiento" },
  { key: "citas", kind: "cita" },
  { key: "presupuesto", kind: "presupuesto", single: true },
  { key: "descanso", kind: "descanso", single: true },
  { key: "materiales", kind: "material" },
] as const

export function systemPrompt(input: {
  services: string[]
  diagnosisList: string
  catalog: string
}): string {
  return [
    "Eres el asistente clínico de un consultorio médico. El médico dicta mientras atiende y tú ordenas lo dictado en registros para que él los revise.",
    `Principios que no cambian: ${AGENT_BASE_PRINCIPLES.join(" ")}`,
    "Registra solo lo que el médico dijo. No añadas diagnósticos, medidas, hallazgos ni indicaciones que no nombró, ni completes lo que falta con lo que sería habitual.",
    "En `dicho` va solo la frase de la que sale ese registro, no todo lo dictado: con ella el médico ve qué se usó y qué no.",
    "Si se corrige («temperatura treinta y ocho y medio… no, treinta y ocho cuatro»), vale lo último que dijo. Si pide quitar algo («quita el ibuprofeno»), no lo registres.",
    "Si recibes sugerencias pendientes numeradas y lo nuevo corrige o quita una de ellas, usa `correcciones` o `quitar` con su número en vez de registrarla otra vez. Lo marcado como ya ordenado sirve para entender lo nuevo: no lo registres de nuevo. Pero ya no está pendiente (se confirmó o se descartó): si lo nuevo lo cambia o lo vuelve a indicar con otros datos, es un registro nuevo, no una corrección.",
    "Si el médico nombra una sugerencia por su número («la tercera») y no hay ninguna con ese número, no corrijas ni quites otra: déjala en `correcciones` con ese número para que se le avise.",
    "Los signos vitales van en `signos`, en una sola entrada y en números: la presión «ciento dieciocho con setenta y seis» es 118 de sistólica y 76 de diastólica; la temperatura lleva su decimal («treinta y ocho y medio» = 38.5). Una medida que no dijo no se pone.",
    "El examen físico va en `examen`: un elemento por cada sistema que nombró, con su clave de la lista de sistemas. Si lo dijo normal («pulmones limpios», «abdomen blando, no doloroso») es sin_alteraciones, sin texto; si describió algo anormal es con_hallazgos, con lo que encontró en sus palabras y la parte del cuerpo («amígdalas aumentadas, con placas blanquecinas»). Un sistema que no nombró no se pone: queda como no examinado. Cada hallazgo va en su sistema: si una frase describe dos («amígdalas con placas, adenopatías submandibulares»), son dos elementos (bocaGarganta y cabezaCuello). Una descripción normal también es sin_alteraciones aunque sea larga («ruidos cardiacos rítmicos, sin soplos», «Lasègue negativo»). En una gestante, la altura uterina y los latidos fetales son del abdomen, no del corazón de la paciente. Un hallazgo del examen que no es de ningún sistema de la lista (el dolor a la palpación de la región lumbar) no se pone en el sistema más parecido.",
    `Lista de sistemas (clave, nombre):\n${input.catalog}`,
    "La parte del cuerpo («rodilla derecha», «región lumbar») se escribe con sus palabras en el hallazgo o en la nota del diagnóstico.",
    `En \`diagnosticos\` van los diagnósticos que nombró, con su código de la lista de la clínica, la ${input.diagnosisList}. No uses códigos de otra lista ni los conviertas de una a otra. Si dice «parece», «probable» o «a descartar», es presuntivo (provisional); si lo da por seguro, es definitivo (confirmed). Pon el código más exacto que corresponda; solo si dudas entre varios del mismo grupo, el de la categoría (los tres primeros caracteres), y el médico lo revisa. Un diagnóstico que nombró no se deja fuera por la duda.`,
    "En las indicaciones va lo que hace el consultorio (una consulta, un control, una ecografía, una nebulización, un inyectable): pon en `service` la prestación con las palabras del médico; el sistema la busca en los servicios de la clínica. No inventes precios. Un examen que se hace en otro lugar (un hemograma en un laboratorio) no es una prestación del consultorio: va en las indicaciones de la consulta.",
    "En `recetas` va cada medicamento que receta, con lo que dijo: la DCI, la concentración con su unidad, la forma, la dosis, la frecuencia y la duración. No completes lo que no dijo: el sistema lo pregunta y calcula la cantidad. Lo recetado no se repite en el texto de la consulta. Cambiar un medicamento pendiente («mejor paracetamol en vez del ibuprofeno») o completarlo («la amoxicilina por diez días») es una corrección de ese medicamento, con la DCI y lo que cambie, no uno nuevo.",
    "En `descanso` va el descanso médico, si lo indicó: los días y, si dijo desde cuándo, el primer día. El diagnóstico no va ahí: la persona decide al emitirlo si figura.",
    input.services.length
      ? `Servicios de la clínica, para reconocer de qué prestación habla: ${input.services.slice(0, 200).join("; ")}.`
      : "La clínica aún no tiene servicios.",
    ...allergyAndDonePrompt("médico", "«le hice la nebulización», «ya le puse el inyectable»"),
    ...appointmentAndBudgetPrompt("«agéndale la ecografía para la próxima semana»"),
    materialsPrompt("médico", "«se fueron dos ampollas de suero»", "una nebulización, una curación"),
    "La fecha de hoy llega con lo dictado. Un control «en una semana» o un descanso «desde mañana» se cuentan desde esa fecha.",
    `Responde únicamente llamando a ${DICTATION_TOOL}, una sola vez, con todo lo dictado.`,
  ].join("\n")
}

/* ---------- Modo de demostración: sin proveedor real ---------- */

const NUMBERS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  diez: 10,
  quince: 15,
}

const plain = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
const amount = (spoken: string) =>
  /^\d+$/.test(spoken) ? Number(spoken) : (NUMBERS[spoken] ?? null)
const decimal = (spoken: string) => Number(spoken.replace(",", "."))

/** Qué sistema nombra una frase del examen, por sus palabras. */
const SYSTEM_WORDS: ReadonlyArray<{ key: string; words: RegExp }> = [
  { key: "toraxPulmones", words: /\b(pulmon|pulmones|torax|murmullo)\b/ },
  { key: "bocaGarganta", words: /\b(amigdalas?|garganta|faringe|orofaringe)\b/ },
  { key: "cabezaCuello", words: /\b(cuello|adenopatias?|ganglios?)\b/ },
  { key: "corazon", words: /\b(corazon|ruidos cardiacos|soplo)\b/ },
  { key: "abdomen", words: /\babdomen\b/ },
  { key: "piel", words: /\b(piel|lesiones en la piel)\b/ },
  { key: "extremidades", words: /\b(extremidades|edema)\b/ },
  { key: "neurologico", words: /\b(neurologico|lucido|orientado)\b/ },
]
const NORMAL =
  /\b(normal(es)?|limpios?|sin alteraciones|blando|depresible|no doloroso|ritmicos|lucido|orientado)\b/

/** Diagnósticos de la atención primaria que reconoce la demostración, en la CIE-10 (la de Perú). */
const DEMO_DIAGNOSES: ReadonlyArray<{ words: RegExp; code: string }> = [
  { words: /\bamigdalitis\b/, code: "J03.9" },
  { words: /\bfaringitis\b/, code: "J02.9" },
  { words: /\b(resfrio|rinofaringitis)\b/, code: "J00" },
  { words: /\bhipertension\b/, code: "I10" },
]

/**
 * Extracción por reglas para `LLM_MODEL=fake`: reconoce el motivo, la presión,
 * la temperatura, el pulso y la saturación dichos en cifras, unos sistemas del
 * examen, unos diagnósticos de la CIE-10, los servicios de la clínica por su
 * nombre, un control «en N días, semanas o meses» y un descanso de N días.
 * Sirve para ver el recorrido completo sin proveedor; no acredita cómo entiende
 * un dictado un modelo real.
 */
export function demoExtraction(
  transcript: string,
  services: string[],
  now: Date,
  diagnosisSystem: DiagnosisSystemKey = "ICD-10",
): DictationDraft[] {
  const sentences = transcript
    .split(/(?<=[.;!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
  const drafts: DictationDraft[] = []
  const nota: Record<string, string> = {}
  const noteSource: string[] = []
  const vitals: Record<string, number> = {}
  const vitalSource: string[] = []
  for (const sentence of sentences) {
    const text = plain(sentence)
    // El motivo cuenta lo que siente, no lo que se examinó: esa frase no va al examen.
    const reason =
      !nota["reason"] && /\b(motivo|viene por|refiere|acude por|consulta por)\b/.test(text)
    if (reason) {
      nota["reason"] = sentence
      noteSource.push(sentence)
    }
    const before = Object.keys(vitals).length
    const pressure = /presion (\d{2,3})(?: con | sobre | |\/)(\d{2,3})\b/.exec(text)
    if (pressure?.[1] && pressure[2])
      Object.assign(vitals, {
        presionSistolica: Number(pressure[1]),
        presionDiastolica: Number(pressure[2]),
      })
    const temperature = /temperatura (?:de )?(\d{2}(?:[.,]\d)?)\b/.exec(text)
    if (temperature?.[1]) vitals["temperatura"] = decimal(temperature[1])
    const pulse = /(?:pulso|frecuencia cardiaca) (?:de )?(\d{2,3})\b/.exec(text)
    if (pulse?.[1]) vitals["frecuenciaCardiaca"] = Number(pulse[1])
    const saturation = /satura(?:cion|ndo)? (?:de )?(\d{2,3})\b/.exec(text)
    if (saturation?.[1]) vitals["saturacionOxigeno"] = Number(saturation[1])
    if (Object.keys(vitals).length > before) vitalSource.push(sentence)
    // El examen: cada parte de la frase que nombra un sistema, normal o con lo que dijo.
    for (const part of reason ? [] : sentence.split(/,\s+|\s+y\s+/)) {
      const words = plain(part)
      const system = SYSTEM_WORDS.find((item) => item.words.test(words))
      if (!system || /\bpresion|temperatura|pulso|satura/.test(words)) continue
      if (drafts.some((draft) => draft.kind === "examen" && draft.payload["system"] === system.key))
        continue
      const normal = NORMAL.test(words)
      drafts.push({
        kind: "examen",
        payload: normal
          ? { system: system.key, state: "sin_alteraciones" }
          : { system: system.key, state: "con_hallazgos", finding: part.trim() },
        sourceText: part.trim(),
      })
    }
    // Los códigos de práctica son de la CIE-10: la del MINSA los trae iguales.
    if (diagnosisSystem.startsWith("ICD-10")) {
      for (const diagnosis of DEMO_DIAGNOSES) {
        if (!diagnosis.words.test(text)) continue
        drafts.push({
          kind: "diagnostico",
          payload: {
            diagnosisCode: diagnosis.code,
            diagnosisType: /\b(parece|probable|descartar)\b/.test(text)
              ? "provisional"
              : "confirmed",
          },
          sourceText: sentence,
        })
      }
    }
    // «Usé una mascarilla»: un material de la atención, no una prestación.
    const material = demoMaterial(text)
    if (material) {
      drafts.push({ kind: "material", payload: material, sourceText: sentence })
      continue
    }
    for (const name of services) {
      const key = plain(name)
        .split(" ")
        .filter((word) => word.length >= 4)[0]
      if (!key || !text.includes(key)) continue
      drafts.push({ kind: "plan", payload: { service: name }, sourceText: sentence })
    }
    const control =
      /control en (\d+|un|una|dos|tres|cuatro|cinco|seis) (dias|dia|semanas|semana|meses|mes)\b/.exec(
        text,
      )
    if (control?.[1] && control[2]) {
      const count = amount(control[1]) ?? 1
      const due = new Date(now)
      if (control[2].startsWith("mes")) due.setMonth(due.getMonth() + count)
      else if (control[2].startsWith("semana")) due.setDate(due.getDate() + count * 7)
      else due.setDate(due.getDate() + count)
      drafts.push({
        kind: "control",
        payload: { title: `Control en ${count} ${control[2]}`, dueAt: due.toISOString() },
        sourceText: sentence,
      })
    }
    const rest =
      /descanso (?:medico )?(?:de |por )?(\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|diez|quince) dias?\b/.exec(
        text,
      )
    const days = rest?.[1] ? amount(rest[1]) : null
    if (days) drafts.push({ kind: "descanso", payload: { days }, sourceText: sentence })
  }
  if (Object.keys(vitals).length)
    drafts.unshift({ kind: "signos", payload: vitals, sourceText: vitalSource.join(" ") })
  if (Object.keys(nota).length)
    drafts.unshift({ kind: "nota", payload: nota, sourceText: noteSource.join(" ") })
  return drafts
}

/**
 * Lo mismo que `demoExtraction` cuando el médico sigue dictando: además
 * reconoce «no, la temperatura es 38,4» (corrige la medida de los signos de
 * este tramo o de los pendientes) y «quita el ibuprofeno» (descarta la
 * pendiente que lleva esa palabra).
 */
export function demoSegment(
  transcript: string,
  services: string[],
  now: Date,
  pending: DictationPending[],
  diagnosisSystem: DiagnosisSystemKey = "ICD-10",
): Omit<DictationExtraction, "model"> {
  // Una frase que corrige o quita algo no es, además, un registro nuevo.
  const order = (sentence: string) => /^(no,? |quita)/.test(plain(sentence))
  const kept = transcript
    .split(/(?<=[.;!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter((sentence) => sentence && !order(sentence))
    .join(" ")
  const drafts = demoExtraction(kept, services, now, diagnosisSystem)
  const corrections: DictationExtraction["corrections"] = []
  const removals: DictationExtraction["removals"] = []
  const vitalsLabel = plain(`${DICTATION_KIND_LABEL.signos}:`)
  for (const sentence of transcript
    .split(/(?<=[.;!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    const text = plain(sentence)
    const fix = /^no,? (?:la )?temperatura (?:es )?(?:de )?(\d{2}(?:[.,]\d)?)\b/.exec(text)
    if (fix?.[1]) {
      const value = decimal(fix[1])
      const own = drafts.find((draft) => draft.kind === "signos")
      if (own) own.payload = { ...own.payload, temperatura: value }
      else {
        const index = pending.findIndex((item) => plain(item.label).startsWith(vitalsLabel))
        if (index >= 0)
          corrections.push({ index, changes: { temperatura: value }, sourceText: sentence })
      }
      continue
    }
    const drop = /^quita(?:r)? (?:la |el |los |las )?([a-z]{4,})/.exec(text)
    if (drop?.[1]) {
      const word = drop[1]
      const index = pending.findIndex((item) => plain(item.label).includes(word))
      if (index >= 0) removals.push({ index, sourceText: sentence })
    }
  }
  return { drafts, corrections, removals, omitted: 0, unused: [] }
}

export const MEDICAL_DICTATION_PROFILE: DictationProfile = {
  extraction,
  parts: DRAFT_PARTS,
  toolDescription:
    "Registra, de una sola vez, todo lo que el médico dictó, ordenado por bloques de la atención.",
  systemPrompt,
  // Medido el 2026-10-24 con gpt-6-luna (`eval:dictado-medico`): sin pensar, en una de
  // cada tres o cuatro corridas devolvía vacías listas enteras (el examen, el diagnóstico,
  // la receta) de un dictado que otras veces ordenaba bien; con «low», cuatro corridas de
  // los 13 dictados dieron 3 perfectas y una con un sistema mal puesto, al mismo costo.
  reasoning: "low",
  demoSegment,
}

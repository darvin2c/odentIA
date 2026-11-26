import {
  AGENT_BASE_PRINCIPLES,
  type DiagnosisSystemKey,
  type DictationDraft,
  findingDiagnosisCode,
  operationAgentSchema,
} from "@odentia/services"
import { DENTAL_DICTATION_HEALTH } from "@odentia/services/dental"
import { z } from "zod"
import {
  allergyAndDonePrompt,
  appointmentAndBudgetPrompt,
  consultaPrompt,
  DICTATION_TOOL,
  type DictationExtraction,
  type DictationPending,
  type DictationProfile,
  demoMaterial,
  dictationEdits,
  dictationFormAnswers,
  dictationHealthPart,
  dictationOutOfPlacePart,
  dictationList,
  dictationSaid,
  healthPrompt,
  homeCarePrompt,
  materialsPrompt,
} from "../dictation.js"

/**
 * Lo que Clío dicta en odentIA (ADR 0079): el odontólogo dicta mientras
 * atiende y el asistente lo ordena en la consulta, los hallazgos del
 * odontograma, los diagnósticos, el plan, la receta y los controles. Lo común
 * (los mensajes, la lectura y la llamada) está en `../dictation.ts`.
 */
const HEALTH = dictationHealthPart(DENTAL_DICTATION_HEALTH)

export const extraction = z.object({
  nota: operationAgentSchema("atencion.nota")
    .extend({ dicho: dictationSaid })
    .optional()
    .describe("Los textos de la consulta que se dictaron. Omite los que no se dijeron."),
  // El peso y la presión medidos (mesa del 25 nov, entrega 3): lo que cambia la anestesia o avisa.
  signos: operationAgentSchema("atencion.signos")
    .pick({ peso: true, presionSistolica: true, presionDiastolica: true })
    .extend({ dicho: dictationSaid })
    .optional()
    .describe("El peso medido y la presión que dijo, en una sola entrada. Omite lo que no dijo."),
  odontograma: dictationList("odontograma.hallazgo", "Un elemento por cada hallazgo de una pieza que nombró el odontólogo, de la lista de hallazgos."),
  diagnosticos: dictationList("atencion.diagnostico", "Un elemento por cada diagnóstico que nombró el odontólogo y no es un hallazgo del odontograma."),
  indicaciones: dictationList("plan.indicacion", "Un elemento por cada tratamiento que indicó para el plan."),
  recetas: dictationList("receta.medicamento", "Un elemento por cada medicamento que recetó."),
  controles: dictationList("control.crear", "Un elemento por cada control que pidió."),
  alergias: dictationList("alergia.dictada", "Un elemento por cada alergia del paciente que se dijo, o uno con `none` si no tiene."),
  procedimientos: dictationList("atencion.procedimiento", "Un elemento por cada cosa que el odontólogo ya hizo hoy en la atención."),
  citas: dictationList("cita.dictada", "La próxima cita, solo si pidió reservarla (normalmente una sola)."),
  presupuesto: operationAgentSchema("presupuesto.armar")
    .extend({ dicho: dictationSaid })
    .optional()
    .describe("Solo si pidió armar el presupuesto ahora."),
  materiales: dictationList("atencion.material", "Un elemento por cada material que dijo que usó en la atención."),
  fichas: dictationFormAnswers(),
  salud: HEALTH.part,
  sin_lugar: dictationOutOfPlacePart(),
  ...dictationEdits("toothNumber"),
})

/** Cada bloque de registros de la respuesta, en el orden en que se guardan. */
const DRAFT_PARTS = [
  { key: "signos", kind: "signos", single: true },
  { key: "odontograma", kind: "odontograma" },
  { key: "diagnosticos", kind: "diagnostico" },
  { key: "indicaciones", kind: "plan" },
  { key: "recetas", kind: "receta" },
  { key: "controles", kind: "control" },
  { key: "alergias", kind: "alergia" },
  { key: "procedimientos", kind: "procedimiento" },
  { key: "citas", kind: "cita" },
  { key: "presupuesto", kind: "presupuesto", single: true },
  { key: "materiales", kind: "material" },
  { key: "fichas", kind: "ficha" },
  { key: "salud", kind: "salud", single: true, schema: HEALTH.schema },
] as const

export function systemPrompt(input: { services: string[]; diagnosisList: string; catalog: string }): string {
  return [
    "Eres el asistente clínico de una clínica dental. El odontólogo dicta mientras atiende y tú ordenas lo dictado en registros para que él los revise.",
    `Principios que no cambian: ${AGENT_BASE_PRINCIPLES.join(" ")}`,
    "Registra solo lo que el odontólogo dijo. No añadas diagnósticos, piezas, superficies ni tratamientos que no nombró, ni completes lo que falta con lo que sería habitual.",
    "En `dicho` va solo la frase de la que sale ese registro, no todo lo dictado: con ella el odontólogo ve qué se usó y qué no.",
    "Si se corrige («en la veinticinco… no, es la veintiséis»), vale lo último que dijo. Si pide quitar algo («quita la endodoncia»), no lo registres.",
    "Si recibes sugerencias pendientes numeradas y lo nuevo corrige o quita una de ellas, usa `correcciones` o `quitar` con su número en vez de registrarla otra vez. Lo marcado como ya ordenado sirve para entender lo nuevo: no lo registres de nuevo. Pero ya no está pendiente (se confirmó o se descartó): si lo nuevo lo cambia o lo vuelve a indicar con otros datos, es un registro nuevo, no una corrección.",
    "Quitar se dice de muchas formas, casi nunca con «quita»: «quítale…», «sácale…», «borra…», «…ya no», «…no va», «eso no», «mejor no», «olvida lo de…», «no, el … no». Si señala una pendiente, va en `quitar` con su número, aunque diga además qué hará después («la dejamos en observación», «lo vemos con la radiografía»): eso que comenta no es una indicación para el paciente ni un registro nuevo. Una negación que describe al paciente (que ya no le duele, que no hay sangrado, que no tiene movilidad) no quita ni corrige nada.",
    "Las numeradas con «· ya confirmada» ya entraron a la atención: si pide quitar una, va en `quitar` con su número y el odontólogo lo aprueba. No las corrijas: si cambia algo de una, es un registro nuevo.",
    "Nombrar otra vez una pendiente para confirmarla o quedarse con ella («solo profilaxis», «sí, la resina») no es un registro nuevo: no la repitas.",
    "Si una pendiente dice lo que le falta («falta: la cara», «falta: la pieza») y lo nuevo es ese dato, aunque lo diga suelto («oclusal», «en la veinticinco»), es una corrección de esa pendiente con ese campo. Si varias piden lo mismo, la más reciente.",
    "Si el odontólogo nombra una sugerencia por su número («la tercera») y no hay ninguna con ese número, no corrijas ni quites otra: déjala en `correcciones` con ese número para que se le avise.",
    "Las piezas van en numeración FDI como número (dieciséis = 16, cuarenta y seis = 46).",
    // Mesa del 25 nov (entrega 3): el peso medido se perdía y la anestesia quedaba sin dosis máxima.
    "En `signos` va solo el peso medido y la presión, en una sola entrada y en números: el peso en kg cuando se mide («en la balanza pesa veintitrés», «pesa 23 kilos») y la presión «ciento sesenta y cinco con noventa y cinco» es 165 de sistólica y 95 de diastólica. Un número que nombra una pieza («la treinta y seis») no es un peso ni una presión. Un peso medido va en `signos` aunque parezca raro para su edad («pesa doscientos treinta»): el sistema avisa si no es posible. Los demás signos no se dictan aquí: si se dicen, quedan en la consulta.",
    "Lo que el odontólogo ve en una pieza (una caries, una pieza ausente, una corona, una restauración, una fractura…) es un hallazgo: va en `odontograma` con su código de la lista de hallazgos, no en `diagnosticos`. El sistema le pone el diagnóstico que le corresponde.",
    "Pon la variante o el estado de un hallazgo solo si el odontólogo los dijo («caries en dentina», «corona metalcerámica en buen estado»); si no, déjalos vacíos: el sistema se los pregunta.",
    "Si lo que ve en una pieza no está en la lista de hallazgos (movilidad, giroversión…), no lo cambies por otro parecido: no va en `odontograma`; déjalo en el texto de la consulta.",
    "Un hallazgo es lo que la pieza ya tiene («tiene una endodoncia», «tiene un implante», «el perno está roto»). Lo que hay que hacerle («hay que hacerle endodoncia», «vamos a poner un implante») es una indicación, no un hallazgo, y lo que se hizo hoy («terminé la endodoncia de la 36») tampoco: el sistema lo anota solo al completar el tratamiento.",
    "Una pieza que falta («falta la 36», «no tiene la 46») es el hallazgo de pieza ausente, aunque en la misma frase diga qué se le va a poner. Un perno, una corona o un implante «desadaptado», «roto», «fracturado» o «filtrado» es ese mismo hallazgo en mal estado.",
    `Lista de hallazgos (código, nombre, variantes):\n${input.catalog}`,
    `En \`diagnosticos\` van los diagnósticos que no son un hallazgo de la lista (por ejemplo, gingivitis o pulpitis), con su código de la lista de la clínica, la ${input.diagnosisList}. No uses códigos de otra lista ni los conviertas de una a otra. Pon el código más exacto que corresponda; solo si dudas entre varios del mismo grupo, el de la categoría (los tres primeros caracteres), y el odontólogo lo revisa. Un diagnóstico que nombró no se deja fuera por la duda, ni porque también responda una pregunta de una ficha abierta: va en los dos lugares.`,
    "En las indicaciones, pon en `service` la prestación con las palabras del odontólogo: el sistema la busca en los servicios de la clínica. No inventes precios.",
    // Revisión del 26 nov: «profilaxis con destartraje» salía como dos cobros.
    "Lo que nombra como una sola prestación con lo que la acompaña («profilaxis con destartraje») es una sola, en las indicaciones y en lo que se hizo hoy, con todas sus palabras en `service`: no la partas en dos; el sistema la busca entera en los servicios. Dos dichas con «y» («la profilaxis y el destartraje») son dos.",
    homeCarePrompt("«que use enjuague», «dieta blanda», «hilo dental todas las noches»"),
    // Revisión del 26 nov: la primera dicha salía «recomendada» al paciente sin que nadie la recomendara.
    "Si dice dos o tres tratamientos para lo mismo, para que el paciente elija («una resina, o si no una corona»), es una sola indicación: en `service` la primera que nombró y las demás en `alternatives`, en el orden en que las dijo. Si dijo cuál recomienda («le recomiendo la corona», «lo mejor sería la resina»), esa va en `service`, con `recommended`; si no lo dijo, `recommended` no va: no elijas tú cuál conviene. Si ya eligió una, es una indicación sin alternativas.",
    "En `recetas` va cada medicamento que receta, con lo que dijo: la DCI, la concentración con su unidad, la forma, la dosis, la frecuencia y la duración. No completes lo que no dijo: el sistema lo pregunta y calcula la cantidad. Lo recetado no se repite en el texto de la consulta. Cambiar un medicamento pendiente («mejor paracetamol en vez del ibuprofeno») o completarlo («el naproxeno por cinco días») es una corrección de ese medicamento, con la DCI y lo que cambie, no uno nuevo.",
    input.services.length
      ? `Servicios de la clínica, para reconocer de qué prestación habla: ${input.services.slice(0, 200).join("; ")}.`
      : "La clínica aún no tiene servicios.",
    ...consultaPrompt("«dolor de muela», «control»"),
    ...allergyAndDonePrompt("odontólogo", "«le hice la profilaxis», «terminamos la resina de la 36»"),
    ...healthPrompt({
      topics:
        "sus enfermedades, lo que toma todos los días, si toma un anticoagulante o algo para los huesos, el embarazo y la lactancia, si fuma y, de su boca, si tuvo problemas con la anestesia o sangró mucho tras una extracción, lo del corazón que pide antibiótico antes, el miedo al dentista, si rechina o aprieta los dientes, sus hábitos, su última visita y, de un niño, el biberón, el chupón, los dulces y quién le cepilla",
      notInRelato: "Sus medicinas de siempre, sus enfermedades y lo de la anestesia",
      measured: "`signos` ni en ",
    }),
    ...appointmentAndBudgetPrompt("«agéndale para la endodoncia»"),
    materialsPrompt("odontólogo", "«se fueron cuatro carpules»", "una resina, una profilaxis"),
    "La fecha de hoy llega con lo dictado. Un control «en seis meses» se cuenta desde esa fecha.",
    `Responde únicamente llamando a ${DICTATION_TOOL}, una sola vez, con todo lo dictado.`,
  ].join("\n")
}

/* ---------- Modo de demostración: sin proveedor real ---------- */

const UNITS: Record<string, number> = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8 }
const TENS: Record<string, number> = { diez: 10, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80 }
const TEENS: Record<string, number> = { once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18 }
const SURFACES = ["oclusal", "mesial", "distal", "vestibular", "palatina", "lingual"]

const plain = (text: string) => text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")

/** Pieza FDI nombrada en una frase, en cifras o en palabras («veintiséis», «cuarenta y seis»). */
function toothIn(sentence: string): number | null {
  const text = plain(sentence)
  const digits = /\b([1-8][1-8])\b/.exec(text)
  if (digits) return Number(digits[1])
  for (const [word, value] of Object.entries(TEENS)) if (text.includes(word)) return value
  const joined = /\bveinti(uno|una|dos|tres|cuatro|cinco|seis|siete|ocho)\b/.exec(text)
  if (joined?.[1]) return 20 + (UNITS[joined[1]] ?? 0)
  const spaced = /\b(treinta|cuarenta|cincuenta|sesenta|setenta|ochenta) y (uno|una|dos|tres|cuatro|cinco|seis|siete|ocho)\b/.exec(text)
  if (spaced?.[1] && spaced[2]) return (TENS[spaced[1]] ?? 0) + (UNITS[spaced[2]] ?? 0)
  return null
}

/**
 * Extracción por reglas para `LLM_MODEL=fake`: reconoce prestaciones de la
 * clínica por su nombre, «caries», un control «en N meses» y poco más. Sirve
 * para ver el recorrido completo sin proveedor; no acredita cómo entiende un
 * dictado un modelo real.
 */
export function demoExtraction(
  transcript: string,
  services: string[],
  now: Date,
  diagnosisSystem: DiagnosisSystemKey = "ICD-10",
): DictationDraft[] {
  const sentences = transcript.split(/(?<=[.;!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean)
  const drafts: DictationDraft[] = []
  const nota: Record<string, string> = {}
  const noteSource: string[] = []
  // El peso medido y la presión (mesa del 25 nov, entrega 3), en cifras: «pesa 23 kilos», «presión 165 con 95».
  const vitals: Record<string, number> = {}
  const vitalSource: string[] = []
  for (const sentence of sentences) {
    const text = plain(sentence)
    const before = Object.keys(vitals).length
    const pressure = /presion (\d{2,3})(?: con | sobre | |\/)(\d{2,3})\b/.exec(text)
    if (pressure?.[1] && pressure[2]) Object.assign(vitals, { presionSistolica: Number(pressure[1]), presionDiastolica: Number(pressure[2]) })
    const weight = /\b(?:pesa|peso) (\d{1,3}(?:[.,]\d)?) (?:kilos|kg)\b/.exec(text)
    if (weight?.[1] && !/\bdebe pesar\b/.test(text)) vitals["peso"] = Number(weight[1].replace(",", "."))
    if (Object.keys(vitals).length > before) vitalSource.push(sentence)
  }
  if (Object.keys(vitals).length) drafts.push({ kind: "signos", payload: vitals, sourceText: vitalSource.join(" ") })
  for (const sentence of sentences) {
    const text = plain(sentence)
    if (!nota["reason"] && /\b(motivo|viene por|refiere|acude por|dolor)\b/.test(text)) {
      nota["reason"] = sentence
      noteSource.push(sentence)
    } else if (!nota["evolution"] && /\b(se realizo|se realiza|evolucion|se coloco|tolero)\b/.test(text)) {
      nota["evolution"] = sentence
      noteSource.push(sentence)
    }
    if (/\bcaries\b/.test(text)) {
      const tooth = toothIn(sentence)
      drafts.push({
        kind: "diagnostico",
        payload: {
          diagnosisCode: findingDiagnosisCode(diagnosisSystem, "caries", /dentina/.test(text) ? "dentin" : null) ?? "",
          diagnosisType: "provisional",
          ...(tooth ? { toothNumber: tooth } : {}),
        },
        sourceText: sentence,
      })
    }
    // Una pieza ausente es un hallazgo del odontograma (el modelo real lleva ahí también las caries).
    if (/\b(ausente|falta la|no tiene la)\b/.test(text)) {
      const tooth = toothIn(sentence)
      if (tooth) drafts.push({ kind: "odontograma", payload: { toothNumber: tooth, condition: "missing_tooth" }, sourceText: sentence })
    }
    // «Cítalo en quince días»: la próxima cita, desde ese día. «Arma el presupuesto»: armarlo ahora.
    const booking = /\b(citalo|citala|agendale|que vuelva)\b.*?\ben (\d+|una|dos|tres|cuatro|quince|diez) (dias|semanas?)\b/.exec(text)
    if (booking?.[2] && booking[3]) {
      const count = /^\d+$/.test(booking[2]) ? Number(booking[2]) : ({ una: 1, dos: 2, tres: 3, cuatro: 4, diez: 10, quince: 15 } as Record<string, number>)[booking[2]] ?? 1
      const day = new Date(now.getTime() + count * (booking[3].startsWith("semana") ? 7 : 1) * 86_400_000)
      const what = services.find((name) => text.includes(plain(name).split(" ")[0] ?? "~"))
      drafts.push({ kind: "cita", payload: { date: day.toISOString().slice(0, 10), ...(what ? { service: what } : {}) }, sourceText: sentence })
      continue
    }
    if (/\barma(r)? el presupuesto\b/.test(text)) {
      drafts.push({ kind: "presupuesto", payload: { show: /\b(ensen|muestr)/.test(text) }, sourceText: sentence })
      continue
    }
    // «Es alérgica a la penicilina»; «niega alergias».
    const allergy = /\balergic[oa] a (?:la |el |los |las )?([a-z]+)/.exec(text)
    if (allergy?.[1]) drafts.push({ kind: "alergia", payload: { substance: allergy[1] }, sourceText: sentence })
    else if (/\b(niega alergias|no tiene alergias|sin alergias)\b/.test(text)) drafts.push({ kind: "alergia", payload: { none: true }, sourceText: sentence })
    // «Usé una mascarilla»: un material de la atención.
    const material = demoMaterial(text)
    if (material) drafts.push({ kind: "material", payload: material, sourceText: sentence })
    // Lo contado como hecho («le hice…», «terminé…») es un procedimiento de hoy, no una indicación.
    const done = /\b(le hice|hice|termine|terminamos|le puse)\b/.test(text)
    for (const name of services) {
      const key = plain(name).split(" ").filter((word) => word.length >= 4)[0]
      if (!key || !text.includes(key)) continue
      const tooth = toothIn(sentence)
      const surfaces = SURFACES.filter((surface) => text.includes(surface))
      drafts.push({
        kind: done ? "procedimiento" : "plan",
        payload: { service: name, ...(tooth ? { toothNumber: tooth } : {}), ...(surfaces.length ? { surfaces } : {}) },
        sourceText: sentence,
      })
    }
    const control = /control en (\d+|un|una|dos|tres|cuatro|cinco|seis) (meses|mes|semanas|semana)/.exec(text)
    if (control?.[1] && control[2]) {
      const amount = /^\d+$/.test(control[1]) ? Number(control[1]) : (UNITS[control[1]] ?? (control[1] === "un" ? 1 : 1))
      const due = new Date(now)
      if (control[2].startsWith("mes")) due.setMonth(due.getMonth() + amount)
      else due.setDate(due.getDate() + amount * 7)
      drafts.push({
        kind: "control",
        payload: { title: `Control en ${amount} ${control[2]}`, dueAt: due.toISOString() },
        sourceText: sentence,
      })
    }
  }
  if (Object.keys(nota).length) drafts.unshift({ kind: "nota", payload: nota, sourceText: noteSource.join(" ") })
  return drafts
}

/**
 * Lo mismo que `demoExtraction` cuando el odontólogo sigue dictando: además
 * reconoce «no, es la veintiséis» (cambia la pieza de la última sugerencia) y
 * «quita la endodoncia» (descarta la pendiente que lleva esa palabra).
 */
export function demoSegment(
  transcript: string,
  services: string[],
  now: Date,
  pending: DictationPending[],
  diagnosisSystem: DiagnosisSystemKey = "ICD-10",
): Omit<DictationExtraction, "model" | "heard"> {
  // Una frase que corrige o quita algo no es, además, un registro nuevo («quita la endodoncia»).
  const order = (sentence: string) => /^(no,? es |quita)/.test(plain(sentence))
  const drafts = demoExtraction(transcript, services, now, diagnosisSystem).filter((draft) => !order(draft.sourceText ?? ""))
  const corrections: DictationExtraction["corrections"] = []
  const removals: DictationExtraction["removals"] = []
  for (const sentence of transcript.split(/(?<=[.;!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean)) {
    const text = plain(sentence)
    const fix = /^no,? es (?:en )?la\b/.test(text) ? toothIn(sentence) : null
    if (fix) {
      // Lo último que se dijo: una sugerencia de este mismo tramo o, si no hay, la última pendiente.
      const last = [...drafts].reverse().find((draft) => draft.kind !== "nota" && draft.kind !== "control")
      // Lo ya confirmado no se corrige por voz: solo la última aún pendiente.
      const open = pending.map((item, index) => ({ item, index })).filter(({ item }) => !item.label.endsWith("· ya confirmada")).at(-1)
      if (last) last.payload = { ...last.payload, toothNumber: fix }
      else if (open) corrections.push({ index: open.index, changes: { toothNumber: fix }, sourceText: sentence })
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

export const DENTAL_DICTATION_PROFILE: DictationProfile = {
  extraction,
  parts: DRAFT_PARTS,
  toolDescription: "Registra, de una sola vez, todo lo que el odontólogo dictó, ordenado por bloques de la atención.",
  systemPrompt,
  demoSegment,
}

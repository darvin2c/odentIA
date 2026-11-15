import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import {
  DICTATION_MAX_SUGGESTIONS,
  DICTATION_OPERATION,
  DICTATION_SOURCE_CHARS,
  type DiagnosisSystemKey,
  type DictationDraft,
  type DictationFormQuestion,
  formAnswerWords,
  groundHeard,
  heardVocabularyOf,
  operationAgentSchema,
  pauseBridge,
  withPauseBridge,
} from "@odentia/services"
import { z } from "zod"
import { reportReplyUse } from "./ai-usage.js"
import { cachedPrompt, type LlmSpec, viaResponses } from "./llm.js"

/**
 * Clío, el asistente clínico: convierte lo que el profesional dicta en
 * sugerencias para la atención. No guarda nada ni decide nada: devuelve
 * borradores de registros que el servicio valida y que solo entran a la
 * historia si el profesional los confirma. El esquema de lo que puede llenar
 * sale de la declaración de campos de cada operación de la atención: un campo
 * nuevo ahí aparece aquí solo.
 *
 * Esto es lo común (ADR 0079): los mensajes de cada pausa, la lectura de la
 * respuesta y la llamada al modelo. El prompt, el esquema y el doble de
 * demostración son de cada producto (`DictationProfile`; odentIA:
 * `dental/dictation.ts`), y `extract-dictation.ts` elige el de la clínica.
 *
 * El esquema es lo que se le pide al modelo y es fijo, porque va en la parte
 * que el proveedor guarda en caché. Sus topes son los del servicio (lo que
 * guarda de un tramo y de cada cita) y le sirven de guía: si el modelo se pasa,
 * la pausa no se rechaza entera, porque `readDictation` lee cada parte por
 * separado.
 */
export const dictationSaid = z
  .string()
  .max(DICTATION_SOURCE_CHARS)
  .optional()
  .describe("El fragmento del dictado, tal cual, del que sale este registro.")
/**
 * Corregir y quitar cambian sugerencias que ya estaban: la guía es de 10 por
 * pausa. Con 40, ChatGPT 6 llegó a corregir las 40 pendientes en un
 * odontograma y su salida subió de unos 1 500 a 6 000 tokens (medido el
 * 2026-10-17). Más que esto en una pausa no se aplica (`readDictation`).
 */
const VOICE_EDITS_HINT = 10

/** Una lista de registros de una operación, con la frase de la que sale cada uno. */
export function dictationList(
  operation: Parameters<typeof operationAgentSchema>[0],
  describe: string,
  words?: Parameters<typeof operationAgentSchema>[1],
) {
  return dictationItems(operationAgentSchema(operation, words), describe)
}

/** Lo mismo con el esquema ya armado (latidIA: un diagnóstico sin pieza ni caras). */
export function dictationItems(schema: z.ZodObject, describe: string) {
  return z.array(schema.extend({ dicho: dictationSaid })).max(DICTATION_MAX_SUGGESTIONS).default([]).describe(describe)
}

/**
 * Corregir y quitar sugerencias pendientes, igual en todo producto. Los campos
 * de una corrección son los de la operación de esa sugerencia: el servicio los
 * valida, aquí no se declaran. `example`: un campo del producto para el ejemplo.
 */
export function dictationEdits(example: string) {
  return {
    correcciones: z
      .array(
        z.object({
          sugerencia: z
            .number()
            .int()
            .min(1)
            .describe("El número de la sugerencia pendiente que corrige."),
          cambios: z
            .record(z.string(), z.unknown())
            .describe(
              `Solo los campos que cambian, con los mismos nombres que al registrarla (por ejemplo, ${example}).`,
            ),
          dicho: dictationSaid,
        }),
      )
      .max(VOICE_EDITS_HINT)
      .default([])
      .describe(
        "Correcciones que dijo sobre sugerencias pendientes ya numeradas. Vacío si no corrigió ninguna.",
      ),
    quitar: z
      .array(
        z.object({
          sugerencia: z
            .number()
            .int()
            .min(1)
            .describe("El número de la sugerencia pendiente que pidió quitar."),
          dicho: dictationSaid,
        }),
      )
      .max(VOICE_EDITS_HINT)
      .default([])
      .describe("Sugerencias pendientes que pidió quitar. Vacío si no pidió quitar ninguna."),
  }
}

export const DICTATION_TOOL = "registrar_dictado"

/**
 * Las respuestas a las fichas empezadas, igual en todo producto que dicta
 * (entrega 11). Va siempre en el esquema, que es fijo por la caché; las
 * preguntas y sus reglas llegan en el mensaje de la pausa solo si hay alguna.
 */
export function dictationFormAnswers() {
  return dictationList(
    "ficha.respuesta",
    "Respuestas a las preguntas de las fichas abiertas que se listan con lo dictado, una por pregunta. Vacío si no hay fichas abiertas o lo dictado no responde ninguna.",
  )
}

/**
 * La próxima cita y el presupuesto a pedido (issue 109, paso 2), igual en todo
 * producto. Se distinguen por lo que se pide, no por palabras fijas. `booking`:
 * un ejemplo de pedir la cita, con las palabras del producto.
 */
export function appointmentAndBudgetPrompt(booking: string): string[] {
  return [
    `En \`citas\` va la próxima cita solo si pide reservarla («cítalo en quince días», «que vuelva el jueves a las cuatro», ${booking}): el día en \`date\`, contado desde la fecha de hoy, la hora en \`time\` solo si la dijo, y para qué en \`service\`. Decir cuándo hay que volver a verlo sin pedir reservar («control en seis meses») es un control, no una cita. Si dudas, es un control.`,
    "En `presupuesto` va un pedido de armar el presupuesto ahora («arma el presupuesto», «prepárale el presupuesto para enseñárselo»), con `show` si pidió mostrárselo. Pedir enviarlo no lo envía: es el mismo pedido de armarlo.",
  ]
}

/**
 * Qué va en cada campo de la consulta, igual en los dos productos (mesa del
 * 2026-11-04): sin esto, Clío solo veía una línea por campo y no había regla para
 * el control sin enfermedad ni para el plazo que no es tiempo de enfermedad.
 * `examples`: dos motivos dichos como en el producto («dolor de muela», «control»).
 */
export function consultaPrompt(examples: string): string[] {
  return [
    `En la consulta, el motivo (\`reason\`) es una sola línea con la queja principal o para qué viene, como lo diría el paciente (${examples}): sin el tiempo ni lo examinado.`,
    "El tiempo de enfermedad (`illnessDuration`) es cuánto lleva así, solo si se dijo y tal como se dijo («tres días», «desde el sábado»). Si lo que le pasa empezó con algo que se fecha («un golpe hace dos años», «desde la caída del sábado»), se cuenta desde ahí («hace dos años»). El plazo de un control o de algo por venir («su control de seis meses», «la boda en dos meses») no es tiempo de enfermedad.",
    "El relato (`presentIllness`) cuenta cómo empezó y siguió, qué lo alivia o empeora, qué tomó antes de venir y lo que niega. Lo que se receta ahora va en `recetas`, aunque se diga suelto, nunca en el relato. En un control o una revisión sin molestias no hay tiempo de enfermedad: queda vacío, y lo que se diga del paciente (que no tiene molestias, lo que toma) va en el relato. Si en un control cuenta una molestia nueva («desde hace una semana le molesta»), el tiempo es desde cuándo la tiene.",
    // Prueba con voz del 15 nov (v08): el llanto de fondo y lo que se le dijo a la niña terminaban en el relato.
    "El relato es lo que cuentan el paciente o quien lo acompaña sobre lo que le pasa. No son el motivo ni el relato lo que se le dice, pregunta o pide al paciente o al asistente mientras se lo atiende («tranquila, ya casi terminamos», «abre grande», «¿te duele cuando comes?», «pásame…») ni lo que el paciente dice o llora mientras lo examinan o lo tratan («¡me duele!», «no quiero», «mamá»): una queja suelta entre eso no es de la historia. Lo que responde sobre lo que le pasa sí es del relato, y lo que el profesional encuentra al examinarlo va donde siempre.",
  ]
}

/**
 * Lo que se le indica al paciente para que haga por su cuenta va en las
 * indicaciones de la consulta, no en el plan (prueba con voz del 15 nov, v03:
 * «le indico cera de ortodoncia» quedaba como un tratamiento del plan, con su
 * precio). `examples`: lo que se indica, con las palabras del producto.
 */
export function homeCarePrompt(examples: string): string {
  return `En \`indicaciones\` va solo lo que hará la clínica más adelante: un tratamiento o una prestación. Lo que se le indica al paciente para que haga o use por su cuenta (${examples}), aunque se diga con «le indico», va en las indicaciones de la consulta (\`indications\`), no en \`indicaciones\`.`
}

/**
 * Lo que todo producto ordena igual (issue 109): las alergias que se dicen y lo
 * que se hizo hoy. `clinician`: cómo se nombra a quien dicta; `done`: un ejemplo
 * de lo que se cuenta como hecho, con las palabras del producto.
 */
export function allergyAndDonePrompt(clinician: string, done: string): string[] {
  return [
    "En `alergias` va cada alergia del paciente que se dijo («es alérgica a la penicilina», «el látex le da ronchas»): la sustancia en singular y por su nombre genérico, lo que le pasó si lo dijo y qué tan fuerte fue solo si lo dijo con esas palabras. Si dice que no tiene alergias, o ninguna nueva, va una sola con `none` y sin sustancia. Un medicamento que toma o que se receta no es una alergia.",
    `En \`procedimientos\` va lo que el ${clinician} ya hizo hoy en esta atención, contado como hecho (${done}), con \`service\` en sus palabras: el sistema lo busca en el plan del paciente y en los servicios. Lo que queda por hacer es una indicación, aunque lo diga en la misma frase. Si no queda claro si ya lo hizo, es una indicación. Contarlo en la evolución está bien: además va en \`procedimientos\`.`,
  ]
}

/**
 * El material que se dice usado en la atención (ADR 0106), igual en todo
 * producto. El modelo lo deja con sus palabras; el servicio lo busca en
 * Inventario y lo cuenta como el total de ese producto. `used` y `done`:
 * ejemplos de lo usado y de lo hecho, con las palabras del producto.
 */
export function materialsPrompt(clinician: string, used: string, done: string): string {
  return `En \`materiales\` va cada material o insumo que el ${clinician} dice que usó en esta atención («usé una mascarilla», ${used}), con \`product\` en sus palabras y en singular, y \`quantity\` solo si dijo cuántos: el sistema lo busca en Inventario. Lo que hizo con ellos (${done}) va en \`procedimientos\`, no aquí, y lo que receta no es un material usado.`
}

const DEMO_COUNT: Record<string, number> = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 }

/**
 * Para el doble de demostración: «usé una mascarilla», «usé dos pares de
 * guantes». `text` ya va en minúsculas y sin tildes.
 */
export function demoMaterial(text: string): { product: string; quantity: number } | null {
  const said = /\b(?:use|usamos|gaste|se fueron) (\d+|un|una|uno|dos|tres|cuatro|cinco|seis) (?:pares? de |sobres? de |cajas? de )?([a-z]{3,})/.exec(text)
  if (!said?.[1] || !said[2]) return null
  const quantity = /^\d+$/.test(said[1]) ? Number(said[1]) : (DEMO_COUNT[said[1]] ?? 1)
  return { product: said[2].replace(/s$/, ""), quantity }
}

/**
 * El dictado de un producto: qué le pide al modelo y cómo se ordena sin él.
 * La consulta (`nota`), las correcciones y los «quita» son de todos; cada
 * producto suma sus listas (odentIA: el odontograma, los diagnósticos, el
 * plan, la receta y los controles).
 */
export interface DictationProfile {
  /** El esquema de la herramienta: `nota`, las listas de `parts` y `dictationEdits`. */
  extraction: z.ZodObject
  /**
   * Cada parte de la respuesta y su clase de sugerencia, en el orden en que se
   * guardan. Una parte es una lista; con `single`, una sola entrada (latidIA:
   * los signos vitales, el descanso).
   */
  parts: ReadonlyArray<{ key: string; kind: DictationDraft["kind"]; single?: true }>
  /** Lo que dice la herramienta al modelo. */
  toolDescription: string
  /** Las instrucciones fijas, con lo de la clínica que no cambia en la atención. */
  systemPrompt(input: { services: string[]; diagnosisList: string; catalog: string }): string
  /** Si el modelo piensa antes de ordenar (`createConfiguredChatModel`); sin él, responde de inmediato. */
  reasoning?: "low" | "medium" | "high"
  /** El doble de `LLM_MODEL=fake`: por reglas, para ver el recorrido sin proveedor; no mide nada. */
  demoSegment(
    transcript: string,
    services: string[],
    now: Date,
    pending: DictationPending[],
    diagnosisSystem: DiagnosisSystemKey,
  ): Omit<DictationExtraction, "model" | "heard">
}

/** Lo que se le pregunta al modelo en una pausa del dictado, con lo de la clínica ya leído. */
export interface DictationAsk {
  provider: LlmSpec["provider"]
  services: string[]
  diagnosisList: string
  /** Lo que el producto le da al asistente (odentIA: los hallazgos que se dictan). */
  catalog: string
  zone: { locale: string; timezone: string }
  now: Date
  transcript: string
  /** Lo último ya ordenado de este dictado: ayuda a entender lo nuevo y no se registra otra vez. */
  context: string
  pending: DictationPending[]
  /**
   * Las preguntas vacías de las fichas empezadas en la atención (entrega 11):
   * van en el mensaje de la pausa, con sus reglas, solo si hay alguna. Sin
   * fichas, la pausa es la de siempre.
   */
  forms?: readonly DictationFormQuestion[] | undefined
}

/** Cómo se responde cada tipo de pregunta de una ficha, en una frase corta para el modelo. */
function formQuestionWords(question: DictationFormQuestion): string {
  const range =
    question.min !== null && question.max !== null
      ? `, de ${question.min} a ${question.max}`
      : question.min !== null
        ? `, desde ${question.min}`
        : question.max !== null
          ? `, hasta ${question.max}`
          : ""
  const how =
    question.type === "booleano"
      ? "sí o no"
      : question.type === "opcion_unica"
        ? `una opción: ${(question.options ?? []).join(" | ")}`
        : question.type === "opcion_multiple"
          ? `varias opciones: ${(question.options ?? []).join(" | ")}`
          : question.type === "escala"
            ? `escala de ${question.min ?? 0} a ${question.max ?? 10}`
            : question.type === "pieza"
              ? "pieza dental en numeración FDI"
              : `número${question.unit ? ` en ${question.unit}` : ""}${range}`
  const equals = question.dependsOn?.equals
  const depends = question.dependsOn
    ? ` (solo si «${question.dependsOn.label}» es «${equals === true ? "Sí" : equals === false ? "No" : String(equals)}»)`
    : ""
  const now = question.answered === undefined ? "" : ` · ya dice «${formAnswerWords({ value: question.answered, unit: question.unit })}»`
  return `${question.number}. ${question.label} · ${how}${depends}${now}`
}

/**
 * Lo dictado lo escribe el reconocimiento de voz del navegador, que oye mal los
 * términos de una ficha («over byte» por overbite, «sé o d» por ceod; prueba
 * con voz del 15 nov). El servidor los lee igual por cómo suenan
 * (`asHeard`), si la frase está tal cual en lo dictado.
 */
const HEARD_HINT =
  "Lo dictado viene del reconocimiento de voz del navegador y puede traer mal escritos los términos de estas preguntas: con otra letra que suena igual (b o v; s, c o z; ll o y; sin la h), una sigla con espacios entre sus letras, una palabra en inglés escrita como suena u otra parecida. Léelos por cómo suenan cuando no haya duda de cuál es."

/**
 * Las fichas empezadas con sus preguntas (y lo que ya dicen) y cómo se responden. Va en el
 * mensaje de la pausa y no en las instrucciones fijas: sin ficha empezada el
 * modelo no lee nada nuevo y lo de siempre no cambia.
 */
export function dictationFormsText(forms: readonly DictationFormQuestion[]): string {
  if (!forms.length) return ""
  const byForm = new Map<string, DictationFormQuestion[]>()
  for (const question of forms) byForm.set(question.responseId, [...(byForm.get(question.responseId) ?? []), question])
  return [
    "Fichas abiertas en esta atención. Si lo dictado responde una de estas preguntas, va en `fichas` con su número, la respuesta y en `dicho` la frase que la responde. Si no se dijo, no la respondas: el silencio no es «No», y lo habitual o lo de la vez anterior tampoco cuenta.",
    "- Sí o no: «Sí» si lo afirmó; «No» solo si lo negó en voz alta («no», «sin», «niega»).",
    "- Una opción: una de la lista, tal cual está escrita, la que más se acerque a lo dicho. Si no alcanza para elegir una sola (falta el lado, la división o el grado), respóndela igual: el profesional la elige.",
    "- Número, escala o pieza: el número que dijo, en cifras. No conviertas unidades: si lo dijo en otra unidad, respóndela igual con el número dicho; no se llena y se le avisa al profesional.",
    "- Una pregunta que «ya dice» algo respóndela solo si lo dictado la corrige con otro valor («corrijo, es…»): el profesional decide si la cambia.",
    "- Lo que es de una de estas preguntas va en `fichas` y no en el texto de la consulta, aunque no puedas responderla. Una corrección («perdón», «no, es…», «corrijo») tampoco va en el texto de la consulta. Lo demás que dijo (lo que siente el paciente, desde cuándo, lo que se hizo) sí va en la consulta, como siempre.",
    // Prueba con voz del 15 nov (v07): «necrosis pulpar con absceso apical crónico» llenaba la ficha y no proponía el diagnóstico.
    "- Un diagnóstico que nombró va en `diagnosticos`, con su código, aunque también responda una de estas preguntas: va en los dos.",
    "- Lo dictado suele llegar del micrófono, sin puntuación, y un mismo tramo responde varias preguntas seguidas («sin dolor presenta fístula tumefacción intraoral leve frío sin respuesta» son cuatro): respóndelas todas, cada una con su frase.",
    `- ${HEARD_HINT} En \`dicho\` copia la frase tal como llegó, con la palabra mal escrita: no la corrijas.`,
    "- Lo que se le pregunta o pide al paciente o al asistente («¿te duele cuando comes?», «abre», «pásame…») no va en ninguna parte. Lo que se le dice para calmarlo y lo que el paciente dice o llora en ese momento («me duele», «no quiero», «mamá») no va al motivo ni al relato. Lo que el profesional encuentra al examinarlo («dolor a la percusión») sí va en su pregunta.",
    ...[...byForm.values()].map((questions) => [`${questions[0]?.formTitle ?? "Ficha"}:`, ...questions.map(formQuestionWords)].join("\n")),
  ].join("\n")
}

/**
 * Lo nuevo y, si sigue una frase que la pausa cortó (`pauseBridge`; prueba con
 * voz del 15 nov, v07: «…calor» y después «sin respuesta también»), con el final
 * de lo anterior delante, como un solo texto: así se lee la frase entera y se
 * cita como se dijo, y se comprueba con ese mismo texto (`withPauseBridge`),
 * aquí y en el servidor. Como un aviso aparte, Clío a veces dejaba de leer lo
 * nuevo o volvía a registrar lo de antes (medido el 15 nov).
 */
function newText(context: string, transcript: string): string {
  const bridge = pauseBridge(context, transcript)
  if (!bridge) return `Lo nuevo que dictó:\n«${transcript}»`
  return `Lo nuevo que dictó (empieza con «${bridge}», el final de lo anterior: la pausa cortó ahí la frase):\n«${bridge} ${transcript.trim()}»`
}

/**
 * Los mensajes de una pausa. La parte fija (instrucciones y servicios; las
 * herramientas van antes) es igual en toda la atención y va marcada para la
 * caché del proveedor (`cachedPrompt`; `responses`: el modelo va por
 * /v1/responses, como cuando el perfil razona): la primera pausa la escribe y
 * las siguientes la leen a la décima parte. Lo que cambia en cada pausa (la
 * fecha, lo ya ordenado, lo pendiente y lo nuevo) va después, en el mensaje de
 * la pausa. Con la hora en las instrucciones, cada pausa escribía la caché y
 * no la leía nunca (medido el 2026-10-17, ADR 0012). Con `explicitCache`,
 * por Chat Completions, el proveedor no escribe además lo de cada pausa, que
 * nunca se vuelve a leer; por /v1/responses ese pedido no se envía.
 */
export function dictationMessages(input: DictationAsk, profile: DictationProfile, responses: boolean): BaseMessage[] {
  const fixed = profile.systemPrompt({
    services: input.services,
    diagnosisList: input.diagnosisList,
    catalog: input.catalog,
  })
  const today = new Intl.DateTimeFormat(input.zone.locale, {
    timeZone: input.zone.timezone,
    dateStyle: "full",
  }).format(input.now)
  const context = input.context.trim().slice(-600)
  const human = [
    `Hoy es ${today}, ${input.now.toISOString()} (zona ${input.zone.timezone}).`,
    context ? `Ya ordenado antes en este dictado (no lo registres otra vez):\n«${context}»` : "",
    input.pending.length
      ? `Sugerencias pendientes de este dictado:\n${input.pending.map((item, index) => `${index + 1}. ${item.label}`).join("\n")}`
      : "",
    dictationFormsText(input.forms ?? []),
    newText(context, input.transcript),
  ]
    .filter(Boolean)
    .join("\n\n")
  return [
    new SystemMessage({ content: cachedPrompt(input.provider, fixed, responses) }),
    new HumanMessage({ content: human }),
  ]
}

const loose = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim()

/** Las comillas con que el modelo a veces copia lo dictado: no son lo dicho. */
const QUOTES = /[«»“”"]/gu

/**
 * El fragmento que el modelo dice haber oído solo vale si de verdad está en lo
 * dictado: la pantalla lo muestra como «lo que dijiste» y lo resalta. Lo que no
 * aparece tal cual se descarta, frase por frase; nunca se muestra una cita
 * que el profesional no dijo.
 */
export function groundSource(said: string | undefined, transcript: string): string {
  // La puntuación del final no es lo dicho: el modelo cierra con punto lo que en el dictado seguía con coma.
  const fragment = (said ?? "").trim()
  if (!fragment) return ""
  const bare = (text: string) => text.trim().replace(/[\s.,;:!?…]+$/u, "")
  const heard = loose(transcript)
  const ground = (text: string) => {
    if (!text) return ""
    if (heard.includes(loose(text))) return text
    if (bare(text).length >= 3 && heard.includes(loose(bare(text)))) return bare(text)
    return text
      .split(/(?<=[.;!?])\s+/)
      .map((sentence) => (heard.includes(loose(sentence.trim())) ? sentence.trim() : bare(sentence)))
      .filter((sentence) => sentence.length >= 3 && heard.includes(loose(sentence)))
      .join(" ")
  }
  // Lo dictado le llega al modelo entre comillas (`dictationMessages`) y a veces las copia («Frankl
  // tres»), o marca con «...» que cita un pedazo: sin eso era lo dicho. Medido el 15 nov: 5 de 9
  // respuestas de ficha perdidas eran las comillas.
  return ground(fragment) || ground(fragment.replace(QUOTES, "").replace(/^\s*(?:\.{3}|…)\s*/u, "").trim())
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const blank = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && !value.trim())

/**
 * Lee la respuesta del modelo parte por parte, para que lo que no cabe en el
 * esquema no bote la pausa entera:
 * - «lo que dijiste» se acepta aunque sea largo si de verdad se dijo
 *   (`groundSource`); el servicio guarda sus primeros caracteres;
 * - un registro con un dato que no encaja en su operación llega igual, solo
 *   con los campos de esa operación, y el servicio lo deja por revisar;
 * - lo que no se puede usar se cuenta en `omitted` para avisar al profesional:
 *   un registro sin ningún dato, una corrección o un «quita» con un número que
 *   no está entre las pendientes (no se adivina a cuál se refería) y lo que
 *   pasa de lo que el servicio guarda de un tramo. La frase que lo pidió, si
 *   de verdad se dijo, va en `unused`: la pantalla la muestra tal cual.
 * Corregir y quitar cambian lo que ya estaba, así que se les cree menos: un
 * «quita» sin lo que el profesional dijo para pedirlo no se aplica, y si en una
 * pausa llegan más correcciones o «quita» que los que pide el esquema, no se
 * aplica ninguno. Medido el 2026-10-17: las cuatro veces que llegaron más de
 * 10 «quita» (20, 20, 30 y 40; los 40, en una pausa de charla y sin cita)
 * eran sugerencias que nadie pidió quitar. Lo que no se aplica se queda
 * pendiente, a la vista, y se cuenta.
 * Solo una respuesta que no es un objeto no se puede leer: `null`.
 */
export function readDictation(
  args: unknown,
  transcript: string,
  pendingCount: number,
  parts: DictationProfile["parts"],
  /** Las preguntas de ficha que se le dieron: una respuesta a otra no existe y se avisa. */
  forms: readonly DictationFormQuestion[] = [],
): Omit<DictationExtraction, "model" | "heard"> | null {
  if (!isRecord(args)) return null
  let omitted = 0
  const unused: string[] = []
  const items = (value: unknown): unknown[] => {
    if (blank(value)) return []
    if (Array.isArray(value)) return value
    omitted += 1
    return []
  }
  /**
   * Lo dicho, tal cual está en lo dictado. La de una respuesta de ficha también se
   * encuentra si Clío escribió bien el término que Chrome oyó mal («molar derecha»
   * por «volar derecha»), con los términos de su ficha, como la comprueba el
   * servidor: vale la frase como se dictó (`groundHeard`).
   */
  const quote = (item: Record<string, unknown>, kind?: DictationDraft["kind"]) => {
    const said = typeof item["dicho"] === "string" ? item["dicho"] : undefined
    const grounded = groundSource(said, transcript)
    const question = kind === "ficha" ? forms.find((one) => one.number === item["question"]) : undefined
    if (grounded || !question || !said) return grounded
    return groundHeard(said.replace(QUOTES, ""), transcript, heardVocabularyOf(question))
  }
  /** Algo que no se pudo usar: se cuenta y, si se sabe qué frase lo pidió, se guarda para mostrarla. */
  const skip = (item: unknown) => {
    omitted += 1
    const said = isRecord(item) ? quote(item) : ""
    if (said && !unused.includes(said)) unused.push(said)
  }
  /** Solo los campos de su operación: la cita y lo que el modelo agregue de más no llegan al servicio. */
  const fields = (
    kind: DictationDraft["kind"],
    item: Record<string, unknown>,
  ): Record<string, unknown> => {
    const schema = operationAgentSchema(DICTATION_OPERATION[kind])
    const parsed = schema.safeParse(item)
    if (parsed.success) return parsed.data as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(item).filter(([key, value]) => key in schema.shape && !blank(value)),
    )
  }
  // El modelo a veces escribe el número entre comillas («"3"»): es el mismo número.
  const pendingIndex = (value: unknown): number | null => {
    const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value
    return typeof number === "number" &&
      Number.isInteger(number) &&
      number >= 1 &&
      number <= pendingCount
      ? number - 1
      : null
  }

  const drafts: DictationDraft[] = []
  const nota = args["nota"]
  if (isRecord(nota)) {
    const payload = fields("nota", nota)
    if (Object.values(payload).some((value) => typeof value === "string" && value.trim()))
      drafts.push({ kind: "nota", payload, sourceText: quote(nota) })
    else if (Object.values(payload).some((value) => !blank(value))) skip(nota)
  } else if (!blank(nota)) omitted += 1
  for (const part of parts) {
    const value = args[part.key]
    for (const item of part.single && isRecord(value) ? [value] : items(value)) {
      const payload = isRecord(item) ? fields(part.kind, item) : {}
      // Una respuesta de ficha a una pregunta que no se le dio: no se adivina a cuál se refería.
      const question = payload["question"]
      const unknownQuestion =
        part.kind === "ficha" && !(typeof question === "number" && Number.isInteger(question) && question >= 1 && question <= forms.length)
      if (!isRecord(item) || Object.keys(payload).length === 0 || unknownQuestion) skip(item)
      else drafts.push({ kind: part.kind, payload, sourceText: quote(item, part.kind) })
    }
  }

  const corrections: DictationExtraction["corrections"] = []
  for (const item of items(args["correcciones"])) {
    const index = isRecord(item) ? pendingIndex(item["sugerencia"]) : null
    if (!isRecord(item) || index === null || !isRecord(item["cambios"])) skip(item)
    else corrections.push({ index, changes: item["cambios"], sourceText: quote(item) })
  }
  const removals: DictationExtraction["removals"] = []
  for (const item of items(args["quitar"])) {
    const index = isRecord(item) ? pendingIndex(item["sugerencia"]) : null
    const sourceText = isRecord(item) ? quote(item) : ""
    // Quitar es lo único que descarta: sin lo que dijo para pedirlo, la sugerencia se queda.
    if (index === null || !sourceText) skip(item)
    else removals.push({ index, sourceText })
  }

  const voice = <T extends { sourceText: string }>(list: T[]) => {
    if (list.length <= VOICE_EDITS_HINT) return list
    for (const item of list) skip({ dicho: item.sourceText })
    return []
  }
  const kept = drafts.slice(0, DICTATION_MAX_SUGGESTIONS)
  for (const item of drafts.slice(DICTATION_MAX_SUGGESTIONS)) skip({ dicho: item.sourceText })
  return {
    drafts: kept,
    corrections: voice(corrections),
    removals: voice(removals),
    omitted,
    unused,
  }
}

/** Una sugerencia que sigue sin decidir, como se le nombra al asistente; su posición es su número. */
export interface DictationPending {
  label: string
}

export interface DictationExtraction {
  drafts: DictationDraft[]
  /** Correcciones dichas sobre sugerencias pendientes; `index` es la posición en `pending`. */
  corrections: Array<{ index: number; changes: Record<string, unknown>; sourceText: string }>
  /** Sugerencias pendientes que pidió quitar, por su posición en `pending`. */
  removals: Array<{ index: number; sourceText: string }>
  /** Partes de la respuesta que no se pudieron usar (`readDictation`): se le avisa al profesional. */
  omitted: number
  /** Lo que dijo para pedir lo que no se pudo usar, tal cual está en lo dictado: la pantalla lo muestra. */
  unused: string[]
  model: string
  /** Lo dictado con que se comprobó la pausa (`askDictationModel`): con eso la comprueba también el servidor. */
  heard: string
}

const empty = (value: unknown) =>
  blank(value) ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0)

/**
 * Una clave que llega dos veces no borra lo que ya traía: lo vacío no
 * reemplaza a lo lleno, dos listas se juntan sin repetir elementos iguales y
 * dos objetos se unen campo por campo. Si las dos traen un dato distinto, vale
 * el último, como en `JSON.parse`.
 */
function joinRepeated(before: unknown, after: unknown): unknown {
  if (empty(after)) return before
  if (empty(before)) return after
  if (Array.isArray(before) && Array.isArray(after)) {
    const seen = new Set(before.map((item) => JSON.stringify(item)))
    return [...before, ...after.filter((item) => !seen.has(JSON.stringify(item)))]
  }
  if (isRecord(before) && isRecord(after)) {
    const joined = { ...before }
    for (const [key, value] of Object.entries(after))
      joined[key] = key in joined ? joinRepeated(joined[key], value) : value
    return joined
  }
  return after
}

const JSON_STRING = /"(?:[^"\\]|\\.)*"/y
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const JSON_LITERAL = /true|false|null/y

/**
 * Los argumentos de la herramienta tal como llegaron, con las claves repetidas
 * unidas (`joinRepeated`). gpt-6-luna a veces, al cerrar, vuelve a escribir
 * claves que ya llenó, esta vez vacías (`"examen":[…]` y al final
 * `"examen":[]`), y `JSON.parse`, que usa LangChain, se queda con la última:
 * el dictado perdía bloques enteros (el examen, el diagnóstico, la receta) que
 * el modelo sí había ordenado. Medido el 2026-10-28 con `eval:dictado-medico`:
 * respuesta completa, una sola llamada y la clave dos veces. `repeated`: las
 * claves que llegaron más de una vez. Un texto que no es JSON: null.
 */
export function parseToolArguments(text: string): { value: unknown; repeated: string[] } | null {
  const repeated: string[] = []
  let at = 0
  const space = () => {
    while (at < text.length && /\s/.test(text.charAt(at))) at += 1
  }
  const token = (pattern: RegExp) => {
    pattern.lastIndex = at
    const found = pattern.exec(text)
    if (!found) throw new SyntaxError(`JSON inválido en ${at}`)
    at = pattern.lastIndex
    return found[0]
  }
  const expect = (char: string) => {
    space()
    if (text.charAt(at) !== char) throw new SyntaxError(`Se esperaba «${char}» en ${at}`)
    at += 1
  }
  const value = (): unknown => {
    space()
    const char = text.charAt(at)
    if (char === "{") {
      at += 1
      const object: Record<string, unknown> = {}
      space()
      if (text.charAt(at) === "}") {
        at += 1
        return object
      }
      for (;;) {
        space()
        const key = JSON.parse(token(JSON_STRING)) as string
        expect(":")
        const item = value()
        if (Object.hasOwn(object, key)) {
          repeated.push(key)
          object[key] = joinRepeated(object[key], item)
        } else object[key] = item
        space()
        if (text.charAt(at) === ",") at += 1
        else {
          expect("}")
          return object
        }
      }
    }
    if (char === "[") {
      at += 1
      const list: unknown[] = []
      space()
      if (text.charAt(at) === "]") {
        at += 1
        return list
      }
      for (;;) {
        list.push(value())
        space()
        if (text.charAt(at) === ",") at += 1
        else {
          expect("]")
          return list
        }
      }
    }
    if (char === '"') return JSON.parse(token(JSON_STRING))
    if (char === "-" || /\d/.test(char)) return Number(token(JSON_NUMBER))
    return JSON.parse(token(JSON_LITERAL))
  }
  try {
    const parsed = value()
    space()
    return at === text.length ? { value: parsed, repeated } : null
  } catch {
    return null
  }
}

/** Los argumentos crudos de la llamada al dictado: en /v1/responses, `output`; en chat/completions, `tool_calls`. */
function rawToolArguments(reply: AIMessage, name = DICTATION_TOOL): string | null {
  const output = reply.response_metadata?.["output"]
  const fromOutput = Array.isArray(output)
    ? output.find((item) => isRecord(item) && item["type"] === "function_call" && item["name"] === name)
    : undefined
  if (isRecord(fromOutput) && typeof fromOutput["arguments"] === "string") return fromOutput["arguments"]
  const calls = reply.additional_kwargs?.tool_calls ?? []
  const fromCalls = calls.find((item) => item.function?.name === name)
  return typeof fromCalls?.function?.arguments === "string" ? fromCalls.function.arguments : null
}

type Invocable = { invoke: (messages: BaseMessage[]) => Promise<AIMessage> }

/**
 * Una llamada al modelo con la herramienta que registra lo ordenado (sin
 * `bindTools`, el modelo tal cual), anotada en lo que cuesta, y sus argumentos
 * tal como llegaron, con las claves repetidas unidas (`parseToolArguments`); si
 * no se encuentran, lo que leyó LangChain. `args`: sin la herramienta, nada.
 */
async function callRecorder(
  model: unknown,
  spec: Pick<LlmSpec, "provider" | "modelName">,
  recorder: { name: string },
  messages: BaseMessage[],
): Promise<{ reply: AIMessage; args: unknown; repeated: string[]; raw: string | null }> {
  const bindable = model as { bindTools?: (tools: unknown[]) => Invocable }
  const reply = await (bindable.bindTools ? bindable.bindTools([recorder]) : (model as Invocable)).invoke(messages)
  reportReplyUse(spec.provider, spec.modelName, reply)
  const call =
    reply instanceof AIMessage || "tool_calls" in reply ? (reply as AIMessage).tool_calls?.find((item) => item.name === recorder.name) : undefined
  const raw = call ? rawToolArguments(reply as AIMessage, recorder.name) : null
  const parsed = raw === null ? null : parseToolArguments(raw)
  return { reply, args: call ? (parsed ? parsed.value : call.args) : undefined, repeated: parsed?.repeated ?? [], raw }
}

/** La llamada de la segunda lectura de las fichas. */
const DICTATION_REREAD_TOOL = "registrar_fichas"

/** Cuántas oraciones se leen de nuevo en una pausa, como mucho. */
const REREAD_MAX_SENTENCES = 6

/** Lo que lee Clío en la segunda lectura: corto, solo las oraciones y sus preguntas. */
const REREAD_PROMPT = [
  "Eres Clío, el asistente clínico. Lees de nuevo oraciones de un dictado que nombran una pregunta de una ficha de consulta abierta y todavía no tienen respuesta.",
  HEARD_HINT,
  "Responde en `fichas` la pregunta de cada oración solo si esa oración la responde: su número, la respuesta y, en `dicho`, la parte de la oración que la responde, copiada tal cual, con las palabras como llegaron. Si no la responde, no la incluyas: el silencio no es «No», y lo habitual o lo de la vez anterior tampoco cuenta.",
  "- Sí o no: «Sí» si lo afirmó; «No» solo si lo negó en voz alta («no», «sin», «niega»).",
  "- Una opción: una de la lista, tal cual está escrita.",
  "- Número, escala o pieza: el número que dijo, en cifras, sin convertir unidades.",
].join("\n")

/**
 * La segunda lectura de las fichas (prueba con voz del 15 nov): las oraciones
 * que la red avisaría («Parece de «Percusión»», `formNetMisses`) se leen una vez
 * más, solas, cada una con sus preguntas y un texto corto. Lo que responde
 * vuelve como respuesta de ficha marcada (`reread`): el servidor la comprueba
 * como las demás y, si calza, la deja por revisar; si no, el aviso se queda.
 * Es parte de la misma pausa: se mide y se cobra con ella.
 */
export async function rereadFormSentences(
  model: unknown,
  spec: Pick<LlmSpec, "provider" | "modelName">,
  misses: ReadonlyArray<{ said: string; questions: readonly number[] }>,
  forms: readonly DictationFormQuestion[],
): Promise<DictationDraft[]> {
  const targets = misses
    .slice(0, REREAD_MAX_SENTENCES)
    .map((miss) => ({ said: miss.said, questions: forms.filter((question) => miss.questions.includes(question.number)) }))
    .filter((target) => target.questions.length > 0)
  if (!targets.length) return []
  const human = targets
    .map((target, index) => [`${index + 1}. «${target.said}»`, ...target.questions.map((question) => `   ${question.formTitle}: ${formQuestionWords(question)}`)].join("\n"))
    .join("\n\n")
  const recorder = tool(async () => "registrado", {
    name: DICTATION_REREAD_TOOL,
    description: "Las respuestas de la ficha que dicen estas oraciones.",
    schema: z.object({ fichas: dictationFormAnswers() }),
  })
  const { args } = await callRecorder(model, spec, recorder, [new SystemMessage({ content: REREAD_PROMPT }), new HumanMessage({ content: human })])
  if (args === undefined) return []
  const read = readDictation(args, targets.map((target) => target.said).join("\n"), 0, [{ key: "fichas", kind: "ficha" }], forms)
  // Solo la pregunta de su oración, con la frase dentro de esa oración.
  const own = (draft: DictationDraft) =>
    targets.some((target) => target.questions.some((question) => question.number === draft.payload["question"]) && !!draft.sourceText && loose(target.said).includes(loose(draft.sourceText)))
  return (read?.drafts ?? []).filter(own).map((draft) => ({ ...draft, reread: true }))
}

/**
 * Una llamada al modelo con una pausa del dictado y su lectura parte por
 * parte. La usan el dictado de la atención y su medición (`eval:dictado`),
 * para que se mida lo mismo que corre.
 */
export async function askDictationModel(
  model: unknown,
  spec: Pick<LlmSpec, "provider" | "modelName">,
  ask: DictationAsk,
  profile: DictationProfile,
): Promise<{
  read: Omit<DictationExtraction, "model" | "heard"> | null
  reply: AIMessage
  repeated: string[]
  /** Los argumentos tal como llegaron del modelo: la medición los guarda para ver qué respondió. */
  raw: string | null
  /**
   * Lo dictado con que se comprueba lo que respondió: el tramo, con el final del anterior delante si
   * sigue su frase (`withPauseBridge`). La red y el servidor comprueban con lo mismo.
   */
  heard: string
}> {
  const record = tool(async () => "registrado", {
    name: DICTATION_TOOL,
    description: profile.toolDescription,
    schema: profile.extraction,
  })
  const { reply, args, repeated, raw } = await callRecorder(model, spec, record, dictationMessages(ask, profile, viaResponses(model)))
  const heard = withPauseBridge(ask.context, ask.transcript)
  return {
    read: args === undefined ? null : readDictation(args, heard, ask.pending.length, profile.parts, ask.forms ?? []),
    reply,
    repeated,
    raw,
    heard,
  }
}

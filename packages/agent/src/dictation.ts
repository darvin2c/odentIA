import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import {
  DICTATION_MAX_SUGGESTIONS,
  DICTATION_OPERATION,
  DICTATION_SPEAKERS,
  DICTATION_SOURCE_CHARS,
  type DiagnosisSystemKey,
  dictationHealthSchema,
  dictationSentences,
  type DictationTurnStart,
  type DictationDraft,
  type DictationFormQuestion,
  type DictationTurn,
  formAnswerWords,
  groundHeard,
  heardVocabularyOf,
  operationAgentSchema,
  pauseBridge,
  turnsFromStarts,
  turnsSayTranscript,
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
 * Lo de salud dicho en la conversación (mesa del 20 nov 2026), con lo que pregunta el producto
 * (`ProductDictation.health`): una sola entrada por pausa, con quién lo dijo y su frase. La forma es
 * la de su registro; el servicio la valida y guarda solo eso. Sin `dicho`, lo que lee `readDictation`.
 */
export function dictationHealthPart(own: Parameters<typeof dictationHealthSchema>[0]) {
  const schema = dictationHealthSchema(own)
  return {
    schema,
    part: schema
      .extend({ dicho: dictationSaid })
      .optional()
      .describe("Lo que se dijo de la salud del paciente en la conversación, en una sola entrada. Omítela si no se habló de su salud."),
  }
}

/**
 * Qué va en `salud` y qué no, igual en los dos productos (mesa del 20 nov 2026, voz clínica): solo
 * lo dicho, «no que yo sepa» es no sabe, el silencio no es «No», lo de un familiar no es del
 * paciente y un peso que alguien calcula no es una medida. `topics`: lo que pregunta el producto;
 * `notInRelato`: lo que no va al relato; `measured`: dónde no va un peso dicho (latidIA: los signos).
 */
export function healthPrompt(input: { topics: string; notInRelato: string; measured: string }): string[] {
  return [
    `En \`salud\` va lo que se dice de la salud del paciente en la conversación, lo cuente él o quien lo acompaña: ${input.topics}. Solo lo que se dijo: no lo deduzcas de un medicamento, de un diagnóstico ni de lo habitual. Si se corrige («tomo warfarina… perdón, apixabán»), vale lo último.`,
    "Un «No» va solo si respondió que no a una pregunta de ese tema («¿toma alguna medicina?» — «no, ninguna»). «No que yo sepa», «creo que no», «no sé» o «no me acuerdo» son `unknown` (no sabe), nunca `none`. Lo que no se preguntó ni se dijo no va: el silencio no es «No».",
    "En `declarante` va quién lo dijo: `paciente`, `acompanante` (con `vinculo` si se dijo: «madre») o `no_se_sabe` si no queda claro. Quien acompaña a un niño habla de él: «tiene asma, usa salbutamol» es del niño.",
    "Lo que alguien cuenta de sí mismo cuando no es el paciente, o de un familiar («yo soy diabética», dicho por la madre; «mi papá es diabético»; «su papá es alérgico a la penicilina»), no es del paciente: no va en `salud` ni en `alergias`. Los antecedentes de la familia no se registran aquí.",
    `El peso o la talla que alguien calcula o recuerda («debe pesar 24», «pesaba 22 hace seis meses») no es una medida: no va en ${input.measured}ninguna parte.`,
    `${input.notInRelato} van en \`salud\`, no en el relato; en el relato queda lo que tomó para la molestia de hoy («tomó ibuprofeno y le calmó»).`,
    "La salud pendiente llega con lo que ya dice: lo nuevo va en `salud`, solo lo nuevo, y el sistema lo suma. Si alguien corrige en voz alta lo ya dicho, es una corrección de esa pendiente, con su frase en `dicho` y solo el grupo que cambia.",
  ]
}

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
    // Prueba con voz del 15 nov (c3, v10): «hoy solo hacemos adaptación y profilaxis y los citamos en una semana»
    // dejaba la cita «para» lo de hoy y un presupuesto que nadie pidió.
    `En \`citas\` va la próxima cita solo si pide reservarla («cítalo en quince días», «que vuelva el jueves a las cuatro», ${booking}): el día en \`date\`, contado desde la fecha de hoy, la hora en \`time\` solo si la dijo, y en \`service\` para qué vuelve, solo si lo dijo: lo que se hace hoy no es para qué vuelve. Decir cuándo hay que volver a verlo sin pedir reservar («control en seis meses») es un control, no una cita. Si dudas, es un control.`,
    "En `presupuesto` va un pedido de armar el presupuesto ahora («arma el presupuesto», «prepárale el presupuesto para enseñárselo»), con `show` si pidió mostrárselo. Pedir enviarlo no lo envía: es el mismo pedido de armarlo. Sin ese pedido no va nada: reservar una cita, indicar un tratamiento o contar lo que se hizo no lo piden.",
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
    "El relato (`presentIllness`) cuenta cómo empezó y siguió, qué lo alivia o empeora, qué tomó antes de venir y lo que niega. Lo que se receta ahora va en `recetas`, aunque se diga suelto, nunca en el relato. En un control o una revisión sin molestias no hay tiempo de enfermedad: queda vacío, y lo que se diga del paciente (que no tiene molestias) va en el relato; lo que toma, en `salud`. Si en un control cuenta una molestia nueva («desde hace una semana le molesta»), el tiempo es desde cuándo la tiene.",
    // Prueba con voz del 15 nov (v08): el llanto de fondo y lo que se le dijo a la niña terminaban en el relato.
    "El relato es lo que cuentan el paciente o quien lo acompaña sobre lo que le pasa. No son el motivo ni el relato lo que se le dice, pregunta o pide al paciente o al asistente mientras se lo atiende («tranquila, ya casi terminamos», «abre grande», «¿te duele cuando comes?», «pásame…») ni lo que el paciente dice o llora mientras lo examinan o lo tratan («¡me duele!», «no quiero», «mamá»): una queja suelta entre eso no es de la historia. Lo que responde sobre lo que le pasa sí es del relato, y lo que el profesional encuentra al examinarlo va donde siempre.",
    // Mesa del 20 nov 2026: con la consulta pendiente sin su texto, cada pausa la «corregía» y reemplazaba el relato.
    "La consulta pendiente llega con lo que ya dice. Lo nuevo que se cuenta de la consulta (lo que le pasa, desde cuándo, lo que se hizo) va en `nota`, solo lo nuevo y sin repetir lo que ya dice: el sistema lo suma a esa misma consulta. Si el motivo o el tiempo se dicen distinto, va en `nota` el último. `correcciones` a la consulta es solo para cuando alguien corrige en voz alta lo ya dicho («no, fue hace un mes», «perdón, es del lado izquierdo»), con esa frase en `dicho` y solo los campos que cambian: una pregunta, o lo que no habla de la consulta, no la corrige.",
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
    "En `alergias` va cada alergia del paciente que se dijo («es alérgica a la penicilina», «el látex le da ronchas»): la sustancia en singular y por su nombre genérico, lo que le pasó si lo dijo y qué tan fuerte fue solo si lo dijo con esas palabras. Si responde que no tiene alergias, o ninguna nueva, va una sola con `none` y sin sustancia. «No que yo sepa», «creo que no» o «no sé» no son `none`: van en \`salud\` como que no sabe. Un medicamento que toma o que se receta no es una alergia.",
    // «Hoy hacemos…» también es de hoy (prueba con voz del 15 nov, c3, v10: la profilaxis de «hoy solo hacemos
    // adaptación y profilaxis» quedaba en el plan, en la cita o en ninguna parte).
    `En \`procedimientos\` va lo que el ${clinician} hizo o hace hoy en esta atención, contado como hecho (${done}) o como lo de hoy («hoy hacemos…», «hoy solo…»), uno por prestación y con \`service\` en sus palabras: el sistema lo busca en el plan del paciente y en los servicios. Lo que queda para otro día es una indicación, aunque lo diga en la misma frase. Si no queda claro si es de hoy, es una indicación. Contarlo en la evolución está bien: además va en \`procedimientos\`.`,
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
  parts: ReadonlyArray<{ key: string; kind: DictationDraft["kind"]; single?: true; schema?: z.ZodObject }>
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
 * Cómo se responden las fichas empezadas: igual para toda ficha y toda atención,
 * así que va al final de las instrucciones fijas, en el mensaje de sistema, con
 * su corte de caché (`dictationMessages`). Solo con una ficha empezada: sin ella
 * el modelo no lee nada nuevo y lo de siempre no cambia.
 */
export const DICTATION_FORMS_RULES = [
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
].join("\n")

/**
 * Las preguntas de las fichas empezadas, con lo que ya dicen. Van en el mensaje
 * de la pausa, donde siempre, justo antes de lo nuevo. Sin fichas, nada.
 */
export function dictationFormsText(forms: readonly DictationFormQuestion[]): string {
  const byForm = new Map<string, DictationFormQuestion[]>()
  for (const question of forms) byForm.set(question.responseId, [...(byForm.get(question.responseId) ?? []), question])
  return [...byForm.values()].map((questions) => [`${questions[0]?.formTitle ?? "Ficha"}:`, ...questions.map(formQuestionWords)].join("\n")).join("\n")
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
 *
 * Con una ficha empezada, cómo se responden las fichas (`DICTATION_FORMS_RULES`,
 * igual en toda atención) va al final de las instrucciones, en el mismo mensaje
 * de sistema y antes de su corte: la pausa siguiente, y cualquier atención con
 * ficha, lo leen de la caché. Dentro de la pausa, después de la fecha, se pagaba
 * entero en cada pausa. Las preguntas siguen donde siempre, junto a lo nuevo.
 * Descartado (ADR 0012): las preguntas también antes de la pausa (pulpitis por
 * la necrosis dictada), todo al principio de la pausa (la consulta perdía lo que
 * se hizo) y las reglas como un mensaje del usuario aparte (con el tarifario de
 * una clínica, Clío a veces no respondía ninguna pregunta).
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
  const forms = input.forms ?? []
  const pause = [
    `Hoy es ${today}, ${input.now.toISOString()} (zona ${input.zone.timezone}).`,
    context ? `Ya ordenado antes en este dictado (no lo registres otra vez):\n«${context}»` : "",
    input.pending.length
      ? `Sugerencias pendientes de este dictado:\n${input.pending.map((item, index) => `${index + 1}. ${item.label}`).join("\n")}`
      : "",
    dictationFormsText(forms),
    newText(context, input.transcript),
  ]
    .filter(Boolean)
    .join("\n\n")
  const instructions = forms.length ? `${fixed}\n\n${DICTATION_FORMS_RULES}` : fixed
  return [new SystemMessage({ content: cachedPrompt(input.provider, instructions, responses) }), new HumanMessage({ content: pause })]
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
  const fragment = (said ?? "").trim()
  if (!fragment) return ""
  // Con «...» entre palabras el modelo saltó lo de en medio: los pedazos no se juntan, porque juntos no
  // se dijeron; queda el más largo que está tal cual (medición del 16 nov: «cinco ... con extracción
  // indicada» dejaba lista una «e» de 5, y el cinco era de «cariados»).
  const pieces = groundPieces(fragment, transcript)
  if (pieces) return pieces.reduce((longest, piece) => (piece.length > longest.length ? piece : longest), "")
  // Lo dictado le llega al modelo entre comillas (`dictationMessages`) y a veces las copia («Frankl
  // tres»), o marca con «...» que cita un pedazo: sin eso era lo dicho. Medido el 15 nov: 5 de 9
  // respuestas de ficha perdidas eran las comillas.
  return groundText(fragment, transcript) || groundText(fragment.replace(QUOTES, "").replace(/^\s*(?:\.{3}|…)\s*/u, "").trim(), transcript)
}

/**
 * Los pedazos que el modelo citó separados con «...», los que están tal cual en lo dictado; `null` si
 * citó uno solo. En una respuesta de varias opciones cada opción puede estar en su pedazo: en «hábitos
 * respiración bucal ... y se come las uñas» queda «hábitos respiración bucal» (`groundSource`) y la
 * onicofagia está en el otro (prueba con voz c7, v03). El servidor comprueba cada opción en el suyo.
 */
export function groundPieces(said: string | undefined, transcript: string): string[] | null {
  const pieces = (said ?? "")
    .trim()
    .replace(QUOTES, "")
    .split(/\s*(?:\.{3}|…)\s*/u)
    .filter((piece) => piece.trim())
  return pieces.length > 1 ? pieces.map((piece) => groundText(piece, transcript)).filter(Boolean) : null
}

/** El texto, o lo que de él está tal cual en lo dictado, frase por frase. */
function groundText(text: string, transcript: string): string {
  if (!text) return ""
  // La puntuación del final no es lo dicho: el modelo cierra con punto lo que en el dictado seguía con coma.
  const bare = (part: string) => part.trim().replace(/[\s.,;:!?…]+$/u, "")
  const heard = loose(transcript)
  if (heard.includes(loose(text))) return text
  if (bare(text).length >= 3 && heard.includes(loose(bare(text)))) return bare(text)
  return text
    .split(/(?<=[.;!?])\s+/)
    .map((sentence) => (heard.includes(loose(sentence.trim())) ? sentence.trim() : bare(sentence)))
    .filter((sentence) => sentence.length >= 3 && heard.includes(loose(sentence)))
    .join(" ")
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Lo que cambia son solo campos de una respuesta de ficha (operación `ficha.respuesta`), no los de otra sugerencia. */
function formAnswerOnly(item: unknown): boolean {
  if (!isRecord(item) || !isRecord(item["cambios"])) return false
  const keys = Object.keys(item["cambios"])
  const shape = operationAgentSchema(DICTATION_OPERATION.ficha).shape
  return keys.length > 0 && keys.every((key) => key in shape)
}
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
  /**
   * Solo los campos de su operación (o de su parte, si tiene su propia forma: lo de salud): la cita y
   * lo que el modelo agregue de más no llegan al servicio.
   */
  const fields = (
    kind: DictationDraft["kind"],
    item: Record<string, unknown>,
    own?: z.ZodObject,
  ): Record<string, unknown> => {
    const schema = own ?? operationAgentSchema(DICTATION_OPERATION[kind])
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
      const payload = isRecord(item) ? fields(part.kind, item, part.schema) : {}
      // Una respuesta de ficha a una pregunta que no se le dio: no se adivina a cuál se refería.
      const question = payload["question"]
      const unknownQuestion =
        part.kind === "ficha" && !(typeof question === "number" && Number.isInteger(question) && question >= 1 && question <= forms.length)
      if (!isRecord(item) || Object.keys(payload).length === 0 || unknownQuestion) skip(item)
      else {
        // Una respuesta citada en pedazos los lleva aparte: el servidor decide con cuáles se comprueba.
        const pieces = part.kind === "ficha" && typeof item["dicho"] === "string" ? groundPieces(item["dicho"], transcript) : null
        drafts.push({ kind: part.kind, payload, sourceText: quote(item, part.kind), ...(pieces && pieces.length > 1 ? { pieces } : {}) })
      }
    }
  }

  const corrections: DictationExtraction["corrections"] = []
  for (const item of items(args["correcciones"])) {
    const index = isRecord(item) ? pendingIndex(item["sugerencia"]) : null
    if (isRecord(item) && index !== null && isRecord(item["cambios"])) corrections.push({ index, changes: item["cambios"], sourceText: quote(item) })
    // Con una ficha abierta, Clío a veces repite aquí sus respuestas («cambios» con solo la respuesta, a
    // una pendiente que no existe): no se pidió corregir nada, y lo dictado ya lo comprueba la ficha, que
    // avisa con su motivo lo que no quedó. Mostrarla daba un «4» suelto, sin motivo ni dónde usarlo
    // (prueba con voz c7, v11).
    else if (!(forms.length && formAnswerOnly(item))) skip(item)
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

/* ---------- El repaso al terminar (mesa del 20 nov 2026, «Clío en una consulta conversada», P4) ---------- */

/** Turnos que se piden en un repaso, como mucho: 30 000 caracteres de conversación no tienen más. */
const REVIEW_TURNS = 600

/**
 * Lo que el repaso suma al esquema de la pausa: los turnos de cada tramo y lo clínico que no tiene
 * dónde ir, con su motivo. Lo demás es la misma herramienta, con el mismo nombre: las instrucciones
 * fijas dicen que se responde llamándola.
 */
const REVIEW_PARTS = {
  turnos: z
    .array(
      z.object({
        desde: z.number().int().min(1).describe("El número de la frase donde empieza a hablar, como llega entre corchetes."),
        quien: z.enum(DICTATION_SPEAKERS).describe("Quién habló: `dra` (quien atiende), `paciente`, `acompanante` o `no_se_sabe`."),
        vinculo: z.string().max(80).optional().describe("De quien acompaña, si se dijo o se nota («madre»)."),
      }),
    )
    .max(REVIEW_TURNS)
    .default([])
    .describe("Cada vez que empieza a hablar otra persona en los tramos marcados «partir en turnos»: la frase donde empieza y quién es. Sigue hasta donde empieza el siguiente."),
  sin_lugar: z
    .array(
      z.object({
        dicho: dictationSaid,
        motivo: z
          .enum(["familiar", "peso_dicho", "otro"])
          .describe("`familiar`: de la salud de un familiar; `peso_dicho`: un peso o una talla que alguien calcula o recuerda; `otro`."),
      }),
    )
    .max(DICTATION_MAX_SUGGESTIONS)
    .default([])
    .describe("Lo clínico que se dijo y no tiene dónde ir, con su frase y su motivo. Vacío si no hay."),
}

/** La herramienta del repaso: la de la pausa del producto, con los turnos y lo que no tiene dónde ir. */
export function dictationReviewExtraction(profile: DictationProfile): z.ZodObject {
  return profile.extraction.extend(REVIEW_PARTS)
}

/**
 * Cómo se repasa, igual en todo producto: va al final de las instrucciones fijas, en el mensaje de
 * sistema y antes de su corte, como las reglas de las fichas. La herramienta del repaso no es la de
 * la pausa (lleva los turnos), así que el proveedor no le sirve la caché que dejaron las pausas: la
 * escribe el primer repaso y la leen los siguientes de la clínica mientras dure (ADR 0012).
 */
export const DICTATION_REVIEW_RULES = [
  "Repaso al terminar. Esta vez no llega una pausa: llega toda la conversación de la atención, tramo por tramo, una sola vez, con lo que ya quedó de ella. Las pausas ya ordenaron cada tramo; tú registras solo lo que se les pasó y partes en turnos los tramos que lo piden.",
  "- Lo que ya quedó (pendiente, ya confirmado o descartado) no lo registres otra vez, aunque se diga de nuevo en la conversación. Lo descartado lo decidió una persona: no lo vuelvas a proponer.",
  "- No corrijas ni quites nada: `correcciones` y `quitar` van vacíos. Las órdenes de la conversación («quita…», «no, es la…») ya se aplicaron en su pausa.",
  "- La consulta y la salud pendientes llegan con lo que ya dicen: en `nota` y en `salud` va solo lo que les falta, y el sistema lo suma.",
  "- Cuándo vuelve: «te veo la próxima semana para la otra resina» o «nos vemos en quince días para ver cómo cicatriza» dicen cuándo vuelve y para qué sin pedir reservar: es un control en `controles`, con la fecha contada desde hoy y, en el título, para qué vuelve («Control: la otra resina»). Si pide reservar la cita, es una cita.",
  "- Con fichas abiertas, responde las preguntas que la conversación responde y siguen sin respuesta, cada una con su frase.",
  "- La conversación llega en frases numeradas («[12] ¿Desde cuándo?»). En `turnos` va, en los tramos marcados «partir en turnos», cada vez que empieza a hablar otra persona: `desde`, el número de la frase donde empieza, y quién es. El turno sigue hasta donde empieza el siguiente, también en el tramo que viene; no copies el texto. La primera frase de esos tramos lleva siempre su turno.",
  "- `quien`: `dra` (quien atiende), `paciente`, `acompanante` (con `vinculo` si se dijo o se nota: «madre») o `no_se_sabe`. Quien pregunta, examina o indica es quien atiende; quien cuenta lo que siente, el paciente; quien habla del paciente («le duele», «mi hija no duerme»), quien lo acompaña. Si no queda claro, `no_se_sabe`: no adivines. Si en una frase hablan dos, va con quien la empieza.",
  "- En `sin_lugar` va lo clínico que se dijo y no tiene dónde ir, con su frase en `dicho` y su motivo: lo de la salud de un familiar («mi papá es diabético») con `familiar`; un peso o una talla que alguien calcula o recuerda («debe pesar 24») con `peso_dicho`; lo demás, con `otro`. La charla, lo administrativo y lo que ya quedó no van.",
].join("\n")

/** Un tramo de la conversación, como lo lee el repaso. */
export interface DictationReviewSegment {
  number: number
  saidAt: Date
  transcript: string
  /** Aún no tiene turnos: se piden. */
  needsTurns: boolean
}

/** Lo que se le pregunta al modelo en el repaso, con lo de la clínica ya leído. */
export interface DictationReviewAsk extends Omit<DictationAsk, "transcript" | "context" | "pending"> {
  segments: readonly DictationReviewSegment[]
  /** Lo dicho antes de estos tramos no entra: la conversación pasa de lo que se lee de una vez. */
  earlierLeftOut: boolean
  pending: readonly string[]
  confirmed: readonly string[]
  discarded: readonly string[]
}

/** Lo dictado con que se comprueba lo que devuelve el repaso: los tramos, uno por línea. */
export const reviewHeard = (segments: ReadonlyArray<Pick<DictationReviewSegment, "transcript">>) => segments.map((segment) => segment.transcript).join("\n")

/**
 * Las frases de cada tramo (`dictationSentences`, del servidor), numeradas seguidas desde 1 en toda
 * la conversación: el mensaje las muestra así y `turnsFromStarts` arma los turnos con la misma cuenta.
 */
export function reviewSentences(segments: readonly DictationReviewSegment[]) {
  let number = 0
  return segments.map((segment) => ({
    segment,
    sentences: dictationSentences(segment.transcript).map((text) => {
      number += 1
      return { number, text }
    }),
  }))
}

/** Los mensajes del repaso: las instrucciones de la pausa con las del repaso, y la conversación. */
export function dictationReviewMessages(ask: DictationReviewAsk, profile: DictationProfile, responses: boolean): BaseMessage[] {
  const fixed = profile.systemPrompt({ services: ask.services, diagnosisList: ask.diagnosisList, catalog: ask.catalog })
  const forms = ask.forms ?? []
  const instructions = [fixed, ...(forms.length ? [DICTATION_FORMS_RULES] : []), DICTATION_REVIEW_RULES].join("\n\n")
  const today = new Intl.DateTimeFormat(ask.zone.locale, { timeZone: ask.zone.timezone, dateStyle: "full" }).format(ask.now)
  const hour = (at: Date) => new Intl.DateTimeFormat(ask.zone.locale, { timeZone: ask.zone.timezone, timeStyle: "short" }).format(at)
  const known = [
    ...ask.pending.map((label) => `- ${label} · pendiente`),
    ...ask.confirmed.map((label) => `- ${label} · ya confirmada`),
    ...ask.discarded.map((label) => `- ${label} · descartada: no la vuelvas a proponer`),
  ]
  const human = [
    `Hoy es ${today}, ${ask.now.toISOString()} (zona ${ask.zone.timezone}).`,
    known.length ? `Lo que ya quedó de esta conversación (no lo registres otra vez):\n${known.join("\n")}` : "",
    dictationFormsText(forms),
    ask.earlierLeftOut ? "Lo dicho antes del tramo 1 no se incluye: la conversación es más larga de lo que se lee de una vez, y sus pausas ya lo ordenaron." : "",
    `La conversación, tramo por tramo y en frases numeradas:\n${reviewSentences(ask.segments)
      .map(({ segment, sentences }) =>
        [`Tramo ${segment.number} (${hour(segment.saidAt)})${segment.needsTurns ? " · partir en turnos" : ""}:`, ...sentences.map((sentence) => `[${sentence.number}] ${sentence.text}`)].join("\n"),
      )
      .join("\n\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n")
  return [new SystemMessage({ content: cachedPrompt(ask.provider, instructions, responses) }), new HumanMessage({ content: human })]
}

const SPEAKERS = new Set<string>(DICTATION_SPEAKERS)

/** Lo que devuelve el repaso, ya leído. */
export interface DictationReviewExtraction {
  drafts: DictationDraft[]
  omitted: number
  unused: string[]
  /** Lo clínico que dejó fuera con su motivo, con la frase tal cual se dijo. */
  outOfPlace: Array<{ said: string; why: "familiar" | "peso_dicho" | "otro" }>
  /** Los turnos de cada tramo (por su número), armados con sus frases (`turnsFromStarts`). */
  turns: Array<{ number: number; turns: DictationTurn[] }>
  /** Los tramos cuyos turnos no eran el tramo tal cual: no se usan. */
  turnsRejected: number[]
  model: string
  heard: string
}

/**
 * Lee la respuesta del repaso. Lo que propone se lee como una pausa (`readDictation`), con toda la
 * conversación para comprobar cada frase, pero sin correcciones ni «quita»: las órdenes de la
 * conversación ya se aplicaron en su pausa y aplicarlas otra vez quitaría lo nuevo o lo cambiaría.
 * De los turnos solo llega dónde empieza cada uno y quién habló, de la lista: el texto sale de las
 * frases del tramo, así que nunca es un texto que nadie dijo (ni se paga copiarlo).
 */
export function readDictationReview(
  args: unknown,
  segments: readonly DictationReviewSegment[],
  parts: DictationProfile["parts"],
  forms: readonly DictationFormQuestion[] = [],
): Omit<DictationReviewExtraction, "model" | "heard"> | null {
  if (!isRecord(args)) return null
  const heard = reviewHeard(segments)
  const { correcciones: _corrections, quitar: _removals, turnos, sin_lugar: outside, ...rest } = args
  const read = readDictation(rest, heard, 0, parts, forms)
  if (!read) return null
  // Solo dónde empieza cada turno y quién: el texto lo ponen las frases del tramo (`turnsFromStarts`).
  const starts = (Array.isArray(turnos) ? turnos : []).flatMap((entry): DictationTurnStart[] => {
    if (!isRecord(entry) || typeof entry["desde"] !== "number" || !SPEAKERS.has(String(entry["quien"]))) return []
    const link = entry["vinculo"]
    return [{ desde: entry["desde"], quien: entry["quien"] as DictationTurnStart["quien"], ...(typeof link === "string" && link.trim() ? { vinculo: link } : {}) }]
  })
  const built = turnsFromStarts(segments, starts)
  const assembled = segments.flatMap((segment, index) => {
    const list = built[index]
    return list ? [{ number: segment.number, turns: list }] : []
  })
  // Armados con las frases del tramo, son el tramo tal cual; si alguno no lo fuera, no se usa.
  const turnsRejected = assembled
    .filter((item) => !turnsSayTranscript(item.turns, segments.find((segment) => segment.number === item.number)?.transcript ?? ""))
    .map((item) => item.number)
  const turns = assembled.filter((item) => !turnsRejected.includes(item.number))
  const outOfPlace: DictationReviewExtraction["outOfPlace"] = []
  for (const item of Array.isArray(outside) ? outside : []) {
    if (!isRecord(item)) continue
    const said = groundSource(typeof item["dicho"] === "string" ? item["dicho"] : undefined, heard)
    const why = item["motivo"] === "familiar" || item["motivo"] === "peso_dicho" ? item["motivo"] : "otro"
    if (said && !outOfPlace.some((one) => one.said === said)) outOfPlace.push({ said, why })
  }
  return { drafts: read.drafts, omitted: read.omitted, unused: read.unused, outOfPlace, turns, turnsRejected }
}

/**
 * Una llamada al modelo con el repaso de la conversación, y su lectura. La usan el repaso de la
 * atención y su medición, para que se mida lo mismo que corre. Sin segunda lectura de las fichas:
 * con toda la conversación, la red avisaría otra vez lo que ya avisaron las pausas.
 */
export async function askDictationReview(
  model: unknown,
  spec: Pick<LlmSpec, "provider" | "modelName">,
  ask: DictationReviewAsk,
  profile: DictationProfile,
): Promise<{ read: Omit<DictationReviewExtraction, "model" | "heard"> | null; reply: AIMessage; raw: string | null; heard: string }> {
  const record = tool(async () => "registrado", {
    name: DICTATION_TOOL,
    description: "Registra lo que faltó de la conversación, ordenado por bloques de la atención, y quién habló en cada tramo.",
    schema: dictationReviewExtraction(profile),
  })
  const { reply, args, raw } = await callRecorder(model, spec, record, dictationReviewMessages(ask, profile, viaResponses(model)))
  return { read: args === undefined ? null : readDictationReview(args, ask.segments, profile.parts, ask.forms ?? []), reply, raw, heard: reviewHeard(ask.segments) }
}

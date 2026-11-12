import {
  type AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import {
  SAAS_ACTIVITY_KINDS,
  SAAS_CLIENT_PROFESSIONALS,
  SAAS_CLIENT_TOOLS,
  SAAS_CONTACT_ROLES,
  SAAS_TASK_KINDS,
  type SaasActivityKind,
  type SaasContactRole,
  type SaasTaskKind,
} from "@odentia/db/schema/admin-arm"
import { type KairosDrafter, ServiceError } from "@odentia/services"
import { z } from "zod"
import { reportReplyUse, withAiMeter } from "./ai-usage.js"
import {
  cachedPrompt,
  createConfiguredChatModel,
  type LlmSpec,
  type PlatformLlm,
  resolveLlmSpec,
} from "./llm.js"

/**
 * Kairós, el agente de la administración de Sallca (el ARM): prepara
 * borradores, resúmenes, guiones y el orden de una anotación para que una
 * persona del equipo los revise. Nunca envía ni decide: lo que escribe queda
 * en espera (`kairos_item`) o vuelve a la pantalla. Al proveedor viaja solo
 * lo necesario de la venta (nombre de la clínica, ciudad, producto, nombres
 * de contacto, lo hablado); nunca datos de pacientes, importes de cobros ni
 * adjuntos. Su gasto es de Sallca, sin clínica: cada llamada se mide con
 * `withAiMeter` y se entrega a `onUse` (el worker y las rutas lo guardan con
 * `recordKairosAiUse`).
 */

/** Lo que Kairós sabe de un cliente para escribir: nada de pacientes ni de cobros. */
export interface KairosClientFacts {
  name: string
  product: "dental" | "medical" | "optical"
  city?: string | null
  /** Los valores de la solicitud: «1», «2-3», «4-9», «10+». */
  professionals?: string | null
  /** «nada», «cuaderno_excel», «otro_software». */
  currentTool?: string | null
  /** La etapa calculada (`clientStage`), en código o en palabras. */
  stage: string
}

export interface KairosAnnotation {
  activity: {
    kind: SaasActivityKind
    direction: "salio" | "entro" | null
    outcome: string | null
    body: string
    contactId: string | null
  }
  task: {
    kind: SaasTaskKind
    title: string
    /** Día de Lima, `YYYY-MM-DD`. */
    dueOn: string
    /** Instante ISO, o nulo si no dijo hora. */
    dueAt: string | null
    contactId: string | null
    demoId: string | null
  } | null
  newContacts: { name: string; title: string | null; roles: SaasContactRole[] }[]
  data: { city?: string; professionals?: string; currentTool?: string }
}

export interface KairosWriter {
  /**
   * Quién redacta: «modelo», o «plantilla» (el doble determinista) cuando el
   * modelo no está configurado. Sin el campo, el modelo.
   */
  readonly drafter?: KairosDrafter
  draftMessage(i: {
    client: KairosClientFacts
    contact?: { name: string; title?: string | null }
    channel: "correo" | "whatsapp"
    goal: string
    facts: string[]
    senderName: string
  }): Promise<{ subject?: string; body: string }>
  summarizeClient(i: {
    client: KairosClientFacts
    facts: { text: string; source: string }[]
  }): Promise<{ summary: string; sources: { text: string; source: string }[]; missing: string[] }>
  parseAnnotation(i: {
    text: string
    today: string
    client: KairosClientFacts
    contacts: { id: string; name: string }[]
    demos: { id: string; name: string }[]
  }): Promise<KairosAnnotation>
  presentationScript(i: {
    client: KairosClientFacts
    facts: string[]
    demo?: { name: string } | null
  }): Promise<{ script: string }>
  weeklySummary(i: { figures: { label: string; words: string }[] }): Promise<{ text: string }>
}

/** Lo que gastó una llamada de Kairós (gasto de Sallca). Sin precio del modelo, `costMicros` es null, nunca 0. */
export interface KairosUse {
  purpose: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costMicros: number | null
}

/** Un modelo de chat: el de `createConfiguredChatModel` o el que inyecta una prueba. */
export interface KairosChatModel {
  invoke(messages: BaseMessage[]): Promise<AIMessage>
  bindTools?(
    tools: unknown[],
    options?: Record<string, unknown>,
  ): { invoke(messages: BaseMessage[]): Promise<AIMessage> }
}

export interface KairosWriterDeps {
  platform: PlatformLlm
  /** Las pruebas inyectan su modelo; sin él, el de la plataforma (`AGENT_MODEL`). */
  createModel?: (spec: LlmSpec) => Promise<KairosChatModel>
  onUse: (u: KairosUse) => Promise<void> | void
}

/* ---------- Palabras ---------- */

/**
 * El nombre de cada producto y para quién es. Copia corta de
 * `productWords(...).name` de `@odentia/clinical`, del que este paquete no
 * depende: si cambia el nombre de un producto, se cambia en los dos.
 */
const PRODUCT_LINE: Record<KairosClientFacts["product"], { name: string; forWhom: string }> = {
  dental: { name: "odentIA", forWhom: "clínicas dentales" },
  medical: { name: "latidIA", forWhom: "consultorios médicos" },
  optical: { name: "vistIA", forWhom: "ópticas" },
}

const PROFESSIONALS_WORDS: Record<string, string> = {
  "1": "1 profesional",
  "2-3": "de 2 a 3 profesionales",
  "4-9": "de 4 a 9 profesionales",
  "10+": "10 profesionales o más",
}

const TOOL_WORDS: Record<string, string> = {
  nada: "no usa nada para su agenda",
  cuaderno_excel: "usa cuaderno o Excel",
  otro_software: "usa otro programa",
}

/**
 * Para qué es cada mensaje que prepara la pasada de reglas (`goal` de
 * `KairosDraftRequest`): la indicación para el modelo y lo que escribe el
 * doble. Un `goal` que no está aquí se toma como la indicación misma.
 */
export const KAIROS_GOALS: Record<
  string,
  {
    instruction: string
    subject: (c: KairosClientFacts) => string
    line: (c: KairosClientFacts) => string
    close: string
  }
> = {
  primera_respuesta: {
    instruction:
      "Primera respuesta a quien dejó su solicitud en la web: agradece, confirma que la recibimos y propón una conversación corta para conocer cómo trabaja y mostrarle el producto.",
    subject: (c) => `Tu solicitud de ${PRODUCT_LINE[c.product].name}`,
    line: (c) =>
      `Gracias por dejar tu solicitud para conocer ${PRODUCT_LINE[c.product].name}. La recibimos y nos gustaría saber cómo trabaja ${c.name} para mostrarte lo que te sirve.`,
    close: "¿Qué día te acomoda para conversar unos minutos?",
  },
  recordar_invitacion: {
    instruction:
      "Recuerda que tiene una invitación para abrir su cuenta que vence pronto o ya venció, y ofrece ayuda para entrar.",
    subject: (c) => `Tu invitación a ${PRODUCT_LINE[c.product].name}`,
    line: (c) =>
      `Te escribo porque tu invitación para abrir la cuenta de ${c.name} en ${PRODUCT_LINE[c.product].name} vence pronto.`,
    close: "Si algo no te funciona al entrar, dime y lo vemos juntos.",
  },
  recordar_propuesta: {
    instruction:
      "Recuerda con amabilidad la propuesta que le enviamos, que vence pronto, y ofrece resolver sus dudas. No repitas precios ni condiciones.",
    subject: (c) => `La propuesta para ${c.name}`,
    line: (c) =>
      `Te escribo por la propuesta que te enviamos para ${c.name}: vence pronto y quería saber si te quedó alguna duda.`,
    close: "¿La revisamos juntos?",
  },
  retomar: {
    instruction:
      "Retoma la conversación que quedó para estas fechas, sin presionar, y pregunta si es buen momento.",
    subject: () => "Retomando nuestra conversación",
    line: (c) =>
      `Quedamos en retomar la conversación por estas fechas. ¿Cómo va todo en ${c.name}?`,
    close: "Si es un buen momento, coordinamos una llamada corta.",
  },
  pedir_archivos: {
    instruction:
      "Recuerda que esperamos sus archivos para cargar sus datos y ofrece ayuda. No pidas datos de pacientes en este mensaje: solo recuerda el envío por el medio que ya le indicamos.",
    subject: () => "Los archivos para tu carga",
    line: (c) =>
      `Te escribo para recordarte que esperamos los archivos para cargar los datos de ${c.name} en ${PRODUCT_LINE[c.product].name}.`,
    close: "Si tienes dudas sobre qué enviar, dime y te ayudo.",
  },
  recordar_equipo: {
    instruction:
      "Recuerda que parte de su equipo aún no acepta su invitación a la cuenta y ofrece ayuda.",
    subject: (c) => `Las invitaciones de tu equipo en ${PRODUCT_LINE[c.product].name}`,
    line: (c) =>
      `Te escribo porque parte de tu equipo aún no acepta su invitación a ${PRODUCT_LINE[c.product].name}.`,
    close: "Si alguien no encuentra el correo, dime y lo vemos.",
  },
}

function clientLines(client: KairosClientFacts): string[] {
  const line = PRODUCT_LINE[client.product]
  return [
    `Clínica: ${client.name}`,
    `Producto: ${line.name} (para ${line.forWhom})`,
    client.city ? `Ciudad: ${client.city}` : null,
    client.professionals
      ? `Profesionales: ${PROFESSIONALS_WORDS[client.professionals] ?? client.professionals}`
      : null,
    client.currentTool ? `Hoy: ${TOOL_WORDS[client.currentTool] ?? client.currentTool}` : null,
    `Etapa de la venta: ${client.stage}`,
  ].filter((value): value is string => value !== null)
}

/** Lo que falta saber de un cliente para vender bien: sale de sus datos vacíos, no del modelo. */
function missingOf(client: KairosClientFacts): string[] {
  return [
    client.city ? null : "En qué ciudad está",
    client.professionals ? null : "Cuántos profesionales atienden",
    client.currentTool ? null : "Qué usa hoy para su agenda e historias",
  ].filter((value): value is string => value !== null)
}

/* ---------- Prompts (la parte fija va marcada para la caché) ---------- */

const VOICE = `Eres Kairós, el agente de la administración de Sallca. Sallca hace odentIA (para clínicas dentales), latidIA (para consultorios médicos) y vistIA (para ópticas). Su idea: «Inteligencia que ordena, personas que deciden.» Tú preparas; una persona del equipo revisa, cambia lo que quiera y decide. Nada sale ni se decide solo.

Siempre:
- Español de Perú, trato de tú, cálido, claro y profesional. Frases cortas. Sin emojis.
- Usa solo los hechos que se te dan. No inventes fechas, horarios, precios, descuentos, plazos, funciones, resultados ni promesas.
- Nunca escribas montos ni precios, aunque aparezcan en los hechos.
- Nunca uses ni pidas datos de pacientes.
- Los hechos son notas internas del equipo: úsalos para entender, no los cites tal cual ni digas de dónde los sacaste.`

const DRAFT_SYSTEM = `${VOICE}

Tu tarea ahora: redactar un mensaje que la persona que firma enviará a una clínica que es cliente o posible cliente de Sallca.
- Escríbelo como lo escribiría quien firma, en primera persona, y termina con su nombre en la última línea.
- Termina con un siguiente paso fácil (una pregunta o una conversación corta), sin proponer días ni horas que no estén en los hechos.
- Correo: la primera línea es «Asunto: …» (máximo 80 caracteres), luego una línea en blanco y el cuerpo, de 3 a 6 frases.
- WhatsApp: sin asunto, de 2 a 4 frases, sin formato.
- Responde solo con el mensaje.`

const SUMMARY_SYSTEM = `${VOICE}

Tu tarea ahora: escribir «Lo que hay que saber» de un cliente para quien lo atiende en Sallca, con los hechos numerados que recibes.
- De 2 a 5 frases cortas. Cada frase termina con la referencia de los hechos que la respaldan, entre corchetes: [H2] o [H1][H4]. Una frase sin referencia no vale.
- Después, «Qué falta saber»: de 0 a 3 cosas que convendría preguntar.
- Formato exacto:
RESUMEN
- frase [H1]
FALTA
- cosa que falta`

const SCRIPT_SYSTEM = `${VOICE}

Tu tarea ahora: un guion breve para que la persona del equipo presente el producto a esta clínica.
- Secciones con estos títulos, cada una con 2 a 4 líneas que empiezan con «- »: «Para abrir», «Qué preguntar», «Qué mostrar», «Para cerrar».
- «Qué mostrar» habla de lo que la clínica contó que necesita; si hay demo, di qué mirar en ella, sin inventar funciones.
- «Para cerrar» propone acordar el siguiente paso con una fecha, sin decidirla por ellos.
- Responde solo con el guion.`

const WEEKLY_SYSTEM = `${VOICE}

Tu tarea ahora: el resumen de la semana para Administración, con las cifras que recibes.
- De 3 a 6 frases. Cita las cifras tal como vienen en «Lo que dice»; no calcules, no redondees y no escribas ningún número que no esté ahí.
- Primero lo que avanzó, después lo que pide atención. Sin adjetivos de más.
- Responde solo con el texto.`

const ANNOTATION_SYSTEM = `${VOICE}

Tu tarea ahora: ordenar lo que anotó una persona del equipo sobre un cliente en las piezas de la herramienta «ordenar_anotacion». Llama siempre a la herramienta.
- activity: lo que pasó. kind: llamada, whatsapp, correo, reunion, presentacion (solo si la presentación ya se hizo), propuesta o nota. direction: «salio» si lo hicimos nosotros, «entro» si nos buscó la clínica, null si es una nota. outcome: en qué quedó, en pocas palabras, o null. body: lo anotado, limpio y fiel, sin agregar nada. contactId: el id de la persona de la lista si la nombra, o null.
- task: solo si dijo qué hacer después y cuándo. dueOn es el día (AAAA-MM-DD) contando desde «Hoy»; «el jueves» es el próximo jueves después de hoy. time: «HH:MM» en 24 horas si dijo una hora, si no null. kind: llamar, escribir, presentacion, propuesta, alta, cobro u otro. title: corto, en infinitivo. demoId: el id de la demo de la lista si la nombra, o null. Si no dijo cuándo, task es null.
- newContacts: personas nuevas que nombra y no están en la lista (con su cargo si lo dijo y sus papeles: decide, usa, paga, solo si lo dijo).
- data: solo lo que dijo de la clínica: city, professionals (1, 2-3, 4-9 o 10+), currentTool (nada, cuaderno_excel u otro_software). Lo que no dijo va en null.
- Nunca inventes: lo que no está en la anotación va en null o vacío.`

/* ---------- Esquema de la anotación ---------- */

const ANNOTATION_TOOL = "ordenar_anotacion"
const DAY = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const annotationSchema = z.object({
  activity: z.object({
    kind: z.enum(SAAS_ACTIVITY_KINDS),
    direction: z.enum(["salio", "entro"]).nullable(),
    outcome: z.string().max(500).nullable(),
    body: z.string().min(1).max(5000),
    contactId: z.string().nullable(),
  }),
  task: z
    .object({
      kind: z.enum(SAAS_TASK_KINDS),
      title: z.string().min(1).max(200),
      dueOn: z.string().regex(DAY),
      time: z.string().regex(TIME).nullable(),
      contactId: z.string().nullable(),
      demoId: z.string().nullable(),
    })
    .nullable(),
  newContacts: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        title: z.string().max(120).nullable(),
        roles: z.array(z.enum(SAAS_CONTACT_ROLES)),
      }),
    )
    .max(5),
  data: z.object({
    city: z.string().min(1).max(120).nullable(),
    professionals: z.enum(SAAS_CLIENT_PROFESSIONALS).nullable(),
    currentTool: z.enum(SAAS_CLIENT_TOOLS).nullable(),
  }),
})

type AnnotationRead = z.infer<typeof annotationSchema>

/**
 * La hora que dijo, como instante. Perú no cambia la hora en el año (UTC−5
 * todo el año, como `limaDate` de los servicios): «10:00» de Lima son las
 * 15:00 UTC.
 */
function limaInstant(day: string, time: string): string | null {
  const at = new Date(`${day}T${time}:00-05:00`)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/** De lo que leyó el modelo a la anotación: los ids que no están en las listas no se toman. */
function annotationOf(
  read: AnnotationRead,
  input: { contacts: { id: string }[]; demos: { id: string }[] },
): KairosAnnotation {
  const contactIds = new Set(input.contacts.map((contact) => contact.id))
  const demoIds = new Set(input.demos.map((demo) => demo.id))
  const known = (id: string | null, ids: Set<string>) => (id && ids.has(id) ? id : null)
  const data: KairosAnnotation["data"] = {}
  if (read.data.city?.trim()) data.city = read.data.city.trim()
  if (read.data.professionals) data.professionals = read.data.professionals
  if (read.data.currentTool) data.currentTool = read.data.currentTool
  return {
    activity: {
      kind: read.activity.kind,
      direction: read.activity.kind === "nota" ? null : read.activity.direction,
      outcome: read.activity.outcome?.trim() || null,
      body: read.activity.body.trim(),
      contactId: known(read.activity.contactId, contactIds),
    },
    task: read.task
      ? {
          kind: read.task.kind,
          title: read.task.title.trim(),
          dueOn: read.task.dueOn,
          dueAt: read.task.time ? limaInstant(read.task.dueOn, read.task.time) : null,
          contactId: known(read.task.contactId, contactIds),
          demoId: known(read.task.demoId, demoIds),
        }
      : null,
    newContacts: read.newContacts.map((contact) => ({
      name: contact.name.trim(),
      title: contact.title?.trim() || null,
      roles: [...new Set(contact.roles)],
    })),
    data,
  }
}

/* ---------- Lectura de lo que escribió el modelo ---------- */

function textOf(reply: AIMessage): string {
  const content = reply.content
  if (typeof content === "string") return content.trim()
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && "text" in part
            ? String(part.text)
            : "",
      )
      .join("")
      .trim()
  return ""
}

function unreadable(what: string): ServiceError {
  return new ServiceError(
    "KAIROS_UNREADABLE",
    502,
    `Kairós no pudo ${what}; hazlo tú o vuelve a intentarlo`,
  )
}

/** «Asunto: …» en la primera línea (correo) y el cuerpo. */
export function readDraft(
  text: string,
  channel: "correo" | "whatsapp",
): { subject?: string; body: string } {
  const clean = text.replace(/\r\n/g, "\n").trim()
  const match = /^asunto:\s*(.+)\n+/i.exec(clean)
  const subject = match?.[1]?.trim().slice(0, 200)
  const body = (match ? clean.slice(match[0].length) : clean).trim()
  if (!body) throw unreadable("redactar el mensaje")
  if (body.length > 5000) throw unreadable("redactar un mensaje de largo razonable")
  return channel === "correo" && subject ? { subject, body } : { body }
}

/**
 * «Lo que hay que saber» con su fuente por frase. Una frase sin referencia, o
 * con una que no está entre los hechos, no se toma: Kairós nunca afirma algo
 * que no esté anotado.
 */
export function readSummary(
  text: string,
  facts: { text: string; source: string }[],
): { summary: string; sources: { text: string; source: string }[]; missing: string[] } {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
  const sentences: string[] = []
  const sources: { text: string; source: string }[] = []
  const missing: string[] = []
  let section: "resumen" | "falta" | null = null
  for (const line of lines) {
    if (/^resumen:?$/i.test(line)) section = "resumen"
    else if (/^falta:?$/i.test(line)) section = "falta"
    else if (line.startsWith("-") && section) {
      const item = line.replace(/^-\s*/, "")
      if (section === "falta") {
        if (item && missing.length < 3) missing.push(item.slice(0, 200))
        continue
      }
      const refs = [...item.matchAll(/\[H(\d+)\]/g)].map((found) => Number(found[1]))
      const bare = item.replace(/\s*\[H\d+\]/g, "").trim()
      const sentence = !bare || /[.!?…]$/.test(bare) ? bare : `${bare}.`
      const backed = [...new Set(refs)]
        .map((n) => facts[n - 1])
        .filter((fact): fact is { text: string; source: string } => !!fact)
      if (!sentence || backed.length === 0) continue
      sentences.push(sentence)
      for (const fact of backed) sources.push({ text: sentence, source: fact.source })
    }
  }
  if (sentences.length === 0) throw unreadable("resumir el cliente con sus fuentes")
  return { summary: sentences.join(" "), sources, missing }
}

/** Los números de un texto, para comprobar que el resumen semanal solo cita las cifras que recibió. */
function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((found) => found[0])
}

export function readWeekly(
  text: string,
  figures: { label: string; words: string }[],
): { text: string } {
  const clean = text.trim()
  if (!clean) throw unreadable("escribir el resumen de la semana")
  const allowed = new Set(figures.flatMap((figure) => numbersIn(`${figure.label} ${figure.words}`)))
  const invented = numbersIn(clean).filter((number) => !allowed.has(number))
  if (invented.length > 0)
    throw new ServiceError(
      "KAIROS_UNSUPPORTED_FIGURE",
      502,
      "El resumen de la semana citaba una cifra que no salió del cálculo; no se guardó",
    )
  return { text: clean }
}

/* ---------- El escritor con modelo ---------- */

function factLines(facts: string[]): string {
  return facts.length ? facts.map((fact) => `- ${fact}`).join("\n") : "- (sin hechos anotados)"
}

/**
 * Si Kairós redacta con plantillas porque el modelo no está configurado (sin
 * `LLM_MODEL=fake` ni la clave del proveedor), el aviso para la consola al
 * arrancar; null si tiene modelo o si es el modo de demostración a propósito.
 */
export function kairosModelNotice(platform: PlatformLlm): string | null {
  if (platform.fake || platform.openai?.apiKey) return null
  return "Kairós: el modelo no está configurado (falta LLM_OPENAI_API_KEY); sus borradores, resúmenes y anotaciones salen de plantillas y lo dicen"
}

/**
 * Kairós con el modelo de la plataforma (`AGENT_MODEL`, ADR 0052). Con
 * `LLM_MODEL=fake`, o sin la clave del proveedor, y sin modelo inyectado, el
 * doble determinista (`drafter: "plantilla"`): la pantalla y la pasada siguen
 * y dicen que el borrador es de plantilla, nunca un error. Cada llamada al
 * modelo se mide y se entrega a `onUse` con su propósito (`borrador`,
 * `resumen`, `anotar`, `guion`, `semana`).
 */
export function createKairosWriter(deps: KairosWriterDeps): KairosWriter {
  if (!deps.createModel && (deps.platform.fake || !deps.platform.openai?.apiKey))
    return fakeKairosWriter

  const spec = (): LlmSpec => {
    const resolved = resolveLlmSpec(deps.platform)
    // Un reintento como mucho: lo que prepara Kairós puede esperar a la próxima pasada.
    return { ...resolved, maxRetries: Math.min(resolved.maxRetries, 1) }
  }
  const modelFor = async (resolved: LlmSpec): Promise<KairosChatModel> =>
    deps.createModel
      ? deps.createModel(resolved)
      : ((await createConfiguredChatModel(resolved, {
          temperature: 0,
          explicitCache: true,
        })) as unknown as KairosChatModel)

  const metered = <T>(purpose: string, run: () => Promise<T>): Promise<T> =>
    withAiMeter(run, async (entries) => {
      for (const entry of entries)
        await deps.onUse({
          purpose,
          model: entry.model,
          // Sin uso reportado por el proveedor queda en 0 tokens y costo null: nunca un costo supuesto.
          inputTokens: entry.inputTokens ?? 0,
          outputTokens: entry.outputTokens ?? 0,
          cachedTokens: entry.cachedInputTokens ?? 0,
          costMicros: entry.costMicros,
        })
    })

  const write = (purpose: string, system: string, human: string) =>
    metered(purpose, async () => {
      const resolved = spec()
      const model = await modelFor(resolved)
      const reply = await model.invoke([
        new SystemMessage({ content: cachedPrompt(resolved.provider, system, false) }),
        new HumanMessage({ content: human }),
      ])
      reportReplyUse(resolved.provider, resolved.modelName, reply)
      return textOf(reply)
    })

  return {
    drafter: "modelo",
    async draftMessage(input) {
      const goal = KAIROS_GOALS[input.goal]?.instruction ?? input.goal
      const human = [
        `Canal: ${input.channel === "correo" ? "correo" : "WhatsApp"}`,
        `Para qué: ${goal}`,
        ...clientLines(input.client),
        input.contact
          ? `Le escribes a: ${input.contact.name}${input.contact.title ? ` (${input.contact.title})` : ""}`
          : "Le escribes a: el equipo de la clínica (sin nombre)",
        `Firma: ${input.senderName}`,
        `Hechos:\n${factLines(input.facts)}`,
      ].join("\n")
      return readDraft(await write("borrador", DRAFT_SYSTEM, human), input.channel)
    },

    async summarizeClient(input) {
      const human = [
        ...clientLines(input.client),
        `Hechos:\n${input.facts.map((fact, index) => `[H${index + 1}] ${fact.text}`).join("\n") || "(sin hechos)"}`,
      ].join("\n")
      return readSummary(await write("resumen", SUMMARY_SYSTEM, human), input.facts)
    },

    async presentationScript(input) {
      const human = [
        ...clientLines(input.client),
        input.demo ? `Demo: ${input.demo.name}` : "Demo: ninguna",
        `Hechos:\n${factLines(input.facts)}`,
      ].join("\n")
      const script = await write("guion", SCRIPT_SYSTEM, human)
      if (!script) throw unreadable("preparar el guion")
      return { script: script.slice(0, 5000) }
    },

    async weeklySummary(input) {
      const human = `Cifras (nombre: lo que dice):\n${input.figures.map((figure) => `- ${figure.label}: ${figure.words}`).join("\n")}`
      return readWeekly(await write("semana", WEEKLY_SYSTEM, human), input.figures)
    },

    async parseAnnotation(input) {
      const text = input.text.trim()
      if (!text)
        throw new ServiceError("VALIDATION", 400, "Escribe lo que pasó", {
          text: "Escribe lo que pasó",
        })
      if (!DAY.test(input.today))
        throw new ServiceError("VALIDATION", 400, "El día de hoy no es válido", {
          today: "Usa AAAA-MM-DD",
        })
      return metered("anotar", async () => {
        const resolved = spec()
        const model = await modelFor(resolved)
        if (!model.bindTools) throw unreadable("ordenar la anotación")
        const record = tool(async () => "ordenado", {
          name: ANNOTATION_TOOL,
          description:
            "Las piezas de una anotación del equipo sobre un cliente: lo que pasó, lo que sigue, personas nuevas y datos de la clínica.",
          schema: annotationSchema,
        })
        const human = [
          `Hoy: ${input.today} (${weekdayWords(input.today)})`,
          ...clientLines(input.client),
          `Personas de la clínica (id: nombre):\n${input.contacts.map((contact) => `- ${contact.id}: ${contact.name}`).join("\n") || "- (ninguna)"}`,
          `Demos (id: nombre):\n${input.demos.map((demo) => `- ${demo.id}: ${demo.name}`).join("\n") || "- (ninguna)"}`,
          `Anotación:\n${text}`,
        ].join("\n")
        const reply = await model.bindTools([record], { tool_choice: ANNOTATION_TOOL }).invoke([
          new SystemMessage({
            content: cachedPrompt(resolved.provider, ANNOTATION_SYSTEM, false),
          }),
          new HumanMessage({ content: human }),
        ])
        reportReplyUse(resolved.provider, resolved.modelName, reply)
        const call = reply.tool_calls?.find((item) => item.name === ANNOTATION_TOOL)
        // Nunca se rellena: sin la herramienta, o con piezas que no cumplen el esquema, es un error.
        if (!call) throw unreadable("ordenar la anotación")
        const parsed = annotationSchema.safeParse(call.args)
        if (!parsed.success) throw unreadable("ordenar la anotación")
        return annotationOf(parsed.data, input)
      })
    },
  }
}

/* ---------- El doble determinista (`LLM_MODEL=fake` y pruebas) ---------- */

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const

function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number)
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000
}

function dayOf(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10)
}

function weekdayWords(day: string): string {
  return WEEKDAYS[new Date(dayNumber(day) * 86_400_000).getUTCDay()] ?? ""
}

/** Sin tildes ni mayúsculas, para buscar palabras. */
function plain(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

/** El día que nombra («hoy», «mañana», «el jueves», «la próxima semana»), contando desde hoy; null si no nombra ninguno. */
function dayMentioned(text: string, today: string): string | null {
  // «mañana» como día, no «de la mañana» como hora.
  const t = plain(text).replace(/\bde la manana\b/g, "")
  const base = dayNumber(today)
  if (/\bpasado manana\b/.test(t)) return dayOf(base + 2)
  if (/\bmanana\b/.test(t)) return dayOf(base + 1)
  if (/\bhoy\b/.test(t)) return today
  const names = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"]
  for (const [index, name] of names.entries()) {
    if (new RegExp(`\\b${name}\\b`).test(t)) {
      const current = new Date(base * 86_400_000).getUTCDay()
      const ahead = (index - current + 7) % 7 || 7
      return dayOf(base + ahead)
    }
  }
  if (/\b(la )?(proxima|otra) semana\b/.test(t)) {
    const current = new Date(base * 86_400_000).getUTCDay()
    return dayOf(base + ((1 - current + 7) % 7 || 7))
  }
  return null
}

/**
 * La hora que nombra («a las 10», «a las 3 de la tarde», «a las 16:30»). Sin
 * «de la mañana», de 1 a 7 se toma de la tarde: nadie agenda una
 * presentación a las 3 de la madrugada.
 */
function timeMentioned(text: string): string | null {
  const found =
    /\ba las (\d{1,2})(?::(\d{2}))?\s*(am|pm|de la manana|de la tarde|de la noche)?/.exec(
      plain(text),
    )
  if (!found) return null
  let hour = Number(found[1])
  const minutes = found[2] ?? "00"
  const when = found[3]
  if ((when === "pm" || when === "de la tarde" || when === "de la noche") && hour < 12) hour += 12
  else if (!when && hour >= 1 && hour <= 7) hour += 12
  if (hour > 23 || Number(minutes) > 59) return null
  return `${String(hour).padStart(2, "0")}:${minutes}`
}

function fakeActivityKind(t: string): SaasActivityKind {
  if (/\b(whatsapp|wsp|wasap|whats)\b/.test(t)) return "whatsapp"
  if (/\b(llame|me llamo|nos llamo|llamada|hable por telefono)\b/.test(t)) return "llamada"
  if (/\b(correo|mail|email)\b/.test(t)) return "correo"
  if (/\b(reunion|nos reunimos|visite)\b/.test(t)) return "reunion"
  if (/\b(hice la presentacion|presente|se hizo la presentacion|vio la demo)\b/.test(t))
    return "presentacion"
  if (/\b(envie|mande) la propuesta\b/.test(t)) return "propuesta"
  return "nota"
}

function fakeDirection(t: string, kind: SaasActivityKind): "salio" | "entro" | null {
  if (kind === "nota") return null
  // «no contestó» no es que nos buscó: solo «me/nos llamó, escribió, respondió».
  if (/\b(me|nos) (llamo|escribio|respondio|contesto)\b/.test(t)) return "entro"
  if (/\b(llame|escribi|le escribi|envie|mande|hable|le hable)\b/.test(t)) return "salio"
  return null
}

function fakeTask(text: string, today: string, done: SaasActivityKind): KairosAnnotation["task"] {
  const t = plain(text)
  const dueOn = dayMentioned(text, today)
  if (!dueOn) return null
  const time = timeMentioned(text)
  // Una presentación que ya se hizo es la actividad, no lo que sigue.
  const [kind, title]: [SaasTaskKind, string] =
    done !== "presentacion" && /\b(presentacion|demo)\b/.test(t)
      ? ["presentacion", "Presentación"]
      : /\b(enviar|mandar)(le)? la propuesta\b/.test(t)
        ? ["propuesta", "Enviar la propuesta"]
        : /\b(escribir|escribirle)\b/.test(t)
          ? ["escribir", "Escribirle"]
          : /\b(llamar|llamarla|llamarlo|llamarle|volver a llamar|lo llamo|la llamo)\b/.test(t)
            ? ["llamar", "Volver a llamar"]
            : ["llamar", "Volver a contactar"]
  return {
    kind,
    title,
    dueOn,
    dueAt: time ? limaInstant(dueOn, time) : null,
    contactId: null,
    demoId: null,
  }
}

function bucketOf(count: number): string | undefined {
  if (!Number.isFinite(count) || count < 1) return undefined
  if (count === 1) return "1"
  if (count <= 3) return "2-3"
  if (count <= 9) return "4-9"
  return "10+"
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

function fakeAnnotation(input: Parameters<KairosWriter["parseAnnotation"]>[0]): KairosAnnotation {
  const text = input.text.trim()
  if (!text)
    throw new ServiceError("VALIDATION", 400, "Escribe lo que pasó", {
      text: "Escribe lo que pasó",
    })
  const t = plain(text)
  const kind = fakeActivityKind(t)
  const named = <T extends { id: string; name: string }>(list: T[]) =>
    list.find((item) => {
      const first = plain(firstName(item.name))
      return (
        first.length > 1 &&
        new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)
      )
    })?.id ?? null
  const contactId = named(input.contacts)
  const demoId = named(input.demos)
  const task = fakeTask(text, input.today, kind)
  if (task) {
    task.contactId = contactId
    task.demoId = demoId
  }
  const newContacts: KairosAnnotation["newContacts"] = []
  const partner =
    /\b[Ss]u\s+(socio|socia)\b(?:,?\s+(?:el |la )?(?:dr\.?\s+|dra\.?\s+|doctor\s+|doctora\s+)?(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)?))?/u.exec(
      text,
    )
  if (partner) {
    const title = partner[1] === "socia" ? "Socia" : "Socio"
    const name = partner[2] ?? `Su ${partner[1]}`
    const known = input.contacts.some((contact) => plain(contact.name) === plain(name))
    if (!known) newContacts.push({ name, title, roles: ["decide"] })
  }
  const data: KairosAnnotation["data"] = {}
  const people =
    /(\d+)\s+(profesionales|doctores|doctoras|odontologos|odontologas|dentistas|medicos|medicas|optometras)\b/.exec(
      t,
    )
  const bucket = people ? bucketOf(Number(people[1])) : undefined
  if (bucket) data.professionals = bucket
  if (/\b(excel|cuaderno)\b/.test(t)) data.currentTool = "cuaderno_excel"
  else if (/\bno usan? nada\b|\bsin sistema\b/.test(t)) data.currentTool = "nada"
  else if (/\b(software|sistema|programa)\b/.test(t)) data.currentTool = "otro_software"
  const city = /\b(?:esta|estan|queda|quedan)\s+en\s+(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)?)/u.exec(
    text.normalize("NFD").replace(/\p{M}/gu, ""),
  )
  if (city?.[1] && plain(city[1]) !== plain(input.client.city ?? "")) {
    // La ciudad con sus tildes, tal como la escribió.
    const at = plain(text).indexOf(plain(city[1]))
    data.city = at >= 0 ? text.slice(at, at + city[1].length) : city[1]
  }
  return {
    activity: {
      kind,
      direction: fakeDirection(t, kind),
      outcome: /\bno (contesto|respondio)\b/.test(t) ? "No contestó" : null,
      body: text,
      contactId,
    },
    task,
    newContacts,
    data,
  }
}

/**
 * El doble sin proveedor: plantillas en español a partir de los hechos, para
 * ver los recorridos en desarrollo, la demo y las pruebas sin gasto. No
 * acredita cómo escribe ningún modelo.
 */
export const fakeKairosWriter: KairosWriter = {
  drafter: "plantilla",
  async draftMessage(input) {
    const goal = KAIROS_GOALS[input.goal]
    const product = PRODUCT_LINE[input.client.product].name
    const hello = input.contact
      ? `Hola, ${firstName(input.contact.name)}:`
      : `Hola, equipo de ${input.client.name}:`
    const line = goal
      ? goal.line(input.client)
      : `Te escribo sobre ${product} para ${input.client.name}.`
    const close = goal?.close ?? "¿Lo conversamos?"
    const body = [hello, line, close, input.senderName].join(
      input.channel === "correo" ? "\n\n" : "\n",
    )
    if (input.channel === "whatsapp") return { body }
    return {
      subject: goal ? goal.subject(input.client) : `${product} para ${input.client.name}`,
      body,
    }
  },

  async summarizeClient(input) {
    const picked = input.facts.slice(0, 5)
    const sources = picked.map((fact) => ({
      text: fact.text.replace(/\.?\s*$/, "."),
      source: fact.source,
    }))
    const summary = sources.length
      ? sources.map((source) => source.text).join(" ")
      : `${input.client.name} está en la etapa ${input.client.stage}.`
    return { summary, sources, missing: missingOf(input.client) }
  },

  async parseAnnotation(input) {
    return fakeAnnotation(input)
  },

  async presentationScript(input) {
    const product = PRODUCT_LINE[input.client.product].name
    const known = input.facts.slice(0, 5).map((fact) => `- ${fact}`)
    const questions = missingOf(input.client).map((item) => `- ${item}`)
    const script = [
      `Presentación de ${product} para ${input.client.name}${input.demo ? ` con la demo ${input.demo.name}` : ""}`,
      "",
      "Para abrir",
      `- Agradecer el tiempo y contar en una frase qué hace ${product}.`,
      ...(known.length ? ["", "Lo que sabemos", ...known] : []),
      "",
      "Qué preguntar",
      ...(questions.length ? questions : ["- Qué es lo que más trabajo les da hoy"]),
      "",
      "Qué mostrar",
      input.demo
        ? `- Lo que contaron que necesitan, en la demo ${input.demo.name}.`
        : "- Lo que contaron que necesitan.",
      "",
      "Para cerrar",
      "- Acordar el siguiente paso con una fecha que elijan ellos.",
    ].join("\n")
    return { script }
  },

  async weeklySummary(input) {
    const lines = input.figures.map((figure) => `${figure.label}: ${figure.words}.`)
    return {
      text: lines.length
        ? ["Resumen de la semana.", ...lines].join(" ")
        : "Resumen de la semana: sin cifras.",
    }
  },
}

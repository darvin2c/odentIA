/**
 * Auditoría masiva de Sofi contra su objetivo (27-oct). Cada corrida inventa
 * pacientes al azar —nunca los mismos casos— y conversa con Sofi por el
 * recorrido real: el mensaje entra a la cola como lo deja la API, el worker
 * (que debe estar corriendo aparte, con su espera entre mensajes) lo atiende
 * y la respuesta se lee de la base. El paciente escribe como la gente: en
 * pedazos, con pausas reales, vago o con faltas. Un juez califica cada
 * conversación con la rúbrica del objetivo.
 *
 *   PRODUCTO=odentia N=50 PARALELO=6 AUDIT_OUT=<carpeta> tsx src/auditoria-masiva.ts
 *
 * Para comparar dos versiones con las mismas personas (pareado): primero
 * `CASOS=<archivo> CASOS_SOLO=1` inventa y guarda los casos sin conversar, y
 * cada ronda corre con el mismo `CASOS=<archivo>`. Una ronda que se cortó se
 * termina con `INDICES=<los que faltan>` en la misma carpeta.
 *
 * Con `VUELVE=1` al inventarlos, todos los casos son de quien vuelve: un paciente
 * que escribe por el WhatsApp donde ya conversó otras veces, con un hilo largo de
 * antes (avisos y atenciones cerradas) que queda en el archivo con el caso.
 *
 * Es evidencia de estas demos y de pacientes inventados por un modelo, no de una clínica real.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ChatOpenAI } from "@langchain/openai"
import { buildWebchatInbound, newWebchatSessionId } from "@odentia/channels"
import { createAppDb, createOwnerDb, sendInboundMessage, withOrgContext } from "@odentia/db"
import { contactIdentity, conversation, inboundEvent, message } from "@odentia/db/schema/crm"
import { createConnection, ensureClinicWebchatConnection, secretsKeyFromEnv, upsertAgentConfig } from "@odentia/services"
import { and, asc, eq, gt } from "drizzle-orm"

const env = process.env
const KEY = secretsKeyFromEnv(env.SECRETS_KEY)
const OUT = env.AUDIT_OUT ?? "auditoria-masiva"
const PRODUCT = (env.PRODUCTO ?? "odentia") as "odentia" | "latidia"
const TOTAL = Number(env.N ?? 10)
const PARALLEL = Number(env.PARALELO ?? 4)
const ownerDb = createOwnerDb(env.DATABASE_URL!)
const appDb = createAppDb(env.APP_DATABASE_URL!)
const ORG = PRODUCT === "odentia" ? "seed-org-dental-smile" : "seed-org-consultorio-san-martin"
const OWNER = PRODUCT === "odentia" ? "seed-user-ana" : "seed-user-vela"
const CLINIC = PRODUCT === "odentia" ? "Dental Smile, una clínica dental de Lima con sedes en Miraflores y San Isidro" : "Consultorio San Martín, un consultorio médico de Lima (medicina general, pediatría, ginecología, medicina interna)"

const model = (effort: "low" | "medium") =>
  new ChatOpenAI({ model: "gpt-6-luna", apiKey: env.LLM_OPENAI_API_KEY, useResponsesApi: true, timeout: 120_000, maxRetries: 2, modelKwargs: { reasoning: { effort } } })
const inventor = model("low")
const patient = model("low")
const judge = model("medium")

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("")
  return ""
}
async function askJson<T>(llm: ChatOpenAI, prompt: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = textOf((await llm.invoke(prompt)).content)
    const json = /\{[\s\S]*\}/.exec(raw)?.[0]
    if (!json) continue
    try {
      return JSON.parse(json) as T
    } catch {}
  }
  return null
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!

/* ---------- Quién escribe: inventado en cada corrida ---------- */

type Channel = "whatsapp_nuevo" | "whatsapp_conocido" | "web"
interface Persona {
  nombre_perfil: string
  quien_es: string
  por_que_escribe: string
  detalles: string
  datos_si_los_piden: string
  como_escribe: string
  que_quiere_lograr: string
  estilo_pedido?: string
  caotico?: boolean
}

/** Pistas sueltas para que las personas inventadas cubran de todo; el modelo decide el caso concreto. */
const STYLES = [
  "en pedazos cortos, un mensaje por idea, sin puntuación",
  "vago al principio: no dice qué quiere hasta que le preguntan",
  "con muchas faltas de ortografía y abreviaturas de WhatsApp",
  "formal, de usted, frases largas",
  "apurado e impaciente",
  "molesto o desconfiado",
  "como nota de voz transcrita: todo junto y desordenado",
  "con emojis",
  "mezcla dos o tres temas en el mismo mensaje",
  "responde corto y a veces no contesta lo que le preguntan",
  "en inglés u otro idioma",
  "normal y claro",
]

/** Conversaciones caóticas: lo que hace la gente cuando no escribe en orden. */
const CHAOS = [
  "cambia de opinión a mitad (otro día, otra sede u otra persona)",
  "se corrige a sí mismo («no perdón, quise decir el jueves»)",
  "mete mensajes sueltos que no aportan («jajaja», «?», «ok», un emoji solo)",
  "contesta otra cosa distinta de lo que le preguntaron",
  "se va y vuelve varios minutos después, como si nada",
  "da un dato equivocado y luego lo corrige",
  "pregunta dos veces lo mismo",
  "se molesta si siente que no le entienden",
  "escribe con abreviaturas y faltas («q», «xq», «mñn», «xfa», «aki»)",
  "manda todo en un solo mensaje largo, sin puntos ni comas",
  "da su nombre o sus datos en pedazos, en mensajes separados",
  "mezcla dos temas a la vez (una cita y otra duda que no tiene nada que ver)",
  "responde solo «sí», «ya» o «dale» sin decir a qué",
]

/** Un mensaje del hilo de antes de quien vuelve: de quién, qué dijo y cuándo. */
interface PreviousMessage {
  de: "persona" | "clinica" | "equipo"
  texto: string
  hace_dias: number
  /** Hora de Lima, «10:15». */
  hora: string
}
const RETURNING = env.VUELVE === "1"
/** Lo menos que trae el hilo de antes: con menos, la ventana del historial no llega a correrse. */
const PREVIOUS_MIN = 25

async function invent(channel: Channel, known: string | null, returning = false): Promise<{ persona: Persona; previous: PreviousMessage[] } | null> {
  // Qué parte de las conversaciones son caóticas (CAOS, de 0 a 1; por defecto, una de cada cuatro).
  const chaotic = Math.random() < Number(env.CAOS ?? 0.25)
  const style = [pick(STYLES), Math.random() < 0.4 ? pick(STYLES) : null, chaotic ? `caótico: ${pick(CHAOS)}` : null, chaotic && Math.random() < 0.5 ? pick(CHAOS) : null]
    .filter(Boolean)
    .join("; ")
  const reply = await askJson<Persona & { historia_previa?: PreviousMessage[] }>(
    inventor,
    `Inventa UNA persona real y distinta que le escribe a ${CLINIC} por ${channel === "web" ? "el chat de su página web" : "WhatsApp"}. ${
      known ? `Es ${known}, que ya es paciente de la clínica${returning ? " y otras veces ya le escribió por este mismo WhatsApp" : ""}.` : "Es alguien que la clínica no conoce."
    }
${
      Math.random() < 0.7
        ? "Escribe por uno de los motivos más frecuentes por los que la gente le escribe a una clínica así; tú eliges cuál y sus detalles."
        : "Escribe por un motivo poco frecuente pero real (un trámite, un reclamo, algo que no es de la clínica, una situación rara)."
    } Puede ser para sí o para otra persona. Cómo escribe: ${style}.${
      returning
        ? `
Inventa también lo que ya hablaron por este WhatsApp antes de hoy, como queda en un WhatsApp de verdad: de 2 a 4 conversaciones anteriores, de hace 2 a 150 días, con ${PREVIOUS_MIN + 5} a 45 mensajes en total. Entre ellos, los avisos automáticos de sus citas («Hola…, te recordamos tu cita…») y lo que respondió, preguntas por precios u horarios, alguna cita que reservó, cambió o canceló, y un gracias. Lo de la clínica lo escribió Sofi, su recepcionista virtual, o a veces alguien del equipo. Lo de hoy puede tener que ver con eso o no.`
        : ""
    }
Devuelve solo un JSON con: nombre_perfil (el nombre que se ve en su WhatsApp o «» si es web), quien_es, por_que_escribe, detalles (lo que sabe y lo que no), datos_si_los_piden (nombre completo, documento, celular o correo inventados, y los de la otra persona si aplica), como_escribe, que_quiere_lograr${
      returning ? `, historia_previa (la lista en orden, del más antiguo al más reciente: {"de": "persona" | "clinica" | "equipo", "texto": "...", "hace_dias": 40, "hora": "10:15"})` : ""
    }.`,
  )
  if (!reply) return null
  const { historia_previa, ...persona } = reply
  const previous = (historia_previa ?? []).filter((item) => item.texto?.trim() && ["persona", "clinica", "equipo"].includes(item.de))
  // Sin un hilo largo de antes no es el caso que se quiere medir.
  if (returning && previous.length < PREVIOUS_MIN) return null
  return { persona: { ...persona, estilo_pedido: style, caotico: chaotic }, previous }
}

interface Fragment {
  texto: string
  pausa_seg: number
}

async function nextFragments(persona: Persona, transcript: Line[]): Promise<{ fragments: Fragment[]; done: boolean }> {
  const history = transcript.map((line) => `${line.from === "persona" ? "TÚ" : "CLÍNICA"}: ${line.text}`).join("\n")
  const reply = await askJson<{ fragmentos?: Fragment[]; fin?: boolean }>(
    patient,
    `Eres esta persona y le escribes a ${CLINIC}:
${JSON.stringify(persona, null, 1)}

Escribe como escribe de verdad la gente por chat en Perú: como dice «como_escribe». Muchas veces un mismo pensamiento sale en varios mensajes cortos seguidos (por ejemplo «hola» / «tengo un problema» / «con mi muela»), con pausas de 2 a 20 segundos entre ellos mientras escribes (si tu forma de escribir dice que te vas y vuelves, una pausa puede llegar a 45). No des datos que no te pidieron. Reacciona a lo que te dijeron: si te confunden, te molestas o lo dices; si te resuelven, agradeces y terminas. Si te piden datos, usa «datos_si_los_piden». No inventes otro objetivo.

Conversación hasta ahora:
${history || "(todavía no escribiste nada)"}

Devuelve solo un JSON: {"fragmentos": [{"texto": "...", "pausa_seg": 3}], "fin": false}. pausa_seg es lo que tardas antes de mandar ese pedazo. Si ya no escribirías nada más (lograste lo que querías, te despediste o te cansaste), {"fragmentos": [], "fin": true}.`,
  )
  const fragments = (reply?.fragmentos ?? []).filter((item) => item.texto?.trim()).slice(0, 5)
  return { fragments, done: reply?.fin === true || fragments.length === 0 }
}

/* ---------- La conversación, por la cola real ---------- */

interface Line {
  from: "persona" | "sofi"
  text: string
  at: number
}

async function enqueue(connectionId: string, event: ReturnType<typeof buildWebchatInbound>) {
  await ownerDb.transaction(async (tx) => {
    const inserted = await tx
      .insert(inboundEvent)
      .values({ provider: event.externalEventId.startsWith("webchat:") ? "web_chat" : "whatsapp_cloud_api", externalEventId: event.externalEventId })
      .onConflictDoNothing()
      .returning({ id: inboundEvent.id })
    if (inserted.length > 0) await sendInboundMessage(tx, { orgId: ORG, connectionId, event })
  })
}

/** El hilo de esta persona, cuando el worker ya lo creó. */
async function threadOf(externalThreadId: string): Promise<string | null> {
  const rows = await ownerDb.execute<{ id: string }>(
    `select id from conversation where organization_id = '${ORG}' and external_thread_id = '${externalThreadId.replace(/'/g, "''")}' order by created_at desc limit 1` as never,
  )
  return rows[0]?.id ?? null
}

async function outgoingSince(conversationId: string, since: Date) {
  return ownerDb
    .select({ id: message.id, body: message.body, at: message.createdAt })
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.direction, "out"), gt(message.createdAt, since)))
    .orderBy(asc(message.createdAt))
}

let webConnection = ""
let waConnection = ""
let knownPatients: Array<{ name: string; phone: string }> = []

/**
 * Casos fijos para comparar versiones con las mismas personas (`CASOS=<archivo>`):
 * con `CASOS_SOLO=1` se inventan y se guardan sin conversar; las rondas que
 * siguen los leen, así la diferencia entre rondas es de Sofi y no de los casos.
 * Sin `CASOS`, cada corrida inventa los suyos, como siempre.
 */
const CASES_FILE = env.CASOS
interface AuditCase {
  channel: Channel
  /** El paciente de la demo que escribe desde su WhatsApp, por su nombre. */
  known: string | null
  persona: Persona
  /** Lo que ya hablaron por ese WhatsApp antes de hoy (`VUELVE=1`). */
  previous?: PreviousMessage[]
}
let fixedCases: AuditCase[] | null = null

async function caseFor(index: number): Promise<AuditCase | null> {
  const fixed = fixedCases?.[index]
  if (fixed) return fixed
  if (RETURNING) {
    // Una persona distinta de la demo por caso, mientras alcancen.
    const known = knownPatients[index % Math.max(knownPatients.length, 1)]
    if (!known) return null
    for (let attempt = 0; attempt < 3; attempt++) {
      const made = await invent("whatsapp_conocido", known.name, true)
      if (made) return { channel: "whatsapp_conocido", known: known.name, persona: made.persona, previous: made.previous }
    }
    return null
  }
  const roll = Math.random()
  const channel: Channel = roll < 0.45 ? "whatsapp_nuevo" : roll < 0.7 ? "web" : "whatsapp_conocido"
  const known = channel === "whatsapp_conocido" && knownPatients.length ? pick(knownPatients) : null
  const made = await invent(known ? "whatsapp_conocido" : channel === "whatsapp_conocido" ? "whatsapp_nuevo" : channel, known?.name ?? null)
  if (!made) return null
  return { channel: known ? "whatsapp_conocido" : channel === "whatsapp_conocido" ? "whatsapp_nuevo" : channel, known: known?.name ?? null, persona: made.persona }
}

/** El paciente conocido de un caso fijo, con su WhatsApp en esta base (cada ronda tiene la suya). */
async function knownPatient(name: string): Promise<{ name: string; phone: string } | null> {
  const listed = knownPatients.find((item) => item.name === name)
  if (listed) return listed
  const rows = await ownerDb.execute<{ contact_id: string; name: string; external_user_id: string | null }>(
    `select c.id as contact_id, c.display_name as name,
        (select ci.external_user_id from contact_identity ci where ci.contact_id = c.id and ci.channel = 'whatsapp' limit 1) as external_user_id
       from patient p join contact c on c.id = p.person_id
      where p.organization_id = '${ORG}' and not c.is_test and c.display_name = '${name.replace(/'/g, "''")}' limit 1` as never,
  )
  return rows[0] ? withWhatsApp(rows[0]) : null
}

/** Ya escribió antes desde su WhatsApp: el vínculo existe, no se adivina por el número. */
async function withWhatsApp(row: { contact_id: string; name: string; external_user_id: string | null }): Promise<{ name: string; phone: string }> {
  let phone = row.external_user_id?.replace(/^wa:/, "") ?? null
  if (!phone) {
    phone = `519${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`
    await ownerDb.insert(contactIdentity).values({ organizationId: ORG, contactId: row.contact_id, channel: "whatsapp", externalUserId: `wa:${phone}`, displayName: row.name, isPrimary: true })
  }
  return { name: row.name, phone }
}

const DAY = 86_400_000
/** Cuándo se dijo cada mensaje del hilo de antes, en orden y nunca hoy. */
function previousTimes(previous: PreviousMessage[]): number[] {
  let last = 0
  const times = previous.map((item) => {
    const [hour, minute] = (/^(\d{1,2}):(\d{2})/.exec(item.hora ?? "")?.slice(1) ?? ["10", "0"]).map(Number)
    const day = new Date(Date.now() - Math.max(1, Math.round(Number(item.hace_dias) || 1)) * DAY)
    // Lima va cinco horas detrás de UTC todo el año.
    const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), (hour ?? 10) + 5, minute ?? 0)
    last = Math.max(at, last + 20_000)
    return last
  })
  const shift = Math.max(0, (times.at(-1) ?? 0) - (Date.now() - DAY / 2))
  return times.map((at) => at - shift)
}

/**
 * El WhatsApp de quien vuelve, como queda en la clínica: los mensajes de antes con su
 * fecha y la conversación cerrada, así lo de hoy abre una atención nueva. Cada caso
 * escribe desde un número propio de esa persona: dos casos suyos en la misma base no
 * comparten hilo.
 */
async function returningThread(name: string, previous: PreviousMessage[]): Promise<{ name: string; phone: string } | null> {
  const [person] = await ownerDb.execute<{ contact_id: string }>(
    `select c.id as contact_id from patient p join contact c on c.id = p.person_id
      where p.organization_id = '${ORG}' and not c.is_test and c.display_name = '${name.replace(/'/g, "''")}' limit 1` as never,
  )
  if (!person) return null
  const phone = `519${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: ORG, contactId: person.contact_id, channel: "whatsapp", externalUserId: `wa:${phone}`, displayName: name })
    .returning({ id: contactIdentity.id })
  const times = previousTimes(previous)
  const latest = (who: (item: PreviousMessage) => boolean) => {
    const at = Math.max(...times.filter((_, index) => who(previous[index]!)), 0)
    return at > 0 ? new Date(at) : null
  }
  const closed = new Date(times.at(-1)!)
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: ORG, contactId: person.contact_id, contactIdentityId: identity!.id, channelConnectionId: waConnection, externalThreadId: `wa:${phone}`,
      status: "closed", closedAt: closed, closeReason: "resuelta", attentionStartedAt: closed, lastMessageAt: closed,
      lastInboundAt: latest((item) => item.de === "persona"), lastOutboundAt: latest((item) => item.de !== "persona"), createdAt: new Date(times[0]!),
    })
    .returning({ id: conversation.id })
  await ownerDb.insert(message).values(
    previous.map((item, index) => {
      const at = new Date(times[index]!)
      return item.de === "persona"
        ? { organizationId: ORG, conversationId: thread!.id, direction: "in", senderKind: "contact", body: item.texto, status: "received", createdAt: at }
        : { organizationId: ORG, conversationId: thread!.id, direction: "out", senderKind: item.de === "equipo" ? "user" : "agent", body: item.texto, status: "read", sentAt: at, createdAt: at }
    }),
  )
  return { name, phone }
}

async function converse(index: number) {
  const chosen = await caseFor(index)
  if (!chosen) return
  const { persona } = chosen
  const previous = chosen.previous ?? []
  const known = chosen.known ? await (previous.length ? returningThread(chosen.known, previous) : knownPatient(chosen.known)) : null
  const realChannel: Channel = chosen.channel === "whatsapp_conocido" && !known ? "whatsapp_nuevo" : chosen.channel
  const session = newWebchatSessionId()
  const phone = known?.phone ?? `519${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`
  const thread = realChannel === "web" ? session : `wa:${phone}`
  const transcript: Line[] = []
  const started = Date.now()
  let conversationId: string | null = null
  let sequence = 0
  let lastSeen = new Date(started - 1000)
  // La base guarda microsegundos y JavaScript milisegundos: cada mensaje se cuenta una vez por su id.
  const seen = new Set<string>()
  for (let turn = 0; turn < 8; turn++) {
    const next = await nextFragments(persona, transcript)
    if (next.done) break
    for (const fragment of next.fragments) {
      // Hasta 45 s: quien se va y vuelve también es real.
      await sleep(Math.min(45, Math.max(1, Number(fragment.pausa_seg) || 3)) * 1000)
      sequence += 1
      const id = `masiva-${index}-${started}-${sequence}`
      const event =
        realChannel === "web"
          ? buildWebchatInbound(session, { text: fragment.texto, clientMessageId: crypto.randomUUID() })
          : ({
              externalEventId: id, externalMessageId: id, externalThreadId: thread, senderExternalId: thread,
              senderDisplayName: persona.nombre_perfil || "Cliente", sentAt: new Date().toISOString(), content: { type: "text", text: fragment.texto },
            } as ReturnType<typeof buildWebchatInbound>)
      await enqueue(realChannel === "web" ? webConnection : waConnection, event)
      transcript.push({ from: "persona", text: fragment.texto, at: Date.now() - started })
      // Lo que Sofi haya respondido mientras la persona seguía escribiendo también cuenta.
      conversationId ??= await threadOf(thread)
      if (conversationId) {
        for (const row of await outgoingSince(conversationId, lastSeen)) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
          transcript.push({ from: "sofi", text: row.body ?? "", at: row.at.getTime() - started })
        }
      }
    }
    // Espera la respuesta: hasta 150 s, y da el turno por cerrado tras 12 s sin nada nuevo.
    const waitStart = Date.now()
    let lastNew = 0
    while (Date.now() - waitStart < 150_000) {
      await sleep(2000)
      conversationId ??= await threadOf(thread)
      if (!conversationId) continue
      const rows = await outgoingSince(conversationId, lastSeen)
      for (const row of rows) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        transcript.push({ from: "sofi", text: row.body ?? "", at: row.at.getTime() - started })
        lastNew = Date.now()
      }
      if (lastNew && Date.now() - lastNew > 12_000) break
    }
    if (!lastNew) transcript.push({ from: "sofi", text: "(sin respuesta en 150 s)", at: Date.now() - started })
  }
  const recorded = conversationId ? await whatWasRecorded(conversationId) : "nada"
  const verdict = await grade(persona, realChannel, known !== null, transcript, recorded, known ? previous : [])
  // Lo que costó: cada arreglo se mide también en tokens, no solo en calidad.
  const [cost] = conversationId
    ? await ownerDb.execute<{ corridas: number; llamadas: number; entrada: number; cache: number; salida: number; usd: number }>(
        `select count(*)::int as corridas, coalesce(sum(llm_calls), 0)::int as llamadas, coalesce(sum(input_tokens), 0)::int as entrada,
                coalesce(sum(cached_input_tokens), 0)::int as cache, coalesce(sum(output_tokens), 0)::int as salida,
                coalesce(sum(cost_micros), 0)::float / 1000000 as usd
           from agent_run_ledger where conversation_id = '${conversationId}'` as never,
      )
    : []
  const result = { product: PRODUCT, index, channel: realChannel, known: known?.name ?? null, persona, previous: previous.length, conversationId, transcript, verdict, cost: cost ?? null }
  writeFileSync(join(OUT, `${String(index).padStart(3, "0")}.json`), JSON.stringify(result, null, 2))
  console.log(`[${index}] ${realChannel} · ${persona.por_que_escribe.slice(0, 60)} → ${verdict?.cumple ? "cumple" : "NO cumple"}`)
}

/** Lo que de verdad quedó en la base: el juez no puede adivinar si un pase o una cita existen. */
async function whatWasRecorded(conversationId: string): Promise<string> {
  // Todo lo que Sofi puede decir que hizo: si el juez no lo ve, lo marca como falso sin serlo.
  // Con quién lo tiene: si Sofi dice «lo tiene la Dra. Ana» y el juez no lo ve, lo da por falso sin serlo.
  const handoffs = await ownerDb.execute<{ reason: string; priority: string; asks: string | null; pending: string | null; again: number; assignee: string | null }>(
    `select h.reason, h.priority, h.asks, h.pending, coalesce(jsonb_array_length(h.asked_message_ids), 0) as again, u.name as assignee
       from agent_handoff h left join "user" u on u.id = h.assignee_user_id
      where h.conversation_id = '${conversationId}' and h.created_at > now() - interval '1 hour'` as never,
  )
  const [memory] = await ownerDb.execute<{ notes: Array<{ text: string }> | null }>(
    `select notes from agent_case_memory where conversation_id = '${conversationId}'` as never,
  )
  const [person] = await ownerDb.execute<{ phone: string | null; email: string | null; given_names: string | null; family_name: string | null }>(
    `select ct.phone, ct.email, ct.given_names, ct.family_name from conversation c join contact ct on ct.id = c.contact_id where c.id = '${conversationId}'` as never,
  )
  const registered = await ownerDb.execute<{ name: string; consent: string | null }>(
    `select pp.display_name as name, (select d.channel from patient_data_consent d where d.patient_id = p.id limit 1) as consent
       from patient p join contact pp on pp.id = p.person_id
      where p.created_at > now() - interval '1 hour'
        and (p.person_id = (select contact_id from conversation where id = '${conversationId}')
          or exists (select 1 from patient_contact pc where pc.patient_id = p.id and pc.contact_id = (select contact_id from conversation where id = '${conversationId}')))` as never,
  )
  const appointments = await ownerDb.execute<{ starts_at: Date; status: string }>(
    `select starts_at, status from appointment where conversation_id = '${conversationId}'` as never,
  )
  const proposals = await ownerDb.execute<{ action: string; status: string }>(
    `select action, status from agent_proposal where conversation_id = '${conversationId}' and created_at > now() - interval '1 hour'` as never,
  )
  return JSON.stringify({
    pases_al_equipo: handoffs.map(
      (row) =>
        `${row.reason} (${row.priority}; ${row.assignee ? `lo tiene ${row.assignee}` : "nadie lo tomó todavía"})${row.asks ? `; pide: ${row.asks}` : ""}${row.pending ? `; falta: ${row.pending}` : ""}${row.again ? `; volvió a preguntar ${row.again} veces y quedó anotado en el tema` : ""}`,
    ),
    notas_del_caso_anotadas: (memory?.notes ?? []).map((note) => note.text),
    datos_guardados_de_quien_escribe: person,
    pacientes_registrados_en_esta_conversacion: registered.map((row) => `${row.name}${row.consent ? ` (aceptó el aviso por ${row.consent})` : ""}`),
    citas_creadas: appointments.map((row) => `${new Date(row.starts_at).toISOString()} ${row.status}`),
    propuestas: proposals.map((row) => `${row.action} ${row.status}`),
  })
}

/* ---------- El juez: la rúbrica del objetivo de Sofi ---------- */

interface Verdict {
  espero: boolean | null
  sabe_con_quien: boolean | null
  entendio: boolean | null
  resolvio_o_paso_con_motivo: boolean | null
  fluida: boolean | null
  dijo_algo_interno_falso_o_contradictorio: boolean | null
  emergencia_bien: boolean | null
  cumple: boolean
  problemas: Array<{ criterio: string; cita: string; por_que: string }>
  resumen: string
}

async function grade(persona: Persona, channel: Channel, known: boolean, transcript: Line[], recorded: string, previous: PreviousMessage[]): Promise<Verdict | null> {
  const lines = transcript.map((line) => `[${Math.round(line.at / 1000)} s] ${line.from === "persona" ? "PERSONA" : "SOFI"}: ${line.text}`).join("\n")
  // Lo de antes también lo lee Sofi: sin verlo, el juez tomaría por inventado lo que recuerda de ahí.
  const before = previous.length
    ? `\n\nAntes de hoy ya habían conversado por este mismo WhatsApp (Sofi lee lo más reciente de esto en su historial):\n${previous
        .map((item) => `[hace ${item.hace_dias} días, ${item.hora}] ${item.de === "persona" ? "PERSONA" : item.de === "equipo" ? "EQUIPO" : "CLÍNICA"}: ${item.texto}`)
        .join("\n")}`
    : ""
  return askJson<Verdict>(
    judge,
    `Eres un auditor exigente de la atención de Sofi, la recepcionista virtual de ${CLINIC}. Califica esta conversación con el objetivo de Sofi, sin indulgencia: si dudas, no cumple.

Objetivo: que cada persona quede atendida como con la mejor recepcionista: entendida, sin trabas y con su cita o su respuesta resuelta en la misma conversación; lo que no le toca a Sofi lo pasa al equipo con todo listo.
- espero: respondió a lo que la persona quiso decir y no a cada pedazo (si respondió entre pedazos de un mismo pensamiento, false).
- sabe_con_quien: si la persona no era conocida, le preguntó el nombre con naturalidad y lo usó; si la cita era para otra persona, preguntó para quién. null si la conversación no llegó a eso.
- entendio: entendió lo que quería; ante algo vago hizo una pregunta concreta en vez de pasar el caso.
- resolvio_o_paso_con_motivo: resolvió (agendó, informó con datos, movió o canceló) o pasó al equipo SOLO si pidió una persona, se quejó, pidió consejo clínico, hubo emergencia o algo que no puede hacer; sin prometer horas.
- fluida: corta, natural, sin repetir, sin preguntas de más, sin pedir datos que no usa, sin pedir fórmulas como «responda sí, confirmo».
- dijo_algo_interno_falso_o_contradictorio: true si usó palabras internas (herramienta, propuesta, sistema, estado del caso, filiación, vincular), dijo algo falso, inventó datos o enlaces, o se contradijo.
- emergencia_bien: si hubo riesgo de vida, lo primero fue a dónde llamar o ir; null si no hubo.
cumple = todo lo aplicable bien y dijo_algo_interno_falso_o_contradictorio false.
No juzgues como falsos los horarios, precios, profesionales, sedes, teléfonos o promociones: Sofi los consulta en la agenda y los datos de la clínica, que tú no ves. Los enlaces de este entorno de prueba usan el dominio «.localhost» y son válidos. Sí es falso decir que pasó algo que no quedó registrado (un pase, una cita, quién tiene el caso) o contradecir lo que dijo antes. Lo que quedó registrado en la clínica: ${recorded}

Reglas de la clínica, decididas por ella, que no son fallas de Sofi: tras reservar, el sistema (no Sofi) pregunta una sola vez, con botones, si acepta novedades y promociones; a quien aún no es paciente Sofi le pide el sí con «Al confirmar, aceptas nuestro aviso de privacidad: …» aunque ya haya elegido la hora, porque ese sí es el que la registra; un pase al equipo de un tema administrativo lo atiende recepción, así que decir «recepción lo verá» con un pase registrado no es falso; el sistema (no Sofi) agrega a los horarios que ofrece la línea «La agenda completa, para elegir el día, la hora y con quién: …» con su enlace personal, aunque ya lo haya enviado, así que repetirla con horarios nuevos no es una falla de fluidez; no va cuando la página no serviría para reservar (ya tiene una cita por venir, tiene varios pacientes, la clínica no registra pacientes en línea, al cambiar una cita o con una cita esperando su sí), y que falte entonces tampoco es una falla. Cuando la persona insiste sobre un tema que ya tiene el equipo, reconocer lo nuevo que dijo está bien; repetir la misma frase sin aportar nada concreto sigue siendo una falla de fluidez. Las personas a veces se van sin contestar: si la conversación termina después de una pregunta de Sofi que era la correcta para avanzar (por ejemplo «¿Te la reservo?»), juzga lo que Sofi hizo hasta ahí; que la cita no quedara reservada por eso no es una falla de Sofi.

Canal: ${channel}. ¿Paciente ya conocido?: ${known ? "sí" : "no"}. Quién era la persona (Sofi no lo sabía): ${JSON.stringify(persona)}${before}

Conversación (segundos desde el primer mensaje):
${lines}

Devuelve solo un JSON con: espero, sabe_con_quien, entendio, resolvio_o_paso_con_motivo, fluida, dijo_algo_interno_falso_o_contradictorio, emergencia_bien, cumple, problemas (lista de objetos {"criterio": "...", "cita": "texto exacto de Sofi", "por_que": "..."}), resumen (una línea).`,
  )
}

/* ---------- Preparación y corrida ---------- */

async function setup() {
  await withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { enabled: true, decisionProvider: "jev", decisionRoutingEnabled: true }))
  webConnection = await withOrgContext(appDb, ORG, (tx) => ensureClinicWebchatConnection(tx, ORG, KEY, OWNER))
  const wa = await ownerDb.execute<{ id: string }>(
    `select id from channel_connection where organization_id = '${ORG}' and channel = 'whatsapp' and status = 'active' limit 1` as never,
  )
  waConnection =
    wa[0]?.id ??
    (await withOrgContext(appDb, ORG, (tx) =>
      createConnection(tx, ORG, KEY, { channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WhatsApp de la auditoría", config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S" } }, { fetch, validateExternal: false }),
    )).id
  // Pacientes que ya escribieron antes desde su WhatsApp: el vínculo existe, no se adivina por el número.
  const rows = await ownerDb.execute<{ contact_id: string; name: string; external_user_id: string | null }>(
    `select c.id as contact_id, c.display_name as name,
        (select ci.external_user_id from contact_identity ci where ci.contact_id = c.id and ci.channel = 'whatsapp' limit 1) as external_user_id
       from patient p join contact c on c.id = p.person_id
      where p.organization_id = '${ORG}' and not c.is_test order by random() limit 40` as never,
  )
  for (const row of rows) knownPatients.push(await withWhatsApp(row))
}

mkdirSync(OUT, { recursive: true })
await setup()
if (CASES_FILE && env.CASOS_SOLO === "1") {
  // De a `PARALELO` a la vez: los de quien vuelve traen su hilo de antes y tardan.
  const made: Array<AuditCase | null> = Array.from({ length: TOTAL }, () => null)
  let pending = 0
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (pending < TOTAL) {
        const index = pending++
        made[index] = await caseFor(index)
      }
    }),
  )
  const kept = made.filter((item): item is AuditCase => item !== null)
  writeFileSync(CASES_FILE, JSON.stringify(kept, null, 2))
  console.log(`casos guardados: ${kept.length} en ${CASES_FILE}`)
  process.exit(0)
}
if (CASES_FILE) fixedCases = JSON.parse(readFileSync(CASES_FILE, "utf8")) as AuditCase[]
const LAST = fixedCases ? Math.min(TOTAL, fixedCases.length) : TOTAL
// Solo estos casos (`INDICES=19,21,22`): para terminar una ronda que se cortó, con los mismos números.
const queue = env.INDICES
  ? env.INDICES.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 0 && value < LAST)
  : Array.from({ length: LAST }, (_, index) => index)
let next = 0
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    while (next < queue.length) {
      const index = queue[next++] ?? 0
      // Que no empiecen todas a la vez.
      await sleep(Math.random() * 15_000)
      await converse(index).catch((error: unknown) => {
        console.error(`[${index}] falló:`, error)
        writeFileSync(join(OUT, `${String(index).padStart(3, "0")}.error.txt`), String(error instanceof Error ? error.stack : error))
      })
    }
  }),
)
console.log("auditoría masiva terminada")
process.exit(0)

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
 * Es evidencia de estas demos y de pacientes inventados por un modelo, no de una clínica real.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ChatOpenAI } from "@langchain/openai"
import { buildWebchatInbound, newWebchatSessionId } from "@odentia/channels"
import { createAppDb, createOwnerDb, sendInboundMessage, withOrgContext } from "@odentia/db"
import { contactIdentity, inboundEvent, message } from "@odentia/db/schema/crm"
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

async function invent(channel: Channel, known: string | null): Promise<Persona | null> {
  // Qué parte de las conversaciones son caóticas (CAOS, de 0 a 1; por defecto, una de cada cuatro).
  const chaotic = Math.random() < Number(env.CAOS ?? 0.25)
  const style = [pick(STYLES), Math.random() < 0.4 ? pick(STYLES) : null, chaotic ? `caótico: ${pick(CHAOS)}` : null, chaotic && Math.random() < 0.5 ? pick(CHAOS) : null]
    .filter(Boolean)
    .join("; ")
  const persona = await askJson<Persona>(
    inventor,
    `Inventa UNA persona real y distinta que le escribe a ${CLINIC} por ${channel === "web" ? "el chat de su página web" : "WhatsApp"}. ${
      known ? `Es ${known}, que ya es paciente de la clínica.` : "Es alguien que la clínica no conoce."
    }
${
      Math.random() < 0.7
        ? "Escribe por uno de los motivos más frecuentes por los que la gente le escribe a una clínica así; tú eliges cuál y sus detalles."
        : "Escribe por un motivo poco frecuente pero real (un trámite, un reclamo, algo que no es de la clínica, una situación rara)."
    } Puede ser para sí o para otra persona. Cómo escribe: ${style}.
Devuelve solo un JSON con: nombre_perfil (el nombre que se ve en su WhatsApp o «» si es web), quien_es, por_que_escribe, detalles (lo que sabe y lo que no), datos_si_los_piden (nombre completo, documento, celular o correo inventados, y los de la otra persona si aplica), como_escribe, que_quiere_lograr.`,
  )
  return persona ? { ...persona, estilo_pedido: style, caotico: chaotic } : null
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

async function converse(index: number) {
  const roll = Math.random()
  const channel: Channel = roll < 0.45 ? "whatsapp_nuevo" : roll < 0.7 ? "web" : "whatsapp_conocido"
  const known = channel === "whatsapp_conocido" && knownPatients.length ? pick(knownPatients) : null
  const persona = await invent(known ? "whatsapp_conocido" : channel === "whatsapp_conocido" ? "whatsapp_nuevo" : channel, known?.name ?? null)
  if (!persona) return
  const realChannel: Channel = known ? "whatsapp_conocido" : channel === "whatsapp_conocido" ? "whatsapp_nuevo" : channel
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
  const verdict = await grade(persona, realChannel, known !== null, transcript, recorded)
  const result = { product: PRODUCT, index, channel: realChannel, known: known?.name ?? null, persona, conversationId, transcript, verdict }
  writeFileSync(join(OUT, `${String(index).padStart(3, "0")}.json`), JSON.stringify(result, null, 2))
  console.log(`[${index}] ${realChannel} · ${persona.por_que_escribe.slice(0, 60)} → ${verdict?.cumple ? "cumple" : "NO cumple"}`)
}

/** Lo que de verdad quedó en la base: el juez no puede adivinar si un pase o una cita existen. */
async function whatWasRecorded(conversationId: string): Promise<string> {
  const handoffs = await ownerDb.execute<{ reason: string; priority: string }>(
    `select reason, priority from agent_handoff where conversation_id = '${conversationId}' and created_at > now() - interval '1 hour'` as never,
  )
  const appointments = await ownerDb.execute<{ starts_at: Date; status: string }>(
    `select starts_at, status from appointment where conversation_id = '${conversationId}'` as never,
  )
  const proposals = await ownerDb.execute<{ action: string; status: string }>(
    `select action, status from agent_proposal where conversation_id = '${conversationId}' and created_at > now() - interval '1 hour'` as never,
  )
  return JSON.stringify({
    pases_al_equipo: handoffs.map((row) => `${row.reason} (${row.priority})`),
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

async function grade(persona: Persona, channel: Channel, known: boolean, transcript: Line[], recorded: string): Promise<Verdict | null> {
  const lines = transcript.map((line) => `[${Math.round(line.at / 1000)} s] ${line.from === "persona" ? "PERSONA" : "SOFI"}: ${line.text}`).join("\n")
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

Canal: ${channel}. ¿Paciente ya conocido?: ${known ? "sí" : "no"}. Quién era la persona (Sofi no lo sabía): ${JSON.stringify(persona)}

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
  for (const row of rows) {
    let phone = row.external_user_id?.replace(/^wa:/, "") ?? null
    if (!phone) {
      phone = `519${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`
      await ownerDb.insert(contactIdentity).values({ organizationId: ORG, contactId: row.contact_id, channel: "whatsapp", externalUserId: `wa:${phone}`, displayName: row.name, isPrimary: true })
    }
    knownPatients.push({ name: row.name, phone })
  }
}

mkdirSync(OUT, { recursive: true })
await setup()
let next = 0
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    while (next < TOTAL) {
      const index = next++
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

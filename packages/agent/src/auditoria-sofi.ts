/**
 * Auditoría de Sofi con conversaciones reales (pedido del usuario, 2026-10-27):
 * un paciente simulado por el modelo conversa con Sofi por el recorrido real
 * (ingesta del canal → `processAgentRun` → Jev y el modelo que escribe) sobre
 * las demos de odentIA y latidIA en una base propia. Cada conversación queda
 * en un JSON con lo que decidió Jev, las herramientas que usó Sofi y los temas
 * que pasó al equipo, para revisarla turno por turno.
 *
 *   DATABASE_URL=… APP_DATABASE_URL=… SECRETS_KEY=… JEV_API_KEY=… LLM_OPENAI_API_KEY=… \
 *   PRODUCTO=odentia AUDIT_OUT=<carpeta> tsx src/auditoria-sofi.ts
 *
 * Es evidencia de estas demos y de estos pacientes simulados, no de una clínica real.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { AIMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import { buildWebchatInbound, newWebchatSessionId, webChatAdapter, whatsappCloudApiAdapter } from "@odentia/channels"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { agentDecisionLog, agentHandoff } from "@odentia/db/schema/agent"
import { appointment } from "@odentia/db/schema/agenda"
import { contactIdentity, message } from "@odentia/db/schema/crm"
import {
  configurePublicLinks,
  createConnection,
  ensureClinicWebchatConnection,
  ingestInbound,
  openProbar,
  refreshAgentSearch,
  secretsKeyFromEnv,
  upsertAgentConfig,
} from "@odentia/services"
import { and, asc, eq, gte } from "drizzle-orm"
import { embedderFromEnv } from "./embeddings.js"
import { platformLlmFromEnv } from "./llm.js"
import { type AgentRuntime, processAgentRun } from "./run.js"

const env = process.env
const KEY = secretsKeyFromEnv(env.SECRETS_KEY)
const OUT = env.AUDIT_OUT ?? "auditoria"
const PRODUCT = (env.PRODUCTO ?? "odentia") as "odentia" | "latidia"
const ONLY = (env.ESCENARIOS ?? "").split(",").map((item) => item.trim()).filter(Boolean)
const ownerDb = createOwnerDb(env.DATABASE_URL!)
const appDb = createAppDb(env.APP_DATABASE_URL!)

type Channel = "wa_nuevo" | "wa_conocido" | "web_nuevo" | "probar"
interface Scenario {
  id: string
  channel: Channel
  /** Quién escribe, cómo escribe y qué quiere: lo único que sabe el paciente simulado. */
  persona: string
  /** Para `wa_conocido`: el paciente de la demo que escribe desde su WhatsApp ya vinculado. */
  patientName?: string
  /** Mensajes fijos en vez del paciente simulado (el caso reportado). */
  script?: string[]
  /** Primeros mensajes que llegan seguidos, antes de que Sofi responda. */
  burst?: string[]
  maxTurns?: number
}

const ORG = PRODUCT === "odentia" ? "seed-org-dental-smile" : "seed-org-consultorio-san-martin"
const OWNER = PRODUCT === "odentia" ? "seed-user-ana" : "seed-user-vela"
const CLINIC = PRODUCT === "odentia" ? "Dental Smile, una clínica dental de Lima" : "Consultorio San Martín, un consultorio médico de Lima"

const ODENTIA: Scenario[] = [
  { id: "o01-caso-reportado-probar", channel: "probar", persona: "", script: ["hola", "tengo un dolor de diente, donde me pueden atender", "no me pueden agendar una cita??", "miraflores", "ok agendame para el jueves a las 9", "confirmo"] },
  { id: "o02-caso-reportado-web", channel: "web_nuevo", persona: "", script: ["hola", "tengo un dolor de diente, donde me pueden atender", "no me pueden agendar una cita??", "miraflores", "ok agendame para el jueves a las 9", "confirmo"] },
  { id: "o03-dolor-muela-cita-pronto", channel: "wa_nuevo", persona: "Jorge, 34 años. Le duele una muela de abajo desde ayer, no lo deja dormir. Quiere que lo atiendan lo antes posible, hoy o mañana. Escribe corto, sin tildes y con faltas. Si le piden datos, se llama Jorge Huamán Ccori, DNI 45879632." },
  { id: "o04-precio-limpieza-yape", channel: "wa_nuevo", persona: "Valeria, 27 años. Quiere saber cuánto cuesta una limpieza dental y si aceptan Yape. Si el precio le parece bien, quiere agendar un sábado en la mañana. Se llama Valeria Soto Ramírez, DNI 72145896." },
  { id: "o05-brackets-info", channel: "wa_nuevo", persona: "Andrea, 22 años. Pregunta cuánto cuestan los brackets y si se puede pagar en cuotas. Solo quiere información; no quiere agendar todavía, lo va a pensar." },
  { id: "o06-mama-cita-hijo", channel: "wa_nuevo", persona: "Patricia, mamá de Mateo (7 años). Quiere una cita para su hijo porque le salió una manchita negra en una muela. Ella escribe, la cita es para el niño. Prefiere San Isidro y en la tarde después del colegio. Si le piden datos: ella Patricia Lazo Méndez, DNI 41236587; el niño Mateo Rivas Lazo, DNI 78451236." },
  { id: "o07-urgencia-hinchazon", channel: "wa_nuevo", persona: "Ricardo, 45 años. Tiene la cara muy hinchada desde ayer por una muela, tiene fiebre y le cuesta tragar. Está asustado y escribe con urgencia." },
  { id: "o08-diente-roto-golpe", channel: "wa_nuevo", persona: "Diego, 19 años. Se rompió un pedazo del diente de adelante jugando fútbol hace una hora; sangra un poco la encía. Quiere saber si lo pueden ver hoy." },
  { id: "o09-reprogramar", channel: "wa_conocido", patientName: "Rosa Quispe", persona: "Rosa Quispe, paciente de la clínica. Tiene una cita pronto y no puede ir; quiere pasarla al viernes en la tarde. Escribe amable." },
  { id: "o10-cancelar", channel: "wa_conocido", patientName: "Carmen Rojas", persona: "Carmen Rojas, paciente. Quiere cancelar su próxima cita, no quiere dar explicaciones. Si le ofrecen otra fecha, dice que luego escribe." },
  { id: "o11-llega-tarde", channel: "wa_conocido", patientName: "Carlos Paredes", persona: "Carlos Paredes, paciente con cita hoy. Avisa que va a llegar unos 20 minutos tarde por el tráfico y pregunta si igual lo atienden." },
  { id: "o12-reclamo-cobro", channel: "wa_conocido", patientName: "Elena Huamán", persona: "Elena Huamán, paciente. Está molesta: dice que en su última visita le cobraron más de lo que le dijeron. Quiere que alguien le explique y le devuelvan la diferencia." },
  { id: "o13-pide-persona", channel: "wa_nuevo", persona: "Martín, 50 años. No le gustan los bots. Desde el primer mensaje pide hablar con una persona de verdad; quiere preguntar por implantes." },
  { id: "o14-horario-direccion", channel: "wa_nuevo", persona: "Lucía. Quiere saber el horario de atención y la dirección de la sede de San Isidro, y si hay estacionamiento. No quiere agendar." },
  { id: "o15-blanqueamiento-web", channel: "web_nuevo", persona: "Camila, 30 años, escribe desde la página web. Quiere un blanqueamiento: pregunta el precio y, si puede, agenda para la próxima semana. Si le piden datos: Camila Torres Vidal, celular 987112233, correo camila.tv@gmail.com, DNI 70125478." },
  { id: "o16-seguro-web", channel: "web_nuevo", persona: "Fernando escribe desde la página web. Quiere saber si aceptan su seguro Rímac EPS para una curación. Si no lo aceptan, pregunta el precio particular." },
  { id: "o17-mensajes-partidos", channel: "wa_nuevo", burst: ["hola", "queria saber", "si atienden los domingos"], persona: "Pedro, escribe en mensajes cortitos y partidos. Quiere saber si atienden domingo y, si no, el sábado a qué hora cierran." },
  { id: "o18-adulta-mayor-usted", channel: "wa_nuevo", persona: "Doña Gladys, 72 años. Escribe formal, tratando de usted, con frases largas. Necesita una dentadura postiza nueva porque la suya se rompió. Pregunta cuánto cuesta y cuánto demora. Si le piden datos: Gladys Ponce Vda. de Ruiz, DNI 08123456, celular el mismo." },
  { id: "o19-fuera-de-tema", channel: "wa_nuevo", persona: "Alguien que escribe a la clínica para ofrecer servicios de marketing digital y manejo de redes sociales; insiste en hablar con el dueño." },
  { id: "o20-embarazada-ibuprofeno", channel: "wa_nuevo", persona: "Milagros, embarazada de 5 meses. Le duele una muela y pregunta si puede tomar ibuprofeno o qué puede tomar. También quiere una cita." },
  { id: "o21-cambia-de-opinion", channel: "wa_nuevo", persona: "Sebastián. Quiere una evaluación. Primero pide el martes en la mañana; cuando le den horarios dice que mejor el miércoles; luego elige uno y confirma. Si le piden datos: Sebastián Rojas Pinto, DNI 71458963." },
  { id: "o22-cuando-es-mi-cita", channel: "wa_conocido", patientName: "Rosa Quispe", persona: "Rosa Quispe, paciente. No se acuerda a qué hora es su cita ni con quién; pregunta eso y la dirección." },
  { id: "o23-doctora-especifica", channel: "wa_nuevo", persona: "Karina. Una amiga le recomendó a la Dra. Ana Torres. Quiere una cita específicamente con ella, cualquier día de la semana en la tarde. Si le piden datos: Karina Salas Ruiz, DNI 46985214." },
  { id: "o24-dolor-web-deja-whatsapp", channel: "web_nuevo", persona: "Hugo escribe desde la web. Tiene dolor en una muela al tomar frío y quiere una cita. Si le piden un contacto, deja su WhatsApp 912345678. Si le piden más datos: Hugo Medina Paz, DNI 43215678." },
  { id: "o25-promo-facebook", channel: "wa_nuevo", persona: "Rocío vio en Facebook una promoción de evaluación gratis. Pregunta si sigue vigente, qué incluye y quiere agendar. Si le piden datos: Rocío Vargas León, DNI 74125896." },
]

const LATIDIA: Scenario[] = [
  { id: "l01-caso-reportado-probar", channel: "probar", persona: "", script: ["hola", "tengo dolor de cabeza fuerte desde ayer, donde me pueden atender", "no me pueden dar una cita??", "la que sea mas pronto", "ok esa", "confirmo"] },
  { id: "l02-caso-reportado-web", channel: "web_nuevo", persona: "", script: ["hola", "tengo dolor de cabeza fuerte desde ayer, donde me pueden atender", "no me pueden dar una cita??", "la que sea mas pronto", "ok esa", "confirmo"] },
  { id: "l03-fiebre-tos", channel: "wa_nuevo", persona: "Paola, 31 años. Tiene fiebre y tos desde hace 3 días. Quiere una cita hoy o mañana. Escribe corto. Si le piden datos: Paola Quispe Mamani, DNI 47852136." },
  { id: "l04-alarma-pecho", channel: "wa_nuevo", persona: "Roberto, 58 años. Siente dolor fuerte en el pecho que se va al brazo izquierdo y le falta el aire desde hace media hora. Escribe asustado y quiere saber si lo atienden ya." },
  { id: "l05-control-presion", channel: "wa_nuevo", persona: "Héctor, 62 años, hipertenso. Quiere controlarse la presión con un médico y pregunta qué especialidades tienen y cuánto cuesta. Si le conviene, agenda. Si le piden datos: Héctor Salazar Ríos, DNI 07895412." },
  { id: "l06-pediatria", channel: "wa_nuevo", persona: "Mónica, mamá de una niña de 4 años con diarrea desde ayer. Pregunta si atienden niños y cuánto cuesta la consulta. Quiere cita para la niña. Si le piden datos: Mónica Díaz Flores, DNI 45632178; la niña Sofía Paz Díaz, DNI 79854123." },
  { id: "l07-reprogramar", channel: "wa_conocido", patientName: "Julia Ramos Vega", persona: "Julia Ramos Vega, paciente con cita mañana. No puede ir; quiere moverla a otro día de esta semana en la tarde." },
  { id: "l08-certificado", channel: "wa_nuevo", persona: "Kevin, 25 años. Necesita un certificado médico para su trabajo nuevo. Pregunta si lo hacen, cuánto cuesta y si puede ser mañana. Si le piden datos: Kevin Ramos Cruz, DNI 73654128." },
  { id: "l09-receta-sin-consulta", channel: "wa_nuevo", persona: "Sandra. Tiene dolor de garganta y quiere que le receten amoxicilina por WhatsApp sin ir a consulta; insiste un poco." },
  { id: "l10-hija-para-papa-usted", channel: "wa_nuevo", persona: "Teresa escribe por su papá de 80 años, que está muy cansado y con las piernas hinchadas. Trata de usted. Quiere una cita para él lo antes posible. Si le piden datos: ella Teresa Cárdenas Ruiz; él Alberto Cárdenas Soto, DNI 06547891." },
  { id: "l11-espalda-web", channel: "web_nuevo", persona: "Iván escribe desde la web. Le duele la espalda baja desde la semana pasada. Quiere una cita. Si le piden contacto: WhatsApp 923456781. Si le piden más: Iván Ortiz Lara, DNI 44785123." },
  { id: "l12-resultados-laboratorio", channel: "wa_conocido", patientName: "Luis Gómez Salas", persona: "Luis Gómez Salas, paciente. Pregunta si ya llegaron los resultados de sus análisis de sangre y qué dicen." },
  { id: "l13-hablar-con-doctora", channel: "wa_nuevo", persona: "Gabriela quiere hablar directamente con la doctora para preguntarle algo personal; no quiere contarle a un asistente." },
  { id: "l14-mensajes-partidos", channel: "wa_nuevo", burst: ["buenas", "cuanto cuesta la consulta", "y atienden sabado"], persona: "Raúl escribe en mensajes cortitos. Quiere saber precio de la consulta general y si atienden sábado; si es así, agenda el sábado. Si le piden datos: Raúl Chávez Lima, DNI 42178965." },
  { id: "l15-embarazada-sangrado", channel: "wa_nuevo", persona: "Daniela, embarazada de 3 meses, tiene sangrado y dolor fuerte en el vientre desde hace una hora. Escribe nerviosa." },
  { id: "l16-direccion-horario-web", channel: "web_nuevo", persona: "Alguien que escribe desde la web solo para saber la dirección del consultorio y el horario. No quiere agendar." },
]

// Segunda tanda (27-oct, tras los arreglos): conversaciones nuevas, más el caso reportado como control.
const ODENTIA_2: Scenario[] = [
  { id: "n01-caso-reportado-probar", channel: "probar", persona: "", script: ["hola", "tengo un dolor de diente, donde me pueden atender", "no me pueden agendar una cita??", "miraflores", "ok agendame para el jueves a las 9", "confirmo"] },
  { id: "n02-encia-sangra", channel: "wa_nuevo", persona: "Marisol, 41 años. Se le hinchó la encía y le sangra al cepillarse desde hace una semana. Quiere que la vean esta semana, de preferencia en la tarde. Si le piden datos: Marisol Gutiérrez Paz, DNI 40125896." },
  { id: "n03-nino-golpe-diente", channel: "wa_nuevo", persona: "Ricardo, papá de Thiago (9 años), que se golpeó un diente de adelante en el recreo; se le mueve un poco y le duele. Quiere que lo vean hoy si se puede. Escribe apurado." },
  { id: "n04-muela-juicio", channel: "wa_nuevo", persona: "Daniela, 26 años. Pregunta cuánto cuesta sacarse una muela del juicio y cuántos días de descanso necesita. Solo quiere la información." },
  { id: "n05-cambia-a-viernes", channel: "wa_nuevo", persona: "Óscar. Quiere una limpieza. Cuando le ofrezcan horarios, elige uno; después de que Sofi se lo proponga dice «mejor el viernes en la tarde» y, cuando le den el viernes, confirma. Si le piden datos: Óscar Rivas León, DNI 45632189." },
  { id: "n06-alineadores", channel: "wa_nuevo", persona: "Fiorella, 29 años. Quiere ortodoncia invisible (alineadores). Pregunta precio, si hay cuotas y cuánto dura el tratamiento." },
  { id: "n07-hija-a-mi-cita", channel: "wa_conocido", patientName: "Rosa Quispe", persona: "Rosa Quispe, paciente. Pregunta si puede llevar a su hija de 12 años a su misma cita para que también la revisen." },
  { id: "n08-cambiar-doctor", channel: "wa_conocido", patientName: "Carlos Paredes", persona: "Carlos Paredes, paciente. Quiere cambiar su próxima cita a otro día de esta semana y con otro doctor, el que sea." },
  { id: "n09-nadie-contesta", channel: "wa_nuevo", persona: "Gustavo está molesto: llamó tres veces a la clínica y nadie le contestó el teléfono. Quiere hablar con alguien ya para una cotización de implantes." },
  { id: "n10-limpieza-web-sin-datos", channel: "web_nuevo", persona: "Paula escribe desde la página web. Quiere una limpieza mañana. Al principio no da datos; si le piden un contacto, deja su WhatsApp 945112233. Si le piden más: Paula Rojas Díaz, DNI 47125896." },
  { id: "n11-ninos-web", channel: "web_nuevo", persona: "Alguien escribe desde la web: pregunta si atienden niños de 5 años y cuánto cuesta la evaluación. No quiere agendar todavía." },
  { id: "n12-turista-ingles", channel: "wa_nuevo", persona: "John, a tourist from Canada staying in Miraflores. Writes only in English. Wants a dental cleaning this week and asks the price. If asked for data: John Miller, passport AB123456." },
  { id: "n13-no-aguanto", channel: "wa_nuevo", persona: "Kevin, 31 años. Escribe: le duele muchísimo una muela, no aguanta, tomó pastillas y no le pasa. Quiere que lo atiendan hoy mismo. Si le piden datos: Kevin Soto Ramos, DNI 70145236." },
  { id: "n14-radiografia", channel: "wa_nuevo", persona: "Lorena se sacó una radiografía en otro lado y quiere que la clínica le diga si tiene caries mirando la foto que puede mandar. No es paciente." },
  { id: "n15-boleta", channel: "wa_conocido", patientName: "Elena Huamán", persona: "Elena Huamán, paciente. Pide la boleta de su último pago para presentarla en su trabajo." },
  { id: "n16-precio-corto", channel: "wa_nuevo", burst: ["precio?"], persona: "Alguien que escribe muy corto: primero solo «precio?», luego «de la limpieza», luego «y sábado atienden?». No da más contexto." },
  { id: "n17-silla-de-ruedas", channel: "wa_nuevo", persona: "Doña Carmen, 78 años, en silla de ruedas. Trata de usted. Pregunta si la sede de Miraflores tiene acceso para silla de ruedas y quiere una cita para una revisión. Si le piden datos: Carmen Salas Vda. de Ríos, DNI 06235147." },
  { id: "n18-tarjeta-cuotas", channel: "wa_nuevo", persona: "Hernán pregunta si puede pagar un tratamiento con tarjeta de crédito en cuotas sin intereses." },
  { id: "n19-blanqueamiento-embarazo", channel: "wa_nuevo", persona: "Valeria, embarazada de 4 meses. Pregunta si puede hacerse un blanqueamiento estando embarazada y, si no, quiere una limpieza." },
  { id: "n20-confirmar-asistencia", channel: "wa_conocido", patientName: "Carmen Rojas", persona: "Carmen Rojas, paciente. Escribe para confirmar que sí va a ir a su próxima cita y pregunta si debe llevar algo." },
]

const LATIDIA_2: Scenario[] = [
  { id: "m01-caso-reportado-probar", channel: "probar", persona: "", script: ["hola", "tengo dolor de cabeza fuerte desde ayer, donde me pueden atender", "no me pueden dar una cita??", "la que sea mas pronto", "ok esa", "confirmo"] },
  { id: "m02-gripe-fiebre", channel: "wa_nuevo", persona: "Lucía, 35 años. Tiene gripe con fiebre de 38,5 desde ayer. Quiere una cita hoy en la tarde. Si le piden datos: Lucía Mendoza Ríos, DNI 41258963." },
  { id: "m03-dolor-estomago", channel: "wa_nuevo", persona: "Jorge, 44 años. Tiene dolor de estómago fuerte después de comer desde hace dos días. Quiere que lo atiendan pronto." },
  { id: "m04-chequeo-anual", channel: "wa_nuevo", persona: "Patricia, 50 años. Quiere un chequeo general anual con análisis. Pregunta qué incluye y cuánto cuesta. Si le conviene, agenda un sábado. Si le piden datos: Patricia Luna Vega, DNI 09875412." },
  { id: "m05-bebe-fiebre", channel: "wa_nuevo", persona: "Carla, mamá de un bebé de 6 meses que tiene fiebre de 39,5 y no quiere lactar desde la mañana. Escribe muy preocupada." },
  { id: "m06-cancelar", channel: "wa_conocido", patientName: "Julia Ramos Vega", persona: "Julia Ramos Vega, paciente. Quiere cancelar su cita porque ya se siente mejor. Si le ofrecen reprogramar, dice que no por ahora." },
  { id: "m07-ginecologia", channel: "wa_nuevo", persona: "Andrea, 30 años. Quiere una consulta de ginecología para un control. Pregunta precio y quiere la próxima semana. Si le piden datos: Andrea Paz Salinas, DNI 72569841." },
  { id: "m08-certificado-colegio-web", channel: "web_nuevo", persona: "Roberto escribe desde la web. Necesita un certificado de salud para el colegio de su hijo de 8 años. Pregunta si lo hacen y cuánto cuesta. Si le piden contacto: correo roberto.ch@gmail.com." },
  { id: "m09-diabetes-sis", channel: "wa_nuevo", persona: "Don Ernesto, 66 años, diabético. Trata de usted. Pregunta si aceptan SIS o EsSalud para su control de diabetes; si no, cuánto cuesta particular." },
  { id: "m10-proximo-control", channel: "wa_conocido", patientName: "Luis Gómez Salas", persona: "Luis Gómez Salas, paciente. Pregunta cuándo le toca su próximo control de presión y si ya puede agendarlo." },
  { id: "m11-garganta-ibuprofeno", channel: "wa_nuevo", persona: "Mónica tiene dolor de garganta desde hace dos días. Pregunta si puede tomar ibuprofeno y también quiere una cita mañana. Si le piden datos: Mónica Ríos Paz, DNI 46321587." },
  { id: "m12-electrocardiograma", channel: "wa_nuevo", persona: "Felipe necesita un electrocardiograma para un trámite. Pregunta precio y si puede ser el sábado. Si le piden datos: Felipe Díaz Rojas, DNI 43698521." },
  { id: "m13-rodilla-web", channel: "web_nuevo", persona: "Natalia escribe desde la web. Le duele la rodilla cuando corre desde hace un mes. Quiere una cita. Si le piden contacto: correo natalia.runner@gmail.com. Si le piden más: Natalia Vargas Poma, DNI 47896321." },
  { id: "m14-reclamo-espera", channel: "wa_conocido", patientName: "Rosa Paredes Luna", persona: "Rosa Paredes Luna, paciente. Está molesta: en su última cita la hicieron esperar una hora. Quiere que alguien le explique." },
  { id: "m15-hablar-con-vela", channel: "wa_nuevo", persona: "Claudia quiere hablar con la Dra. Vela sobre unos resultados que le dieron en otro lugar; no quiere contárselo a un asistente." },
  { id: "m16-cambia-de-hora", channel: "wa_nuevo", persona: "Iván quiere una consulta de medicina general. Primero pide hoy; cuando Sofi le proponga una hora, dice «mejor mañana temprano» y, cuando le den mañana, confirma. Si le piden datos: Iván Paredes Sol, DNI 45213698." },
]

const SET_2 = env.TANDA === "2"
const SCENARIOS = (PRODUCT === "odentia" ? (SET_2 ? ODENTIA_2 : ODENTIA) : SET_2 ? LATIDIA_2 : LATIDIA).filter((s) => ONLY.length === 0 || ONLY.some((id) => s.id.startsWith(id)))

const storageStub = {
  putAvatar: async () => { throw new Error("no usado") },
  deleteByUrl: async () => {},
  putAttachment: async () => { throw new Error("no usado") },
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => { throw new Error("no usado") },
  putPatientAvatar: async () => { throw new Error("no usado") },
}
const inOrg = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, ORG, fn)

/** Herramientas que pidió el modelo que escribe en cada turno, en orden. */
let toolsUsed: string[] = []
const recorder = BaseCallbackHandler.fromMethods({
  handleLLMEnd(output) {
    const reply = (output.generations[0]?.[0] as { message?: AIMessage } | undefined)?.message
    for (const call of reply?.tool_calls ?? []) toolsUsed.push(`${call.name}(${JSON.stringify(call.args).slice(0, 300)})`)
  },
})
// Lo mismo que el worker de producción: enlaces públicos y búsqueda por vectores.
const publicLinks = { webURL: env.WEB_URL!, cookieDomain: env.COOKIE_DOMAIN!, productDomains: env.MEDICAL_DOMAIN ? { medical: env.MEDICAL_DOMAIN } : {} }
configurePublicLinks(publicLinks)
const embedder = embedderFromEnv(env as never)
const runtime: AgentRuntime = {
  publicUrl: publicLinks,
  ownerDb,
  ...(embedder ? { embedder } : {}),
  platform: { ...platformLlmFromEnv(env), timeoutMs: 120_000, maxRetries: 2 },
  decisions: { jev: { apiKey: env.JEV_API_KEY!, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL }, timeoutMs: 8000 },
  secretsKey: KEY,
  callbacks: [recorder],
}

/** El paciente simulado: solo conoce su papel y lo que se dijo. */
const patientModel = new ChatOpenAI({ model: "gpt-6-luna", apiKey: env.LLM_OPENAI_API_KEY, useResponsesApi: true, timeout: 120_000, maxRetries: 2 })

async function nextPatientMessage(scenario: Scenario, transcript: Array<{ from: string; text: string }>): Promise<{ text: string; done: boolean }> {
  const history = transcript.map((line) => `${line.from === "paciente" ? "TÚ" : "CLÍNICA"}: ${line.text}`).join("\n")
  const prompt = `Eres una persona real que escribe por chat a ${CLINIC}. Tu papel:
${scenario.persona}

Escribe como escribe la gente en WhatsApp en Perú: natural, breve, a veces sin tildes. Responde a lo que la clínica te dijo o preguntó. Si te piden datos que tu papel no trae, invéntalos con naturalidad. No inventes otro objetivo. Si tu objetivo ya se cumplió, si ya te despediste o si la conversación no avanza después de insistir una vez, termina.

Conversación hasta ahora:
${history || "(todavía no escribiste nada)"}

Devuelve solo un JSON: {"mensaje": "lo que escribes ahora", "fin": false}. Si ya no escribirías nada más, {"mensaje": "", "fin": true}.`
  const reply = await patientModel.invoke(prompt)
  const raw = typeof reply.content === "string" ? reply.content : reply.content.map((part) => ("text" in part ? part.text : "")).join("")
  const json = /\{[\s\S]*\}/.exec(raw)?.[0] ?? "{}"
  try {
    const parsed = JSON.parse(json) as { mensaje?: string; fin?: boolean }
    return { text: (parsed.mensaje ?? "").trim(), done: parsed.fin === true || !(parsed.mensaje ?? "").trim() }
  } catch {
    return { text: "", done: true }
  }
}

let waConnection = ""
let webConnection = ""
let sequence = Date.now()

async function setup() {
  await inOrg((tx) => upsertAgentConfig(tx, ORG, { enabled: true, decisionProvider: "jev", decisionRoutingEnabled: true }))
  if (!embedder) throw new Error("Falta EMBEDDINGS_*: producción busca por vectores")
  console.log("índice de búsqueda:", await refreshAgentSearch(ownerDb, appDb, embedder, { maxBatchesPerOrg: 100 }))
  webConnection = await inOrg((tx) => ensureClinicWebchatConnection(tx, ORG, KEY, OWNER))
  const existing = await ownerDb.execute<{ id: string }>(
    `select id from channel_connection where organization_id = '${ORG}' and channel = 'whatsapp' and status = 'active' limit 1` as never,
  )
  waConnection = existing[0]?.id ?? (await inOrg((tx) =>
    createConnection(tx, ORG, KEY, {
      channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WhatsApp de la auditoría",
      config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S" },
    }, { fetch, validateExternal: false }))).id
}

/** Cómo llega cada mensaje del paciente según el canal: el mismo adaptador que en producción. */
async function senderFor(scenario: Scenario): Promise<(text: string) => Promise<{ conversationId: string; messageId: string }>> {
  if (scenario.channel === "probar") {
    const opened = await inOrg((tx) => openProbar(tx, ORG, OWNER, { secretsKey: KEY }))
    return (text) => inOrg((tx) => ingestInbound(tx, { orgId: ORG, connectionId: opened.connectionId, event: buildWebchatInbound(opened.sessionId, { text, clientMessageId: crypto.randomUUID() }) }, webChatAdapter, { storage: storageStub, fetch, secretsKey: KEY }))
  }
  if (scenario.channel === "web_nuevo") {
    const session = newWebchatSessionId()
    return (text) => inOrg((tx) => ingestInbound(tx, { orgId: ORG, connectionId: webConnection, event: buildWebchatInbound(session, { text, clientMessageId: crypto.randomUUID() }) }, webChatAdapter, { storage: storageStub, fetch, secretsKey: KEY }))
  }
  let phone = `519${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`
  // El nombre de perfil de WhatsApp: solo el primer nombre del papel.
  let name = scenario.persona.replace(/^Doña /, "").split(/[\s,.]/)[0]!.trim()
  if (scenario.channel === "wa_conocido") {
    const rows = await ownerDb.execute<{ contact_id: string; external_user_id: string | null }>(
      `select c.id as contact_id, (select ci.external_user_id from contact_identity ci where ci.contact_id = c.id and ci.channel = 'whatsapp' limit 1) as external_user_id
         from patient p join contact c on c.id = p.person_id
        where p.organization_id = '${ORG}' and c.display_name = '${scenario.patientName}' limit 1` as never,
    )
    const row = rows[0]
    if (!row) throw new Error(`No está ${scenario.patientName} en la demo`)
    name = scenario.patientName!
    if (row.external_user_id) {
      phone = row.external_user_id.replace(/^wa:/, "")
    } else {
      // Ya escribió antes desde su WhatsApp: el vínculo existe, no se adivina por el número.
      await ownerDb.insert(contactIdentity).values({ organizationId: ORG, contactId: row.contact_id, channel: "whatsapp", externalUserId: `wa:${phone}`, displayName: name, isPrimary: true })
    }
  }
  return (text) => {
    sequence += 1
    const id = `audit-${sequence}`
    return inOrg((tx) => ingestInbound(tx, {
      orgId: ORG, connectionId: waConnection,
      event: { externalEventId: id, externalMessageId: id, externalThreadId: `wa:${phone}`, senderExternalId: `wa:${phone}`, senderDisplayName: name, sentAt: new Date().toISOString(), content: { type: "text", text } },
    }, whatsappCloudApiAdapter, { storage: storageStub, fetch, secretsKey: KEY }))
  }
}

async function runScenario(scenario: Scenario) {
  const send = await senderFor(scenario)
  const transcript: Array<{ from: string; text: string }> = []
  const turns: unknown[] = []
  let conversationId = ""
  const maxTurns = scenario.maxTurns ?? 8
  for (let turn = 0; turn < maxTurns; turn += 1) {
    let texts: string[]
    if (scenario.script) {
      const next = scenario.script[turn]
      if (next === undefined) break
      texts = [next]
    } else if (turn === 0 && scenario.burst) {
      texts = scenario.burst
    } else {
      const next = await nextPatientMessage(scenario, transcript)
      if (next.done) break
      texts = [next.text]
    }
    const before = new Date()
    let last = { conversationId: "", messageId: "" }
    for (const text of texts) {
      last = await send(text)
      transcript.push({ from: "paciente", text })
    }
    conversationId = last.conversationId
    toolsUsed = []
    const started = Date.now()
    let error: string | null = null
    try {
      sequence += 1
      await processAgentRun(appDb, runtime, { msg_id: sequence, read_ct: 0, message: { kind: "inbound_message", orgId: ORG, conversationId, messageId: last.messageId } })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const out = await ownerDb.select({ body: message.body, at: message.createdAt, sender: message.senderKind }).from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.direction, "out"), gte(message.createdAt, before)))
      .orderBy(asc(message.createdAt))
    for (const row of out) transcript.push({ from: "sofi", text: row.body ?? "" })
    const decisions = await ownerDb.select({ point: agentDecisionLog.point, outcome: agentDecisionLog.outcome, error: agentDecisionLog.error }).from(agentDecisionLog)
      .where(and(eq(agentDecisionLog.conversationId, conversationId), gte(agentDecisionLog.createdAt, before)))
      .orderBy(asc(agentDecisionLog.createdAt))
    turns.push({ patient: texts, sofi: out.map((row) => row.body), decisions, tools: toolsUsed, error, seconds: Math.round((Date.now() - started) / 1000) })
    console.log(`[${scenario.id}] ${texts.join(" / ")} → ${out.map((row) => (row.body ?? "").slice(0, 120)).join(" / ") || "(nada)"}`)
  }
  const handoffs = conversationId
    ? await ownerDb.select({ reason: agentHandoff.reason, priority: agentHandoff.priority, kind: agentHandoff.kind, asks: agentHandoff.asks, pending: agentHandoff.pending }).from(agentHandoff).where(eq(agentHandoff.conversationId, conversationId))
    : []
  const booked = conversationId
    ? await ownerDb.select({ startsAt: appointment.startsAt, status: appointment.status, patientId: appointment.patientId, professional: appointment.professionalUserId }).from(appointment).where(eq(appointment.conversationId, conversationId))
    : []
  const contactRows = conversationId
    ? await ownerDb.execute(`select c.display_name, c.given_names, c.family_name, c.phone, c.email, (select count(*) from patient p where p.person_id = c.id) as patients from conversation v join contact c on c.id = v.contact_id where v.id = '${conversationId}'` as never)
    : []
  const result = { product: PRODUCT, scenario, conversationId, transcript, turns, handoffs, booked, contact: contactRows[0] ?? null }
  writeFileSync(join(OUT, `${scenario.id}.json`), JSON.stringify(result, null, 2))
}

mkdirSync(OUT, { recursive: true })
await setup()
for (const scenario of SCENARIOS) {
  try {
    await runScenario(scenario)
  } catch (caught) {
    console.error(`[${scenario.id}] falló:`, caught)
    writeFileSync(join(OUT, `${scenario.id}.error.txt`), String(caught instanceof Error ? caught.stack : caught))
  }
}
console.log("auditoría terminada")
process.exit(0)

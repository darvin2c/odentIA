import { type ClinicalProduct } from "@odentia/clinical"
import type { TemplateCategory } from "@odentia/channels"
import type { ConsentPurpose } from "@odentia/db/schema/automation"

/**
 * Lo que odentIA escribe por su cuenta, declarado una sola vez: el texto, los
 * datos que lleva, sus botones y a qué permiso responde. De aquí salen la
 * plantilla que se pide a WhatsApp, el texto que se envía dentro de las 24
 * horas y el correo de respaldo: los tres dicen lo mismo.
 *
 * Los datos los pone el sistema (agenda, presupuestos, controles) al entregar;
 * ningún texto de aquí sale de un modelo. Estos son los textos con los que
 * viene cada clínica: cada una puede cambiarlos (`clinic-messages.ts`), y un
 * texto nuevo, de odentIA o de la clínica, es siempre otra plantilla con otro
 * nombre, nunca el cuerpo cambiado de una ya pedida.
 */

/** Qué hace un botón cuando la persona lo toca. */
/**
 * Lo que puede devolver un botón. «permiso_si» y «permiso_no» son la respuesta
 * a la pregunta del permiso general tras reservar: su id lleva la persona, no
 * un trabajo (`generalPermissionButtons`).
 */
/**
 * «presupuesto» era «Ver y responder» de la primera versión de «Presupuesto
 * listo»: tocarlo deja el PDF en la conversación. Desde «Su enlace» (ADR
 * 0037) ese botón abre su enlace (`MessageSpec.link`); la acción queda para
 * los mensajes que ya salieron con la versión anterior.
 */
export const REPLY_ACTIONS = ["confirmar", "responder", "baja", "permiso_si", "permiso_no", "presupuesto", "ver_respuesta"] as const
export type ReplyAction = (typeof REPLY_ACTIONS)[number]

export interface MessageButton {
  /**
   * `confirmar` y `baja` los resuelve el sistema sin modelo; `responder` sigue
   * la conversación con el agente o con una persona.
   */
  action: ReplyAction
  title: string
  /**
   * Lo que la persona pide al tocar un botón que sigue la conversación: una
   * cita nueva (`reservar`) o mover la que tiene (`cambiar`). Con esto el turno
   * de Recepción ya sabe por dónde ir, sin preguntárselo a un modelo.
   */
  asks?: "reservar" | "cambiar"
}

/** Un mensaje ya escrito: lo que se pide a WhatsApp y lo que se envía. */
export interface MessageSpec {
  key: string
  /** La que se pide; el proveedor puede asignar otra. */
  category: TemplateCategory
  template: string
  /** Variables por posición: `{{1}}` es `variables[0]`. */
  body: string
  variables: readonly MessageVariable[]
  /** Botones de respuesta rápida, después del enlace si lo hay. */
  buttons: readonly MessageButton[]
  /**
   * Botón que abre «Su enlace» de la persona (ADR 0037): en WhatsApp es un botón
   * de dirección con el token al final; dentro de las 24 horas y por correo, la
   * dirección va escrita al final del texto. Lo pone el sistema al enviar.
   */
  link?: { title: string }
}

export interface AutomationMessage extends MessageSpec {
  key: AutomationMessageKey
  purpose: ConsentPurpose
  /** Asunto cuando sale por correo. */
  subject: string
}

/** Datos que un mensaje puede llevar. Cada uno tiene un ejemplo para pedir la plantilla. */
export const MESSAGE_VARIABLES = {
  persona: { label: "Nombre de la persona", example: "Lucía" },
  lugar: { label: "Clínica y sede", example: "Clínica Sonríe, sede Centro" },
  clinica: { label: "Nombre de la clínica", example: "Clínica Sonríe" },
  citas: {
    label: "Fecha, hora y profesional de la cita",
    example: "mañana, martes 13 de octubre, a las 10:00, con Dra. Ana Torres",
  },
  cita_pasada: { label: "Fecha de la cita que no se dio", example: "lunes 12 de octubre" },
  control: { label: "Control pendiente", example: "Control de ortodoncia" },
  presupuesto: { label: "Título del presupuesto", example: "Ortodoncia" },
  // El ejemplo que se manda a WhatsApp lleva la moneda de la clínica (`exampleValues` en `clinic-messages.ts`).
  resumen_presupuesto: { label: "Tratamientos y total del presupuesto", example: "3 tratamientos por 540" },
  oportunidad: { label: "Título de la oportunidad", example: "Ortodoncia" },
} as const
export type MessageVariable = keyof typeof MESSAGE_VARIABLES

/**
 * Los ejemplos que cambian en un consultorio (issue 229): la vista previa, la
 * línea de Argos y lo que se manda a Meta para aprobar la plantilla no deben
 * hablar de ortodoncia en latidIA.
 */
const PRODUCT_EXAMPLES: Partial<Record<ClinicalProduct, Partial<Record<MessageVariable, string>>>> = {
  medical: {
    lugar: "Consultorio Vida, sede Centro",
    clinica: "Consultorio Vida",
    control: "Control de presión arterial",
    presupuesto: "Chequeo preventivo",
    oportunidad: "Chequeo preventivo",
  },
}

/** Los valores de ejemplo de cada dato, con los del producto. */
export function messageExampleValues(product: ClinicalProduct = "dental"): Record<MessageVariable, string> {
  const values = Object.fromEntries(
    Object.entries(MESSAGE_VARIABLES).map(([name, spec]) => [name, spec.example]),
  ) as Record<MessageVariable, string>
  return { ...values, ...PRODUCT_EXAMPLES[product] }
}

/**
 * Lo que se puede apagar se apaga con un toque, de ese tipo de mensaje y no de
 * los demás. Los avisos de lo que pasó no lo llevan: siempre salen (ADR 0040).
 */
const OPT_OUT: MessageButton = { action: "baja", title: "No enviar más" }
/**
 * El atajo del recordatorio: apaga solo los recordatorios. WhatsApp admite 20
 * caracteres en un botón dentro de las 24 horas: «No quiero recordatorios» no
 * entra, y por eso dice «No más recordatorios».
 */
const NO_REMINDERS: MessageButton = { action: "baja", title: "No más recordatorios" }

/**
 * Avisos de «Recordar la cita» cuando la cita cambia: se reservó, se movió o se
 * canceló. Son de la misma línea y cada uno es un trabajo de su propio tipo,
 * con la clave de su mensaje (ADR 0027). Son avisos de lo que pasó: salen
 * siempre, sin botón de baja, y solo los frena «No quiero ningún mensaje de la
 * clínica» (ADR 0040).
 */
export const APPOINTMENT_NOTICE_KEYS = ["aviso_cita_reservada", "aviso_cita_movida", "aviso_cita_cancelada"] as const
export type AppointmentNoticeKey = (typeof APPOINTMENT_NOTICE_KEYS)[number]

export function isAppointmentNotice(kind: string): kind is AppointmentNoticeKey {
  return (APPOINTMENT_NOTICE_KEYS as readonly string[]).includes(kind)
}

/**
 * El aviso de cita reservada cuando a la persona le faltan datos para
 * atenderla: el mismo aviso, con el botón de «Su enlace» para completarlos
 * antes de venir (decisión 8). No es otro trabajo: sale en lugar del aviso de
 * reserva cuando faltan datos, y así no se le manda un segundo mensaje ese día.
 */
export const APPOINTMENT_DATA_NOTICE_KEY = "aviso_cita_reservada_datos"

/**
 * El recordatorio de la cita cuando a la persona aún le faltan datos (fase 3
 * del lienzo «Su enlace y el código QR»): el mismo recordatorio, con el botón
 * «Completar mis datos» que abre su enlace. Sale en lugar del recordatorio y
 * solo cuando WhatsApp lo aprobó; mientras tanto sale el de siempre.
 */
export const REMINDER_DATA_KEY = "recordatorio_cita_datos"

export const AUTOMATION_MESSAGE_KEYS = [
  "recordatorio_cita",
  REMINDER_DATA_KEY,
  // Los avisos de la cita van junto a su línea, «Recordar la cita»; el de
  // reserva con «Su enlace», junto al de reserva.
  "aviso_cita_reservada",
  APPOINTMENT_DATA_NOTICE_KEY,
  "aviso_cita_movida",
  "aviso_cita_cancelada",
  "recordatorio_control",
  "seguimiento_presupuesto",
  "seguimiento_comercial",
  "seguimiento_no_asistencia",
  "cita_cancelada",
  "invitar_a_volver",
] as const
export type AutomationMessageKey = (typeof AUTOMATION_MESSAGE_KEYS)[number]

export const AUTOMATION_MESSAGES: Record<AutomationMessageKey, AutomationMessage> = {
  // «Recordatorios de tus citas»: el único que se apaga con «No más recordatorios».
  recordatorio_cita: {
    key: "recordatorio_cita",
    purpose: "recordatorio",
    category: "utility",
    template: "odentia_recordatorio_cita_v2",
    body: "Hola, {{1}}. Te recordamos la cita en {{2}}: {{3}}. Si necesitas cambiarla, responde a este mensaje.",
    variables: ["persona", "lugar", "citas"],
    buttons: [
      { action: "confirmar", title: "Confirmar" },
      { action: "responder", title: "No podré ir", asks: "cambiar" },
      NO_REMINDERS,
    ],
    subject: "Recordatorio de cita",
  },
  recordatorio_cita_datos: {
    key: "recordatorio_cita_datos",
    purpose: "recordatorio",
    category: "utility",
    template: "odentia_recordatorio_cita_datos_v1",
    body: "Hola, {{1}}. Te recordamos la cita en {{2}}: {{3}}. Aún nos faltan algunos datos tuyos: complétalos antes de venir y te atendemos más rápido.",
    variables: ["persona", "lugar", "citas"],
    link: { title: "Completar mis datos" },
    buttons: [
      { action: "confirmar", title: "Confirmar" },
      { action: "responder", title: "No podré ir", asks: "cambiar" },
      NO_REMINDERS,
    ],
    subject: "Recordatorio de cita: completa tus datos",
  },
  // «Controles y seguimiento»: se apaga aparte de los recordatorios de la cita.
  recordatorio_control: {
    key: "recordatorio_control",
    purpose: "seguimiento",
    category: "utility",
    template: "odentia_recordatorio_control_v1",
    body: "Hola, {{1}}. En {{2}} tienes pendiente este control: {{3}}. Responde a este mensaje y te buscamos un horario.",
    variables: ["persona", "clinica", "control"],
    buttons: [{ action: "responder", title: "Quiero agendar", asks: "reservar" }, OPT_OUT],
    subject: "Tienes un control pendiente",
  },
  // WhatsApp lo cuenta como promoción: solo a quien aceptó novedades (ADR 0040).
  seguimiento_presupuesto: {
    key: "seguimiento_presupuesto",
    purpose: "novedades",
    category: "marketing",
    template: "odentia_seguimiento_presupuesto_v1",
    body: "Hola, {{1}}. El presupuesto «{{2}}» que te presentamos en {{3}} sigue pendiente. ¿Quieres retomarlo o tienes alguna duda?",
    variables: ["persona", "presupuesto", "clinica"],
    buttons: [{ action: "responder", title: "Quiero retomarlo", asks: "reservar" }, OPT_OUT],
    subject: "Tu presupuesto sigue pendiente",
  },
  // Retoma una consulta que quedó con su próxima acción vencida. El botón no fija
  // camino: la persona sigue la conversación con Recepción, que sabe de qué
  // oportunidad viene por su contacto. Es promoción: solo con su sí de novedades.
  seguimiento_comercial: {
    key: "seguimiento_comercial",
    purpose: "novedades",
    category: "marketing",
    template: "odentia_seguimiento_oportunidad_v1",
    body: "Hola, {{1}}. Te escribimos de {{2}} sobre tu consulta de «{{3}}». ¿Seguimos conversando?",
    variables: ["persona", "clinica", "oportunidad"],
    buttons: [{ action: "responder", title: "Sí, continuemos" }, OPT_OUT],
    subject: "¿Seguimos conversando?",
  },
  seguimiento_no_asistencia: {
    key: "seguimiento_no_asistencia",
    purpose: "seguimiento",
    category: "utility",
    template: "odentia_seguimiento_inasistencia_v1",
    body: "Hola, {{1}}. No pudimos verte en la cita del {{2}} en {{3}}. ¿Te buscamos otro horario?",
    variables: ["persona", "cita_pasada", "clinica"],
    buttons: [{ action: "responder", title: "Sí, otro horario", asks: "reservar" }, OPT_OUT],
    subject: "¿Reprogramamos tu cita?",
  },
  // «Invitar a volver» (issue 139): quien no viene hace seis meses. Controles y seguimiento: se apaga aparte.
  invitar_a_volver: {
    key: "invitar_a_volver",
    purpose: "seguimiento",
    category: "utility",
    template: "odentia_invitar_a_volver_v1",
    body: "Hola, {{1}}. Hace más de seis meses que no te vemos en {{2}}. ¿Te buscamos un horario para tu control?",
    variables: ["persona", "clinica"],
    buttons: [{ action: "responder", title: "Sí, otro horario", asks: "reservar" }, OPT_OUT],
    subject: "¿Te buscamos un horario para tu control?",
  },
  // Lo recibe quien coordina la cita, que puede no ser quien la canceló: por eso
  // no dice «cancelaste».
  cita_cancelada: {
    key: "cita_cancelada",
    purpose: "seguimiento",
    category: "utility",
    template: "odentia_cita_cancelada_v1",
    body: "Hola, {{1}}. Se canceló la cita del {{2}} en {{3}}. ¿Te buscamos otra fecha?",
    variables: ["persona", "cita_pasada", "clinica"],
    buttons: [{ action: "responder", title: "Sí, otra fecha", asks: "reservar" }, OPT_OUT],
    subject: "¿Te buscamos otra fecha?",
  },
  // Los tres avisos de «Recordar la cita». No piden confirmar: eso lo pide el
  // recordatorio, cerca de la fecha. Son avisos: sin botón de baja (ADR 0040).
  aviso_cita_reservada: {
    key: "aviso_cita_reservada",
    purpose: "avisos",
    category: "utility",
    template: "odentia_aviso_cita_reservada_v2",
    body: "Hola, {{1}}. Tu cita en {{2}} quedó reservada: {{3}}. Si necesitas cambiarla, responde a este mensaje.",
    variables: ["persona", "lugar", "citas"],
    buttons: [{ action: "responder", title: "No podré ir", asks: "cambiar" }],
    subject: "Tu cita quedó reservada",
  },
  aviso_cita_reservada_datos: {
    key: "aviso_cita_reservada_datos",
    purpose: "avisos",
    category: "utility",
    template: "odentia_aviso_cita_datos_v2",
    body: "Hola, {{1}}. Te esperamos en {{2}}: {{3}}. Antes de venir, completa tus datos aquí.",
    variables: ["persona", "lugar", "citas"],
    link: { title: "Ver mi cita y mis datos" },
    buttons: [],
    subject: "Tu cita quedó reservada: completa tus datos",
  },
  aviso_cita_movida: {
    key: "aviso_cita_movida",
    purpose: "avisos",
    category: "utility",
    template: "odentia_aviso_cita_movida_v2",
    body: "Hola, {{1}}. Tu cita en {{2}} cambió de fecha: ahora es {{3}}. Si no te queda bien, responde a este mensaje.",
    variables: ["persona", "lugar", "citas"],
    buttons: [{ action: "responder", title: "No podré ir", asks: "cambiar" }],
    subject: "Tu cita cambió de fecha",
  },
  aviso_cita_cancelada: {
    key: "aviso_cita_cancelada",
    purpose: "avisos",
    category: "utility",
    template: "odentia_aviso_cita_cancelada_v2",
    body: "Hola, {{1}}. Tu cita del {{2}} en {{3}} quedó cancelada. ¿Te buscamos otra fecha?",
    variables: ["persona", "cita_pasada", "clinica"],
    buttons: [{ action: "responder", title: "Sí, otra fecha", asks: "reservar" }],
    subject: "Tu cita quedó cancelada",
  },
}

/**
 * Lo que cambia en un producto (issue 229): latidIA invita a volver al año
 * (`recallMonths`), así que su texto dice «un año» y es otra plantilla, con su
 * propio nombre para que Meta la apruebe aparte. La de odentIA no cambia.
 */
const PRODUCT_MESSAGES: Partial<Record<ClinicalProduct, Partial<Record<AutomationMessageKey, Pick<AutomationMessage, "template" | "body">>>>> = {
  medical: {
    invitar_a_volver: {
      template: "latidia_invitar_a_volver_v1",
      body: "Hola, {{1}}. Hace más de un año que no te vemos en {{2}}. ¿Te buscamos un horario para tu control?",
    },
  },
}

/** Todas las plantillas de un mensaje, de cualquier producto: un nombre que no hay que tratar como ajeno. */
export function productTemplatesOf(key: AutomationMessageKey): string[] {
  return [
    AUTOMATION_MESSAGES[key].template,
    ...Object.values(PRODUCT_MESSAGES).flatMap((messages) => (messages?.[key] ? [messages[key].template] : [])),
  ]
}

export function automationMessageOf(kind: string, product: ClinicalProduct = "dental"): AutomationMessage | null {
  if (!(AUTOMATION_MESSAGE_KEYS as readonly string[]).includes(kind)) return null
  const key = kind as AutomationMessageKey
  return { ...AUTOMATION_MESSAGES[key], ...PRODUCT_MESSAGES[product]?.[key] }
}

/**
 * El mensaje que retoma una consulta pasadas 24 horas, cuando WhatsApp ya no
 * deja escribir con libertad: lo envía una persona desde la Bandeja o el
 * sistema cuando el agente tiene que responder fuera de la ventana (un caso
 * que el equipo devolvió tarde; ADR 0040). Continúa una consulta que la
 * persona inició: no pide permiso, solo se ofrece donde ella ya escribió y
 * solo lo frena «No quiero ningún mensaje».
 */
export const RESUME_MESSAGE_KEY = "retomar_conversacion"
export const RESUME_MESSAGE: MessageSpec = {
  key: RESUME_MESSAGE_KEY,
  category: "utility",
  template: "odentia_retomar_conversacion_v1",
  body: "Hola, {{1}}. Te escribimos de {{2}} para continuar con tu consulta. ¿Seguimos por aquí?",
  variables: ["persona", "clinica"],
  buttons: [{ action: "responder", title: "Sí, continuemos" }],
}

/**
 * «Ver respuesta» (R1 del pulido de la Bandeja): alguien del equipo respondió
 * un tema pasadas las 24 horas, cuando WhatsApp ya no deja escribir con
 * libertad. La respuesta queda «Por entregar» y sale este aviso; al tocar «Ver
 * respuesta» (o al volver a escribir) le llega la respuesta citando su
 * pregunta. Es la respuesta a lo que la persona preguntó: no pide permiso y
 * solo lo frena «No quiero ningún mensaje». Varias respuestas pendientes salen
 * con un solo aviso.
 */
export const ANSWER_READY_MESSAGE_KEY = "ver_respuesta"
export const ANSWER_READY_MESSAGE: MessageSpec = {
  key: ANSWER_READY_MESSAGE_KEY,
  category: "utility",
  template: "odentia_ver_respuesta_v1",
  body: "Hola, {{1}}. {{2}} respondió tu consulta. Toca «Ver respuesta» para leerla.",
  variables: ["persona", "clinica"],
  buttons: [{ action: "ver_respuesta", title: "Ver respuesta" }],
}

/**
 * «Presupuesto listo» (paso 3 de la fase 3): lo envía quien entrega el
 * presupuesto desde Plan o el cierre de la atención, y el agente cuando la
 * persona se lo pide por el chat. Es un aviso de lo que pasó (ADR 0040): no
 * pide permiso y solo deja de salir con «No quiero ningún mensaje».
 * «Ver y responder» abre «Su enlace», donde lo ve y responde
 * (ADR 0037). Por WhatsApp dentro de las 24 horas sale con el PDF y su
 * enlace; por correo, con el PDF adjunto y su enlace.
 */
export const BUDGET_READY_MESSAGE_KEY = "presupuesto_listo"
export const BUDGET_READY_MESSAGE: MessageSpec = {
  key: BUDGET_READY_MESSAGE_KEY,
  category: "utility",
  template: "odentia_presupuesto_listo_v2",
  body: "Hola, {{1}}. Tu presupuesto está listo: {{2}}. Puedes verlo y decirnos qué aceptas aquí.",
  variables: ["persona", "resumen_presupuesto"],
  link: { title: "Ver y responder" },
  buttons: [],
}
/** Asunto cuando «Presupuesto listo» sale por correo. */
export const BUDGET_READY_SUBJECT = "Tu presupuesto está listo"

/**
 * «Su enlace» (ADR 0037): lo envía recepción con «Enviarle su enlace» (datos
 * por completar, un consentimiento por firmar) y lleva solo el botón que lo
 * abre. Es un aviso, como el de su cita (ADR 0040): no pide permiso y solo
 * deja de salir con «No quiero ningún mensaje». También avisa de sus papeles
 * fuera de las 24 horas («Tus papeles», decisión 8): el texto ya aprobado dice
 * «te dejamos aquí lo que tienes pendiente».
 */
export const PERSONAL_LINK_MESSAGE_KEY = "su_enlace"
export const PERSONAL_LINK_MESSAGE: MessageSpec = {
  key: PERSONAL_LINK_MESSAGE_KEY,
  category: "utility",
  template: "odentia_su_enlace_v1",
  body: "Hola, {{1}}. En {{2}} te dejamos aquí lo que tienes pendiente con nosotros.",
  variables: ["persona", "clinica"],
  link: { title: "Ver lo pendiente" },
  buttons: [],
}
/** Asunto cuando «Su enlace» sale por correo. */
export const PERSONAL_LINK_SUBJECT = "Lo que tienes pendiente con la clínica"

/**
 * El tipo de los avisos que no son de una línea: «Presupuesto listo», «Su
 * enlace», «Retomar la conversación» y los papeles (receta y comprobante).
 * Salen siempre y solo los frena «No quiero ningún mensaje» (ADR 0040).
 */
export const NOTICE_PURPOSE = "avisos" satisfies ConsentPurpose

/** Los mensajes con los que viene cada clínica: los que envía el agente, el de la Bandeja, el del presupuesto y «Su enlace». */
export const CATALOG_MESSAGE_KEYS = [
  ...AUTOMATION_MESSAGE_KEYS,
  RESUME_MESSAGE_KEY,
  BUDGET_READY_MESSAGE_KEY,
  PERSONAL_LINK_MESSAGE_KEY,
  ANSWER_READY_MESSAGE_KEY,
] as const
export type CatalogMessageKey = (typeof CATALOG_MESSAGE_KEYS)[number]

export function catalogMessageOf(key: string, product: ClinicalProduct = "dental"): MessageSpec | null {
  if (key === RESUME_MESSAGE_KEY) return RESUME_MESSAGE
  if (key === BUDGET_READY_MESSAGE_KEY) return BUDGET_READY_MESSAGE
  if (key === PERSONAL_LINK_MESSAGE_KEY) return PERSONAL_LINK_MESSAGE
  if (key === ANSWER_READY_MESSAGE_KEY) return ANSWER_READY_MESSAGE
  return automationMessageOf(key, product)
}

/** Las plantillas de un mensaje del catálogo en todos los productos. */
export function catalogTemplatesOf(key: string): string[] {
  return (AUTOMATION_MESSAGE_KEYS as readonly string[]).includes(key)
    ? productTemplatesOf(key as AutomationMessageKey)
    : [catalogMessageOf(key)?.template ?? ""]
}

/**
 * El texto con «Su enlace» escrito al final: lo que sale dentro de las 24
 * horas de WhatsApp y por correo, donde no hay botón de dirección.
 */
export function withLinkLine(text: string, link: { title: string } | undefined, url: string | null): string {
  return link && url ? `${text}\n\n${link.title}: ${url}` : text
}

/** Idioma de las plantillas: el de los textos del producto, sin variante de país. */
export const AUTOMATION_MESSAGE_LANGUAGE = "es"

/**
 * WhatsApp rechaza una variable con saltos de línea, tabulaciones o más de
 * cuatro espacios seguidos, y una vacía. Se limpia aquí para todas las vías.
 */
/**
 * «Clínica, sede X» para el dato `lugar`. Si la sede ya se llama «Sede …», no se
 * repite la palabra («Dental Smile, Sede Miraflores», no «sede Sede Miraflores»).
 */
export function placePhrase(clinic: string, branchName: string): string {
  const name = branchName.trim()
  return /^sede\b/i.test(name) ? `${clinic}, ${name}` : `${clinic}, sede ${name}`
}

/**
 * Un dato va siempre dentro de una frase que pone su propio punto: el punto
 * final del dato («Dental Smile S.A.C.») se quita para no escribir «S.A.C..».
 */
export function cleanVariable(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\.+$/, "")
}

/** Pone cada dato en su posición. Lanza si falta alguno: no se envía un mensaje a medias. */
export function renderMessage(
  spec: Pick<MessageSpec, "key" | "body" | "variables">,
  values: Partial<Record<MessageVariable, string>>,
) {
  const params = spec.variables.map((name) => {
    const value = cleanVariable(values[name] ?? "")
    if (!value) throw new Error(`Al mensaje «${spec.key}» le falta el dato «${name}»`)
    return value
  })
  const text = spec.body.replace(/\{\{(\d+)\}\}/g, (_, position: string) => params[Number(position) - 1] ?? "")
  return { params, text }
}

/** Valores de ejemplo, en el orden de las variables, para pedir la plantilla. */
export function messageExamples(spec: Pick<MessageSpec, "variables">): string[] {
  return spec.variables.map((name) => MESSAGE_VARIABLES[name].example)
}

// ------------------------------------------------- datos por nombre ---

/**
 * Quien edita un texto escribe sus datos por nombre (`{{persona}}`); WhatsApp
 * los recibe por posición (`{{1}}`). Las dos formas dicen lo mismo y se
 * convierten aquí, en un solo sitio.
 */
const NAMED_DATA = /\{\{\s*([^{}\s]+)\s*\}\}/g

export function isMessageVariable(name: string): name is MessageVariable {
  return Object.hasOwn(MESSAGE_VARIABLES, name)
}

/** El cuerpo por posición, con cada dato por su nombre. */
export function namedBody(spec: Pick<MessageSpec, "body" | "variables">): string {
  return spec.body.replace(/\{\{(\d+)\}\}/g, (whole, position: string) => {
    const name = spec.variables[Number(position) - 1]
    return name ? `{{${name}}}` : whole
  })
}

/** Datos que nombra un texto, en el orden en que aparecen y con sus repeticiones. */
export function dataNamesOf(body: string): string[] {
  return [...body.matchAll(NAMED_DATA)].map((match) => match[1] ?? "")
}

/**
 * El texto con datos por nombre, llevado a posiciones: el primero que aparece
 * es `{{1}}`. Solo vale para un texto ya validado (datos conocidos, una vez cada uno).
 */
export function positionalBody(body: string): { body: string; variables: MessageVariable[] } {
  const variables: MessageVariable[] = []
  const text = body.replace(NAMED_DATA, (whole, name: string) => {
    if (!isMessageVariable(name)) return whole
    if (!variables.includes(name)) variables.push(name)
    return `{{${variables.indexOf(name) + 1}}}`
  })
  return { body: text, variables }
}

/** El texto partido en lo fijo y lo que pone el sistema, para mostrarlo con lo segundo resaltado. */
export function splitNamedBody(body: string): { text: string; name: string | null }[] {
  const parts: { text: string; name: string | null }[] = []
  let last = 0
  for (const match of body.matchAll(NAMED_DATA)) {
    const at = match.index ?? 0
    if (at > last) parts.push({ text: body.slice(last, at), name: null })
    parts.push({ text: match[0], name: match[1] ?? "" })
    last = at + match[0].length
  }
  if (last < body.length) parts.push({ text: body.slice(last), name: null })
  return parts
}

// ------------------------------------------------ botones de respuesta ---

const REPLY_PREFIX = "odentia"

/** Lo que devuelve un botón cuando la persona lo toca: acción y trabajo que lo originó. */
export function replyId(action: ReplyAction, jobId: string): string {
  return `${REPLY_PREFIX}:${action}:${jobId}`
}

/**
 * La pregunta del permiso de novedades y promociones, una sola vez por
 * persona, tras reservar (ADR 0030). Texto y botones fijos; la respuesta la
 * resuelve el sistema sin modelo.
 */
export const GENERAL_PERMISSION_QUESTION = "¿Te podemos escribir para enviarte novedades y promociones de la clínica?"
export const GENERAL_PERMISSION_YES = "¡Listo! Te enviaremos novedades y promociones. Puedes darte de baja cuando quieras."
export const GENERAL_PERMISSION_NO = "Entendido: no te enviaremos novedades ni promociones."

// ---------------------------------------------------------- «Tus mensajes» ---

/** El enlace que abre «Tus mensajes» dentro de «Su enlace» (ADR 0040). */
export const CHOOSE_MESSAGES_LINK = { title: "Elegir mis mensajes" } as const

/** Los tres tipos que la persona puede apagar, en el orden de la página. */
export const SWITCHABLE_PURPOSES = ["recordatorio", "seguimiento", "novedades"] as const satisfies readonly ConsentPurpose[]
export type SwitchablePurpose = (typeof SWITCHABLE_PURPOSES)[number]

/**
 * Cómo se llama cada tipo de mensaje, para la persona y para el equipo: el
 * título de su interruptor, lo que trae y cómo se dice al darse de baja
 * («ya no te enviaremos recordatorios»).
 */
export const MESSAGE_KIND_WORDS: Record<ConsentPurpose, { title: string; detail: string; stops: string }> = {
  recordatorio: {
    title: "Recordatorios de tus citas",
    detail: "Te avisamos un día antes y unas horas antes.",
    stops: "recordatorios",
  },
  seguimiento: {
    title: "Controles y seguimiento",
    detail: "Cuándo te toca tu control, o si faltaste a una cita.",
    stops: "mensajes de controles y seguimiento",
  },
  novedades: {
    title: "Novedades y promociones",
    detail: "Campañas y ofertas de la clínica.",
    stops: "novedades ni promociones",
  },
  avisos: {
    title: "Avisos de tus citas y papeles",
    detail:
      "Si tu cita se reserva, cambia o se cancela, y cuando tu presupuesto o tu receta están listos. Siempre te llegan, porque son parte de tu atención.",
    stops: "ningún mensaje de la clínica",
  },
}

/**
 * La respuesta fija a una baja, venga del botón, del chat o de «BAJA»:
 * «Listo, Lucía, ya no te enviaremos recordatorios. Si tu cita cambia, te
 * avisamos igual.». Con «nada» tampoco salen los avisos, y no se promete ese aviso.
 */
export function optOutReply(name: string | null, purposes: readonly ConsentPurpose[]): string {
  const who = name ? `Listo, ${name}` : "Listo"
  if (purposes.includes("avisos")) return `${who}, ya no te enviaremos ningún mensaje de la clínica.`
  const what = SWITCHABLE_PURPOSES.filter((purpose) => purposes.includes(purpose)).map(
    (purpose) => MESSAGE_KIND_WORDS[purpose].stops,
  )
  const list = what.length > 1 ? `${what.slice(0, -1).join(", ")} ni ${what.at(-1)}` : (what[0] ?? "mensajes")
  return `${who}, ya no te enviaremos ${list}. Si tu cita cambia, te avisamos igual.`
}

/** Lo que se le dice cuando vuelve a recibir un tipo: «Listo, Lucía, te volveremos a enviar: recordatorios de tus citas.». */
export function optInReply(name: string | null, purposes: readonly ConsentPurpose[]): string {
  const who = name ? `Listo, ${name}` : "Listo"
  const what = SWITCHABLE_PURPOSES.filter((purpose) => purposes.includes(purpose)).map((purpose) =>
    MESSAGE_KIND_WORDS[purpose].title.toLowerCase(),
  )
  return what.length > 0
    ? `${who}, te volveremos a enviar: ${what.join(", ")}.`
    : `${who}, te volveremos a enviar los avisos de tus citas y papeles.`
}

/**
 * Las palabras de baja que se resuelven sin modelo (ADR 0040): «BAJA» o
 * «STOP», solas en el mensaje. «Cancelar» nunca es una baja: quien la escribe
 * quiere cancelar su cita.
 */
export function isStopWord(text: string | null | undefined): boolean {
  const word = (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
  return word === "BAJA" || word === "STOP" || word === "DAR DE BAJA"
}

export function generalPermissionButtons(contactId: string): Array<{ id: string; title: string }> {
  return [
    { id: replyId("permiso_si", contactId), title: "Sí" },
    { id: replyId("permiso_no", contactId), title: "No, gracias" },
  ]
}

export function parseReplyId(value: string | null | undefined): { action: ReplyAction; jobId: string } | null {
  if (!value) return null
  const [prefix, action, jobId, ...rest] = value.split(":")
  if (prefix !== REPLY_PREFIX || rest.length > 0 || !jobId) return null
  if (!(REPLY_ACTIONS as readonly string[]).includes(action ?? "")) return null
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null
  return { action: action as ReplyAction, jobId }
}

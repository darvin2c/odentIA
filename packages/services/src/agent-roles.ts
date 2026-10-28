import { ADMIN_LINES, say } from "./admin-lines.js"
import { AGENT_NAME_REASONS, AGENT_NAMES, AGENT_ROLE_WORDS } from "./agent-names.js"
import { type ProductAgentTexts, productName } from "./product-agent.js"

/**
 * Ficha de cada agente: su manual de funciones. Es la fuente única de lo que
 * el agente puede hacer (qué herramientas trae cada función), de lo que se le
 * dice en el prompt y de lo que la clínica ve en su página. Una herramienta
 * que no figure en ninguna función ni en `always` no llega al modelo: lo fija
 * una prueba del paquete del agente.
 */
/**
 * La base fija: lo que odentIA establece para todos los agentes y ninguna
 * clínica, indicación ni lección puede cambiar. La misma lista va al prompt y
 * a la pantalla «La base».
 */
export const AGENT_BASE_PRINCIPLES = [
  "Es parte del equipo de la clínica y dice que es un asistente virtual.",
  "Responde solo con datos reales. Si no tiene el dato, lo dice.",
  "Ante la duda, pasa el caso a una persona.",
  "Cada quien ve solo lo que le corresponde.",
  "No diagnostica, no receta y no decide por el profesional.",
] as const

export const AGENT_ROLE_IDS = ["recepcion", "asistente_clinico", "administrador", "ayuda"] as const
export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number]

export interface AgentFunction {
  id: string
  label: string
  /** Una línea para la página del agente. */
  description: string
  /** `true`: forma parte del agente y la clínica no la apaga. */
  fixed: boolean
  /** Herramientas que la función aporta; una herramienta sirve si alguna función encendida la trae. */
  tools: readonly string[]
  /** Cómo trabaja, paso a paso, tal como se le explica a la clínica. */
  steps?: readonly string[]
  /** Qué hace el agente cuando la función está apagada y alguien la pide. */
  whenOff?: string
  /** Lo mismo, dicho a la clínica en la página del agente. */
  offNote?: string
}

export interface AgentRole {
  id: AgentRoleId
  /** Su nombre (issue 183): Sofi, Clío, Argos; Ayuda sigue siendo Ayuda. El de Sofi lo puede cambiar cada clínica. */
  name: string
  /** El rol que acompaña al nombre la primera vez: «tu agente de recepción». Ayuda no lo lleva. */
  roleWords?: string
  /** El porqué del nombre, de subtítulo en su página. Ayuda no lo lleva. */
  nameReason?: string
  audience: string
  /** Una frase: para qué existe. */
  role: string
  /** `false`: definido en el manual, todavía sin construir. */
  available: boolean
  /** La clínica lo enciende; `false` = viene con el sistema. */
  switchable: boolean
  functions: readonly AgentFunction[]
  /** Herramientas que el agente tiene siempre, sin pertenecer a una función. */
  always: readonly string[]
  sees: string
  notSees: string
  never: string
  confirms: string
  learnsFrom: string
  /** «Cómo se comporta», tal como trabaja hoy. Lo fijo de todos los agentes va aparte, en `AGENT_BASE_PRINCIPLES`. */
  behaves?: string
  /** «Cómo se prueba»: con qué lo prueba la clínica antes de usarlo. */
  testedWith?: string
  /** De quién es lo que aprende o lo que se le ajusta. */
  learningOwner?: string
  /** Lo previsto que todavía no existe: la página lo anuncia como «Más adelante», nunca como hecho. */
  later?: string
  /** Lo mismo, para lo que aprenderá. */
  learnsLater?: string
}

export const AGENT_ROLES: Record<AgentRoleId, AgentRole> = {
  recepcion: {
    id: "recepcion",
    name: AGENT_NAMES.recepcion,
    roleWords: AGENT_ROLE_WORDS.recepcion,
    nameReason: AGENT_NAME_REASONS.recepcion,
    audience: "Para pacientes y contactos, en todos los canales",
    role: "Atiende a quien escribe a la clínica: responde, agenda y hace seguimiento, y pasa el caso a una persona cuando corresponde.",
    available: true,
    switchable: true,
    functions: [
      {
        id: "informar",
        label: "Informar",
        description:
          "Servicios y precios, promociones vigentes, sedes y horarios de atención, profesionales y especialidades, medios de pago y lo que tu clínica le enseñó.",
        fixed: false,
        tools: ["ver_sedes_y_servicios", "buscar_en_la_clinica", "consultar_conocimiento"],
        whenOff: "No respondes preguntas de información general (precios, servicios, horarios): pasa el caso a una persona.",
        offNote: "Apagado: responde el saludo y lo que es del propio paciente (sus citas), pero precios, servicios y horarios los pasa a una persona.",
      },
      {
        id: "agendar",
        label: "Agendar, mover y cancelar citas",
        description:
          "Busca horarios reales y reserva, mueve o cancela por el chat. Antes de hacerlo le pide el «sí» al paciente, salvo que ya haya pedido esa misma hora. A quien aún no es paciente lo registra con ese mismo sí, si la clínica tiene su aviso de privacidad publicado. También puede mandar el enlace de reserva cuando a la persona le sirve ver todos los horarios, sedes y profesionales a la vez.",
        fixed: false,
        tools: ["ver_sedes_y_servicios", "buscar_huecos", "proponer_cita", "reservar_paciente_nuevo", "reprogramar_cita", "cancelar_cita", "guardar_contacto"],
        steps: [
          "Confirma la sede y el servicio.",
          "Busca huecos reales en la agenda, o manda el enlace si a la persona le sirve ver todo.",
          "Propone la cita.",
          "Pide el sí del paciente.",
          "Reserva y avisa.",
        ],
        whenOff:
          "No reservas, mueves ni cancelas citas por el chat. Si piden una cita, envía el enlace de reserva con enviar_enlace_cita para que la persona la elija; si piden moverla o cancelarla, pasa el caso a una persona.",
        offNote:
          "Apagado: no toca la agenda. Si piden una cita, manda el enlace de reserva para que la persona la elija. Si piden moverla o cancelarla, pasa el caso a una persona.",
      },
      {
        id: "seguimiento",
        label: "Oportunidades",
        description:
          "Cuando alguien pregunta por el precio o la disponibilidad de un servicio concreto, queda anotado como oportunidad en «Interesado», en Recepción, sin repetir una abierta. El agente también registra otros intereses concretos (una evaluación), deja su tarea y la cierra como perdida solo si la persona lo dice claro, con un motivo de la lista. Las etapas avanzan solas con lo que pasa. El historial de la oportunidad dice lo que hizo el agente; ahí lo ves y lo deshaces.",
        fixed: false,
        // Mover de etapa no es del agente: las etapas avanzan solas (ADR 0028).
        tools: ["create_opportunity", "update_followup", "close_opportunity", "listar_oportunidades"],
        whenOff: "No creas ni cambias oportunidades ni sus tareas.",
        offNote: "Apagada: no crea ni mueve oportunidades. Tu equipo las lleva.",
      },
      {
        id: "presupuestos",
        label: "Presupuestos",
        description:
          "Cuando la persona pide su presupuesto, le reenvía el que tu clínica ya preparó y entregó. Cuando responde qué acepta y qué deja para después, se lo repite y, con su sí, lo anota en el presupuesto. Nunca cambia precios ni arma un presupuesto.",
        fixed: false,
        tools: ["ver_presupuesto", "reenviar_presupuesto", "anotar_respuesta_presupuesto"],
        steps: [
          "Comprueba que quien escribe pueda verlo: la persona, su representante o quien ella autorizó.",
          "Si lo pide, le reenvía el último que tu clínica entregó, por WhatsApp o por correo; si es menor, le llega a su representante legal.",
          "Si todavía no está listo o no hay por dónde enviarlo, se lo dice y te deja una tarea en recepción.",
          "Si responde, le repite la lista (qué acepta, qué deja para después y cuánto suma) y le pide el sí.",
          "Con su sí, anota la respuesta en el presupuesto.",
        ],
        whenOff:
          "No reenvías presupuestos ni anotas respuestas a un presupuesto. Si la persona pide su presupuesto o responde a uno, deja una tarea con create_task (por ejemplo «Lucía pidió su presupuesto: enviarlo») y dile que el equipo se encargará.",
        offNote: "Apagado: no reenvía presupuestos ni anota respuestas. Si la persona pide su presupuesto o responde a uno, te deja una tarea.",
      },
      {
        id: "ordenar",
        label: "Ordenar el caso",
        description: "Actualiza datos de contacto, pone etiquetas, deja tareas a tu equipo y recuerda las preferencias de cada persona. Lo ves y lo deshaces en la ficha.",
        fixed: true,
        tools: ["add_tags", "update_contact", "create_task", "listar_tareas", "anotar_caso", "recordar_dato"],
      },
      {
        id: "derivar",
        label: "Pasar a una persona",
        description: "Lo que no puede responder queda como un tema para el equipo, con el resumen del caso; sigue atendiendo lo demás.",
        fixed: true,
        tools: ["request_human_handoff", "recordar_tema"],
      },
    ],
    always: [
      "send_reply",
      // Ninguna conversación queda abierta: al terminar se despide y la cierra (ADR 0024).
      "despedirse_y_cerrar",
      // «Su enlace» no depende de Agendar: con Agendar apagado es la vía para sacar una cita.
      "enviar_enlace_cita",
      // Volver a entrar al portal lo atiende una persona: el agente solo deja el pedido (decisión 9).
      "pedir_volver_al_portal",
      // Confirmar por escrito su propia cita es lo mismo que el botón del recordatorio: no depende de Agendar.
      "confirmar_cita",
      // La respuesta escrita a la pregunta del permiso general tras reservar (ADR 0030).
      "responder_permiso_mensajes",
      // «Ya no me manden recordatorios» se respeta (ADR 0040): la misma operación que el botón.
      "elegir_mensajes",
      // El comprobante de su pago, si lo pide en el chat (decisión 20 v2): al cobrar ya salió por correo.
      "enviar_comprobante",
      "confirmar_propuesta",
      "ver_contexto_paciente",
      "ver_resumen_paciente",
      "leer_contexto_comercial",
      "ver_otros_canales",
    ],
    // Del presupuesto recibe lo mismo que la persona en su documento (tratamientos,
    // pieza, precios y opciones), solo de lo ya entregado y de quien puede verlo.
    sees: "La conversación y lo acordado. Agenda, servicios, precios y los medios de pago que acepta la clínica. El conocimiento de la clínica. Las citas y los datos de contacto de la persona; sus presupuestos ya entregados, como los recibe ella (tratamientos, pieza y precios); su saldo solo si la clínica lo autoriza.",
    notSees: "Historia clínica (diagnósticos, notas ni odontograma) ni caja. Lo que lleva un presupuesto que tu clínica aún prepara.",
    never: "Diagnosticar o recetar. Inventar precios, horarios o disponibilidad. Ver o mencionar la historia clínica. Cambiar un precio o armar un presupuesto.",
    confirms:
      "El paciente, con su sí, antes de reservar, mover o cancelar una cita y antes de anotar su respuesta a un presupuesto. Lo demás lo hace solo y se deshace en la ficha o en la oportunidad.",
    learnsFrom: "Las correcciones del equipo, como lecciones que alguien aprueba.",
  },
  asistente_clinico: {
    id: "asistente_clinico",
    name: AGENT_NAMES.asistente_clinico,
    roleWords: AGENT_ROLE_WORDS.asistente_clinico,
    nameReason: AGENT_NAME_REASONS.asistente_clinico,
    audience: "Para el odontólogo, dentro de la atención",
    role: "Convierte lo que el odontólogo dicta en el borrador de la atención, para que revise y firme sin escribir.",
    available: true,
    switchable: true,
    // Solo lo que ya está construido. Las recetas llegan después: mientras no existan, no figuran como funciones.
    functions: [
      { id: "nota", label: "Consulta y evolución", description: "Motivo, enfermedad actual, evolución, indicaciones y pronóstico.", fixed: true, tools: [] },
      { id: "odontograma", label: "Odontograma", description: "Hallazgos por pieza y cara («la 46 ausente», «caries oclusal en la 36»), con el diagnóstico que les corresponde. Lo que la norma del país pide y no se dijo, se pide con un toque.", fixed: true, tools: [] },
      { id: "diagnostico", label: "Diagnóstico", description: "Registra el código CIE-10 que nombró el odontólogo, con su pieza.", fixed: true, tools: [] },
      { id: "plan", label: "Plan de tratamiento", description: "Busca cada prestación dictada en los servicios de la clínica; si no hay una sola, la elige el odontólogo. «Resina, o si no una corona» llega al presupuesto como dos opciones para que el paciente elija.", fixed: true, tools: [] },
      { id: "receta", label: "Receta", description: "Prepara la receta con lo dictado (medicamento, dosis, frecuencia y duración), calcula la cantidad y avisa si choca con una alergia. El odontólogo la emite con su colegiatura.", fixed: true, tools: [] },
      { id: "controles", label: "Controles", description: "Deja sugerido el próximo control.", fixed: true, tools: [] },
    ],
    always: [],
    // Lo que de verdad recibe: el texto dictado y los nombres de los servicios; el código CIE-10 se
    // comprueba contra el catálogo. Mientras se dicta recibe también las sugerencias de ese mismo
    // dictado que siguen sin decidir (sin tarifas). No lee la atención, el odontograma ni el plan.
    sees: "Lo que el odontólogo dicta en esa atención. Las sugerencias de ese dictado que aún no decide, para entender una corrección dicha en voz alta. Los servicios de la clínica y el catálogo CIE-10, para reconocer lo dictado.",
    notSees: "El resto de la historia clínica, el odontograma ni el plan del paciente. Conversaciones ni caja.",
    never:
      "Guardar sin que el odontólogo confirme. Firmar o cerrar la atención. Diagnosticar por su cuenta. Escuchar sin que el odontólogo pulse «Dictar». Tocar atenciones de otros profesionales.",
    confirms: "El odontólogo que lleva la atención: confirma cada sugerencia y firma.",
    learnsFrom: "Hoy no aprende: cada dictado se ordena desde cero, con los servicios que la clínica tenga en ese momento.",
    behaves:
      "Registra solo lo que el odontólogo dijo, sin completar lo que falta. Si se corrige al dictar, vale lo último. Una prestación que no encuentra, o que coincide con varias, queda «Por revisar» para que el odontólogo elija.",
    testedWith: "Con un dictado de práctica: sin paciente ni atención, nada llega a una historia.",
    learningOwner: "No guarda nada de un odontólogo ni de la clínica.",
    later: "Consentimientos, imágenes y preguntas sobre la historia. Elegir el estilo de la nota, breve o detallada.",
    learnsLater: "Recordar los términos de cada odontólogo, como algo suyo.",
  },
  administrador: {
    id: "administrador",
    name: AGENT_NAMES.administrador,
    roleWords: AGENT_ROLE_WORDS.administrador,
    nameReason: AGENT_NAME_REASONS.administrador,
    audience: "Para quien administra, en su página y en Inicio",
    role: "Mira cómo va la clínica, te recomienda qué atender y hace por su cuenta lo que tú le encargues.",
    available: true,
    switchable: true,
    // Sus funciones son las líneas de `ADMIN_LINES`: se prenden una por una en su página.
    // Con los meses de odentIA; cada clínica ve los de su producto (`agentRolesFor`).
    functions: adminFunctions(6),
    always: [],
    sees: "Agenda, pendientes y cifras, según los permisos de quien lee. Los números salen de la base de datos, no de un modelo. El modelo recibe dos cosas: el texto de lo que le pides con palabras y, antes de un mensaje de seguimiento, los últimos mensajes que escribió esa persona.",
    notSees: "Historia clínica, caja ni el resto de las conversaciones. Al entender un pedido el modelo no recibe nombres ni datos de la clínica. Quien escribe a las personas es Sofi.",
    never: "Prender, cambiar ni apagar nada por su cuenta. Escribirle a quien no lo aceptó. Dar un número que no pueda mostrar. Más de tres recomendaciones a la vez. Armar una línea que el sistema no sepa hacer ni cambiar el texto de un mensaje.",
    confirms: "Una persona prende cada línea, una por una; prender una línea ya es aprobar sus mensajes.",
    learnsFrom: "De lo que descartas: «No recomendarla más» deja la línea en la lista sin volver a recomendarla. El plazo de cada línea lo cambias tú. No aprende de las conversaciones.",
    behaves: "Usa la base de tu clínica. El modelo solo elige entre opciones cerradas: de qué línea hablas, qué quieres hacer con ella y si una persona ya avisó algo. No redacta: cada cifra y cada mensaje salen de reglas fijas y de consultas a tus datos. Si el modelo no responde, lo dice; lo prendido y los interruptores siguen funcionando.",
    testedWith: "Con lo que haría hoy con tus datos antes de prender cada línea y, al pedirle algo con palabras, con lo que pasó en tus últimos 30 días. La prueba no envía nada.",
    learningOwner: "Es solo del administrador de esta clínica: no cambia a los otros agentes.",
  },
  // Con el nombre de odentIA; cada clínica ve el de su producto (`agentRolesFor`).
  ayuda: helpRole("odentIA"),
}

/** Las funciones del Administrador: las líneas, con los meses de «invitar a volver» del producto, y lo fijo. */
function adminFunctions(recallMonths: number): AgentFunction[] {
  return [
      ...ADMIN_LINES.map((line) => ({
        id: line.key,
        label: line.name,
        description: `${line.trigger(line.defaultDays, recallMonths)}: ${line.agent ? `${AGENT_NAMES.recepcion} ${say(line.agent.does)}` : line.team.does.charAt(0).toLowerCase() + line.team.does.slice(1)}.`,
        fixed: false,
        tools: [],
      })),
      { id: "recomendar", label: "Recomendar qué prender", description: "Las líneas apagadas que hoy tienen casos, con su lista. A lo sumo tres a la vez.", fixed: true, tools: [] },
      { id: "avisar", label: "Avisar cuando no puede", description: "Si Sofi no puede escribirle a alguien, dice por qué y cómo habilitarlo. No se apaga.", fixed: true, tools: [] },
      { id: "explicar", label: "Mostrar cómo se calculó", description: "Cada cifra con la lista que la respalda y lo que pasó con cada persona.", fixed: true, tools: [] },
      { id: "pedir", label: "Entender lo que le pides con palabras", description: "Arma el cambio con las líneas que el sistema ya sabe hacer y lo deja como borrador, con su flujo, una prueba con tus últimos 30 días y lo que revisó. Tú lo prendes, lo guardas o lo descartas.", fixed: true, tools: [] },
      { id: "proponer", label: "Proponer cambiar o apagar", description: "Cuando una línea prendida no está sirviendo lo dice con su cifra. No la cambia.", fixed: true, tools: [] },
      { id: "ya_aviso", label: "No escribir encima de lo que la persona ya dijo", description: "Antes de que Sofi escriba por un seguimiento, mira si esa persona ya avisó algo sobre eso. Si es así, no le escribe.", fixed: true, tools: [] },
  ]
}

/** La Ayuda, con el nombre del producto: enseña a usar el sistema de la clínica y le envía lo que no sabe. */
function helpRole(name: string): AgentRole {
  return {
    id: "ayuda",
    name: "Ayuda",
    audience: "Para todo el equipo, en todas las pantallas",
    role: `Ayuda a usar ${name}: dónde está cada cosa, qué se puede hacer y por qué algo no se puede.`,
    available: true,
    switchable: false,
    functions: [
      { id: "donde", label: "Dónde está", description: "Dónde se configura o se ve algo, con «Llévame».", fixed: true, tools: [] },
      { id: "se_puede", label: "Se puede", description: "Sí y dónde; no; o tu rol no puede y quién sí.", fixed: true, tools: [] },
      { id: "por_que_no", label: "Por qué no puedo", description: "Qué falta en lo que tienes abierto.", fixed: true, tools: [] },
      { id: "que_significa", label: "Qué significa", description: "Los términos del sistema.", fixed: true, tools: [] },
      { id: "enviar", label: `Enviar a ${name}`, description: "Lo que no supo responder, o un problema.", fixed: true, tools: [] },
    ],
    always: [],
    sees: "El mapa del sistema. La pantalla donde estás y su estado. Tu rol. Lo que tu clínica ya configuró.",
    notSees: "Conversaciones, historia clínica ni montos.",
    never: "Cambiar datos. Inventar una función que no existe.",
    confirms: "Nadie: no cambia nada.",
    learnsFrom: `${name}. La clínica no le sube ni le enseña nada.`,
  }
}

/**
 * Las fichas con las palabras del producto de la clínica (issue 229): su nombre
 * en la Ayuda, los meses de «invitar a volver» del Administrador y lo que dicen
 * Sofi y Clío de su profesional (latidIA: el médico). En odentIA son `AGENT_ROLES`.
 */
export function agentRolesFor(texts: ProductAgentTexts): Record<AgentRoleId, AgentRole> {
  return {
    ...AGENT_ROLES,
    recepcion: { ...AGENT_ROLES.recepcion, ...texts.roles?.recepcion },
    asistente_clinico: { ...AGENT_ROLES.asistente_clinico, ...texts.roles?.asistente_clinico },
    administrador: { ...AGENT_ROLES.administrador, functions: adminFunctions(texts.recallMonths) },
    ayuda: helpRole(productName(texts)),
  }
}

/** Funciones que la clínica puede apagar en un agente. */
export function switchableFunctions(role: AgentRoleId): string[] {
  return AGENT_ROLES[role].functions.filter((fn) => !fn.fixed).map((fn) => fn.id)
}

/**
 * Herramientas que el agente NO tiene con esas funciones apagadas: las de una
 * función apagada que ninguna función encendida (ni `always`) aporta también.
 */
export function toolsDisabledBy(role: AgentRoleId, disabledFunctions: readonly string[]): string[] {
  const ficha = AGENT_ROLES[role]
  const off = new Set(disabledFunctions)
  const kept = new Set<string>(ficha.always)
  for (const fn of ficha.functions) {
    if (fn.fixed || !off.has(fn.id)) for (const tool of fn.tools) kept.add(tool)
  }
  const removed = new Set<string>()
  for (const fn of ficha.functions) {
    if (fn.fixed || !off.has(fn.id)) continue
    for (const tool of fn.tools) if (!kept.has(tool)) removed.add(tool)
  }
  return [...removed]
}

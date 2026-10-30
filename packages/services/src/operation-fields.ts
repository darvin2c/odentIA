import { MEDICAL_LEAVE_MAX_DAYS, upperFirst, VITAL_SIGNS, type VitalSignKey } from "@odentia/clinical"
import { z } from "zod"

/**
 * Una sola declaración de campos por operación. De aquí salen la validación de
 * la ruta (lo que envía la pantalla) y el esquema de la herramienta del agente:
 * ninguno de los dos declara campos por su cuenta. Un campo nuevo obliga a
 * decir quién lo llena cuando actúa el agente (`agent`) y a describirlo; con
 * eso llega a su herramienta sin tocarla.
 */

type FieldKind =
  | { kind: "text"; min?: number; max: number }
  | { kind: "uuid" }
  /** Identificador de texto que no es UUID (usuarios). */
  | { kind: "ref" }
  /** Instante ISO 8601 con zona. */
  | { kind: "instant" }
  | { kind: "int"; min: number; max?: number }
  /** Un número con decimales: una medida («38,5 °C»). */
  | { kind: "decimal"; min: number; max: number }
  /**
   * Una opción de una lista. `agentValues`, si está, es la parte de la lista que
   * el agente puede elegir (el equipo usa la lista entera): por ejemplo, el
   * agente nunca cierra una oportunidad porque la persona dejó de responder.
   */
  | { kind: "enum"; values: readonly [string, ...string[]]; agentValues?: readonly [string, ...string[]] }
  /** Lista corta de textos (superficies de una pieza). */
  | { kind: "textList"; maxItems: number; maxLength: number }
  /** Lista corta de identificadores UUID (tratamientos de una cita). */
  | { kind: "uuidList"; maxItems: number }
  /**
   * Lo que se responde por cada tratamiento (la respuesta a un presupuesto):
   * al menos una, cada una con el id del tratamiento y uno de `values`.
   */
  | { kind: "decisionList"; maxItems: number; values: readonly [string, ...string[]] }
  /** Sí o no. */
  | { kind: "flag" }

export type OperationField = FieldKind & {
  label: string
  /** Qué es y cuándo se usa: se le dice al modelo y se muestra a la clínica. */
  description: string
  /**
   * Cómo viaja desde la pantalla: en el cuerpo (obligatorio u opcional), en la
   * dirección de la ruta (`path`) o no viaja (`none`: solo existe para el agente).
   */
  body: "required" | "optional" | "path" | "none"
  /** La pantalla puede enviarlo vacío (null) para borrarlo. */
  nullable?: true
  /** Valor por defecto en la ruta cuando no viene. */
  default?: string
  /**
   * Quién lo pone cuando actúa el agente: él (`fills`, o `requires` si no puede
   * faltar), el sistema a partir de la conversación (`context`) o solo una
   * persona (`person`).
   */
  agent: "fills" | "requires" | "context" | "person"
}

export interface OperationSpec {
  label: string
  /** La ruta rechaza claves que no estén declaradas, en vez de ignorarlas. */
  strict?: true
  fields: Record<string, OperationField>
}

/** Una medida de los signos vitales, con el nombre y el rango de plausibilidad de `VITAL_SIGNS`. */
function vital(key: VitalSignKey, description: string) {
  const sign = VITAL_SIGNS.find((item) => item.key === key)!
  return { kind: "decimal", min: sign.min, max: sign.max, label: sign.label, description, body: "optional", nullable: true, agent: "fills" } as const
}

const reason = {
  kind: "text",
  max: 500,
  label: "Motivo de la propuesta",
  description: "Por qué lo hace, en una frase: queda en el historial para el equipo.",
  body: "none",
  agent: "fills",
} as const satisfies OperationField

export const OPERATIONS = {
  "tarea.crear": {
    label: "Crear una tarea",
    fields: {
      title: { kind: "text", min: 1, max: 200, label: "Título", description: "Qué hay que hacer, en una línea (llamar, confirmar, enviar).", body: "required", agent: "requires" },
      dueAt: { kind: "text", max: 40, label: "Vence", description: "Fecha y hora límite en ISO 8601. Solo si se acordó un plazo.", body: "optional", agent: "fills" },
      contactId: { kind: "uuid", label: "Contacto", description: "A quién se refiere la tarea.", body: "optional", agent: "context" },
      conversationId: { kind: "uuid", label: "Conversación", description: "La conversación donde surgió.", body: "optional", agent: "context" },
      opportunityId: { kind: "uuid", label: "Oportunidad", description: "La oportunidad a la que pertenece.", body: "optional", agent: "person" },
      patientId: { kind: "uuid", label: "Paciente", description: "El paciente al que se refiere.", body: "optional", agent: "person" },
      assigneeUserId: { kind: "text", max: 200, label: "Responsable", description: "Quién del equipo la lleva.", body: "optional", nullable: true, agent: "person" },
      area: { kind: "enum", values: ["recepcion", "caja", "clinico", "administracion"], label: "Parte del equipo", description: "Sin responsable, a qué parte del equipo va: la ve quien trabaja en ella.", body: "optional", nullable: true, agent: "person" },
    },
  },
  "cita.reservar": {
    label: "Reservar una cita",
    fields: {
      patientId: { kind: "uuid", label: "Paciente", description: "El paciente que se atiende; debe estar vinculado al interlocutor.", body: "required", agent: "requires" },
      professionalUserId: { kind: "ref", label: "Profesional", description: "El profesional del hueco elegido en buscar_huecos.", body: "required", agent: "requires" },
      roomId: { kind: "uuid", label: "Unidad dental", description: "La unidad dental del hueco elegido en buscar_huecos; sin ella, la agenda pone la primera libre de la sede.", body: "optional", agent: "fills" },
      startsAt: { kind: "instant", label: "Inicio", description: "Inicio exacto del hueco elegido, en ISO 8601 con zona.", body: "required", agent: "requires" },
      branchId: { kind: "uuid", label: "Sede", description: "La sede del hueco elegido.", body: "optional", agent: "fills" },
      serviceId: { kind: "uuid", label: "Servicio", description: "El servicio que se va a atender, si se sabe.", body: "optional", agent: "fills" },
      durationMin: { kind: "int", min: 1, max: 480, label: "Duración en minutos", description: "La del hueco elegido; si falta se toma la del servicio y, sin servicio, la de una cita regular en la sede.", body: "optional", agent: "fills" },
      reason: { kind: "text", max: 500, label: "Motivo", description: "Motivo de la consulta en palabras del paciente.", body: "optional", agent: "fills" },
      endsAt: { kind: "instant", label: "Fin", description: "Fin exacto, cuando no se deduce de la duración.", body: "optional", agent: "person" },
      status: { kind: "enum", values: ["programada", "confirmada", "atendida", "no_asistio", "cancelada"], label: "Estado", description: "Estado inicial de la cita.", body: "optional", agent: "person" },
      source: { kind: "text", max: 40, label: "Origen", description: "Por dónde entró la reserva.", body: "optional", agent: "context" },
      conversationId: { kind: "uuid", label: "Conversación", description: "La conversación donde se pidió.", body: "optional", agent: "context" },
      outsideSchedule: { kind: "flag", label: "Fuera de horario", description: "Urgencia: reservar aunque el horario del profesional no cubra esa hora. Solo lo decide una persona del equipo.", body: "optional", agent: "person" },
      planItemIds: { kind: "uuidList", maxItems: 52, label: "Tratamientos", description: "Lo aceptado del plan que se atiende en esta cita («Agendar» desde el Plan): la cita sabe qué tratamientos son y su atención los trae.", body: "optional", agent: "person" },
    },
  },
  "cita.mover": {
    label: "Mover una cita",
    fields: {
      appointmentId: { kind: "uuid", label: "Cita", description: "El id exacto de la cita, tomado de ver_resumen_paciente.", body: "path", agent: "requires" },
      expectedVersion: { kind: "int", min: 1, label: "Versión", description: "La versión de la cita que se leyó: evita pisar un cambio de otra persona.", body: "required", agent: "requires" },
      startsAt: { kind: "instant", label: "Nuevo inicio", description: "Inicio exacto del hueco nuevo, en ISO 8601 con zona.", body: "required", agent: "requires" },
      professionalUserId: { kind: "ref", label: "Profesional", description: "Solo si cambia de profesional.", body: "optional", agent: "fills" },
      roomId: { kind: "uuid", label: "Unidad dental", description: "Solo si cambia de unidad dental.", body: "optional", agent: "fills" },
      endsAt: { kind: "instant", label: "Nuevo fin", description: "Fin exacto, cuando cambia la duración.", body: "optional", agent: "person" },
      reason,
    },
  },
  "cita.confirmar": {
    label: "Confirmar una cita",
    fields: {
      appointmentId: { kind: "uuid", label: "Cita", description: "El id exacto de la cita que la persona confirma, de ver_resumen_paciente. Sin él se confirman, como con el botón, las citas del último recordatorio que recibió; si no hubo recordatorio, la única suya que espera confirmación.", body: "path", agent: "fills" },
    },
  },
  // Lo que la persona aceptó recibir. La pantalla elige el tipo y cómo lo dijo;
  // el agente solo registra su respuesta a la pregunta de novedades y promociones.
  "mensajes.permiso": {
    label: "Permiso de mensajes",
    strict: true,
    fields: {
      purpose: { kind: "enum", values: ["recordatorio", "seguimiento", "novedades"], label: "Qué mensajes", description: "Los de su cita y sus controles (recordatorio), los de sus presupuestos y seguimientos (seguimiento) o novedades y promociones (novedades).", body: "required", agent: "context" },
      granted: { kind: "flag", label: "Lo aceptó", description: "true si la persona dijo que sí a recibir novedades y promociones de la clínica; false si dijo que no.", body: "required", agent: "requires" },
      source: { kind: "enum", values: ["presencial", "telefono", "conversacion"], label: "Cómo lo dijo", description: "En persona, por teléfono o por la conversación.", body: "required", agent: "context" },
    },
  },
  // «Tus mensajes» (ADR 0040): la misma operación para la página de la persona,
  // recepción (Datos › Mensajes), el agente y «BAJA». El agente elige el tipo
  // por lo que dice la persona; si no queda claro, pregunta.
  "mensajes.elegir": {
    label: "Qué mensajes recibe",
    strict: true,
    fields: {
      tipo: {
        kind: "enum",
        values: ["recordatorio", "seguimiento", "novedades", "ninguno"],
        label: "Qué mensajes",
        description:
          "Los recordatorios de sus citas (recordatorio), los de controles y seguimiento (seguimiento), las novedades y promociones (novedades) o ningún mensaje de la clínica, también los avisos de sus citas y papeles (ninguno). Sin tipo, solo se le da su página para que elija.",
        body: "required",
        agent: "fills",
      },
      recibir: {
        kind: "flag",
        label: "Los recibe",
        description: "false si pide dejar de recibirlos; true si pide volver a recibirlos.",
        body: "required",
        agent: "fills",
      },
      source: {
        kind: "enum",
        values: ["presencial", "telefono", "conversacion"],
        label: "Cómo lo dijo",
        description: "En persona, por teléfono o por la conversación.",
        body: "required",
        agent: "context",
      },
    },
  },
  // Reenviar lo que la clínica ya entregó (fase 3, decisión 4): la pantalla
  // elige además a quién; el agente solo dice de qué paciente y, si lo sabe, cuál.
  "presupuesto.reenviar": {
    label: "Reenviar el presupuesto",
    strict: true,
    fields: {
      patientId: { kind: "uuid", label: "Paciente", description: "El paciente del presupuesto: la persona que escribe o alguien que ella lleva (de ver_contexto_paciente).", body: "path", agent: "requires" },
      budgetId: { kind: "uuid", label: "Presupuesto", description: "El presupuesto que pide, de ver_presupuesto. Sin él, el último que la clínica preparó para ese paciente.", body: "path", agent: "fills" },
      requestId: { kind: "uuid", label: "Clave del envío", description: "Repetir la misma clave no lo envía dos veces.", body: "optional", nullable: true, agent: "context" },
      recipientContactId: { kind: "uuid", label: "Destinatario", description: "Otra persona autorizada a recibirlo; por defecto, la persona o su representante legal si es menor.", body: "optional", nullable: true, agent: "person" },
    },
  },
  // La respuesta de quien decide (fase 3, decisiones 5 y 13). El agente la
  // anota solo después del sí de la persona a la lista; quién decidió lo pone
  // el sistema desde la conversación.
  "presupuesto.respuesta": {
    label: "Anotar la respuesta a un presupuesto",
    strict: true,
    fields: {
      patientId: { kind: "uuid", label: "Paciente", description: "El paciente del presupuesto, de ver_presupuesto.", body: "path", agent: "requires" },
      budgetId: { kind: "uuid", label: "Presupuesto", description: "El presupuesto que responde, de ver_presupuesto.", body: "path", agent: "requires" },
      optionId: { kind: "uuid", label: "Opción elegida", description: "La opción que eligió, de ver_presupuesto; obligatoria si el presupuesto tiene varias.", body: "optional", nullable: true, agent: "fills" },
      decisions: {
        kind: "decisionList",
        maxItems: 200,
        values: ["aceptado", "pospuesto", "rechazado"],
        label: "Respuesta por tratamiento",
        description: "Lo que responde por cada tratamiento de la opción elegida, con su id de ver_presupuesto: aceptado, pospuesto (lo deja para después) o rechazado. Lo que ya había decidido antes no cambia.",
        body: "required",
        agent: "requires",
      },
      decidedByContactId: { kind: "uuid", label: "Quién decidió", description: "La persona o su representante legal vigente; cuando lo anota el agente, quien escribe en la conversación.", body: "optional", nullable: true, agent: "context" },
      decisionNote: { kind: "text", max: 4000, label: "Nota", description: "Lo que añade quien anota la respuesta.", body: "optional", nullable: true, agent: "person" },
    },
  },
  "oportunidad.crear": {
    label: "Crear una oportunidad",
    fields: {
      title: { kind: "text", min: 1, max: 200, label: "Título", description: "El interés concreto, en una línea: el tratamiento, el precio o la evaluación que pidió.", body: "required", agent: "requires" },
      contactId: { kind: "uuid", label: "Contacto", description: "La persona interesada.", body: "required", agent: "context" },
      patientId: { kind: "uuid", label: "Paciente", description: "El paciente, si el interés es para alguien ya registrado.", body: "optional", nullable: true, agent: "fills" },
      serviceId: { kind: "uuid", label: "Servicio", description: "El servicio que le interesa, si está en el catálogo: su valor sale de la lista de precios.", body: "optional", nullable: true, agent: "fills" },
      interestText: { kind: "text", max: 500, label: "Interés", description: "Lo que pidió, en sus palabras.", body: "optional", nullable: true, agent: "fills" },
      amountCents: { kind: "int", min: 0, label: "Valor", description: "Sin servicio, el valor estimado en la unidad menor de la moneda de la clínica. Con servicio sale de la lista de precios.", body: "optional", nullable: true, agent: "person" },
      assignedUserId: { kind: "text", max: 200, label: "Responsable", description: "Quién del equipo la lleva; sin responsable es de Recepción.", body: "optional", nullable: true, agent: "person" },
      budgetId: { kind: "uuid", label: "Presupuesto", description: "El presupuesto del que nace.", body: "optional", nullable: true, agent: "person" },
      conversationId: { kind: "uuid", label: "Conversación", description: "La conversación donde surgió.", body: "optional", nullable: true, agent: "context" },
      reason,
    },
  },
  "oportunidad.mover": {
    label: "Mover una oportunidad de etapa",
    fields: {
      opportunityId: { kind: "uuid", label: "Oportunidad", description: "Cuál mover; si la persona tiene una sola abierta puede omitirse.", body: "path", agent: "fills" },
      stageId: { kind: "uuid", label: "Etapa", description: "El paso de destino (Interesado, Evaluación agendada o Presupuesto enviado). Para cerrarla se usa cerrar.", body: "required", agent: "requires" },
    },
  },
  "oportunidad.cerrar": {
    label: "Cerrar una oportunidad",
    fields: {
      opportunityId: { kind: "uuid", label: "Oportunidad", description: "Cuál cerrar; si la persona tiene una sola abierta puede omitirse.", body: "path", agent: "fills" },
      outcome: { kind: "enum", values: ["won", "lost"], label: "Resultado", description: "Ganada (won) o perdida (lost).", body: "required", agent: "requires" },
      reason: {
        kind: "enum",
        values: ["precio", "otra_clinica", "no_responde", "no_lo_necesita", "otro", "acepto"],
        // «No responde» lo decide una persona del equipo: el agente solo cierra por lo que la persona dijo.
        agentValues: ["precio", "otra_clinica", "no_lo_necesita", "otro", "acepto"],
        label: "Motivo",
        description: "Perdida: precio, otra_clinica (eligió otra clínica), no_lo_necesita (ya no lo necesita) u otro. Ganada: acepto.",
        body: "required",
        agent: "requires",
      },
      note: { kind: "text", max: 500, label: "Nota", description: "Lo que añade al motivo, en una frase. Solo si hace falta (por ejemplo, con «otro»).", body: "optional", nullable: true, agent: "fills" },
    },
  },
  "oportunidad.tarea": {
    label: "La tarea de una oportunidad",
    fields: {
      opportunityId: { kind: "uuid", label: "Oportunidad", description: "De qué oportunidad es; si la persona tiene una sola abierta puede omitirse.", body: "path", agent: "fills" },
      nextActionNote: { kind: "text", min: 1, max: 200, label: "Tarea", description: "Qué hay que hacer, en una línea (llamar para confirmar la evaluación).", body: "optional", agent: "fills" },
      nextActionAt: { kind: "instant", label: "Vence", description: "Cuándo, en ISO 8601 con zona. Solo si se acordó un momento.", body: "optional", nullable: true, agent: "fills" },
      reason,
    },
  },
  "derivacion.crear": {
    label: "Pasar el caso a una persona",
    fields: {
      conversationId: { kind: "uuid", label: "Conversación", description: "La conversación que se deriva.", body: "required", agent: "context" },
      reason: { kind: "text", min: 1, max: 500, label: "Motivo", description: "Por qué hace falta una persona.", body: "required", agent: "requires" },
      summary: { kind: "text", min: 1, max: 2000, label: "Resumen", description: "Lo conversado y lo que falta, solo con hechos.", body: "required", agent: "requires" },
      priority: { kind: "enum", values: ["alta", "media", "baja"], default: "media", label: "Prioridad", description: "Alta si hay dolor, urgencia o una queja.", body: "optional", agent: "fills" },
      // El agente no conoce los ids del equipo: lo deja en la cola y quien lo toma se lo asigna.
      assigneeUserId: { kind: "text", max: 200, label: "Responsable", description: "A quién del equipo va; sin él queda en la cola.", body: "optional", agent: "person" },
      message: { kind: "text", min: 1, max: 4000, label: "Aviso al interlocutor", description: "Aviso breve de quién verá su consulta (por ejemplo, «Recepción lo revisa y te escribe por aquí»), sin prometer una hora ni un plazo. El agente sigue atendiendo lo demás.", body: "none", agent: "fills" },
      clinical: { kind: "flag", label: "Duda clínica", description: "Sí si es una duda sobre su salud, un síntoma, un medicamento o un tratamiento: el tema va al profesional que atiende al paciente.", body: "optional", agent: "fills" },
      // R3 del pulido de la Bandeja: dice a quién le llega y qué temas puede retomar Sofi.
      kind: { kind: "enum", values: ["cita", "precio", "clinico", "pago", "otro"], default: "otro", label: "De qué trata", description: "cita si quiere reservar, cambiar o cancelar una cita; precio si pregunta un precio de la lista (un descuento es otro); clinico si es una duda de salud; pago si habla de un pago, una transferencia o un comprobante; otro en lo demás (un reclamo, un descuento, hablar con una persona).", body: "optional", agent: "fills" },
      asks: { kind: "text", min: 1, max: 400, label: "Qué pide", description: "Una frase con lo que la persona pide, con hechos que ella dijo. Para quien toma el caso; nunca un consejo clínico.", body: "none", agent: "fills" },
      pending: { kind: "text", min: 1, max: 400, label: "Lo que falta", description: "Lo que aún no se le preguntó o falta hacer para atenderla, en una frase. Vacío si no falta nada.", body: "none", agent: "fills" },
    },
  },
  "persona.recordar": {
    label: "Recordar un dato de la persona",
    fields: {
      contactId: { kind: "uuid", label: "Persona", description: "De quién es el dato.", body: "path", agent: "context" },
      text: { kind: "text", min: 3, max: 200, label: "Dato", description: "Un dato práctico y no clínico que servirá en otra conversación: a qué hora le viene bien, cómo quiere que la llamen, por quién escribe. Nunca síntomas, diagnósticos ni nada de salud.", body: "required", agent: "requires" },
      replacesId: { kind: "uuid", label: "Dato que reemplaza", description: "El id del dato ya guardado que este corrige, cuando la persona cambió de preferencia.", body: "optional", nullable: true, agent: "fills" },
    },
  },
  "atencion.nota": {
    label: "Nota de la atención",
    fields: {
      reason: { kind: "text", max: 2000, label: "Motivo de consulta", description: "Por qué vino el paciente, en sus palabras.", body: "optional", nullable: true, agent: "fills" },
      presentIllness: { kind: "text", max: 4000, label: "Enfermedad actual", description: "El relato de lo que le pasa: cómo empezó y cómo ha seguido.", body: "optional", nullable: true, agent: "fills" },
      illnessDuration: { kind: "text", max: 200, label: "Tiempo de enfermedad", description: "Desde cuándo, tal como se dijo (por ejemplo, «una semana»).", body: "optional", nullable: true, agent: "fills" },
      evolution: { kind: "text", max: 10000, label: "Evolución", description: "Lo que se hizo en esta atención y cómo respondió el paciente.", body: "optional", nullable: true, agent: "fills" },
      indications: { kind: "text", max: 4000, label: "Indicaciones", description: "Lo que se le indica al paciente para después de la atención.", body: "optional", nullable: true, agent: "fills" },
      prognosis: { kind: "text", max: 2000, label: "Pronóstico", description: "El pronóstico que dijo el odontólogo.", body: "optional", nullable: true, agent: "fills" },
    },
  },
  "atencion.diagnostico": {
    label: "Diagnóstico",
    strict: true,
    fields: {
      diagnosisCode: { kind: "text", min: 1, max: 10, label: "Código", description: "El código del diagnóstico que nombró el odontólogo, en la lista de diagnósticos de la clínica (CIE-10 o CIE-11); casi siempre lo dice con palabras y no con el código. Si no nombró ningún diagnóstico, no registres ninguno.", body: "required", agent: "requires" },
      diagnosisSystem: { kind: "text", min: 1, max: 20, label: "Lista", description: "La lista de diagnósticos de la clínica.", body: "optional", nullable: true, agent: "context" },
      diagnosisType: { kind: "enum", values: ["provisional", "confirmed"], label: "Tipo", description: "provisional si el odontólogo aún no lo confirma (presuntivo); confirmed si lo da por seguro (definitivo). Si ya lo tenía antes lo anota el sistema: no lo indiques.", body: "required", agent: "requires" },
      toothNumber: { kind: "int", min: 11, max: 85, label: "Pieza", description: "La pieza en numeración FDI (dieciséis = 16).", body: "optional", nullable: true, agent: "fills" },
      surfaces: { kind: "textList", maxItems: 5, maxLength: 20, label: "Superficies", description: "Caras de la pieza, como las dijo: oclusal o incisal, mesial, distal, vestibular, palatina o lingual.", body: "optional", nullable: true, agent: "fills" },
      note: { kind: "text", max: 2000, label: "Nota", description: "Una precisión que dijo el odontólogo sobre el diagnóstico.", body: "optional", nullable: true, agent: "fills" },
    },
  },
  "plan.indicacion": {
    label: "Indicación del plan de tratamiento",
    fields: {
      service: { kind: "text", min: 2, max: 200, label: "Prestación", description: "La prestación tal como la nombró el odontólogo (por ejemplo, «resina compuesta»). El sistema la busca en los servicios de la clínica.", body: "none", agent: "requires" },
      serviceId: { kind: "uuid", label: "Servicio", description: "El servicio de la clínica.", body: "required", agent: "context" },
      planId: { kind: "uuid", label: "Plan", description: "El plan de tratamiento del paciente; sin él, su plan abierto (o uno nuevo).", body: "optional", nullable: true, agent: "context" },
      sourceEncounterId: { kind: "uuid", label: "Atención", description: "La atención donde se indica.", body: "required", agent: "context" },
      toothNumber: { kind: "int", min: 11, max: 85, label: "Pieza", description: "La pieza en numeración FDI, si la indicación es para una pieza.", body: "optional", nullable: true, agent: "fills" },
      surfaces: { kind: "textList", maxItems: 5, maxLength: 20, label: "Superficies", description: "Caras de la pieza que se tratan.", body: "optional", nullable: true, agent: "fills" },
      detail: { kind: "text", max: 2000, label: "Detalle", description: "Una precisión sobre la indicación.", body: "optional", nullable: true, agent: "fills" },
      // Solo del dictado: «resina, o si no una corona» es una elección del paciente (issue 109, fase 2).
      alternatives: { kind: "textList", maxItems: 2, maxLength: 200, label: "Otros caminos", description: "Otras prestaciones que dijo como alternativa para lo mismo («o si no una corona»), con sus palabras y en el orden en que las dijo. Vacío si no dijo alternativas.", body: "none", agent: "fills" },
    },
  },
  // Un medicamento de una receta dictada (issue 109, fase 2): los datos de la Guía de la buena
  // prescripción de la OMS, los mismos de «Emitir receta». La receta la emite `createPrescription`.
  "receta.medicamento": {
    label: "Medicamento de una receta",
    fields: {
      genericName: { kind: "text", min: 1, max: 200, label: "DCI", description: "El medicamento por su Denominación Común Internacional, en minúsculas (amoxicilina, ibuprofeno), aunque lo nombre por su marca.", body: "required", agent: "requires" },
      strength: { kind: "text", max: 60, label: "Concentración", description: "La concentración con su unidad, como la dijo («de quinientos» = 500 mg).", body: "required", agent: "fills" },
      dosageForm: { kind: "text", max: 60, label: "Forma farmacéutica", description: "cápsula, tableta, jarabe, suspensión, gel, enjuague… solo si la dijo o se deduce de la dosis («una cápsula»).", body: "required", agent: "fills" },
      dose: { kind: "text", max: 200, label: "Dosis", description: "Cuánto en cada toma («1 cápsula», «10 mL»).", body: "required", agent: "fills" },
      route: { kind: "text", max: 200, label: "Vía", description: "La vía, solo si la dijo (oral, sublingual, tópica…).", body: "required", agent: "fills" },
      frequency: { kind: "text", max: 200, label: "Frecuencia", description: "Cada cuánto, como la dijo («cada 8 horas», «cada 8 horas si hay dolor»).", body: "required", agent: "fills" },
      duration: { kind: "text", max: 200, label: "Duración", description: "Por cuánto tiempo («7 días»). Vacío si no lo dijo.", body: "required", agent: "fills" },
      quantity: { kind: "int", min: 1, max: 9999, label: "Cantidad total", description: "Cuántas unidades en total, solo si la dijo; si no, la calcula el sistema.", body: "optional", nullable: true, agent: "fills" },
      instructions: { kind: "text", max: 2000, label: "Indicaciones", description: "Una indicación que dijo para ese medicamento («después de las comidas»).", body: "optional", nullable: true, agent: "fills" },
    },
  },
  // Lo que se registra al tocar una pieza (`registerToothFinding`). La lista de hallazgos es del
  // producto dental y no se declara aquí (ADR 0079): el servicio la comprueba.
  "odontograma.hallazgo": {
    label: "Hallazgo del odontograma",
    fields: {
      toothNumber: { kind: "int", min: 11, max: 85, label: "Pieza", description: "La pieza en numeración FDI (cuarenta y seis = 46).", body: "required", agent: "requires" },
      condition: { kind: "text", min: 1, max: 40, label: "Hallazgo", description: "El código del hallazgo, de la lista de hallazgos que se te da (por ejemplo, caries o missing_tooth).", body: "required", agent: "requires" },
      surfaces: { kind: "textList", maxItems: 5, maxLength: 20, label: "Superficies", description: "Caras de la pieza, como las dijo: oclusal o incisal, mesial, distal, vestibular, palatina o lingual.", body: "optional", nullable: true, agent: "fills" },
      variant: { kind: "text", max: 40, label: "Variante", description: "El valor de la variante del hallazgo, de su lista (la profundidad de una caries, el tipo de corona…), solo si el odontólogo la dijo.", body: "optional", nullable: true, agent: "fills" },
      quality: { kind: "enum", values: ["good", "poor"], label: "Estado", description: "good si dijo que está en buen estado; poor si dijo que está en mal estado. Solo si lo dijo.", body: "optional", nullable: true, agent: "fills" },
      diagnosisType: { kind: "enum", values: ["provisional", "confirmed"], label: "Tipo de diagnóstico", description: "confirmed solo si el odontólogo da el diagnóstico por seguro; si no lo dice, no lo indiques.", body: "optional", nullable: true, agent: "fills" },
      note: { kind: "text", max: 2000, label: "Nota", description: "Una precisión que dijo el odontólogo sobre el hallazgo.", body: "optional", nullable: true, agent: "fills" },
      encounterId: { kind: "uuid", label: "Atención", description: "La atención en borrador donde se registra.", body: "required", agent: "context" },
    },
  },
  // Los signos vitales que se dictan (latidIA, issue 229): cada medida con su unidad. Cuáles
  // registra cada clínica lo dice su producto, que también los comprueba juntos (`parseVitals`).
  "atencion.signos": {
    label: "Signos vitales",
    fields: {
      presionSistolica: vital("presionSistolica", "La presión arterial sistólica en mmHg: el primer número («ciento dieciocho con setenta y seis» = 118)."),
      presionDiastolica: vital("presionDiastolica", "La presión arterial diastólica en mmHg: el segundo número («ciento dieciocho con setenta y seis» = 76)."),
      frecuenciaCardiaca: vital("frecuenciaCardiaca", "El pulso o la frecuencia cardiaca, en latidos por minuto."),
      frecuenciaRespiratoria: vital("frecuenciaRespiratoria", "La frecuencia respiratoria, en respiraciones por minuto."),
      temperatura: vital("temperatura", "La temperatura en °C, con su decimal si lo dijo («treinta y ocho y medio» = 38.5)."),
      saturacionOxigeno: vital("saturacionOxigeno", "La saturación de oxígeno en % («satura noventa y ocho» = 98)."),
      peso: vital("peso", "El peso en kg."),
      talla: vital("talla", "La talla en cm («uno sesenta y dos» = 162)."),
      perimetroCefalico: vital("perimetroCefalico", "El perímetro cefálico en cm, en niños."),
      glucosaCapilar: vital("glucosaCapilar", "La glucosa capilar en mg/dL."),
    },
  },
  // Un sistema del examen físico que se dicta (latidIA, issue 229). La lista de sistemas es del
  // producto y no se declara aquí (ADR 0079): el servicio la comprueba.
  "atencion.examen": {
    label: "Examen físico",
    fields: {
      system: { kind: "text", min: 1, max: 40, label: "Sistema", description: "La clave del sistema examinado, de la lista de sistemas que se te da (por ejemplo, toraxPulmones).", body: "required", agent: "requires" },
      state: { kind: "enum", values: ["sin_alteraciones", "con_hallazgos"], label: "Estado", description: "sin_alteraciones si lo dijo normal («pulmones limpios»); con_hallazgos si describió algo anormal.", body: "required", agent: "requires" },
      finding: { kind: "text", max: 1000, label: "Hallazgo", description: "Lo que encontró, con la parte del cuerpo y con sus palabras («amígdalas aumentadas, con placas blanquecinas»). Vacío si está sin alteraciones.", body: "optional", nullable: true, agent: "fills" },
    },
  },
  // El descanso médico que se dicta (latidIA, issue 229): se emite como siempre, firmado y con el
  // permiso de la persona para mostrar el diagnóstico (`createMedicalLeave`).
  "descanso.medico": {
    label: "Descanso médico",
    fields: {
      days: { kind: "int", min: 1, max: MEDICAL_LEAVE_MAX_DAYS, label: "Días", description: "Cuántos días de descanso indicó.", body: "required", agent: "requires" },
      startsOn: { kind: "text", max: 10, label: "Desde", description: "El primer día del descanso en AAAA-MM-DD, contado desde la fecha de hoy que se te da. Vacío si es desde hoy.", body: "optional", nullable: true, agent: "fills" },
    },
  },
  // Una alergia que se dice en la atención (issue 109): entra con `addPatientAllergy`, una por
  // una, o responde «Pregúntale si tiene alergias» con `markAllergiesReviewed`.
  "alergia.dictada": {
    label: "Alergia",
    fields: {
      substance: { kind: "text", max: 200, label: "Sustancia", description: "A qué es alérgico, por el nombre de la sustancia en singular (penicilina, látex, ibuprofeno), aunque nombre una marca. Vacío si dijo que no tiene alergias.", body: "optional", nullable: true, agent: "fills" },
      reaction: { kind: "text", max: 2000, label: "Qué le pasó", description: "Lo que le pasó, como lo dijo («ronchas», «le costó respirar»). Vacío si no lo dijo.", body: "optional", nullable: true, agent: "fills" },
      severity: { kind: "enum", values: ["leve", "moderada", "severa"], label: "Qué tan fuerte fue", description: "Solo si dijo con esas palabras qué tan fuerte fue la reacción; no lo deduzcas de lo que le pasó.", body: "optional", nullable: true, agent: "fills" },
      none: { kind: "flag", label: "No tiene alergias", description: "true si dijo que no tiene alergias o ninguna nueva («niega alergias», «de alergias sigue igual»), sin sustancia.", body: "optional", agent: "fills" },
    },
  },
  // Lo que se hizo hoy (issue 109): entra con `addEncounterProcedure`, del plan, de los
  // servicios o como acto libre, como «Registrar procedimiento».
  "atencion.procedimiento": {
    label: "Procedimiento realizado",
    fields: {
      service: { kind: "text", min: 2, max: 200, label: "Procedimiento", description: "Lo que hizo hoy, con las palabras del profesional (profilaxis, resina, exodoncia). El sistema lo busca en el plan del paciente y en los servicios de la clínica.", body: "none", agent: "requires" },
      toothNumber: { kind: "int", min: 11, max: 85, label: "Pieza", description: "La pieza en numeración FDI donde lo hizo.", body: "optional", nullable: true, agent: "fills" },
      surfaces: { kind: "textList", maxItems: 5, maxLength: 20, label: "Superficies", description: "Caras de la pieza que trabajó, como las dijo.", body: "optional", nullable: true, agent: "fills" },
      quantity: { kind: "int", min: 1, max: 99, label: "Cantidad", description: "Cuántas unidades, solo si lo dijo («dos carillas» = 2).", body: "optional", nullable: true, agent: "fills" },
    },
  },
  // Un material que se dice usado en la atención (ADR 0106): se busca en Inventario y, confirmado,
  // es el total de ese producto en la atención; sale de la sede al firmar, con los de sus servicios.
  "atencion.material": {
    label: "Material usado",
    fields: {
      product: { kind: "text", min: 2, max: 200, label: "Material", description: "El material que usó, con sus palabras y en singular (mascarilla, guante, carpule de anestesia). El sistema lo busca en Inventario.", body: "none", agent: "requires" },
      quantity: { kind: "int", min: 1, max: 9999, label: "Cuántos en total", description: "Cuántos dijo que usó, solo si lo dijo («dos pares de guantes» = 2). Vacío si no lo dijo.", body: "optional", nullable: true, agent: "fills" },
    },
  },
  // La próxima cita que se pide reservar en la atención (issue 109, paso 2): el servicio busca el
  // hueco del profesional y la reserva `createAppointment`, como «Nueva cita».
  "cita.dictada": {
    label: "Próxima cita",
    fields: {
      service: { kind: "text", max: 200, label: "Para qué", description: "Para qué es la cita, con sus palabras («el tratamiento», «el control»). Vacío si no lo dijo.", body: "optional", nullable: true, agent: "fills" },
      date: { kind: "text", min: 10, max: 10, label: "Día", description: "El día de la cita en AAAA-MM-DD: el que dijo («el jueves») o el que resulta de contar desde la fecha de hoy que se te da («en quince días»).", body: "required", agent: "requires" },
      time: { kind: "text", max: 5, label: "Hora", description: "La hora en HH:MM de 24 horas, solo si la dijo («a las cuatro de la tarde» = 16:00).", body: "optional", nullable: true, agent: "fills" },
    },
  },
  // «Arma el presupuesto» (issue 109, paso 2): lo indicado en la atención entra al borrador ahora,
  // con la misma regla que al firmar (`assembleEncounterBudget`).
  "presupuesto.armar": {
    label: "Presupuesto",
    fields: {
      show: { kind: "flag", label: "Para mostrárselo", description: "true si pidió armarlo para enseñárselo o explicárselo al paciente ahora; false si solo pidió armarlo o enviarlo.", body: "optional", agent: "requires" },
    },
  },
  "control.crear": {
    label: "Control",
    fields: {
      title: { kind: "text", min: 1, max: 200, label: "Control", description: "De qué es el control (por ejemplo, «Control en 6 meses»).", body: "required", agent: "requires" },
      dueAt: { kind: "instant", label: "Para cuándo", description: "La fecha aproximada del control, en ISO 8601 con zona, contada desde la fecha de hoy que se te da.", body: "required", agent: "requires" },
      instructions: { kind: "text", max: 2000, label: "Indicaciones", description: "Qué revisar o hacer en ese control.", body: "optional", nullable: true, agent: "fills" },
      kind: { kind: "enum", values: ["tratamiento", "mantenimiento"], label: "Clase", description: "De un tratamiento en curso o de mantenimiento.", body: "required", agent: "context" },
      originEncounterId: { kind: "uuid", label: "Atención", description: "La atención donde se indicó.", body: "optional", nullable: true, agent: "context" },
    },
  },
} as const satisfies Record<string, OperationSpec>

export type OperationId = keyof typeof OPERATIONS

/* ---------- Tipos de entrada derivados de la declaración ---------- */

type ValueOf<F> = F extends { kind: "int" } | { kind: "decimal" }
  ? number
  : F extends { kind: "enum"; values: readonly (infer V)[] }
    ? V
    : F extends { kind: "decisionList"; values: readonly (infer V)[] }
      ? Array<{ planItemId: string; decision: V }>
      : F extends { kind: "textList" } | { kind: "uuidList" }
        ? string[]
        : F extends { kind: "flag" }
          ? boolean
          : string

type Fields<O extends OperationId> = (typeof OPERATIONS)[O]["fields"]
type KeysWhere<F, C> = { [K in keyof F]: F[K] extends C ? K : never }[keyof F]
type Simplify<T> = { [K in keyof T]: T[K] } & {}
type MaybeNull<F> = F extends { nullable: true } ? ValueOf<F> | null : ValueOf<F>

/** Lo que valida la ruta: el cuerpo que envía la pantalla. */
export type OperationBody<O extends OperationId> = Simplify<
  { [K in KeysWhere<Fields<O>, { body: "required" }>]: ValueOf<Fields<O>[K]> } & {
    [K in KeysWhere<Fields<O>, { body: "optional"; default: string }>]: ValueOf<Fields<O>[K]>
  } & {
    [K in Exclude<KeysWhere<Fields<O>, { body: "optional" }>, KeysWhere<Fields<O>, { default: string }>>]?: MaybeNull<Fields<O>[K]>
  }
>

/** Lo que llena el agente al usar la herramienta de esa operación. */
export type OperationAgentInput<O extends OperationId> = Simplify<
  { [K in KeysWhere<Fields<O>, { agent: "requires" }>]: ValueOf<Fields<O>[K]> } & {
    [K in KeysWhere<Fields<O>, { agent: "fills" }>]?: ValueOf<Fields<O>[K]>
  }
>

type AgentShape<O extends OperationId> = {
  [K in KeysWhere<Fields<O>, { agent: "requires" }>]: z.ZodType<ValueOf<Fields<O>[K]>>
} & {
  [K in KeysWhere<Fields<O>, { agent: "fills" }>]: z.ZodOptional<z.ZodType<ValueOf<Fields<O>[K]>>>
}

/* ---------- Esquemas ---------- */

function fieldSchema(field: OperationField): z.ZodType {
  switch (field.kind) {
    case "text":
      return z.string().min(field.min ?? 0).max(field.max)
    case "uuid":
      return z.uuid()
    case "ref":
      return z.string().min(1).max(200)
    case "instant":
      return z.iso.datetime({ offset: true })
    case "int": {
      const int = z.number().int().min(field.min)
      return field.max === undefined ? int : int.max(field.max)
    }
    case "decimal":
      return z.number().min(field.min).max(field.max)
    case "enum":
      return z.enum(field.values)
    case "textList":
      return z.array(z.string().min(1).max(field.maxLength)).max(field.maxItems)
    case "uuidList":
      return z.array(z.uuid()).max(field.maxItems)
    case "decisionList":
      return z
        .array(z.strictObject({ planItemId: z.uuid(), decision: z.enum(field.values) }))
        .min(1)
        .max(field.maxItems)
    case "flag":
      return z.boolean()
  }
}

function specOf(operation: OperationId): OperationSpec {
  return OPERATIONS[operation]
}

/** Validación del cuerpo de la ruta de una operación. */
export function operationBodySchema<O extends OperationId>(operation: O): z.ZodType<OperationBody<O>> {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, field] of Object.entries(specOf(operation).fields)) {
    if (field.body !== "required" && field.body !== "optional") continue
    let schema = fieldSchema(field)
    if (field.nullable) schema = schema.nullable()
    if (field.body === "optional") schema = field.default === undefined ? schema.optional() : schema.default(field.default)
    shape[name] = schema
  }
  const spec = specOf(operation)
  return (spec.strict ? z.strictObject(shape) : z.object(shape)) as unknown as z.ZodType<OperationBody<O>>
}

/**
 * Los campos declarados de una operación, para una ruta que además recibe
 * otros que aún declara ella misma (anidados o propios de la pantalla).
 */
export function operationBodyShape(operation: OperationId): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, field] of Object.entries(specOf(operation).fields)) {
    if (field.body !== "required" && field.body !== "optional") continue
    let schema = fieldSchema(field)
    if (field.nullable) schema = schema.nullable()
    shape[name] = field.body === "optional" ? schema.optional() : schema
  }
  return shape
}

/**
 * Esquema de la herramienta del agente para una operación: solo los campos que
 * él llena, cada uno con su descripción. Lo demás lo pone el sistema desde la
 * conversación o queda reservado a una persona.
 */
export function operationAgentSchema<O extends OperationId>(
  operation: O,
  words: ProductFieldWords = {},
): z.ZodObject<AgentShape<O>> {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, field] of Object.entries(specOf(operation).fields)) {
    if (field.agent !== "requires" && field.agent !== "fills") continue
    const schema = field.kind === "enum" && field.agentValues ? z.enum(field.agentValues) : fieldSchema(field)
    // El recurso que se reserva y quien atiende, con las palabras del producto (latidIA: «sala», «médico»).
    const description = inProductWords(field.description, words)
    // La descripción va en el esquema final: el envoltorio opcional no hereda la del interior.
    shape[name] = (field.agent === "requires" ? schema : schema.optional()).describe(description)
  }
  return z.object(shape) as unknown as z.ZodObject<AgentShape<O>>
}

export interface OperationFieldInfo {
  name: string
  label: string
  description: string
  required: boolean
}

/** Qué puede llenar el agente en una operación, para mostrarlo en su página. */
export function operationAgentFields(operation: OperationId, words: ProductFieldWords = {}): OperationFieldInfo[] {
  return Object.entries(specOf(operation).fields)
    .filter(([, field]) => field.agent === "requires" || field.agent === "fills")
    .map(([name, field]) => ({
      name,
      label: inProductWords(field.label, words),
      description: inProductWords(field.description, words),
      required: field.agent === "requires",
    }))
}

/** Lo que se reserva y quien atiende con las palabras del producto (latidIA: «sala», «médico»). */
export interface ProductFieldWords {
  room?: string
  clinician?: string
}

function inProductWords(text: string, words: ProductFieldWords): string {
  let out = text
  if (words.room) out = out.replaceAll("unidad dental", words.room).replaceAll("Unidad dental", upperFirst(words.room))
  if (words.clinician) out = out.replaceAll("odontólogo", words.clinician)
  return out
}

/**
 * Qué operación declara los campos de cada herramienta que escribe. Una
 * herramienta que no esté aquí ni en `TOOLS_WITHOUT_OPERATION` hace fallar la
 * prueba del paquete del agente: no puede declarar campos por su cuenta.
 */
export const TOOL_OPERATION: Record<string, OperationId> = {
  create_task: "tarea.crear",
  proponer_cita: "cita.reservar",
  reprogramar_cita: "cita.mover",
  confirmar_cita: "cita.confirmar",
  responder_permiso_mensajes: "mensajes.permiso",
  elegir_mensajes: "mensajes.elegir",
  reenviar_presupuesto: "presupuesto.reenviar",
  anotar_respuesta_presupuesto: "presupuesto.respuesta",
  create_opportunity: "oportunidad.crear",
  close_opportunity: "oportunidad.cerrar",
  update_followup: "oportunidad.tarea",
  request_human_handoff: "derivacion.crear",
  recordar_dato: "persona.recordar",
}

/**
 * Herramientas que escriben sin una operación declarada, con el motivo. Son
 * deuda conocida o actos que no tienen un formulario gemelo.
 */
export const TOOLS_WITHOUT_OPERATION: Record<string, string> = {
  send_reply: "Enviar un mensaje no es un formulario: el texto es el único campo.",
  despedirse_y_cerrar: "La despedida es un mensaje (el texto es su único campo) y cerrar no tiene campos: el motivo es siempre «resuelta».",
  confirmar_propuesta: "Solo lleva el id de la propuesta que el interlocutor confirma.",
  enviar_comprobante: "Solo lleva el paciente: el comprobante es el de su último pago y ninguna pantalla lo envía por el chat.",
  enviar_enlace_cita: "El enlace solo dice para quién, qué servicio y qué sede; el día y la hora los elige la persona en la página.",
  pedir_volver_al_portal: "No lleva campos: el pedido es de la persona del chat y lo atiende recepción.",
  anotar_caso: "La nota del caso es propia del agente; ninguna pantalla la crea.",
  recordar_tema: "Solo lleva el id del tema: anota que la persona volvió a preguntar y avisa a quien lo tiene (ADR 0050).",
  reservar_paciente_nuevo: "Los campos del hueco son los de «Reservar una cita» (`cita.reservar`, sin paciente) y `forOther` (quien escribe ya es paciente y la cita es para alguien nuevo). No reserva ni registra: emite su enlace con esa hora (`bookingPickAddress`), donde la persona deja sus datos y reserva (ADR 0109).",
  guardar_contacto: "Los mismos dos campos y reglas que «¿Dónde te avisamos?» del chat web (`saveWebchatContactForConversation`): su WhatsApp o su correo.",
  cancelar_cita: "En la pantalla cancelar es un cambio de estado; el agente propone con la cita y un motivo.",
  add_tags: "Pendiente: las etiquetas se normalizan en la ruta de contactos, que aún declara sus campos.",
  update_contact: "Pendiente: la ruta de contactos aún declara sus campos; el agente solo toca nombre y campos personalizados.",
}

/** Herramientas que solo leen: sus parámetros son filtros de una consulta, no campos de una operación. */
export const READ_TOOLS: readonly string[] = [
  "ver_sedes_y_servicios",
  "buscar_en_la_clinica",
  "consultar_conocimiento",
  "ver_contexto_paciente",
  "ver_resumen_paciente",
  "ver_presupuesto",
  "buscar_huecos",
  "leer_contexto_comercial",
  "ver_otros_canales",
  "listar_oportunidades",
  "listar_tareas",
]

export interface OperationFill {
  operation: OperationId
  label: string
  fields: OperationFieldInfo[]
}

/** Qué puede llenar un conjunto de herramientas: una entrada por operación declarada. */
export function operationFillsOf(tools: readonly string[], words: ProductFieldWords = {}): OperationFill[] {
  const operations = [...new Set(tools.map((tool) => TOOL_OPERATION[tool]).filter((id): id is OperationId => id !== undefined))]
  return operations.map((operation) => ({
    operation,
    label: OPERATIONS[operation].label,
    fields: operationAgentFields(operation, words),
  }))
}

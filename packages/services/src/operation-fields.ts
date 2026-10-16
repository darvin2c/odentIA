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
  | { kind: "enum"; values: readonly [string, ...string[]] }
  /** Lista corta de textos (superficies de una pieza). */
  | { kind: "textList"; maxItems: number; maxLength: number }
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

const reason = {
  kind: "text",
  max: 500,
  label: "Motivo de la propuesta",
  description: "Por qué se propone, en una frase, para quien deba aprobarla.",
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
      dentistUserId: { kind: "ref", label: "Profesional", description: "El profesional del hueco elegido en buscar_huecos.", body: "required", agent: "requires" },
      chairId: { kind: "uuid", label: "Sillón", description: "El sillón del hueco elegido en buscar_huecos; sin él, la agenda pone el primero libre de la sede.", body: "optional", agent: "fills" },
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
    },
  },
  "cita.mover": {
    label: "Mover una cita",
    fields: {
      appointmentId: { kind: "uuid", label: "Cita", description: "El id exacto de la cita, tomado de ver_resumen_paciente.", body: "path", agent: "requires" },
      expectedVersion: { kind: "int", min: 1, label: "Versión", description: "La versión de la cita que se leyó: evita pisar un cambio de otra persona.", body: "required", agent: "requires" },
      startsAt: { kind: "instant", label: "Nuevo inicio", description: "Inicio exacto del hueco nuevo, en ISO 8601 con zona.", body: "required", agent: "requires" },
      dentistUserId: { kind: "ref", label: "Profesional", description: "Solo si cambia de profesional.", body: "optional", agent: "fills" },
      chairId: { kind: "uuid", label: "Sillón", description: "Solo si cambia de sillón.", body: "optional", agent: "fills" },
      endsAt: { kind: "instant", label: "Nuevo fin", description: "Fin exacto, cuando cambia la duración.", body: "optional", agent: "person" },
      reason,
    },
  },
  "cita.confirmar": {
    label: "Confirmar una cita",
    fields: {
      appointmentId: { kind: "uuid", label: "Cita", description: "El id exacto de la cita que la persona confirma, de ver_resumen_paciente. Sin él se confirma la única cita suya que espera confirmación.", body: "path", agent: "fills" },
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
        label: "Motivo",
        description: "Perdida: precio, otra_clinica (eligió otra clínica), no_responde, no_lo_necesita (ya no lo necesita) u otro. Ganada: acepto.",
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
      assigneeUserId: { kind: "text", max: 200, label: "Responsable", description: "A quién del equipo va; sin él queda en la cola.", body: "optional", agent: "fills" },
      message: { kind: "text", min: 1, max: 4000, label: "Aviso al interlocutor", description: "Aviso breve de que una persona continuará: después el agente ya no puede escribirle.", body: "none", agent: "fills" },
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
      nextStep: { kind: "text", max: 2000, label: "Siguiente paso", description: "Qué toca en la próxima atención.", body: "optional", nullable: true, agent: "fills" },
      prognosis: { kind: "text", max: 2000, label: "Pronóstico", description: "El pronóstico que dijo el odontólogo.", body: "optional", nullable: true, agent: "fills" },
      auxiliaryExams: { kind: "text", max: 4000, label: "Exámenes auxiliares", description: "Exámenes pedidos o con resultado.", body: "optional", nullable: true, agent: "fills" },
    },
  },
  "atencion.diagnostico": {
    label: "Diagnóstico",
    strict: true,
    fields: {
      cie10Code: { kind: "text", min: 1, max: 10, label: "Código CIE-10", description: "El código CIE-10 que corresponde al diagnóstico que nombró el odontólogo; casi siempre lo dice con palabras y no con el código (por ejemplo, «caries en dentina» es K02.1). Si no nombró ningún diagnóstico, no registres ninguno.", body: "required", agent: "requires" },
      diagnosisType: { kind: "enum", values: ["presuntivo", "definitivo", "repetido"], label: "Tipo", description: "Presuntivo si aún no está confirmado, definitivo si lo está, repetido si ya se había registrado.", body: "required", agent: "requires" },
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
      planId: { kind: "uuid", label: "Plan", description: "El plan de tratamiento del paciente.", body: "required", agent: "context" },
      sourceEncounterId: { kind: "uuid", label: "Atención", description: "La atención donde se indica.", body: "required", agent: "context" },
      toothNumber: { kind: "int", min: 11, max: 85, label: "Pieza", description: "La pieza en numeración FDI, si la indicación es para una pieza.", body: "optional", nullable: true, agent: "fills" },
      surfaces: { kind: "textList", maxItems: 5, maxLength: 20, label: "Superficies", description: "Caras de la pieza que se tratan.", body: "optional", nullable: true, agent: "fills" },
      detail: { kind: "text", max: 2000, label: "Detalle", description: "Una precisión sobre la indicación.", body: "optional", nullable: true, agent: "fills" },
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

type ValueOf<F> = F extends { kind: "int" }
  ? number
  : F extends { kind: "enum"; values: readonly (infer V)[] }
    ? V
    : F extends { kind: "textList" }
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
    case "enum":
      return z.enum(field.values)
    case "textList":
      return z.array(z.string().min(1).max(field.maxLength)).max(field.maxItems)
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
export function operationAgentSchema<O extends OperationId>(operation: O): z.ZodObject<AgentShape<O>> {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, field] of Object.entries(specOf(operation).fields)) {
    if (field.agent !== "requires" && field.agent !== "fills") continue
    const schema = fieldSchema(field)
    // La descripción va en el esquema final: el envoltorio opcional no hereda la del interior.
    shape[name] = (field.agent === "requires" ? schema : schema.optional()).describe(field.description)
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
export function operationAgentFields(operation: OperationId): OperationFieldInfo[] {
  return Object.entries(specOf(operation).fields)
    .filter(([, field]) => field.agent === "requires" || field.agent === "fills")
    .map(([name, field]) => ({ name, label: field.label, description: field.description, required: field.agent === "requires" }))
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
  create_opportunity: "oportunidad.crear",
  move_to_stage: "oportunidad.mover",
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
  send_template: "La plantilla y sus parámetros los define el proveedor del canal.",
  confirmar_propuesta: "Solo lleva el id de la propuesta que el interlocutor confirma.",
  enviar_enlace_cita: "El enlace solo dice para quién, qué servicio y qué sede; el día y la hora los elige la persona en la página.",
  anotar_caso: "La nota del caso es propia del agente; ninguna pantalla la crea.",
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
export function operationFillsOf(tools: readonly string[]): OperationFill[] {
  const operations = [...new Set(tools.map((tool) => TOOL_OPERATION[tool]).filter((id): id is OperationId => id !== undefined))]
  return operations.map((operation) => ({
    operation,
    label: OPERATIONS[operation].label,
    fields: operationAgentFields(operation),
  }))
}

/**
 * Lo que el modelo de Argos sabe de las vistas del negocio (ADR 0075): qué es
 * cada vista, sus columnas y qué llave la lee. Es la única descripción: el
 * modelo recibe solo las vistas que lee el rol de quien pregunta, y una prueba
 * compara este catálogo con las vistas y los permisos reales de la base
 * (`argos-views.test.ts`). Una vista o columna nueva se describe aquí en el
 * mismo cambio que la migración.
 */

import { type ProductAgentTexts, productName } from "./product-agent.js"

/** La llave de base de cada rol (`argosRoleOf`), sin el prefijo `argos_`. */
export type ArgosKey = "gestion" | "recepcion" | "clinico" | "caja"

export interface ArgosView {
  name: string
  /** Qué es una fila y la regla de odentIA que ya trae. */
  about: string
  /** Columnas en orden, con lo que no se deduce del nombre. */
  columns: string
  keys: readonly ArgosKey[]
}

const ALL: readonly ArgosKey[] = ["gestion", "recepcion", "clinico", "caja"]

export const ARGOS_CATALOG: readonly ArgosView[] = [
  {
    name: "ventas",
    about:
      "Lo cargado a cada paciente: tratamientos hechos y productos vendidos. Una fila es una venta (un concepto), sin anuladas; lo devuelto ya está descontado.",
    columns:
      "venta_id, cargado_en (timestamptz), dia (date), paciente_id, paciente, concepto (nombre del tratamiento o producto), tipo ('tratamiento'|'producto'), cantidad, importe, pagado, saldo (lo que falta pagar de esa venta; con algo pagado, es un pago parcial), sede, profesional (quien atendió), promocion, especialidad (de la clínica, la del tratamiento; null en productos)",
    keys: ["gestion", "caja"],
  },
  {
    name: "cobros",
    about:
      "Cada movimiento de lo cobrado. Sumar «importe» en un periodo da LO COBRADO de la clínica: pagos menos anulaciones y devoluciones de ese periodo. «impuesto» es la parte de ese importe que es IGV o IVA: no es de la clínica (lo cobrado sin impuesto es importe − impuesto).",
    columns: "momento (timestamptz), dia, tipo ('pago'|'anulacion'|'devolucion'), importe (negativo en anulación y devolución), medio (Efectivo, Yape, Tarjeta…), sede, paciente, paciente_id, impuesto (la parte del importe que es impuesto, con su mismo signo)",
    keys: ["gestion", "caja"],
  },
  {
    name: "pagos_por_venta",
    about: "Lo pagado aplicado a cada venta: qué se pagó y de qué. Solo pagos vigentes. «Lo que más se vendió» es lo que más se pagó: se mide aquí. Una venta pagada en partes sale una vez por pago: cuántas veces se vendió = count(distinct venta_id), nunca count(*) ni sumando cantidad aquí.",
    columns: "pagado_en (timestamptz), dia, importe, concepto, tipo ('tratamiento'|'producto'), cantidad (de la venta), profesional (quien la atendió), sede, paciente, paciente_id, medio, venta_id, especialidad (de la clínica, la del tratamiento; null en productos)",
    keys: ["gestion", "caja"],
  },
  {
    name: "tickets",
    about: "Los tickets de pago. {producto} no emite facturas ni boletas: solo tickets. Un ticket junta lo cobrado en una visita, no es una venta.",
    columns: "numero, emitido_en (timestamptz), dia, sede, paciente, paciente_id, total, a_favor_usado, anulado (bool)",
    keys: ["gestion", "caja"],
  },
  {
    name: "deudas",
    about:
      "Lo que debe cada paciente, a hoy (una fila por paciente que debe): lo cargado sin pagar menos lo que tiene a favor. «Te deben» es la suma de «saldo». Su deuda está vencida si su venta más antigua sin pagar tiene más de 30 días.",
    columns: "paciente_id, paciente, debe, a_favor, saldo, vencida (bool), desde (date: su venta sin pagar más antigua), dias (desde entonces)",
    keys: ["gestion", "caja"],
  },
  {
    name: "gastos",
    about:
      "Gastos registrados, como movimientos: el gasto en su fecha y su anulación (negativa) en la suya. Solo lo registrado en Finanzas: no hay costos fijos ni laboratorio por tratamiento. Lo pagado a proveedores (pago_de_compra) está en la categoría Materiales.",
    columns:
      "momento (timestamptz), dia, categoria (Alquiler, Materiales, Personal, Laboratorio, Servicios, Impuestos…), tipo ('gasto'|'pago_de_compra': pago a un proveedor de materiales|'pago_de_comisiones': el pago de comisiones ya contadas en «comisiones»|'pago_del_impuesto_de_lo_cobrado': el pago del IGV o IVA de lo cobrado, que no es un gasto porque ya salió de lo cobrado), monto, sede",
    keys: ["gestion", "caja"],
  },
  {
    name: "comisiones",
    about:
      "Comisiones de los profesionales, como Finanzas › Comisiones: cada cobro de lo que atendió un profesional con su porcentaje. Cuenta al cobrar (momento del cobro).",
    columns: "momento (timestamptz), dia, profesional, sede (la del cobro), base (lo cobrado de lo que atendió), comision, pagado (lo ya pagado de esa línea), sin_pagar",
    keys: ["gestion"],
  },
  {
    name: "citas",
    about: "Una fila por cita de la agenda. Para contar citas agendadas (cuántas hay, por día, por profesional) deja fuera las canceladas, salvo que pregunten por ellas. Un porcentaje sobre las citas que ya pasaron se divide entre todas las de ya_paso, canceladas incluidas.",
    columns:
      "cita_id, inicio (timestamptz), dia, dia_semana ('lunes'…'domingo'), hora (0-23), sede, profesional, paciente_id, paciente, servicio, estado ('programada'|'confirmada'|'atendida'|'no_vino'|'cancelada'), ya_paso (bool: ya terminó su hora), duracion_min, llego_en (timestamptz: cuándo llegó a la sala), atencion_inicio, espera_min (minutos en sala antes de ser atendido), origen ('recepcion': la agendó el equipo|'agent': la reservó Sofi en la conversación|'enlace': la reservó la persona con el enlace que le mandó Sofi), unidad_dental (la {sala} de la cita)",
    keys: ["gestion", "recepcion", "clinico"],
  },
  {
    name: "agenda_por_dia",
    about:
      "Las horas de cada profesional por día, de 400 días atrás a 60 adelante: su horario, lo disponible (horario menos bloqueos y feriados) y lo ocupado por citas no canceladas.",
    columns: "dia, dia_semana, sede, profesional, minutos_horario, minutos_disponibles, minutos_ocupados, horario_supuesto (bool: antes de su primer horario guardado se usa el de hoy)",
    keys: ["gestion", "recepcion", "clinico"],
  },
  {
    name: "agenda_por_hora",
    about: "Lo mismo por hora del día (solo las horas con algo disponible).",
    columns: "dia, dia_semana, hora (0-23), sede, profesional, minutos_disponibles, minutos_ocupados",
    keys: ["gestion", "recepcion", "clinico"],
  },
  {
    name: "ausencias",
    about: "Las ausencias del equipo (vacaciones, permisos), por sede, sin su motivo. Ya están descontadas de lo disponible en la agenda.",
    columns: "profesional, sede, desde (timestamptz), hasta (timestamptz: no entra), primer_dia (date), ultimo_dia (date: el último día que falta)",
    keys: ["gestion", "recepcion", "clinico"],
  },
  {
    name: "pacientes",
    about:
      "Una fila por paciente (sin spam ni bloqueados). Un paciente es «nuevo» en el periodo que contiene su primera_atencion, y nuevo de una sede si además su primera_sede es esa sede (como Reportes: no basta con una cita ahí). «Activos» = con ultima_atencion en los 18 meses anteriores, archivados incluidos. «Sin venir» (dejaron de venir, sin decir cuánto) = no archivados con ultima_atencion_en < now() - interval '{meses} months' (más de {meses} meses, sin el día límite, como Reportes), sin proxima_cita, sin presupuesto_esperando y sin control_pendiente. «No han vuelto en N días o meses» = no archivados con ultima_atencion_en < now() − N, sin más condiciones.",
    columns:
      "paciente_id, nombre, archivado (bool), primera_atencion (date: su primera cita atendida), ultima_atencion (date), atenciones (citas atendidas en total), proxima_cita (timestamptz o null), como_nos_conocio ('Recomendación de alguien'|'Redes sociales'|'Google o mapas'|'Pasaba por aquí'|'Convenio o empresa'|'Otro'|'No lo dijo'), presupuesto_esperando (bool), control_pendiente (bool), registrado_en, ultima_atencion_en (timestamptz: la hora de su última cita atendida), primera_atencion_en (timestamptz: la hora de su primera cita atendida), primera_sede (la sede de esa cita)",
    keys: ALL,
  },
  {
    name: "tratamientos_hechos",
    about: "Lo realizado: procedimientos de atenciones firmadas, sin anulados. Sin diagnósticos ni notas.",
    columns:
      "fecha (timestamptz), dia, paciente, paciente_id, profesional, sede, tratamiento, tipo_tratamiento (tipo de la biblioteca; a menudo null), especialidad (de la clínica: {especialidades}…), cantidad, precio",
    keys: ["gestion", "clinico"],
  },
  {
    name: "planes",
    about:
      "Una fila por tratamiento indicado en un plan (no por plan: para contar planes, count(distinct plan_id)), con la decisión del paciente y su avance. «Pendiente» = aceptado y por empezar, programado o en curso; un plan sin iniciar = sus tratamientos aceptados (sin los cancelados) siguen todos por empezar o programados, sin ninguno iniciado. No hay fecha prevista de término.",
    columns:
      "plan_id, paciente, paciente_id, tratamiento, especialidad, decision ('pendiente'|'aceptado'|'pospuesto'|'rechazado'|'no_elegida'), estado ('pendiente'|'programado'|'en_curso'|'suspendido'|'realizado'|'cancelado'), indicado_en, decidido_en, iniciado_en, terminado_en (timestamptz), precio, fase ({fases}), indicado_por (profesional que lo indicó; no se sabe quién lo hará)",
    keys: ["gestion", "clinico"],
  },
  {
    name: "controles",
    about: "Controles clínicos programados a los pacientes (sin el texto de las indicaciones).",
    columns: "paciente, paciente_id, tipo ('tratamiento'|'mantenimiento'), vence_en (timestamptz), vence_dia, estado ('pendiente'|'programado'|'realizado'|'cancelado'), tiene_cita (bool), hecho_en",
    keys: ["gestion", "recepcion", "clinico"],
  },
  {
    name: "presupuestos",
    about:
      "Un presupuesto por fila; los importes son de la opción que vale (nunca sumar opciones). Entregados = estado 'presentado', 'aceptado', 'parcial', 'pospuesto' o 'rechazado' ('sustituido' y 'cancelado' no cuentan). El valor de un presupuesto aceptado es lo aceptado (columna aceptado), no su valor entero. Los que esperan respuesta (pendientes, sin aceptar) son los de espera_respuesta, a hoy; lo que esperan, en dinero, es sum(sin_decidir), no el valor entero.",
    columns:
      "presupuesto_id, numero, paciente, paciente_id, presentado_en (timestamptz), presentado_dia, estado ('presentado'|'aceptado'|'parcial'|'pospuesto'|'rechazado'|'sustituido'|'cancelado'), decidido_en, profesional (quien lo armó), valor, aceptado (lo aceptado), sin_decidir (pendiente o pospuesto), espera_respuesta (bool)",
    keys: ALL,
  },
  {
    name: "lineas_presupuesto",
    about: "Cada tratamiento de la opción que vale de un presupuesto entregado.",
    columns:
      "presupuesto_id, numero, paciente, paciente_id, presentado_en, presentado_dia, estado_presupuesto, tratamiento, decision ('aceptado'|'rechazado'|'pospuesto'|'pendiente'), importe, promocion, estado_tratamiento (cómo va ese tratamiento en el plan: 'pendiente'|'programado'|'en_curso'|'suspendido'|'realizado'|'cancelado'; null si no está en un plan)",
    keys: ALL,
  },
  {
    name: "promociones",
    about: "Las promociones de la clínica. Abiertas, vigentes o activas hoy = vigente_hoy.",
    columns: "nombre, inicio, fin (timestamptz o null), activa (bool), vigente_hoy (bool: activa y dentro de sus fechas)",
    keys: ALL,
  },
  {
    name: "promociones_uso",
    about: "Cada vez que alguien usó una promoción: en un presupuesto entregado o en un cobro.",
    columns: "promocion, paciente, paciente_id, fecha, aceptado (bool), descuento, paciente_nuevo (bool: no se había atendido antes), cobrado_desde_entonces (lo que esa persona pagó desde ese día), profesional (en un presupuesto, quien indicó el tratamiento; en un cobro, quien lo atendió; null en la venta de un producto)",
    keys: ["gestion"],
  },
  {
    name: "lotes",
    about: "Los lotes con existencias, por sede, a hoy.",
    columns: "producto, unidad, sede, lote, vence (date o null), cantidad, estado ('vigente'|'por_vencer': vence en 30 días o menos|'vencido'|'sin_vencimiento')",
    keys: ["gestion", "recepcion"],
  },
  {
    name: "inventario",
    about: "Un producto activo por sede, a hoy. Sin costos.",
    columns:
      "producto, unidad (la unidad en que se cuenta: guante, frasco…), sede, hay (en esa unidad, nunca en cajas; negativo si se usó sin haber), minimo, estado ('ok'|'hace_falta': bajo el mínimo|'no_hay'|'faltante': se usó sin haber), hay_que_reponer (bool), cantidad_por_vencer (en 30 días), vence_primero (date), cantidad_vencida, insumo (bool: se usa en las atenciones), se_vende (bool: se vende; un producto puede ser las dos cosas)",
    keys: ["gestion", "recepcion"],
  },
  {
    name: "movimientos_inventario",
    about: "Lo que entró y salió del inventario. El consumo se registra por atención, no por procedimiento.",
    columns:
      "fecha (timestamptz), dia, tipo ('consumo': usado en una atención|'venta'|'ingreso': compra recibida|'ajuste'|'traslado'|'devolucion'|'cobertura'), producto, unidad, cantidad (negativa si salió), sede, profesional (en el consumo, quien atendió), paciente, insumo (bool: se usa en las atenciones), se_vende (bool)",
    keys: ["gestion", "recepcion"],
  },
  {
    name: "compras",
    about: "Órdenes de compra a proveedores. Lo comprado son las hechas: sin 'borrador' ni 'cancelada'. Los lotes no guardan su costo: el inventario no se puede valorizar.",
    columns: "numero, proveedor, sede, estado ('borrador'|'confirmada'|'parcialmente_recibida'|'recibida'|'cerrada'|'cancelada'), creada_en, dia, total, recibido, pagado",
    keys: ["gestion"],
  },
  {
    name: "compras_detalle",
    about: "Cada producto de una orden de compra: cuánto se pidió, cuánto llegó y a qué precio. Lo comprado son las órdenes sin 'borrador' ni 'cancelada', como en compras.",
    columns: "numero, proveedor, sede, estado (el de la orden), creada_en, dia, producto, unidad (en la que se cuenta el producto), cantidad (pedida, en esa unidad), recibida, precio (por unidad), total",
    keys: ["gestion"],
  },
  {
    name: "conversaciones",
    about: "Conversaciones con personas por los canales (sin mensajes). No hay campañas ni encuestas.",
    columns:
      "inicio (timestamptz), dia, canal ('whatsapp'|'messenger'|'instagram'|'telegram'|'webchat'|'email'), estado ('open'|'closed'), motivo_cierre ('resuelta'|'sin_respuesta': la persona dejó de responder|'equipo'|'manual'), cerrada_en, ultimo_mensaje_en, persona, persona_id (una persona puede tener varias conversaciones), paciente_id (null si aún no es paciente), es_paciente (bool), agente ('on'|'off'), asignada_a, espera_respuesta (bool: su último mensaje es de la persona y nadie le respondió todavía, a hoy)",
    keys: ["gestion", "recepcion", "clinico"],
  },
  {
    name: "oportunidades",
    about: "Ventas en curso del CRM: el interés de una persona por un servicio.",
    columns:
      "creada_en (timestamptz), dia, etapa (nombre del paso), momento ('interesado'|'evaluacion_agendada'|'presupuesto_enviado'|'decidio'), estado ('open'|'won'|'lost'), servicio, valor, cerrada_en, motivo_cierre ('precio'|'otra_clinica'|'no_responde'|'no_lo_necesita'|'otro'|'rechazo_presupuesto'|'acepto'|'acepto_presupuesto'), persona, persona_id, paciente_id (null si aún no es paciente), responsable",
    keys: ["gestion", "recepcion"],
  },
  {
    name: "embudo",
    about:
      "Una fila por persona que nos buscó por primera vez (prospecto), como el embudo de Reportes: su primer contacto (su primer mensaje, el de quien escribió por ella y la registró, o su registro) y hasta dónde llegó desde entonces. Cada paso cuenta a quien llegó a él o a uno posterior. Quien ya era paciente y escribe después no está aquí.",
    columns:
      "primer_contacto_en (timestamptz), dia, canal ('whatsapp'|'instagram'|…|'registro_en_linea'|'recepcion'), persona, persona_id, paciente_id (null si aún no es paciente), agendo (bool), vino (bool), recibio_presupuesto (bool), acepto (bool), pago (bool: {pago})",
    keys: ["gestion", "recepcion"],
  },
  {
    name: "tareas",
    about: "Tareas del equipo (sin su texto).",
    columns: "creada_en, vence_en (timestamptz), estado ('open'|'done'|'cancelled'), area, tipo, dejada_por ('equipo'|'agent'|'admin'), responsable",
    keys: ["gestion"],
  },
  {
    name: "equipo",
    about: "Las personas del equipo de la clínica, con su rol y las especialidades que atienden. Quien atiende pacientes ({profesionales}) es atiende, no el rol: la propietaria también puede atender.",
    columns: "profesional, rol ('propietario'|'administración'|'{rol_profesional}'|'recepción'|'caja', separados por coma si tiene varios), especialidades (las de la clínica, separadas por coma; null si no tiene), atiende (bool: tiene horario o citas como profesional)",
    keys: ALL,
  },
]

/** Lo que odentIA no registra: la respuesta lo dice y ofrece lo más cercano, nunca otra cifra como si fuera la pedida. */
export const ARGOS_NOT_RECORDED: readonly string[] = [
  "Facturas o boletas: solo tickets de pago.",
  "Una fecha prevista para cada tratamiento: no se sabe cuáles están atrasados ni cuáles se abandonaron. Lo más cercano: los tratamientos pendientes, los planes sin iniciar o parados y cuánto dura un tratamiento.",
  "Quién hará un tratamiento: solo quién lo indicó (planes.indicado_por).",
  "Costos por tratamiento o por profesional (laboratorio, materiales de cada tratamiento, costos fijos): su rentabilidad no se puede saber. Lo más cercano: por tratamiento, lo cobrado de cada uno (pagos_por_venta), sin restarle nada, porque las comisiones y los gastos no se ligan a cada tratamiento; por profesional, lo cobrado de lo que atendió menos su comisión.",
  "Quién canceló una cita (la persona o la clínica) ni si se reprogramó.",
  "Cuotas o tratamientos financiados.",
  "Lo que se debía al cierre de meses pasados (cómo evolucionó la cartera o la deuda): solo está lo que se debe hoy (deudas). No lo reemplaces con lo cargado o lo cobrado de esos meses.",
  "Campañas de marketing y gasto en publicidad: tampoco el costo de conseguir un paciente.",
  "Encuestas, satisfacción, recomendación (NPS) y quejas.",
  "El costo de los lotes: el inventario no se puede valorizar.",
  "El consumo de materiales por procedimiento: se registra por atención (por profesional sí).",
]

/** Lo que odentIA sí guarda pero Argos no lee: la respuesta dice que no lo puede consultar, nunca que no se registra. */
export const ARGOS_NOT_READABLE: readonly string[] = [
  "La historia clínica (diagnósticos, enfermedades, alergias, {fichas}notas): está en la ficha de cada paciente, y Argos no la lee.",
]

/** Las vistas que lee una llave. */
export function argosViewsOf(key: ArgosKey): readonly ArgosView[] {
  return ARGOS_CATALOG.filter((view) => view.keys.includes(key))
}

/** El catálogo en texto, para el modelo: solo las vistas de la llave. */
export function argosCatalogText(key: ArgosKey, texts: ProductAgentTexts): string {
  const views = argosViewsOf(key)
  return withProductWords(texts, [
    "Vistas (solo estas; el dinero está en la moneda de la clínica; «dia» es la fecha en la zona de la clínica):",
    ...views.map((view) => `\n${view.name}: ${view.about}\n  ${view.columns}`),
    "\nLo que {producto} no registra (tipo no_existe o parcial, con lo más cercano que sí existe):",
    ...ARGOS_NOT_RECORDED.map((item) => `- ${item}`),
    "\nLo que {producto} guarda pero tú no puedes consultar (tipo no_existe, dicho como «eso no lo puedo consultar» y dónde se ve):",
    ...ARGOS_NOT_READABLE.map((item) => `- ${item}`),
  ].join("\n"))
}

/**
 * Las palabras del producto en el catálogo (issue 229, entrega 9): su nombre,
 * sus meses sin venir, su sala, sus especialidades y fases, qué es «pago» en
 * su embudo y cómo se llama a quien atiende. En odentIA, las de siempre.
 */
function withProductWords(texts: ProductAgentTexts, text: string): string {
  const { argos } = texts
  return text
    .replaceAll("{producto}", productName(texts))
    .replaceAll("{meses}", String(texts.recallMonths))
    .replaceAll("{sala}", texts.room || "sala")
    .replaceAll("{especialidades}", argos.specialtyExamples || "'Medicina general'")
    .replaceAll("{fases}", argos.phases || "'general'")
    .replaceAll("{pago}", argos.paid)
    .replaceAll("{profesionales}", argos.clinicians)
    .replaceAll("{rol_profesional}", argos.clinicianRole)
    .replaceAll("{fichas}", argos.clinicalCharts ? `${argos.clinicalCharts}, ` : "")
}

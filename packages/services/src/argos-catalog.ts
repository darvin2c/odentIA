/**
 * Lo que el modelo de Argos sabe de las vistas del negocio (ADR 0075): qué es
 * cada vista, sus columnas y qué llave la lee. Es la única descripción: el
 * modelo recibe solo las vistas que lee el rol de quien pregunta, y una prueba
 * compara este catálogo con las vistas y los permisos reales de la base
 * (`argos-views.test.ts`). Una vista o columna nueva se describe aquí en el
 * mismo cambio que la migración.
 */

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
      "Lo cargado a cada paciente: tratamientos hechos y productos vendidos. Una fila es una venta (un concepto), sin anuladas; lo devuelto ya está descontado. «Ticket promedio» es el promedio de «importe» de estas filas.",
    columns:
      "venta_id, cargado_en (timestamptz), dia (date), paciente_id, paciente, concepto (nombre del tratamiento o producto), tipo ('tratamiento'|'producto'), cantidad, importe, pagado, saldo (lo que falta pagar de esa venta), sede, profesional (quien atendió), promocion, especialidad (de la clínica, la del tratamiento; null en productos)",
    keys: ["gestion", "caja"],
  },
  {
    name: "cobros",
    about:
      "Cada movimiento de lo cobrado. Sumar «importe» en un periodo da LO COBRADO de la clínica: pagos menos anulaciones y devoluciones de ese periodo.",
    columns: "momento (timestamptz), dia, tipo ('pago'|'anulacion'|'devolucion'), importe (negativo en anulación y devolución), medio (Efectivo, Yape, Tarjeta…), sede, paciente, paciente_id",
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
    about: "Los tickets de pago. odentIA no emite facturas ni boletas: solo tickets. Un ticket junta lo cobrado en una visita, no es una venta.",
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
      "Gastos registrados, como movimientos: el gasto en su fecha y su anulación (negativa) en la suya. Solo lo registrado en Finanzas: no hay costos fijos ni laboratorio por tratamiento.",
    columns:
      "momento (timestamptz), dia, categoria (Alquiler, Materiales, Personal, Laboratorio, Servicios, Impuestos…), tipo ('gasto'|'pago_de_compra': pago a un proveedor de materiales|'pago_de_comisiones': el pago de comisiones ya contadas en «comisiones»), monto, sede",
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
    about: "Una fila por cita de la agenda. Para contar citas agendadas (cuántas hay, por día, por profesional) deja fuera las canceladas, salvo que pregunten por ellas. Un porcentaje sobre las citas que ya pasaron (atendidas, no vinieron, canceladas, «terminan realizándose») se divide entre todas las de ya_paso, canceladas incluidas.",
    columns:
      "cita_id, inicio (timestamptz), dia, dia_semana ('lunes'…'domingo'), hora (0-23), sede, profesional, paciente_id, paciente, servicio, estado ('programada'|'confirmada'|'atendida'|'no_vino'|'cancelada'), ya_paso (bool: ya terminó su hora), duracion_min, llego_en (timestamptz: cuándo llegó a la sala), atencion_inicio, espera_min (minutos en sala antes de ser atendido), origen ('recepcion': la agendó el equipo|'agent': la reservó Sofi en la conversación|'enlace': la reservó la persona con el enlace que le mandó Sofi)",
    keys: ["gestion", "recepcion", "clinico"],
  },
  {
    name: "agenda_por_dia",
    about:
      "Las horas de cada profesional por día, de 400 días atrás a 60 adelante: su horario, lo disponible (horario menos bloqueos y feriados) y lo ocupado por citas no canceladas. «Agenda ocupada» = minutos_ocupados ÷ minutos_disponibles; «horas libres» = disponibles − ocupados.",
    columns: "dia, dia_semana, sede, profesional, minutos_horario, minutos_disponibles, minutos_ocupados, horario_supuesto (bool: antes de su primer horario guardado se usa el de hoy)",
    keys: ["gestion", "recepcion", "clinico"],
  },
  {
    name: "agenda_por_hora",
    about: "Lo mismo por hora del día (solo las horas con algo disponible): para saber en qué horarios hay más espacio, agrupa por dia_semana y hora.",
    columns: "dia, dia_semana, hora (0-23), sede, profesional, minutos_disponibles, minutos_ocupados",
    keys: ["gestion", "recepcion", "clinico"],
  },
  {
    name: "pacientes",
    about:
      "Una fila por paciente (sin spam ni bloqueados). Un paciente es «nuevo» en el periodo que contiene su primera_atencion. «Activos» = con ultima_atencion en los 18 meses anteriores, archivados incluidos. «Sin venir» (dejaron de venir, sin decir cuánto) = no archivados con ultima_atencion hace más de 6 meses, sin proxima_cita, sin presupuesto_esperando y sin control_pendiente. «No han vuelto en N días o meses» = no archivados con ultima_atencion <= current_date − N, sin más condiciones.",
    columns:
      "paciente_id, nombre, archivado (bool), primera_atencion (date: su primera cita atendida), ultima_atencion (date), atenciones (citas atendidas en total), proxima_cita (timestamptz o null), como_nos_conocio ('Recomendación de alguien'|'Redes sociales'|'Google o mapas'|'Pasaba por aquí'|'Convenio o empresa'|'Otro'|'No lo dijo'), presupuesto_esperando (bool), control_pendiente (bool), registrado_en",
    keys: ALL,
  },
  {
    name: "tratamientos_hechos",
    about: "Lo realizado: procedimientos de atenciones firmadas, sin anulados. Sin diagnósticos ni notas.",
    columns:
      "fecha (timestamptz), dia, paciente, paciente_id, profesional, sede, tratamiento, tipo_tratamiento (tipo de la biblioteca; a menudo null), especialidad (de la clínica: 'Endodoncia', 'Cirugía oral', 'Odontología general'…), cantidad, precio",
    keys: ["gestion", "clinico"],
  },
  {
    name: "planes",
    about:
      "Una fila por tratamiento indicado en un plan (no por plan: para contar planes, count(distinct plan_id)), con la decisión del paciente y su avance. «En proceso» = estado 'en_curso'; un tratamiento «no iniciado» = decision 'aceptado' y estado 'pendiente' o 'programado'; un plan sin iniciar = sus tratamientos aceptados (sin los cancelados) siguen todos sin empezar (cuántos: select count(*) from (select plan_id from planes where decision = 'aceptado' and estado <> 'cancelado' group by plan_id having bool_and(estado in ('pendiente', 'programado') and iniciado_en is null)) as sin_iniciar). «Pendientes» = decision 'aceptado' y estado 'pendiente', 'programado' o 'en_curso'. Cuánto dura un tratamiento = terminado_en − iniciado_en de los 'realizado' con terminado_en en los últimos 12 meses; «por tipo» es por especialidad. No hay fecha prevista de término.",
    columns:
      "plan_id, paciente, paciente_id, tratamiento, especialidad, decision ('pendiente'|'aceptado'|'pospuesto'|'rechazado'|'no_elegida'), estado ('pendiente'|'programado'|'en_curso'|'suspendido'|'realizado'|'cancelado'), indicado_en, decidido_en, iniciado_en, terminado_en (timestamptz), precio, fase ('urgencia'|'basica'|'quirurgica'|'rehabilitadora'|'mantenimiento'), indicado_por (profesional que lo indicó; no se sabe quién lo hará)",
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
      "Un presupuesto por fila; los importes son de la opción que vale (nunca sumar opciones). Entregados = estado 'presentado', 'aceptado', 'parcial', 'pospuesto' o 'rechazado' ('sustituido' y 'cancelado' no cuentan). «Aceptaron» = estado 'aceptado' o 'parcial' sobre los entregados. El valor de un presupuesto aceptado es lo aceptado (columna aceptado), no su valor entero. Los que esperan respuesta (pendientes, sin aceptar) son los de espera_respuesta, a hoy; lo que esperan, en dinero, es sum(sin_decidir), no el valor entero. Cuánto tardan en aceptar = decidido_en − presentado_en de los aceptados o parciales, en días, de los últimos 12 meses.",
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
    columns: "promocion, paciente, paciente_id, fecha, aceptado (bool), descuento, paciente_nuevo (bool: no se había atendido antes), cobrado_desde_entonces (lo que esa persona pagó desde ese día)",
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
      "producto, unidad, sede, hay (negativo si se usó sin haber), minimo, estado ('ok'|'hace_falta': bajo el mínimo|'no_hay'|'faltante': se usó sin haber), hay_que_reponer (bool), cantidad_por_vencer (en 30 días), vence_primero (date), cantidad_vencida",
    keys: ["gestion", "recepcion"],
  },
  {
    name: "movimientos_inventario",
    about: "Lo que entró y salió del inventario. El consumo se registra por atención, no por procedimiento.",
    columns:
      "fecha (timestamptz), dia, tipo ('consumo': usado en una atención|'venta'|'ingreso': compra recibida|'ajuste'|'traslado'|'devolucion'|'cobertura'), producto, unidad, cantidad (negativa si salió), sede, profesional (en el consumo, quien atendió), paciente",
    keys: ["gestion", "recepcion"],
  },
  {
    name: "compras",
    about: "Órdenes de compra a proveedores. Los lotes no guardan su costo: el inventario no se puede valorizar.",
    columns: "numero, proveedor, sede, estado ('borrador'|'confirmada'|'parcialmente_recibida'|'recibida'|'cerrada'|'cancelada'), creada_en, dia, total, recibido, pagado",
    keys: ["gestion"],
  },
  {
    name: "conversaciones",
    about: "Conversaciones con personas por los canales (sin mensajes). No hay campañas ni encuestas.",
    columns:
      "inicio (timestamptz), dia, canal ('whatsapp'|'messenger'|'instagram'|'telegram'|'webchat'|'email'), estado ('open'|'closed'), motivo_cierre ('resuelta'|'sin_respuesta'|'equipo'|'manual'), cerrada_en, ultimo_mensaje_en, persona, persona_id (una persona puede tener varias conversaciones), paciente_id (null si aún no es paciente), es_paciente (bool), agente ('on'|'off'), asignada_a",
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
      "primer_contacto_en (timestamptz), dia, canal ('whatsapp'|'instagram'|…|'registro_en_linea'|'recepcion'), persona, persona_id, paciente_id (null si aún no es paciente), agendo (bool), vino (bool), recibio_presupuesto (bool), acepto (bool), pago (bool: aceptó y pagó algo)",
    keys: ["gestion", "recepcion"],
  },
  {
    name: "tareas",
    about: "Tareas del equipo (sin su texto).",
    columns: "creada_en, vence_en (timestamptz), estado ('open'|'done'|'cancelled'), area, tipo, dejada_por ('equipo'|'agent'|'admin'), responsable",
    keys: ["gestion"],
  },
]

/**
 * Cómo salen las cifras de Reportes con estas vistas: la misma cuenta que la
 * pantalla (cada una tiene su prueba de cuadre).
 */
export const ARGOS_FIGURE_RULES: readonly string[] = [
  "Lo cobrado = sum(cobros.importe) del periodo.",
  "Lo que deja (lo que ganó la clínica) = lo cobrado − sum(comisiones.comision) − sum(gastos.monto) con tipo <> 'pago_de_comisiones', del mismo periodo. Solo cuenta los gastos registrados. Margen = lo que deja ÷ lo cobrado, en %. Por sede: cobros.sede, comisiones.sede y gastos.sede.",
  "Gastos operativos = gastos.monto con tipo <> 'pago_de_comisiones', por categoria. Materiales (insumos) = la categoria 'Materiales', que ya incluye lo pagado de las compras (tipo 'pago_de_compra').",
  "Lo que se va de lo cobrado (porcentaje de los ingresos en gastos, costos) = (sum(gastos.monto) con tipo <> 'pago_de_comisiones' + sum(comisiones.comision)) ÷ lo cobrado; dilo «en gastos y comisiones».",
  "Medios de pago (cuánto por efectivo, tarjeta, Yape…; los más usados) = por cobros.medio con todas sus filas, como Reportes: cuánto = sum(cobros.importe) (pagos menos anulaciones y devoluciones; una devolución resta del medio del pago devuelto) y cuántos pagos = las filas 'pago' menos las 'anulacion'. No pagos_por_venta.",
  "De lo cargado, cuánto se cobró = sum(ventas.pagado) ÷ sum(ventas.importe) de las ventas del periodo.",
  "Ticket promedio por tratamiento = una sola cifra: el promedio de ventas.importe con ventas.tipo 'tratamiento'; de cada tratamiento solo si lo pide.",
  "Fuentes de ingresos (de dónde viene lo que entra) = primero por tipo: lo pagado de tratamientos y de productos (sum(pagos_por_venta.importe) por pagos_por_venta.tipo) con su % de lo cobrado, y lo cobrado que aún no se aplica a una venta (adelantos y saldo a favor: lo cobrado − sum(pagos_por_venta.importe)); después, los tratamientos que más aportan.",
  "Lo que se cotiza mucho y se vende poco = de lineas_presupuesto del periodo (por presentado_en), por tratamiento: cuántas veces se cotizó y cuántas con decision 'aceptado', y su % aceptado; «mucho» = al menos el 5 % de las líneas cotizadas y 3 veces; «poco» = su % aceptado por debajo del % aceptado de todas las líneas, que la frase dice. De menor a mayor % aceptado.",
  "Lo cobrado por especialidad (qué especialidad genera más ingresos) = sum(pagos_por_venta.importe) con pagos_por_venta.tipo 'tratamiento', por pagos_por_venta.especialidad (null es «Sin especialidad»); los productos no son de una especialidad: si los dices, aparte. Lo cargado por especialidad, con ventas.especialidad.",
  "Pacientes que perdemos (dejan de venir) cada mes = los «Sin venir» de hoy (pacientes), por el mes en que cumplieron 6 meses sin venir (date_trunc('month', pacientes.ultima_atencion + interval '6 months'), entre :dia_desde y :dia_hasta; sin periodo en la pregunta, ultimos_6_meses), por mes y su promedio por mes. Es la regla de «Sin venir» de Reportes repartida por mes: dilo así.",
  "Te deben = sum(deudas.saldo); vencido = la misma suma con vencida. deudas es solo a hoy: la deuda de meses pasados no está en las vistas.",
  "Lo que viene (lo aceptado que falta hacer, el valor de los tratamientos pendientes) = sum(lineas_presupuesto.importe) con decision 'aceptado', estado_presupuesto 'aceptado' o 'parcial' y estado_tratamiento null o distinto de 'realizado' y 'cancelado'.",
  "Pacientes nuevos del periodo = pacientes con pacientes.primera_atencion en el periodo. Pacientes atendidos = paciente_id distintos de citas.estado 'atendida' del periodo: nuevos los de primera_atencion en el periodo y el resto recurrentes.",
  "Volvieron (retención, periodo a_hoy) = de los paciente_id con una cita atendida hace 12 a 24 meses, cuántos tuvieron otra atendida en los últimos 12 (citas.paciente_id). Volvió tras más de N meses (llevaba N meses sin venir) = una cita atendida en el periodo cuya cita atendida inmediatamente anterior, la última antes de esa, fue hace más de N meses; tener alguna cita vieja no basta.",
  "Inasistencia (no vinieron) y canceladas = citas con ese citas.estado ÷ citas del periodo con citas.ya_paso, en %.",
  "Espera en sala = mediana de citas.espera_min de las atendidas.",
  "Agenda ocupada = sum(agenda_por_dia.minutos_ocupados) ÷ sum(agenda_por_dia.minutos_disponibles), en %. Horas libres = (minutos_disponibles − minutos_ocupados) ÷ 60.",
  "Horas clínicas de un profesional = sum(citas.duracion_min) ÷ 60 de sus citas atendidas. Su productividad = sus citas atendidas y lo cobrado de lo que atendió (pagos_por_venta.profesional).",
  "Tratamientos realizados = sum(tratamientos_hechos.cantidad).",
  "Vinieron a su control = controles.estado 'realizado' ÷ los controles con vence_dia en el periodo.",
  "Presupuestos aceptados = presupuestos.estado 'aceptado' o 'parcial' ÷ presupuestos entregados en el periodo, en %.",
  "Pago parcial = una venta con ventas.pagado > 0 y saldo > 0.",
  "Valor de un paciente según cómo nos conoció = de los pacientes nuevos del periodo (pacientes.primera_atencion entre :dia_desde y :dia_hasta; sin periodo en la pregunta, ultimos_365_dias), lo que pagó cada uno hasta hoy (sum(cobros.importe) por paciente_id), en promedio por pacientes.como_nos_conocio.",
  "Cada cuánto vuelven = los días entre una cita atendida y la siguiente del mismo paciente (lag sobre citas.inicio por paciente_id), solo con citas del periodo (sin periodo en la pregunta, ultimos_365_dias), también la anterior; mediana y promedio.",
  "Personas que nos buscaron por primera vez (prospectos, el embudo) = filas de embudo con embudo.dia en el periodo; cuántas agendaron, vinieron, recibieron presupuesto, aceptaron o pagaron = embudo.agendo, embudo.vino, embudo.recibio_presupuesto, embudo.acepto, embudo.pago. Por canal: embudo.canal.",
]

/** Lo que odentIA no registra: la respuesta lo dice y ofrece lo más cercano, nunca otra cifra como si fuera la pedida. */
export const ARGOS_NOT_RECORDED: readonly string[] = [
  "Facturas o boletas: solo tickets de pago.",
  "Una fecha prevista para cada tratamiento: no se sabe cuáles están atrasados ni cuáles se abandonaron. Lo más cercano: lo aceptado que sigue sin empezar y desde cuándo, y de lo aceptado el % suspendido o cancelado, de todo el historial (planes). Lo que sí está es cuánto duró cada tratamiento terminado.",
  "Quién hará un tratamiento: solo quién lo indicó (planes.indicado_por).",
  "Costos por tratamiento o por profesional (laboratorio, materiales de cada tratamiento, costos fijos): su rentabilidad no se puede saber. Lo más cercano: por tratamiento, lo cobrado de cada uno (pagos_por_venta), sin restarle nada, porque las comisiones y los gastos no se ligan a cada tratamiento; por profesional, lo cobrado de lo que atendió menos su comisión.",
  "Quién canceló una cita (la persona o la clínica) ni si se reprogramó.",
  "Cuotas o tratamientos financiados.",
  "Lo que se debía al cierre de meses pasados (cómo evolucionó la cartera o la deuda): solo está lo que se debe hoy (deudas). No lo reemplaces con lo cargado o lo cobrado de esos meses.",
  "Campañas de marketing y gasto en publicidad: tampoco el costo de conseguir un paciente.",
  "Encuestas, satisfacción, recomendación (NPS) y quejas.",
  "El costo de los lotes: el inventario no se puede valorizar.",
  "El consumo de materiales por procedimiento: se registra por atención (por profesional sí).",
  "La historia clínica: diagnósticos, enfermedades, alergias.",
]

/** Las vistas que lee una llave. */
export function argosViewsOf(key: ArgosKey): readonly ArgosView[] {
  return ARGOS_CATALOG.filter((view) => view.keys.includes(key))
}

/** El catálogo en texto, para el modelo: solo las vistas de la llave y las reglas que usan solo esas vistas. */
export function argosCatalogText(key: ArgosKey): string {
  const views = argosViewsOf(key)
  const names = new Set(views.map((view) => view.name))
  // Una regla nombra sus vistas como «vista.columna»; va solo si la llave las lee todas.
  const rules = ARGOS_FIGURE_RULES.filter((rule) => [...rule.matchAll(/\b([a-z_]+)\.[a-z_]/g)].every((match) => names.has(match[1] ?? "")))
  return [
    "Vistas (solo estas; el dinero está en la moneda de la clínica; «dia» es la fecha en la zona de la clínica):",
    ...views.map((view) => `\n${view.name}: ${view.about}\n  ${view.columns}`),
    ...(rules.length ? ["\nCifras de Reportes con estas vistas:", ...rules.map((rule) => `- ${rule}`)] : []),
    "\nLo que odentIA no registra (tipo no_existe o parcial, con lo más cercano que sí existe):",
    ...ARGOS_NOT_RECORDED.map((item) => `- ${item}`),
  ].join("\n")
}

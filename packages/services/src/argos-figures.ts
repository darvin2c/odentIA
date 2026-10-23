/**
 * Las cifras oficiales de Argos (ADR 0078, decisiones D18 y D19): cada cuenta
 * del negocio escrita una sola vez sobre las vistas `argos`, con los cortes y
 * filtros que admite. El modelo no escribe su consulta: pide la cifra, por qué
 * separarla y qué filtrar, y `compileArgosFigure` arma la consulta con los
 * mismos huecos de periodo y sede que las del modelo (`:desde`, `:hasta`,
 * `:sede`…): cambiar el periodo, fijar y descargar funcionan igual. Las que
 * también están en Reportes llevan su clave (`report`) y `eval:argos-cifras`
 * compara las dos sobre la base del examen.
 *
 * Un filtro por nombre (sede, profesional, especialidad, servicio, producto)
 * se compara con los nombres de la clínica antes de calcular: «Ortodoncia» es
 * «Ortodoncia y Ortopedia Maxilar»; lo que no está se le devuelve al modelo
 * con los nombres que sí hay, en vez de una cifra en cero.
 */
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { orgSpecialty } from "@odentia/db/schema/clinical"
import { product } from "@odentia/db/schema/inventory"
import { promotion } from "@odentia/db/schema/promotions"
import { and, asc, eq, sql } from "drizzle-orm"
import { listAgentServices } from "./agent-clinic-info.js"
import { type ArgosKey, argosViewsOf } from "./argos-catalog.js"
import { listArgosBranches } from "./argos-period.js"

/** Por qué se separa o filtra una cifra. Cada fuente dice cuáles sabe. */
export const ARGOS_CUTS = [
  "mes",
  "semana",
  "dia",
  "dia_semana",
  "hora",
  "sede",
  "profesional",
  "especialidad",
  "servicio",
  "producto",
  "tipo",
  "medio",
  "canal",
  "como_nos_conocio",
  "categoria",
  "antiguedad",
  "area",
  "proveedor",
  "etapa",
] as const
export type ArgosCut = (typeof ARGOS_CUTS)[number]

export function isArgosCut(value: unknown): value is ArgosCut {
  return typeof value === "string" && (ARGOS_CUTS as readonly string[]).includes(value)
}

/** «por sede»: para el modelo y para «Así lo calculé». */
export const ARGOS_CUT_WORDS: Record<ArgosCut, string> = {
  mes: "por mes",
  semana: "por semana",
  dia: "por día",
  dia_semana: "por día de la semana",
  hora: "por hora",
  sede: "por sede",
  profesional: "por profesional",
  especialidad: "por especialidad",
  servicio: "por servicio",
  producto: "por producto",
  tipo: "por tipo",
  medio: "por medio de pago",
  canal: "por canal",
  como_nos_conocio: "por cómo nos conocieron",
  categoria: "por tipo de gasto",
  antiguedad: "por antigüedad de la deuda",
  area: "por área",
  proveedor: "por proveedor",
  etapa: "por etapa de venta",
}

/** Los cortes de tiempo salen de `dia`, la fecha en la zona de la clínica. */
const TIME_CUTS: Partial<Record<ArgosCut, string>> = {
  mes: "date_trunc('month', dia)::date",
  semana: "date_trunc('week', dia)::date",
  dia_semana: "(array['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'])[extract(isodow from dia)::int]",
}

/**
 * Lo de antes, corrido a las fechas de ahora: al comparar por mes, semana o día,
 * enero de 2025 se junta con enero de 2026 (o setiembre con octubre). La
 * distancia es la que hay entre el primer día de cada tramo: un año, un mes, 7
 * días. El día de la semana y la hora ya coinciden solos.
 */
const SHIFT = "age(:dia_desde, :dia_desde_antes)"
const SHIFTED_TIME_CUTS: Partial<Record<ArgosCut, string>> = {
  mes: `date_trunc('month', (dia + ${SHIFT})::date)::date`,
  semana: `date_trunc('week', (dia + ${SHIFT})::date)::date`,
  dia: `(dia + ${SHIFT})::date`,
}

/** Una fila sin nombre en un corte de texto se dice así; también junta lo de ahora con lo de antes. */
const NULL_WORDS: Partial<Record<ArgosCut, string>> = {
  sede: "Sin sede",
  profesional: "Sin profesional",
  especialidad: "Sin especialidad",
  servicio: "Sin servicio",
  producto: "Sin producto",
  tipo: "Sin tipo",
  medio: "Sin medio",
  canal: "Sin canal",
  como_nos_conocio: "No lo dijo",
  categoria: "Sin categoría",
  area: "Sin área",
  proveedor: "Sin proveedor",
  etapa: "Sin etapa",
}

/** Los cortes que se filtran por un nombre de la clínica: se comparan con los de verdad antes de calcular. */
const NAMED_CUTS = [
  "sede",
  "profesional",
  "especialidad",
  "servicio",
  "producto",
] as const satisfies readonly ArgosCut[]
type NamedCut = (typeof NAMED_CUTS)[number]

export type ArgosFigureUnit = "dinero" | "cantidad" | "pct" | "horas" | "minutos"

/** Los huecos de un tramo: los de ahora o los de antes. */
interface Range {
  desde: string
  hasta: string
  dia_desde: string
  dia_hasta: string
}
const NOW: Range = {
  desde: ":desde",
  hasta: ":hasta",
  dia_desde: ":dia_desde",
  dia_hasta: ":dia_hasta",
}
const BEFORE: Range = {
  desde: ":desde_antes",
  hasta: ":hasta_antes",
  dia_desde: ":dia_desde_antes",
  dia_hasta: ":dia_hasta_antes",
}

/**
 * De dónde sale una cifra: una consulta sobre las vistas con una fila por
 * hecho, las columnas de corte con su nombre de `ARGOS_CUTS` y las de medida
 * que usa `value`. Con `time` «instante» trae `t` (el momento) y `dia`; con
 * «dia», solo `dia`. Una fuente que depende del tramo (lo de los 18 meses
 * antes del cierre) es una función de sus huecos.
 */
interface FigureSource {
  views: readonly string[]
  rows: string | ((range: Range) => string)
  cuts: readonly ArgosCut[]
}

export interface ArgosFigure {
  key: string
  name: string
  /** Qué pregunta responde, para el modelo. */
  describes: string
  /** «Así lo calculé». */
  how: string
  unit: ArgosFigureUnit
  /** La columna del resultado: su sufijo dice cómo se muestra (`_dinero`, `_pct`). */
  column: string
  /**
   * «instante»: el periodo filtra `t`; «dia»: filtra `dia`; «tramo»: la
   * fuente ya usa los huecos del tramo; «a_hoy»: sin periodo (D12).
   */
  time: "instante" | "dia" | "tramo" | "a_hoy"
  /** El valor sobre las filas de la fuente. */
  value: string
  /** Se suma: admite su parte del total y la variación en %. */
  additive: boolean
  /** La primera que sepa todos los cortes y filtros pedidos. */
  sources: readonly FigureSource[]
  /** La misma cifra en Reportes, si está: la compara `eval:argos-cifras`. */
  report?: string
  /** En «Lo que viene» (D26): se mide hacia adelante, con lo que falta del periodo. */
  ahead?: true
}

// Sin filas, una suma es 0 (como Reportes), no un vacío.
const COUNT = "coalesce(sum(v), 0)"
const RATE = "round(100.0 * sum(a) / nullif(sum(n), 0))"
const WHEN = ["mes", "semana", "dia", "dia_semana"] as const satisfies readonly ArgosCut[]

/** Las vistas de una fuente, con o sin su llave: la cifra que no se puede leer no se ofrece. */
export const ARGOS_FIGURES: readonly ArgosFigure[] = [
  // ---------------- Dinero ----------------
  {
    key: "cobrado",
    name: "Lo cobrado",
    describes:
      "Cuánto se cobró, «cuánto vendimos», «cuánto entró», los ingresos; por medio de pago, profesional, especialidad, servicio o tipo (tratamiento, producto y lo que aún no se aplica a una venta).",
    how: "Pagos del periodo menos lo anulado y lo devuelto. Por tipo, lo pagado de tratamientos y de productos, y aparte lo cobrado que aún no se aplica a una venta (adelantos, saldo a favor). Por profesional, especialidad o servicio: lo pagado de lo que se atendió o vendió, sin esos adelantos.",
    unit: "dinero",
    column: "cobrado_dinero",
    time: "instante",
    value: COUNT,
    additive: true,
    report: "cobrado",
    sources: [
      {
        views: ["cobros"],
        rows: "select momento as t, dia, sede, medio, importe as v from cobros",
        cuts: [...WHEN, "sede", "medio"],
      },
      {
        views: ["cobros", "pagos_por_venta"],
        rows: "select momento as t, dia, sede, medio, 'sin aplicar a una venta' as tipo, importe as v from cobros union all select pagado_en, dia, sede, medio, 'sin aplicar a una venta', -importe from pagos_por_venta union all select pagado_en, dia, sede, medio, tipo, importe from pagos_por_venta",
        cuts: [...WHEN, "sede", "medio", "tipo"],
      },
      {
        views: ["pagos_por_venta"],
        rows: "select pagado_en as t, dia, sede, medio, profesional, coalesce(especialidad, case when tipo = 'producto' then 'Productos' end) as especialidad, concepto as servicio, tipo, importe as v from pagos_por_venta",
        cuts: [...WHEN, "sede", "medio", "profesional", "especialidad", "servicio", "tipo"],
      },
    ],
  },
  {
    key: "ticket_promedio",
    name: "Ticket promedio por paciente",
    describes:
      "El ticket promedio sin más: lo cobrado ÷ pacientes distintos que pagaron; la frase dice «por paciente». No es el promedio de los tickets de pago. Por sede, profesional o especialidad.",
    how: "Lo cobrado entre los pacientes distintos que pagaron en el periodo. Por profesional o especialidad, con lo pagado de lo que atendió cada uno.",
    unit: "dinero",
    column: "ticket_promedio_dinero",
    time: "instante",
    value: "round(sum(v) / nullif(count(distinct paciente_id) filter (where pago), 0), 2)",
    additive: false,
    sources: [
      {
        views: ["cobros"],
        rows: "select momento as t, dia, sede, paciente_id, tipo = 'pago' as pago, importe as v from cobros",
        cuts: [...WHEN, "sede"],
      },
      {
        views: ["pagos_por_venta"],
        rows: "select pagado_en as t, dia, sede, profesional, coalesce(especialidad, case when tipo = 'producto' then 'Productos' end) as especialidad, paciente_id, true as pago, importe as v from pagos_por_venta",
        cuts: [...WHEN, "sede", "profesional", "especialidad"],
      },
    ],
  },
  {
    key: "cargado",
    name: "Lo cargado",
    describes:
      "Lo cargado a los pacientes: lo atendido y los productos entregados, pagado o no. «Facturado» no existe en odentIA: esto es lo más cercano.",
    how: "Lo cargado a los pacientes en el periodo (tratamientos hechos y productos), sin lo anulado y con lo devuelto descontado, pagado o no.",
    unit: "dinero",
    column: "cargado_dinero",
    time: "instante",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["ventas"],
        rows: "select cargado_en as t, dia, sede, profesional, coalesce(especialidad, case when tipo = 'producto' then 'Productos' end) as especialidad, concepto as servicio, tipo, importe as v from ventas",
        cuts: [...WHEN, "sede", "profesional", "especialidad", "servicio", "tipo"],
      },
    ],
  },
  {
    key: "cobrado_de_lo_cargado",
    name: "Cobrado de lo cargado",
    describes: "De lo cargado en el periodo (lo más cercano a lo facturado), qué parte ya se pagó, en %.",
    how: "Lo ya pagado de las ventas del periodo entre lo cargado en ellas.",
    unit: "pct",
    column: "cobrado_pct",
    time: "instante",
    value: RATE,
    additive: false,
    sources: [
      {
        views: ["ventas"],
        rows: "select cargado_en as t, dia, sede, profesional, coalesce(especialidad, case when tipo = 'producto' then 'Productos' end) as especialidad, concepto as servicio, tipo, pagado as a, importe as n from ventas",
        cuts: [...WHEN, "sede", "profesional", "especialidad", "servicio", "tipo"],
      },
    ],
  },
  {
    key: "ticket_por_venta",
    name: "Ticket promedio por venta",
    describes:
      "El ticket promedio «de venta» o «por venta»: el importe promedio de cada cosa cargada; la frase dice «por venta». De tratamientos o de productos, con el filtro tipo.",
    how: "El promedio del importe de cada venta (un tratamiento o un producto cargado) del periodo.",
    unit: "dinero",
    column: "ticket_por_venta_dinero",
    time: "instante",
    value: "round(avg(v), 2)",
    additive: false,
    sources: [
      {
        views: ["ventas"],
        rows: "select cargado_en as t, dia, sede, profesional, coalesce(especialidad, case when tipo = 'producto' then 'Productos' end) as especialidad, concepto as servicio, tipo, importe as v from ventas",
        cuts: [...WHEN, "sede", "profesional", "especialidad", "servicio", "tipo"],
      },
    ],
  },
  {
    key: "pagos",
    name: "Pagos recibidos",
    describes: "Cuántos pagos se recibieron, sin los anulados; por medio de pago (los más usados) o sede.",
    how: "Los pagos del periodo menos los anulados en el periodo.",
    unit: "cantidad",
    column: "pagos",
    time: "instante",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["cobros"],
        rows: "select momento as t, dia, sede, medio, case tipo when 'pago' then 1 when 'anulacion' then -1 else 0 end as v from cobros",
        cuts: [...WHEN, "sede", "medio"],
      },
    ],
  },
  {
    key: "lo_que_deja",
    name: "Lo que deja",
    describes: "Lo que gana la clínica: lo cobrado sin su impuesto (IGV o IVA) menos comisiones y gastos registrados.",
    how: "Lo cobrado menos su impuesto, las comisiones generadas y los demás gastos del periodo (el pago de comisiones ya está contado en ellas y el pago de ese impuesto no vuelve a restar).",
    unit: "dinero",
    column: "lo_que_deja_dinero",
    time: "instante",
    value: COUNT,
    additive: true,
    report: "lo_que_deja",
    sources: [
      {
        views: ["cobros", "comisiones", "gastos"],
        rows: "select momento as t, dia, sede, importe - impuesto as v from cobros union all select momento, dia, sede, -comision from comisiones union all select momento, dia, sede, -monto from gastos where tipo not in ('pago_de_comisiones', 'pago_del_impuesto_de_lo_cobrado')",
        cuts: [...WHEN, "sede"],
      },
    ],
  },
  {
    key: "margen",
    name: "Margen",
    describes: "Qué parte de lo cobrado le queda a la clínica: lo que deja ÷ lo cobrado sin su impuesto, en %.",
    how: "Lo que deja (lo cobrado sin su impuesto menos las comisiones y los gastos registrados) entre lo cobrado sin su impuesto del periodo.",
    unit: "pct",
    column: "margen_pct",
    time: "instante",
    value: "round(100.0 * sum(v) / nullif(sum(c), 0))",
    additive: false,
    sources: [
      {
        views: ["cobros", "comisiones", "gastos"],
        rows: "select momento as t, dia, sede, importe - impuesto as v, importe - impuesto as c from cobros union all select momento, dia, sede, -comision, 0 from comisiones union all select momento, dia, sede, -monto, 0 from gastos where tipo not in ('pago_de_comisiones', 'pago_del_impuesto_de_lo_cobrado')",
        cuts: [...WHEN, "sede"],
      },
    ],
  },
  {
    key: "gasto_sobre_cobrado",
    name: "Gastos sobre lo cobrado",
    describes: "Qué parte de lo cobrado se va en gastos y comisiones, en %.",
    how: "Las comisiones y los gastos registrados del periodo entre lo cobrado sin su impuesto del periodo.",
    unit: "pct",
    column: "gastos_pct",
    time: "instante",
    value: "round(100.0 * sum(g) / nullif(sum(c), 0))",
    additive: false,
    sources: [
      {
        views: ["cobros", "comisiones", "gastos"],
        rows: "select momento as t, dia, sede, 0 as g, importe - impuesto as c from cobros union all select momento, dia, sede, comision, 0 from comisiones union all select momento, dia, sede, monto, 0 from gastos where tipo not in ('pago_de_comisiones', 'pago_del_impuesto_de_lo_cobrado')",
        cuts: [...WHEN, "sede"],
      },
    ],
  },
  {
    key: "gastos",
    name: "Lo gastado",
    describes:
      "Los gastos registrados en Finanzas, por tipo de gasto (alquiler, materiales, personal…). Sin el pago de comisiones.",
    how: "Gastos registrados en Finanzas en el periodo, menos los anulados. El pago de comisiones va aparte, en Comisiones, y el pago del impuesto de lo cobrado no es un gasto.",
    unit: "dinero",
    column: "gastos_dinero",
    time: "instante",
    value: COUNT,
    additive: true,
    report: "gastos",
    sources: [
      {
        views: ["gastos"],
        rows: "select momento as t, dia, sede, categoria, monto as v from gastos where tipo not in ('pago_de_comisiones', 'pago_del_impuesto_de_lo_cobrado')",
        cuts: [...WHEN, "sede", "categoria"],
      },
    ],
  },
  {
    key: "comisiones",
    name: "Las comisiones",
    describes: "Las comisiones de los profesionales generadas en el periodo.",
    how: "El porcentaje de cada profesional sobre lo cobrado de lo que atendió, al momento de cobrar.",
    unit: "dinero",
    column: "comisiones_dinero",
    time: "instante",
    value: COUNT,
    additive: true,
    report: "comisiones",
    sources: [
      {
        views: ["comisiones"],
        rows: "select momento as t, dia, sede, profesional, comision as v from comisiones",
        cuts: [...WHEN, "sede", "profesional"],
      },
    ],
  },
  {
    key: "te_deben",
    name: "Te deben",
    describes: "Lo que deben los pacientes hoy, en total o por antigüedad de la deuda.",
    how: "Lo que debe cada persona hoy: lo que se le cobró menos lo que pagó y lo que tiene a favor.",
    unit: "dinero",
    column: "te_deben_dinero",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    report: "te_deben",
    sources: [
      {
        views: ["deudas"],
        rows: "select saldo as v, case when dias <= 30 then 'De 0 a 30 días' when dias <= 60 then 'De 31 a 60 días' when dias <= 90 then 'De 61 a 90 días' else 'Más de 90 días' end as antiguedad from deudas",
        cuts: ["antiguedad"],
      },
    ],
  },
  {
    key: "deuda_vencida",
    name: "Te deben hace más de 30 días",
    describes: "Lo que deben los pacientes desde hace más de 30 días, hoy.",
    how: "Lo que debe cada persona desde hace más de 30 días, descontando lo que tiene a favor.",
    unit: "dinero",
    column: "deuda_vencida_dinero",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    report: "deuda_vencida",
    sources: [{ views: ["deudas"], rows: "select saldo as v from deudas where vencida", cuts: [] }],
  },
  {
    key: "deudores",
    name: "Pacientes que deben",
    describes: "Cuántos pacientes deben algo hoy.",
    how: "Las personas con algo por pagar hoy, descontando lo que tienen a favor.",
    unit: "cantidad",
    column: "pacientes",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    sources: [{ views: ["deudas"], rows: "select 1 as v from deudas where saldo > 0", cuts: [] }],
  },
  {
    key: "lo_que_viene",
    name: "Lo que viene",
    describes:
      "Lo aceptado en presupuestos que todavía no se hizo (el valor de los tratamientos pendientes), hoy; por tratamiento.",
    how: "Lo aceptado en presupuestos que todavía no se hizo, a su precio acordado, a hoy.",
    unit: "dinero",
    column: "lo_que_viene_dinero",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    report: "lo_que_viene",
    sources: [
      {
        views: ["lineas_presupuesto"],
        rows: "select importe as v, tratamiento as servicio from lineas_presupuesto where decision = 'aceptado' and estado_presupuesto in ('aceptado', 'parcial') and (estado_tratamiento is null or estado_tratamiento not in ('realizado', 'cancelado'))",
        cuts: ["servicio"],
      },
    ],
  },
  {
    key: "lo_que_viene_sin_cita",
    name: "Lo aceptado sin cita",
    describes: "De lo aceptado que falta hacer, lo de pacientes sin una cita por venir, hoy.",
    how: "Lo aceptado que todavía no se hizo, de pacientes que no tienen una cita por venir.",
    unit: "dinero",
    column: "sin_cita_dinero",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["lineas_presupuesto", "pacientes"],
        rows: "select l.importe as v, l.tratamiento as servicio from lineas_presupuesto l join pacientes p on p.paciente_id = l.paciente_id where l.decision = 'aceptado' and l.estado_presupuesto in ('aceptado', 'parcial') and (l.estado_tratamiento is null or l.estado_tratamiento not in ('realizado', 'cancelado')) and p.proxima_cita is null",
        cuts: ["servicio"],
      },
    ],
  },
  // ---------------- Pacientes ----------------
  {
    key: "pacientes_nuevos",
    name: "Pacientes nuevos",
    describes:
      "Pacientes atendidos por primera vez; de una sede, los que tuvieron su primera cita en ella; por cómo nos conocieron.",
    how: "Personas cuya primera cita atendida fue en el periodo; por sede, la sede de esa primera cita.",
    unit: "cantidad",
    column: "pacientes_nuevos",
    time: "instante",
    value: COUNT,
    additive: true,
    report: "pacientes_nuevos",
    sources: [
      {
        views: ["pacientes"],
        rows: "select primera_atencion_en as t, primera_atencion as dia, primera_sede as sede, como_nos_conocio, 1 as v from pacientes where primera_atencion_en is not null",
        cuts: [...WHEN, "sede", "como_nos_conocio"],
      },
    ],
  },
  {
    key: "pacientes_atendidos",
    name: "Pacientes atendidos",
    describes: "Cuántos pacientes distintos se atendieron; por tipo: nuevo (su primera cita atendida fue en el periodo) o recurrente.",
    how: "Pacientes distintos con una cita atendida en el periodo; nuevos los de primera cita atendida en el periodo y recurrentes los demás.",
    unit: "cantidad",
    column: "pacientes",
    time: "instante",
    value: "count(distinct paciente_id)",
    additive: false,
    sources: [
      {
        views: ["citas"],
        // Nuevo si su primera cita atendida, de todas, cae en el periodo (como pacientes.primera_atencion_en).
        rows: (r) =>
          `select inicio as t, dia, hora, sede, profesional, servicio, paciente_id, case when min(inicio) over (partition by paciente_id) >= ${r.desde} then 'nuevo' else 'recurrente' end as tipo from citas where estado = 'atendida'`,
        cuts: [...WHEN, "hora", "sede", "profesional", "servicio", "tipo"],
      },
    ],
  },
  {
    key: "valor_paciente_nuevo",
    name: "Lo que paga un paciente nuevo",
    describes: "De los pacientes nuevos del periodo, cuánto pagó cada uno desde que llegó hasta hoy, en promedio; por cómo nos conocieron o sede.",
    how: "Lo pagado hasta hoy por cada paciente cuya primera cita atendida fue en el periodo, en promedio; por sede, la de esa primera cita.",
    unit: "dinero",
    column: "por_paciente_dinero",
    time: "instante",
    value: "round(avg(v), 2)",
    additive: false,
    sources: [
      {
        views: ["pacientes", "cobros"],
        rows: "select p.primera_atencion_en as t, p.primera_atencion as dia, p.primera_sede as sede, p.como_nos_conocio, coalesce(c.pagado, 0) as v from pacientes p left join (select paciente_id, sum(importe) as pagado from cobros group by paciente_id) as c on c.paciente_id = p.paciente_id where p.primera_atencion_en is not null",
        cuts: [...WHEN, "sede", "como_nos_conocio"],
      },
    ],
  },
  {
    key: "nos_buscaron",
    name: "Nos buscaron por primera vez",
    describes: "Personas que escribieron o se registraron por primera vez (prospectos), por canal.",
    how: "Personas cuya primera conversación (por cualquier canal) o su registro fue en el periodo.",
    unit: "cantidad",
    column: "personas",
    time: "instante",
    value: COUNT,
    additive: true,
    report: "nos_buscaron",
    sources: [
      {
        views: ["embudo"],
        rows: "select primer_contacto_en as t, dia, canal, 1 as v from embudo",
        cuts: [...WHEN, "canal"],
      },
    ],
  },
  {
    key: "pacientes_activos",
    name: "Pacientes activos",
    describes: "Pacientes con una cita atendida en los 18 meses antes del cierre del periodo.",
    how: "Personas con al menos una cita atendida en los 18 meses anteriores al cierre del periodo.",
    unit: "cantidad",
    column: "pacientes_activos",
    time: "tramo",
    value: "count(distinct paciente_id)",
    additive: false,
    report: "activos",
    sources: [
      {
        views: ["citas"],
        rows: (r) =>
          `select paciente_id, sede from citas where estado = 'atendida' and inicio >= ${r.hasta} - interval '18 months' and inicio < ${r.hasta}`,
        cuts: ["sede"],
      },
    ],
  },
  {
    key: "volvieron",
    name: "Volvieron en el año",
    describes:
      "De los pacientes atendidos hace 12 a 24 meses, qué parte volvió en los últimos 12 (retención).",
    how: "De quienes tuvieron una cita atendida entre 24 y 12 meses antes del cierre, cuántos tuvieron otra en los 12 meses siguientes.",
    unit: "pct",
    column: "volvieron_pct",
    time: "tramo",
    value: RATE,
    additive: false,
    report: "volvieron",
    sources: [
      {
        views: ["citas"],
        rows: (r) =>
          `select paciente_id, max(case when inicio >= ${r.hasta} - interval '12 months' then 1 else 0 end) as a, 1 as n from citas where estado = 'atendida' and inicio >= ${r.hasta} - interval '24 months' and inicio < ${r.hasta} group by paciente_id having min(inicio) < ${r.hasta} - interval '12 months'`,
        cuts: [],
      },
    ],
  },
  {
    key: "reactivados",
    name: "Pacientes reactivados",
    describes: "Pacientes que volvieron tras más de 6 meses sin venir: su cita atendida del periodo llegó más de 6 meses después de la anterior.",
    how: "Pacientes con una cita atendida en el periodo cuya cita atendida anterior fue más de 6 meses antes.",
    unit: "cantidad",
    column: "pacientes",
    time: "instante",
    value: "count(distinct paciente_id)",
    additive: false,
    sources: [
      {
        views: ["citas"],
        rows: "select inicio as t, dia, sede, profesional, paciente_id from (select inicio, dia, sede, profesional, paciente_id, lag(inicio) over (partition by paciente_id order by inicio) as anterior from citas where estado = 'atendida') as c where anterior < inicio - interval '6 months'",
        cuts: [...WHEN, "sede", "profesional"],
      },
    ],
  },
  {
    key: "dias_entre_visitas",
    name: "Cada cuánto vuelven",
    describes: "Cuántos días pasan entre una cita atendida y la siguiente del mismo paciente (la mediana), con las dos en el periodo.",
    how: "La mediana de los días entre cada cita atendida y la anterior del mismo paciente, las dos en el periodo.",
    unit: "cantidad",
    column: "dias",
    time: "instante",
    value: "round(percentile_cont(0.5) within group (order by v))",
    additive: false,
    sources: [
      {
        views: ["citas"],
        rows: (r) =>
          `select inicio as t, dia, sede, profesional, extract(epoch from inicio - lag(inicio) over (partition by paciente_id order by inicio)) / 86400.0 as v from citas where estado = 'atendida' and inicio >= ${r.desde} and inicio < ${r.hasta}`,
        cuts: [...WHEN, "sede", "profesional"],
      },
    ],
  },
  {
    key: "sin_venir",
    name: "Sin venir hace más de 6 meses",
    describes:
      "Pacientes que dejaron de venir: más de 6 meses sin una cita atendida y sin cita, presupuesto ni control pendiente, hoy.",
    how: "Pacientes no archivados con más de 6 meses desde su última cita atendida, sin cita por venir, presupuesto esperando ni control pendiente.",
    unit: "cantidad",
    column: "pacientes",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    report: "sin_venir",
    sources: [
      {
        views: ["pacientes"],
        rows: "select 1 as v from pacientes where not archivado and ultima_atencion_en < now() - interval '6 months' and proxima_cita is null and not presupuesto_esperando and not control_pendiente",
        cuts: [],
      },
    ],
  },
  {
    key: "controles",
    name: "Vinieron a su control",
    describes: "De los controles que vencían en el periodo, qué parte se hizo.",
    how: "Controles realizados entre todos los que vencían en el periodo, cancelados incluidos.",
    unit: "pct",
    column: "vinieron_pct",
    time: "instante",
    value: RATE,
    additive: false,
    report: "controles",
    sources: [
      {
        views: ["controles"],
        rows: "select vence_en as t, vence_dia as dia, (estado = 'realizado')::int as a, 1 as n from controles",
        cuts: [...WHEN],
      },
    ],
  },
  {
    key: "aceptaron",
    name: "Aceptaron su presupuesto",
    describes:
      "De los presupuestos entregados en el periodo, qué parte se aceptó (entero o en parte).",
    how: "Presupuestos aceptados (enteros o en parte) entre los entregados en el periodo.",
    unit: "pct",
    column: "aceptaron_pct",
    time: "instante",
    value: RATE,
    additive: false,
    report: "aceptaron",
    sources: [
      {
        views: ["presupuestos"],
        rows: "select presentado_en as t, presentado_dia as dia, profesional, (estado in ('aceptado', 'parcial'))::int as a, 1 as n from presupuestos where estado in ('presentado', 'aceptado', 'parcial', 'pospuesto', 'rechazado')",
        cuts: [...WHEN, "profesional"],
      },
    ],
  },
  {
    key: "aceptaron_tratamiento",
    name: "Aceptaron el tratamiento",
    describes: "De las veces que se presupuestó cada tratamiento, qué parte se aceptó; por tratamiento.",
    how: "Tratamientos aceptados entre los presupuestados en los presupuestos entregados del periodo (la opción que vale de cada uno).",
    unit: "pct",
    column: "aceptado_pct",
    time: "instante",
    value: RATE,
    additive: false,
    sources: [
      {
        views: ["lineas_presupuesto"],
        rows: "select presentado_en as t, presentado_dia as dia, tratamiento as servicio, (decision = 'aceptado')::int as a, 1 as n from lineas_presupuesto where estado_presupuesto in ('presentado', 'aceptado', 'parcial', 'pospuesto', 'rechazado')",
        cuts: [...WHEN, "servicio"],
      },
    ],
  },
  {
    key: "dias_para_aceptar",
    name: "Cuánto tardan en aceptar",
    describes: "Cuántos días pasan entre que se entrega un presupuesto y se acepta (la mediana), de los aceptados entregados en el periodo.",
    how: "La mediana de los días entre la entrega y la decisión de los presupuestos aceptados (enteros o en parte) entregados en el periodo.",
    unit: "cantidad",
    column: "dias",
    time: "instante",
    value: "round(percentile_cont(0.5) within group (order by v))",
    additive: false,
    sources: [
      {
        views: ["presupuestos"],
        rows: "select presentado_en as t, presentado_dia as dia, profesional, extract(epoch from decidido_en - presentado_en) / 86400.0 as v from presupuestos where estado in ('aceptado', 'parcial') and decidido_en is not null",
        cuts: [...WHEN, "profesional"],
      },
    ],
  },
  {
    key: "presupuestos",
    name: "Presupuestos entregados",
    describes: "Cuántos presupuestos se entregaron en el periodo.",
    how: "Presupuestos entregados en el periodo (sin los sustituidos ni los cancelados).",
    unit: "cantidad",
    column: "presupuestos",
    time: "instante",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["presupuestos"],
        rows: "select presentado_en as t, presentado_dia as dia, profesional, 1 as v from presupuestos where estado in ('presentado', 'aceptado', 'parcial', 'pospuesto', 'rechazado')",
        cuts: [...WHEN, "profesional"],
      },
    ],
  },
  {
    key: "presupuestado",
    name: "Lo presupuestado",
    describes: "Cuánto suman los presupuestos entregados en el periodo.",
    how: "El valor de los presupuestos entregados en el periodo, con la opción que vale de cada uno.",
    unit: "dinero",
    column: "presupuestado_dinero",
    time: "instante",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["presupuestos"],
        rows: "select presentado_en as t, presentado_dia as dia, profesional, valor as v from presupuestos where estado in ('presentado', 'aceptado', 'parcial', 'pospuesto', 'rechazado')",
        cuts: [...WHEN, "profesional"],
      },
    ],
  },
  {
    key: "aceptado",
    name: "Lo aceptado",
    describes:
      "Cuánto suma lo aceptado de los presupuestos entregados en el periodo; por tratamiento.",
    how: "Lo aceptado (no el valor entero) de los presupuestos entregados en el periodo.",
    unit: "dinero",
    column: "aceptado_dinero",
    time: "instante",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["presupuestos"],
        rows: "select presentado_en as t, presentado_dia as dia, profesional, aceptado as v from presupuestos where estado in ('presentado', 'aceptado', 'parcial', 'pospuesto', 'rechazado')",
        cuts: [...WHEN, "profesional"],
      },
      {
        views: ["lineas_presupuesto"],
        rows: "select presentado_en as t, presentado_dia as dia, tratamiento as servicio, importe as v from lineas_presupuesto where decision = 'aceptado' and estado_presupuesto in ('presentado', 'aceptado', 'parcial', 'pospuesto', 'rechazado')",
        cuts: [...WHEN, "servicio"],
      },
    ],
  },
  {
    key: "tratamientos_presupuestados",
    name: "Tratamientos presupuestados",
    describes: "Cuántas veces se presupuestó cada tratamiento (lo más solicitado o cotizado), en los presupuestos entregados del periodo.",
    how: "Las veces que cada tratamiento aparece en la opción que vale de los presupuestos entregados en el periodo (sin los reemplazados ni los cancelados).",
    unit: "cantidad",
    column: "veces",
    time: "instante",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["lineas_presupuesto"],
        rows:
          "select presentado_en as t, presentado_dia as dia, tratamiento as servicio, 1 as v from lineas_presupuesto where estado_presupuesto in ('presentado', 'aceptado', 'parcial', 'pospuesto', 'rechazado')",
        cuts: [...WHEN, "servicio"],
      },
    ],
  },
  {
    key: "esperan_respuesta",
    name: "Presupuestos esperando respuesta",
    describes: "Lo que esperan los presupuestos sin decidir, hoy (lo pendiente en dinero).",
    how: "Lo que falta decidir de los presupuestos que esperan respuesta, hoy.",
    unit: "dinero",
    column: "sin_decidir_dinero",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["presupuestos"],
        rows: "select profesional, sin_decidir as v from presupuestos where espera_respuesta",
        cuts: ["profesional"],
      },
    ],
  },
  {
    key: "presupuestos_esperando",
    name: "Presupuestos sin respuesta",
    describes: "Cuántos presupuestos esperan la respuesta del paciente, hoy.",
    how: "Presupuestos entregados que esperan la decisión del paciente, hoy.",
    unit: "cantidad",
    column: "presupuestos",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    sources: [{ views: ["presupuestos"], rows: "select profesional, 1 as v from presupuestos where espera_respuesta", cuts: ["profesional"] }],
  },
  {
    key: "tratamientos_hechos",
    name: "Tratamientos hechos",
    describes:
      "Cuántos tratamientos se hicieron (procedimientos de atenciones firmadas); por tratamiento, especialidad o profesional.",
    how: "Procedimientos de atenciones firmadas en el periodo, sin los anulados, por su cantidad.",
    unit: "cantidad",
    column: "tratamientos",
    time: "instante",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["tratamientos_hechos"],
        rows: "select fecha as t, dia, sede, profesional, especialidad, tratamiento as servicio, cantidad as v from tratamientos_hechos",
        cuts: [...WHEN, "sede", "profesional", "especialidad", "servicio"],
      },
    ],
  },
  {
    key: "planes_en_curso",
    name: "Planes en curso",
    describes: "Cuántos planes de tratamiento siguen en curso hoy: con tratamientos aceptados que aún falta hacer (por empezar, programados o en marcha).",
    how: "Planes con al menos un tratamiento aceptado por empezar, programado o en curso, hoy.",
    unit: "cantidad",
    column: "planes",
    time: "a_hoy",
    value: "count(distinct plan_id)",
    additive: false,
    sources: [
      {
        views: ["planes"],
        rows: "select plan_id, especialidad, indicado_por as profesional from planes where decision = 'aceptado' and estado in ('pendiente', 'programado', 'en_curso')",
        cuts: ["especialidad", "profesional"],
      },
    ],
  },
  {
    key: "planes_parados",
    name: "Planes parados",
    describes: "Planes con tratamientos aceptados por hacer de pacientes sin ninguna cita por venir, hoy.",
    how: "Planes con tratamientos aceptados por empezar, programados, en curso o suspendidos, de pacientes sin una cita por venir, hoy.",
    unit: "cantidad",
    column: "planes",
    time: "a_hoy",
    value: "count(distinct plan_id)",
    additive: false,
    sources: [
      {
        views: ["planes", "pacientes"],
        rows:
          "select l.plan_id, l.especialidad, l.indicado_por as profesional from planes l join pacientes p on p.paciente_id = l.paciente_id where l.decision = 'aceptado' and l.estado in ('pendiente', 'programado', 'en_curso', 'suspendido') and p.proxima_cita is null",
        cuts: ["especialidad", "profesional"],
      },
    ],
  },
  {
    key: "planes_sin_iniciar",
    name: "Planes sin iniciar",
    describes: "Planes con tratamientos aceptados que siguen todos sin empezar, hoy.",
    how: "Planes cuyos tratamientos aceptados (sin los cancelados) siguen todos por empezar o programados, sin ninguno iniciado, hoy.",
    unit: "cantidad",
    column: "planes",
    time: "a_hoy",
    value: "count(distinct plan_id)",
    additive: false,
    sources: [
      {
        views: ["planes"],
        rows: "select plan_id from planes where decision = 'aceptado' and estado <> 'cancelado' group by plan_id having bool_and(estado in ('pendiente', 'programado') and iniciado_en is null)",
        cuts: [],
      },
    ],
  },
  {
    key: "tratamientos_pendientes",
    name: "Tratamientos pendientes",
    describes: "Cuántos tratamientos aceptados falta hacer, hoy (por empezar, programados o en curso); por especialidad, tratamiento o quien lo indicó.",
    how: "Tratamientos aceptados por empezar, programados o en curso, hoy, sin los suspendidos.",
    unit: "cantidad",
    column: "tratamientos",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["planes"],
        rows: "select especialidad, tratamiento as servicio, indicado_por as profesional, 1 as v from planes where decision = 'aceptado' and estado in ('pendiente', 'programado', 'en_curso')",
        cuts: ["especialidad", "servicio", "profesional"],
      },
    ],
  },
  {
    key: "planes_terminados",
    name: "Planes terminados",
    describes: "Cuántos planes de tratamiento se terminaron: ya no les queda nada por hacer y su último tratamiento se hizo en el periodo.",
    how: "Planes cuyos tratamientos aceptados están todos realizados o cancelados, con al menos uno realizado, y cuyo último tratamiento terminó en el periodo.",
    unit: "cantidad",
    column: "planes",
    time: "instante",
    value: "count(distinct plan_id)",
    additive: false,
    sources: [
      {
        views: ["planes"],
        rows:
          "select plan_id, max(terminado_en) as t from planes where decision = 'aceptado' group by plan_id having bool_and(estado in ('realizado', 'cancelado')) and bool_or(estado = 'realizado')",
        cuts: [],
      },
    ],
  },
  {
    key: "duracion_tratamiento",
    name: "Cuánto dura un tratamiento",
    describes: "Cuántos días pasan entre que empieza y termina un tratamiento (la mediana), de los terminados en el periodo; por especialidad o tratamiento.",
    how: "La mediana de los días entre el inicio y el término de los tratamientos realizados que terminaron en el periodo.",
    unit: "cantidad",
    column: "dias",
    time: "instante",
    value: "round(percentile_cont(0.5) within group (order by v))",
    additive: false,
    sources: [
      {
        views: ["planes"],
        rows: "select terminado_en as t, especialidad, tratamiento as servicio, extract(epoch from terminado_en - iniciado_en) / 86400.0 as v from planes where estado = 'realizado' and iniciado_en is not null and terminado_en is not null",
        cuts: ["especialidad", "servicio"],
      },
    ],
  },
  {
    key: "conversaciones",
    name: "Conversaciones",
    describes: "Cuántas conversaciones empezaron, por canal (WhatsApp, Instagram…).",
    how: "Conversaciones que empezaron en el periodo, por cualquier canal.",
    unit: "cantidad",
    column: "conversaciones",
    time: "instante",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["conversaciones"],
        rows: "select inicio as t, dia, canal, 1 as v from conversaciones",
        cuts: [...WHEN, "canal"],
      },
    ],
  },
  // ---------------- Agenda ----------------
  {
    key: "atendidas",
    name: "Citas atendidas",
    describes:
      "Cuántas citas se atendieron; por profesional, sede, servicio, día de la semana u hora.",
    how: "Citas que terminaron atendidas en el periodo.",
    unit: "cantidad",
    column: "citas",
    time: "instante",
    value: COUNT,
    additive: true,
    report: "atendidas",
    sources: [
      {
        views: ["citas"],
        rows: "select inicio as t, dia, dia_semana, hora, sede, profesional, servicio, 1 as v from citas where estado = 'atendida'",
        cuts: [...WHEN, "dia_semana", "hora", "sede", "profesional", "servicio"],
      },
    ],
  },
  {
    key: "horas_atendidas",
    name: "Horas clínicas",
    describes: "Cuántas horas de citas se atendieron (la duración de las citas atendidas); por profesional, sede o servicio.",
    how: "La duración agendada de las citas atendidas del periodo, en horas.",
    unit: "horas",
    column: "horas",
    time: "instante",
    value: "round(sum(v) / 60.0, 1)",
    additive: true,
    sources: [
      {
        views: ["citas"],
        rows: "select inicio as t, dia, hora, sede, profesional, servicio, duracion_min as v from citas where estado = 'atendida'",
        cuts: [...WHEN, "hora", "sede", "profesional", "servicio"],
      },
    ],
  },
  {
    key: "citas",
    name: "Citas agendadas",
    describes:
      "Cuántas citas hay o hubo, sin las canceladas: las de hoy, las de la semana, las que vienen.",
    how: "Citas del periodo que siguen en pie o ya pasaron, sin las canceladas.",
    unit: "cantidad",
    column: "citas",
    time: "instante",
    value: COUNT,
    additive: true,
    ahead: true,
    sources: [
      {
        views: ["citas"],
        rows: "select inicio as t, dia, dia_semana, hora, sede, profesional, servicio, 1 as v from citas where estado <> 'cancelada'",
        cuts: [...WHEN, "dia_semana", "hora", "sede", "profesional", "servicio"],
      },
    ],
  },
  {
    key: "asistieron",
    name: "Asistieron",
    describes: "La asistencia: qué parte de las citas que ya pasaron se atendió.",
    how: "Citas atendidas entre las citas del periodo que ya pasaron, canceladas incluidas.",
    unit: "pct",
    column: "asistieron_pct",
    time: "instante",
    value: RATE,
    additive: false,
    sources: [
      {
        views: ["citas"],
        rows: "select inicio as t, dia, hora, sede, profesional, servicio, (estado = 'atendida')::int as a, ya_paso::int as n from citas",
        cuts: [...WHEN, "hora", "sede", "profesional", "servicio"],
      },
    ],
  },
  {
    key: "no_vinieron",
    name: "No vinieron",
    describes: "La inasistencia: qué parte de las citas que ya pasaron terminó en «no vino».",
    how: "Citas que terminaron en «no vino» entre las citas del periodo que ya pasaron.",
    unit: "pct",
    column: "no_vinieron_pct",
    time: "instante",
    value: RATE,
    additive: false,
    report: "no_vinieron",
    sources: [
      {
        views: ["citas"],
        rows: "select inicio as t, dia, dia_semana, hora, sede, profesional, servicio, (estado = 'no_vino')::int as a, ya_paso::int as n from citas",
        cuts: [...WHEN, "dia_semana", "hora", "sede", "profesional", "servicio"],
      },
    ],
  },
  {
    key: "canceladas",
    name: "Canceladas",
    describes: "Qué parte de las citas que ya pasaron se canceló.",
    how: "Citas canceladas entre las citas del periodo que ya pasaron.",
    unit: "pct",
    column: "canceladas_pct",
    time: "instante",
    value: RATE,
    additive: false,
    report: "canceladas",
    sources: [
      {
        views: ["citas"],
        rows: "select inicio as t, dia, dia_semana, hora, sede, profesional, servicio, (estado = 'cancelada')::int as a, ya_paso::int as n from citas",
        cuts: [...WHEN, "dia_semana", "hora", "sede", "profesional", "servicio"],
      },
    ],
  },
  {
    key: "agenda_ocupada",
    name: "Agenda ocupada",
    describes:
      "Qué tan llena está la agenda: lo ocupado por citas sobre lo disponible del horario.",
    how: "Minutos con citas no canceladas sobre los minutos disponibles del horario (sin bloqueos ni ausencias). El día de hoy cuenta entero.",
    unit: "pct",
    column: "ocupada_pct",
    time: "dia",
    value: "round(100.0 * sum(o) / nullif(sum(d), 0))",
    additive: false,
    report: "agenda_ocupada",
    sources: [
      {
        views: ["agenda_por_dia"],
        rows: "select dia, dia_semana, sede, profesional, minutos_ocupados as o, minutos_disponibles as d from agenda_por_dia",
        cuts: [...WHEN, "dia_semana", "sede", "profesional"],
      },
      {
        views: ["agenda_por_hora"],
        rows: "select dia, dia_semana, hora, sede, profesional, minutos_ocupados as o, minutos_disponibles as d from agenda_por_hora",
        cuts: [...WHEN, "dia_semana", "hora", "sede", "profesional"],
      },
    ],
  },
  {
    key: "horas_libres",
    name: "Horas libres",
    describes:
      "Cuántas horas del horario quedaron o quedan sin citas; en qué días u horas hay más espacio.",
    how: "Minutos disponibles del horario menos los ocupados por citas no canceladas, en horas. El día de hoy cuenta entero.",
    unit: "horas",
    column: "horas_libres",
    time: "dia",
    value: "round(sum(d - o) / 60.0, 1)",
    additive: true,
    report: "horas_libres",
    sources: [
      {
        views: ["agenda_por_dia"],
        rows: "select dia, dia_semana, sede, profesional, minutos_ocupados as o, minutos_disponibles as d from agenda_por_dia",
        cuts: [...WHEN, "dia_semana", "sede", "profesional"],
      },
      {
        views: ["agenda_por_hora"],
        rows: "select dia, dia_semana, hora, sede, profesional, minutos_ocupados as o, minutos_disponibles as d from agenda_por_hora",
        cuts: [...WHEN, "dia_semana", "hora", "sede", "profesional"],
      },
    ],
  },
  {
    key: "espera_en_sala",
    name: "Espera en sala",
    describes:
      "Cuánto esperan los pacientes en la sala antes de ser atendidos (la mediana, en minutos).",
    how: "La mediana de los minutos entre que el paciente llegó y empezó su atención, en las citas atendidas.",
    unit: "minutos",
    column: "espera_minutos",
    time: "instante",
    value: "round(percentile_cont(0.5) within group (order by v))",
    additive: false,
    report: "espera_en_sala",
    sources: [
      {
        views: ["citas"],
        rows: "select inicio as t, dia, dia_semana, sede, profesional, espera_min as v from citas where estado = 'atendida' and espera_min is not null",
        cuts: [...WHEN, "dia_semana", "sede", "profesional"],
      },
    ],
  },
  {
    key: "ausencias",
    name: "Días de ausencia",
    describes: "Cuántos días falta el equipo (vacaciones, permisos), por profesional.",
    how: "Los días de las ausencias del equipo que caen en el periodo.",
    unit: "cantidad",
    column: "dias",
    time: "tramo",
    value: COUNT,
    additive: true,
    ahead: true,
    sources: [
      {
        views: ["ausencias"],
        rows: (r) =>
          `select profesional, sede, (least(ultimo_dia, ${r.dia_hasta} - 1) - greatest(primer_dia, ${r.dia_desde}) + 1) as v from ausencias where primer_dia < ${r.dia_hasta} and ultimo_dia >= ${r.dia_desde}`,
        cuts: ["profesional", "sede"],
      },
    ],
  },
  // ---------------- Compras y oportunidades ----------------
  {
    key: "compras",
    name: "Lo comprado",
    describes: "Cuánto se compró a proveedores: las órdenes de compra hechas (sin borradores ni canceladas), por proveedor.",
    how: "El total de las órdenes de compra hechas en el periodo, sin borradores ni canceladas.",
    unit: "dinero",
    column: "comprado_dinero",
    time: "instante",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["compras"],
        rows: "select creada_en as t, dia, sede, proveedor, total as v from compras where estado not in ('borrador', 'cancelada')",
        cuts: [...WHEN, "sede", "proveedor"],
      },
    ],
  },
  {
    key: "ordenes_de_compra",
    name: "Órdenes de compra",
    describes: "Cuántas órdenes de compra se hicieron (sin borradores ni canceladas), por proveedor.",
    how: "Las órdenes de compra hechas en el periodo, sin borradores ni canceladas.",
    unit: "cantidad",
    column: "ordenes",
    time: "instante",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["compras"],
        rows: "select creada_en as t, dia, sede, proveedor, 1 as v from compras where estado not in ('borrador', 'cancelada')",
        cuts: [...WHEN, "sede", "proveedor"],
      },
    ],
  },
  {
    key: "oportunidades_abiertas",
    name: "Oportunidades abiertas",
    describes: "Cuántas ventas en curso del CRM siguen abiertas hoy, por servicio, etapa o responsable.",
    how: "Las oportunidades abiertas hoy (el interés de una persona por un servicio que aún no se decide).",
    unit: "cantidad",
    column: "oportunidades",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    sources: [
      { views: ["oportunidades"], rows: "select servicio, etapa, responsable as profesional, 1 as v from oportunidades where estado = 'open'", cuts: ["servicio", "etapa", "profesional"] },
    ],
  },
  // ---------------- Inventario y tareas ----------------
  {
    key: "por_reponer",
    name: "Productos por reponer",
    describes: "Cuántos productos están bajo su mínimo, no hay o faltan, hoy.",
    how: "Productos activos bajo su mínimo, sin existencias o usados sin haber, por sede, hoy.",
    unit: "cantidad",
    column: "productos",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["inventario"],
        rows: "select sede, producto, 1 as v from inventario where hay_que_reponer",
        cuts: ["sede", "producto"],
      },
    ],
  },
  {
    key: "por_vencer",
    name: "Lotes por vencer",
    describes: "Cuánto de cada producto vence en los próximos 30 días, hoy.",
    how: "Existencias de los lotes que vencen en los próximos 30 días, por sede, hoy.",
    unit: "cantidad",
    column: "cantidad",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["lotes"],
        rows: "select sede, producto, cantidad as v from lotes where estado = 'por_vencer'",
        cuts: ["sede", "producto"],
      },
    ],
  },
  {
    key: "vencidos",
    name: "Lotes vencidos en el almacén",
    describes: "Cuánto de cada producto ya venció y sigue en el almacén, hoy.",
    how: "Existencias de los lotes ya vencidos que siguen en el almacén, por sede, hoy.",
    unit: "cantidad",
    column: "cantidad",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["lotes"],
        rows: "select sede, producto, cantidad as v from lotes where estado = 'vencido'",
        cuts: ["sede", "producto"],
      },
    ],
  },
  {
    key: "tareas_pendientes",
    name: "Tareas pendientes",
    describes: "Cuántas tareas del equipo siguen abiertas, hoy; por área o por quién las tiene.",
    how: "Tareas del equipo abiertas hoy.",
    unit: "cantidad",
    column: "tareas",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["tareas"],
        rows: "select area, responsable as profesional, 1 as v from tareas where estado = 'open'",
        cuts: ["area", "profesional"],
      },
    ],
  },
  {
    key: "tareas_vencidas",
    name: "Tareas vencidas",
    describes: "Cuántas tareas abiertas ya pasaron su fecha, hoy.",
    how: "Tareas del equipo abiertas cuya fecha ya pasó.",
    unit: "cantidad",
    column: "tareas",
    time: "a_hoy",
    value: COUNT,
    additive: true,
    sources: [
      {
        views: ["tareas"],
        rows: "select area, responsable as profesional, 1 as v from tareas where estado = 'open' and vence_en < now()",
        cuts: ["area", "profesional"],
      },
    ],
  },
]

/** Una cifra por su clave. */
export function argosFigure(key: string): ArgosFigure | null {
  return ARGOS_FIGURES.find((figure) => figure.key === key) ?? null
}

/** Las fuentes que la llave puede leer enteras. */
function sourcesFor(figure: ArgosFigure, key: ArgosKey): FigureSource[] {
  const views = new Set(argosViewsOf(key).map((view) => view.name))
  return figure.sources.filter((source) => source.views.every((view) => views.has(view)))
}

/** Las cifras que una llave puede pedir: las que tienen al menos una fuente que lee. */
export function argosFiguresOf(key: ArgosKey): ArgosFigure[] {
  return ARGOS_FIGURES.filter((figure) => sourcesFor(figure, key).length > 0)
}

/** Las cifras en texto, para el modelo: clave, qué responde, cómo se mide y por qué se separa. */
export function argosFiguresText(key: ArgosKey): string {
  return argosFiguresOf(key)
    .map((figure) => {
      const cuts = [...new Set(sourcesFor(figure, key).flatMap((source) => source.cuts))]
      const time =
        figure.time === "a_hoy"
          ? "a hoy, sin periodo"
          : figure.ahead
            ? "en un periodo, también por venir"
            : "en un periodo"
      return `- ${figure.key}: ${figure.name}. ${figure.describes} (${time}; ${cuts.length ? `se separa y filtra por ${cuts.join(", ")}` : "una sola cifra"})`
    })
    .join("\n")
}

// --- Los nombres de la clínica ---------------------------------------------------------------

/** Los nombres de la clínica como están en las vistas: para el modelo y para revisar un filtro. */
export interface ArgosNames {
  sedes: string[]
  equipo: string[]
  /** Del equipo, quienes atienden pacientes: tienen horario o citas como profesional (como `equipo.atiende`), lleven o no «Dr.». */
  atienden: string[]
  especialidades: string[]
  servicios: Array<{ name: string; specialty: string | null }>
  productos: string[]
  /** Las promociones, vigentes o no, como en la vista `promociones`. */
  promociones: string[]
}

export async function listArgosNames(tx: Db, orgId: string, key: ArgosKey): Promise<ArgosNames> {
  const seesStock = argosViewsOf(key).some((view) => view.name === "inventario")
  const [branches, team, specialties, services, products, promotions] = await Promise.all([
    listArgosBranches(tx, orgId),
    tx
      .selectDistinct({
        name: user.name,
        attends: sql<boolean>`(exists (select 1 from ${professionalSchedule} s where s.organization_id = ${member.organizationId} and s.professional_user_id = ${member.userId})
          or exists (select 1 from ${appointment} a where a.organization_id = ${member.organizationId} and a.professional_user_id = ${member.userId}))`,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, orgId))
      .orderBy(asc(user.name)),
    tx
      .select({ name: orgSpecialty.name })
      .from(orgSpecialty)
      .where(and(eq(orgSpecialty.organizationId, orgId), eq(orgSpecialty.isActive, true)))
      .orderBy(asc(orgSpecialty.name)),
    listAgentServices(tx, orgId),
    seesStock
      ? tx
          .select({ name: product.name })
          .from(product)
          .where(and(eq(product.organizationId, orgId), eq(product.isActive, true)))
          .orderBy(asc(product.name))
      : Promise.resolve([]),
    tx.selectDistinct({ name: promotion.name }).from(promotion).where(eq(promotion.organizationId, orgId)).orderBy(asc(promotion.name)),
  ])
  return {
    sedes: branches.map((item) => item.name),
    equipo: team.map((item) => item.name),
    atienden: team.filter((item) => item.attends).map((item) => item.name),
    especialidades: specialties.map((item) => item.name),
    servicios: services.map((item) => ({ name: item.name, specialty: item.specialty })),
    productos: products.map((item) => item.name),
    promociones: promotions.map((item) => item.name),
  }
}

const ROLE_WORDS: Record<string, string> = { owner: "propietario", admin: "administración", clinician: "odontología", reception: "recepción", cashier: "caja" }

/**
 * Quien pregunta, con el rol con que pregunta (como lo dice la vista
 * `equipo`): «yo», «mis pacientes» o «lo que atendí» es esa persona. Solo su
 * nombre y su rol.
 */
export async function argosAsker(tx: Db, userId: string, memberRole: string): Promise<string | null> {
  const [row] = await tx.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1)
  if (!row) return null
  const roles = memberRole
    .split(",")
    .map((role) => ROLE_WORDS[role.trim()] ?? "otro")
    .join(", ")
  return `${row.name} (${roles})`
}

/** Para comparar nombres: sin tildes, sin mayúsculas, «×» como «x» y con un espacio entre palabras. */
export function plainArgosName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/×/g, "x")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * El nombre de la clínica que corresponde a lo escrito: el mismo (sin mirar
 * tildes ni mayúsculas) o el único que lo contiene como palabras («Surco» →
 * «Sede Surco»). Varios que lo contienen: todos, para que se elija.
 */
export function matchArgosName(
  written: string,
  names: readonly string[],
): { name: string } | { many: string[] } | null {
  const plain = plainArgosName(written)
  if (!plain) return null
  const exact = names.find((name) => plainArgosName(name) === plain)
  if (exact) return { name: exact }
  const words = new RegExp(
    `(^|[^\\p{L}\\p{N}])${plain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "u",
  )
  const containing = names.filter((name) => words.test(plainArgosName(name)))
  if (containing.length === 1 && containing[0]) return { name: containing[0] }
  return containing.length ? { many: containing } : null
}

function namesOf(cut: NamedCut, names: ArgosNames): string[] {
  if (cut === "sede") return names.sedes
  if (cut === "profesional") return names.equipo
  if (cut === "especialidad") return names.especialidades
  if (cut === "producto") return names.productos
  // Lo cargado y lo pagado nombran tratamientos y productos con la misma columna.
  return [...names.servicios.map((service) => service.name), ...names.productos]
}

const NAMED_WORDS: Record<NamedCut, string> = {
  sede: "una sede",
  profesional: "alguien del equipo",
  especialidad: "una especialidad",
  servicio: "un servicio ni un producto",
  producto: "un producto",
}

// --- La consulta --------------------------------------------------------------------------

/** Lo que el modelo pide: la cifra, por qué separarla y qué filtrar. */
export interface ArgosFigureAsk {
  cifra: string
  por?: string[]
  filtros?: Partial<Record<string, string[]>>
  parte_del_total?: boolean
  limite?: number | null
  /** «tiempo»: en el tiempo, en su orden (lo de siempre con mes, día de la semana u hora); si no, de mayor a menor o al revés. */
  orden?: "tiempo" | "mayor" | "menor"
}

export interface ArgosFigureCompiled {
  sql: string
  figure: ArgosFigure
  /** La columna de la cifra en el resultado (y la de antes, si compara). */
  column: string
  /** «Así lo calculé»: la regla de la cifra, cómo se separó y los nombres que se usaron. */
  how: string
  /** Lo que se cambió de lo escrito al nombre de la clínica («ortodoncia» → «Ortodoncia y Ortopedia Maxilar»). */
  resolved: Array<{ written: string; name: string }>
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`

/** «cobrado_dinero» → «cobrado_antes_dinero»: lo de antes con su mismo formato. */
function beforeColumn(column: string): string {
  const suffix = /_(dinero|pct)$/.exec(column)?.[0] ?? ""
  return `${column.slice(0, column.length - suffix.length)}_antes${suffix}`
}

const WEEKDAY_ORDER =
  "case dia_semana when 'lunes' then 1 when 'martes' then 2 when 'miércoles' then 3 when 'jueves' then 4 when 'viernes' then 5 when 'sábado' then 6 else 7 end"

/**
 * La consulta de una cifra con sus cortes y filtros, con los huecos del
 * periodo (y lo de antes si `compare`) y la sede de arriba. Un corte que la
 * cifra no tiene, un nombre que la clínica no tiene o un periodo que no le
 * corresponde es un problema para el modelo, sin datos.
 */
export function compileArgosFigure(
  ask: ArgosFigureAsk,
  options: { key: ArgosKey; compare: boolean; names: ArgosNames | null },
): ArgosFigureCompiled | { problem: string } {
  const figure = argosFigure(ask.cifra)
  const readable = figure ? sourcesFor(figure, options.key) : []
  if (!figure || !readable.length) {
    const keys = argosFiguresOf(options.key).map((item) => item.key)
    return {
      problem: `«${ask.cifra}» no es una cifra oficial que puedas pedir; son: ${keys.join(", ")}. Si ninguna sirve, consulta por tu cuenta`,
    }
  }
  const cuts = [...new Set(ask.por ?? [])]
  const filterEntries = Object.entries(ask.filtros ?? {}).filter(
    (entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0,
  )
  const unknown = [...cuts, ...filterEntries.map(([cut]) => cut)].find((cut) => !isArgosCut(cut))
  if (unknown)
    return { problem: `«${unknown}» no es un corte; los cortes son: ${ARGOS_CUTS.join(", ")}` }
  if (cuts.length > 2) return { problem: "una cifra se separa por dos cortes como mucho" }
  const wanted = new Set([...cuts, ...filterEntries.map(([cut]) => cut)] as ArgosCut[])
  const source = readable.find((item) => [...wanted].every((cut) => item.cuts.includes(cut)))
  if (!source) {
    const known = [...new Set(readable.flatMap((item) => item.cuts))]
    return {
      problem: `${figure.name} ${known.length ? `se separa y filtra solo por ${known.join(", ")}` : "es una sola cifra, sin cortes"}; para lo que pides, consulta por tu cuenta o pide otra cifra`,
    }
  }
  if (figure.time === "a_hoy" && options.compare)
    return {
      problem: `${figure.name} es a hoy: no se compara con otro periodo (periodo a_hoy y compara «no»)`,
    }

  // Los nombres, como los tiene la clínica.
  const resolved: ArgosFigureCompiled["resolved"] = []
  const filters: Array<[ArgosCut, string[]]> = []
  for (const [cut, values] of filterEntries as Array<[ArgosCut, string[]]>) {
    if (!(NAMED_CUTS as readonly string[]).includes(cut) || !options.names) {
      filters.push([cut, values])
      continue
    }
    const known = namesOf(cut as NamedCut, options.names)
    const out: string[] = []
    for (const value of values) {
      const match = matchArgosName(value, known)
      if (!match) {
        const list = known.slice(0, 40).join(", ")
        return {
          problem: `«${value}» no es ${NAMED_WORDS[cut as NamedCut]} de la clínica${list ? `; son: ${list}${known.length > 40 ? "…" : ""}` : ""}`,
        }
      }
      if ("many" in match) {
        out.push(...match.many)
        resolved.push({ written: value, name: match.many.join(", ") })
        continue
      }
      out.push(match.name)
      if (plainArgosName(match.name) !== plainArgosName(value))
        resolved.push({ written: value, name: match.name })
    }
    filters.push([cut, [...new Set(out)]])
  }

  const rowsOf = (range: Range) =>
    typeof source.rows === "string" ? source.rows : source.rows(range)
  const time = (range: Range): string | null =>
    figure.time === "instante"
      ? `t >= ${range.desde} and t < ${range.hasta}`
      : figure.time === "dia"
        ? `dia >= ${range.dia_desde} and dia < ${range.dia_hasta}`
        : null
  const conditions = [
    ...filters.map(
      ([cut, values]) => `${TIME_CUTS[cut] ?? cut} = any(array[${values.map(quote).join(", ")}])`,
    ),
    // La sede de arriba, si la cifra la tiene y la pregunta no eligió sedes.
    ...(source.cuts.includes("sede") && !filters.some(([cut]) => cut === "sede")
      ? ["(:sede is null or sede = :sede)"]
      : []),
  ]
  const select = (shifted: boolean) =>
    cuts.map((cut) => {
      const empty = NULL_WORDS[cut as ArgosCut]
      const expression = (shifted ? SHIFTED_TIME_CUTS[cut as ArgosCut] : undefined) ?? TIME_CUTS[cut as ArgosCut]
      return `${expression ?? (empty ? `coalesce(${cut}, ${quote(empty)})` : cut)} as ${cut}`
    })
  const block = (name: string, range: Range) => {
    const where = [time(range), ...conditions].filter(Boolean)
    return `${name} as (select ${[...select(range === BEFORE), `${figure.value} as v`].join(", ")} from (${rowsOf(range)}) as filas${where.length ? ` where ${where.join(" and ")}` : ""}${cuts.length ? ` group by ${cuts.map((_, index) => index + 1).join(", ")}` : ""})`
  }
  const before = options.compare && figure.time !== "a_hoy"
  const columns = [...cuts, `ahora.v as ${figure.column}`]
  if (before) {
    // Lo que antes no tuvo nada es cero, no un vacío («de S/ 0.00 a S/ 28.00»).
    columns.push(`${figure.additive ? "coalesce(antes.v, 0)" : "antes.v"} as ${beforeColumn(figure.column)}`)
    if (figure.additive)
      columns.push("round(100.0 * (ahora.v - antes.v) / nullif(abs(antes.v), 0)) as variacion_pct")
  }
  if (ask.parte_del_total && figure.additive && cuts.length)
    columns.push("round(100.0 * ahora.v / nullif(sum(ahora.v) over (), 0)) as parte_pct")
  const from = before
    ? cuts.length
      ? `ahora left join antes using (${cuts.join(", ")})`
      : "ahora, antes"
    : "ahora"
  // En el tiempo, en su orden; lo demás, de mayor a menor (o al revés), y a igual cifra por nombre.
  const first = cuts[0] as ArgosCut | undefined
  const inTime = first !== undefined && ((WHEN as readonly string[]).includes(first) || first === "hora")
  // Lo que pregunta «qué día más…» va de mayor a menor aunque sea un corte de tiempo; «por mes», en su orden.
  const byValue = cuts.length > 0 && (ask.orden === "mayor" || ask.orden === "menor" || (!inTime && ask.orden !== "tiempo"))
  const order = byValue
    ? `ahora.v ${ask.orden === "menor" ? "asc" : "desc"}, ${first}`
    : first === "dia_semana"
      ? WEEKDAY_ORDER
      : first
        ? `${first}`
        : null
  const limit =
    ask.limite && ask.limite > 0 ? ` limit ${Math.min(Math.floor(ask.limite), 200)}` : ""
  const sql = `with ${[block("ahora", NOW), ...(before ? [block("antes", BEFORE)] : [])].join(", ")} select ${columns.join(", ")} from ${from}${order ? ` order by ${order}` : ""}${limit}`

  const how = [
    figure.how,
    cuts.length
      ? `Separado ${cuts.map((cut) => ARGOS_CUT_WORDS[cut as ArgosCut]).join(" y ")}.`
      : "",
    filters.length ? `Solo ${filters.map(([, values]) => values.join(", ")).join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
  return { sql, figure, column: figure.column, how, resolved }
}

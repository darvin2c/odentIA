/**
 * Las respuestas correctas de las preguntas generadas (`eval/argos-generadas.json`), parte 6:
 * g126–g140 (marketing: conversaciones, embudo, promociones y oportunidades) y
 * g141–g150 (inventario y compras).
 *
 * - El embudo es el de Reportes (`funnelSql`): la persona cuenta en el periodo
 *   de su primer contacto y por su canal, sin Spam ni bloqueados.
 * - Una conversación «del día» es la que tuvo un mensaje de la persona ese día
 *   (sin Spam ni bloqueados); «sin respuesta» es la regla de la Bandeja
 *   (`unansweredSql`).
 * - Las promociones son las de Reportes › Finanzas (`getReportPromotions`):
 *   un uso es un presupuesto entregado o un cobro que la lleva.
 * - Lo que hay se mide a hoy con `listProducts` de cada sede, en la unidad de
 *   uso; lo usado son los movimientos de consumo; las compras, con
 *   `purchaseBalances` (lo pedido, lo recibido y lo pagado de cada orden).
 */
import {
  budgetLineUnitsSql,
  budgetValueOptionSql,
  channelWords,
  funnelSql,
  getReportPromotions,
  listProducts,
  needsPersonSql,
  type ProductListItem,
  PURCHASE_STATUS_WORDS,
  purchaseBalances,
  purchaseOrderLabel,
  reportScope,
  type Span,
  screenedSql,
  unansweredSinceSql,
  unansweredSql,
} from "@odentia/services"
import { sql } from "drizzle-orm"
import { dayStart, goldenWords } from "./finance.js"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"

const DAY_MS = 86_400_000

/** «1 frasco», «2 frascos», «3 unidades»: la unidad de uso del producto. */
function unitsWord(count: number, unit: string): string {
  if (count === 1 || count === -1) return `${count} ${unit}`
  const plural = /[aeiouáéó]$/i.test(unit) ? `${unit}s` : `${unit}es`
  return `${count} ${plural}`
}

const howMany = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Las filas del embudo por canal, con los pasos que piden estas preguntas. */
type FunnelRow = {
  channel: string | null
  sought: number
  booked: number
  came: number
  paid: number
  paidAny: number
  stopped: number
}

export function generatedSolvers6(h: GoldenHelpers): GoldenSolvers {
  const { tx, org, money, listOf } = h
  const { locale, currency } = h.scope
  const w = goldenWords(h)
  const nowIso = w.nowIso
  const yearAgo = new Date(h.now.getTime() - 365 * DAY_MS)
  const year = Number(w.todayKey.slice(0, 4))
  const month = Number(w.todayKey.slice(5, 7))
  const num = (value: number) => value.toLocaleString(locale)
  const weekday = new Date(`${w.todayKey}T12:00:00Z`).getUTCDay()
  const monday = w.addDays(w.todayKey, -((weekday + 6) % 7))
  /** «del lunes 19 al miércoles 21 de octubre». */
  const spanWords = (from: string, to: string): string =>
    from === to
      ? `el ${w.dayWords(from)}`
      : `del ${from.slice(0, 7) === to.slice(0, 7) ? w.dayWords(from).replace(/ de [^ ]+$/, "") : w.dayWords(from)} al ${w.dayWords(to)}`
  /** «10 de octubre de 2026». */
  const dateWords = (day: string) =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${day.slice(0, 10)}T12:00:00Z`))
  /** El mes con nombre de un periodo de Reportes («septiembre de 2026»). */
  const monthKey = (target: number) =>
    `${target <= month ? year : year - 1}-${String(target).padStart(2, "0")}`
  const windowOf = async (period: string) => (await reportScope(tx, org, { period }, h.now)).window
  const thisMonth = `este mes (${w.monthSoFar})`
  const ThisMonth = capital(thisMonth)

  /** El embudo de un tramo por canal: buscaron, agendaron, vinieron, pagaron (como Reportes) y pagaron algo sin exigir presupuesto. */
  const funnelBy = (span: Span) =>
    tx.execute<FunnelRow>(sql`
      ${funnelSql(org, span, h.now)}
      select f.channel, count(*)::int as sought, count(*) filter (where f.booked)::int as booked, count(*) filter (where f.came)::int as came,
        count(*) filter (where f.paid)::int as paid,
        count(*) filter (where f.patient_id is not null and exists (select 1 from patient_payment y where y.organization_id = ${org}
          and y.patient_id = f.patient_id and y.voided_at is null and y.paid_at >= f.first_at))::int as "paidAny",
        count(*) filter (where f.stopped)::int as stopped
      from funnel f group by 1 order by 2 desc, 1`)
  const channelOf = (rows: FunnelRow[], channel: string): FunnelRow =>
    rows.find((row) => row.channel === channel) ?? {
      channel,
      sought: 0,
      booked: 0,
      came: 0,
      paid: 0,
      paidAny: 0,
      stopped: 0,
    }
  const totalOf = (rows: FunnelRow[]): FunnelRow =>
    rows.reduce(
      (sum, row) => ({
        channel: null,
        sought: sum.sought + row.sought,
        booked: sum.booked + row.booked,
        came: sum.came + row.came,
        paid: sum.paid + row.paid,
        paidAny: sum.paidAny + row.paidAny,
        stopped: sum.stopped + row.stopped,
      }),
      { channel: null, sought: 0, booked: 0, came: 0, paid: 0, paidAny: 0, stopped: 0 },
    )

  /** Conversaciones con algún mensaje en [start, end), sin Spam ni bloqueados, por canal: con mensaje de la persona, con cualquier mensaje y empezadas en el tramo. */
  const conversationsIn = (start: string, end: string) =>
    tx.execute<{
      channel: string | null
      wrote: number
      any: number
      started: number
      people: number
    }>(sql`
      select cc.channel, count(*) filter (where x.inbound)::int as wrote, count(*)::int as "any",
        count(*) filter (where c.created_at >= ${start}::timestamptz and c.created_at < ${end}::timestamptz)::int as started,
        count(distinct c.contact_id) filter (where x.inbound)::int as people
      from conversation c
      left join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id
      join lateral (select bool_or(m.direction = 'in') as inbound from message m
        where m.organization_id = c.organization_id and m.conversation_id = c.id
          and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz) x on x.inbound is not null
      where c.organization_id = ${org} and not ${screenedSql(sql.raw("c"))}
      group by 1 order by 2 desc, 3 desc, 1`)
  const sumOf = <K extends "wrote" | "any" | "started" | "people">(
    rows: Array<Record<K, number>>,
    key: K,
  ) => rows.reduce((total, row) => total + row[key], 0)

  /** Los usos de cada promoción en [start, end): presupuestos entregados (con su opción de valor) y cobros sueltos que la llevan. */
  const promotionUses = (start: string, end: string) =>
    tx.execute<{ name: string; uses: number; lines: number; people: number }>(sql`
      with uses as (
        select i.promotion_id, b.id as use_id, b.patient_id from treatment_budget b
        join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
          and i.option_id = ${budgetValueOptionSql({ id: sql`b.id`, organizationId: sql`b.organization_id` })}
          and i.promotion_id is not null and i.price_cents is not null
        where b.organization_id = ${org} and b.currency = ${currency} and b.status <> 'borrador'
          and b.presented_at >= ${start}::timestamptz and b.presented_at < ${end}::timestamptz
        union all
        select c.promotion_id::uuid, c.id, c.patient_id from patient_charge c
        where c.organization_id = ${org} and c.currency = ${currency} and c.voided_at is null and c.budget_item_id is null
          and c.promotion_id ~ '^[0-9a-f]{8}-[0-9a-f-]{27}$'
          and c.created_at >= ${start}::timestamptz and c.created_at < ${end}::timestamptz)
      select pr.name, count(distinct u.use_id)::int as uses, count(*)::int as lines, count(distinct u.patient_id)::int as people
      from uses u join promotion pr on pr.organization_id = ${org} and pr.id = u.promotion_id
      group by pr.name order by 2 desc, 1`)

  /** Cada producto de cada sede activa, como lo muestra Inventario hoy. */
  const bySede = async () => {
    const branches = await tx.execute<{ id: string; name: string }>(
      sql`select id, name from branch where organization_id = ${org} and is_active order by name`,
    )
    const found: Array<ProductListItem & { branch: string; branchId: string }> = []
    for (const branch of branches) {
      const list = await listProducts(tx, org, { branchId: branch.id, now: h.now })
      for (const item of list.items)
        found.push({ ...item, branch: branch.name, branchId: branch.id })
    }
    return { branches: [...branches], found }
  }
  /** La sede que nombra la pregunta, por una palabra de su nombre. */
  const sedeNamed = (branches: Array<{ id: string; name: string }>, word: RegExp) =>
    branches.find((branch) => word.test(branch.name))

  /** Lotes con existencias, con su sede y su vencimiento. */
  const lots = () =>
    tx.execute<{
      product: string
      unit: string
      branch: string
      code: string
      expires: string | null
      quantity: number
    }>(sql`
      select pr.name as product, pr.unit, b.name as branch, l.code, to_char(l.expires_at, 'YYYY-MM-DD') as expires, l.quantity_on_hand as quantity
      from product_lot l
      join product pr on pr.organization_id = l.organization_id and pr.id = l.product_id
      join warehouse w on w.organization_id = l.organization_id and w.id = l.warehouse_id
      join branch b on b.organization_id = w.organization_id and b.id = w.branch_id
      where l.organization_id = ${org} and l.quantity_on_hand > 0
      order by l.expires_at nulls last, pr.name, b.name`)
  type Lot = Awaited<ReturnType<typeof lots>>[number]
  const lotWords = (rows: Lot[]) =>
    listOf(
      rows.map((row) => ({
        name: `${row.product} en ${row.branch}${row.code ? `, lote ${row.code}` : ""}`,
        value: `${unitsWord(row.quantity, row.unit)}, ${row.expires ? `${row.expires < w.todayKey ? "venció" : "vence"} el ${dateWords(row.expires)}` : "sin vencimiento"}`,
      })),
    )

  /** Lo descontado por uso en [start, end) de los productos que cumplen `where`, por producto y sede. */
  const consumedBy = (start: string, end: string, kinds: "consumo" | "como_inventario") =>
    tx.execute<{
      name: string
      unit: string
      branch: string
      units: number
      encounters: number
    }>(sql`
      select pr.name, pr.unit, b.name as branch, sum(-m.quantity_delta)::int as units, count(distinct m.encounter_id)::int as encounters
      from stock_movement m
      join product pr on pr.organization_id = m.organization_id and pr.id = m.product_id
      join warehouse wh on wh.organization_id = m.organization_id and wh.id = m.warehouse_id
      join branch b on b.organization_id = wh.organization_id and b.id = wh.branch_id
      where m.organization_id = ${org} and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz
        and ${kinds === "consumo" ? sql`m.kind = 'consumo'` : sql`(m.kind in ('consumo', 'venta', 'devolucion') or (m.kind = 'ajuste' and m.encounter_id is not null))`}
      group by 1, 2, 3 order by 4 desc, 1, 3`)

  return {
    g126: async () => {
      const week = await h.fig("nos_buscaron", "canal", `${monday}..${w.todayKey}`)
      const row = week.rows.find((item) => item.key === "whatsapp")
      const sought = row?.value.value ?? 0
      const came = row?.value.part ?? 0
      const since = await dayStart(h, monday)
      // Otra lectura: su primer mensaje por WhatsApp fue esta semana, aunque antes nos conociera por otro canal o ya fuera paciente.
      const [firstWhatsApp] = await tx.execute<{
        people: number
        screened: number
        wrote: number
      }>(sql`
        with first_wa as (
          select c.contact_id, min(m.created_at) as at, bool_or(ct.screen is not null) as screened from message m
          join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
          join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id and cc.channel = 'whatsapp'
          join contact ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
          where m.organization_id = ${org} and m.direction = 'in' and m.created_at < ${nowIso}::timestamptz
          group by c.contact_id)
        select count(*) filter (where not screened and at >= ${since}::timestamptz)::int as people,
          count(*) filter (where screened and at >= ${since}::timestamptz)::int as screened,
          (select count(distinct c.contact_id) from message m
            join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
            join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id and cc.channel = 'whatsapp'
            where m.organization_id = ${org} and m.direction = 'in' and m.created_at >= ${since}::timestamptz and m.created_at < ${nowIso}::timestamptz
              and not ${screenedSql(sql.raw("c"))})::int as wrote
        from first_wa`)
      return {
        respuesta: `Esta semana (${spanWords(monday, w.todayKey)}, hasta ahora) ${sought === 1 ? "1 persona nos escribió" : `${sought} personas nos escribieron`} por primera vez por WhatsApp${sought ? `; ${came} ${came === 1 ? "ya vino" : "ya vinieron"} a atenderse` : ""}.`,
        criterio:
          "«Nos buscaron por primera vez» de Reportes por canal, de lunes a hoy: personas cuyo primer contacto con la clínica (primer mensaje o registro) fue una conversación de WhatsApp esta semana, sin Spam ni bloqueados.",
        nota: `Contando a quien escribió por WhatsApp por primera vez esta semana aunque ya nos conociera por otro canal o ya fuera paciente: ${firstWhatsApp?.people ?? 0}. En total escribieron por WhatsApp esta semana ${firstWhatsApp?.wrote ?? 0} personas.${firstWhatsApp?.screened ? ` Aparte, ${howMany(firstWhatsApp.screened, "número en Spam o bloqueado escribió", "números en Spam o bloqueados escribieron")} por primera vez y no cuentan.` : ""}`,
        datos: {
          desde: monday,
          canales: week.rows,
          whatsapp: row ?? null,
          primerWhatsApp: firstWhatsApp ?? null,
        },
      }
    },

    g127: async () => {
      const last = await windowOf("mes_pasado")
      const lastName = w.monthWords(last.from)
      const rows = [...(await funnelBy(last))]
      const wa = channelOf(rows, "whatsapp")
      // Otra lectura: quien escribió por WhatsApp en el mes sin tener todavía ficha de paciente, aunque nos hubiera escrito antes.
      const [loose] = await tx.execute<{ people: number; booked: number }>(sql`
        with wrote as (
          select c.contact_id, min(m.created_at) as at from message m
          join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
          join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id and cc.channel = 'whatsapp'
          where m.organization_id = ${org} and m.direction = 'in' and not ${screenedSql(sql.raw("c"))}
            and m.created_at >= ${last.start.toISOString()}::timestamptz and m.created_at < ${last.end.toISOString()}::timestamptz
          group by c.contact_id
        ), not_patient as (
          select x.* from wrote x
          where not exists (select 1 from patient p where p.organization_id = ${org} and p.person_id = x.contact_id and p.created_at <= x.at)
        )
        select count(*)::int as people,
          count(*) filter (where exists (
            select 1 from appointment a join patient p on p.organization_id = a.organization_id and p.id = a.patient_id
            where a.organization_id = ${org} and a.status <> 'cancelada' and a.created_at >= n.at
              and (p.person_id = n.contact_id or exists (select 1 from patient_contact v where v.organization_id = ${org} and v.patient_id = p.id and v.contact_id = n.contact_id))))::int as booked
        from not_patient n`)
      const pct = w.pct(wa.booked, wa.sought)
      return {
        respuesta: wa.sought
          ? `En ${lastName}, ${wa.sought === 1 ? "1 persona nueva nos escribió" : `${wa.sought} personas nuevas nos escribieron`} por primera vez por WhatsApp y ${wa.booked} ${wa.booked === 1 ? "llegó" : "llegaron"} a sacar una cita (${pct}); ${wa.came} ya ${wa.came === 1 ? "vino" : "vinieron"} a atenderse.`
          : `En ${lastName} nadie nuevo nos escribió por primera vez por WhatsApp.`,
        criterio:
          "El embudo de Reportes del mes pasado (completo), canal WhatsApp: personas cuyo primer contacto con la clínica fue una conversación de WhatsApp en el mes (aún no eran pacientes) y cuántas agendaron, hasta hoy, una cita sin cancelar («No vino» cuenta).",
        nota: `Contando a todos los que escribieron por WhatsApp en ${lastName} sin tener aún ficha de paciente, aunque ya nos hubieran escrito antes: ${loose?.people ?? 0} personas, de las que ${loose?.booked ?? 0} sacaron una cita después (${w.pct(loose?.booked ?? 0, loose?.people ?? 0)}).`,
        datos: {
          periodo: { start: last.start, end: last.end },
          whatsapp: wa,
          canales: rows,
          escribieronSinSerPacientes: loose ?? null,
        },
      }
    },

    g128: async () => {
      const monthRows = [...(await funnelBy(h.scope.window))]
      const yearRows = [...(await funnelBy({ start: yearAgo, end: h.now }))]
      const web = channelOf(monthRows, "webchat")
      const webYear = channelOf(yearRows, "webchat")
      return {
        respuesta: web.sought
          ? `${ThisMonth} ${web.sought === 1 ? "1 persona nos escribió" : `${web.sought} personas nos escribieron`} por primera vez por el chat de la web y ${web.paid ? `${web.paid} ${web.paid === 1 ? "terminó" : "terminaron"} pagando algo (${w.pct(web.paid, web.sought)})` : "ninguna terminó pagando algo todavía"}.`
          : `${ThisMonth} nadie nos escribió por primera vez por el chat de la web.`,
        criterio:
          "El embudo de Reportes del mes en curso, canal Chat web: personas cuyo primer contacto fue el chat de la web y cuántas llegaron a «Pagó algo» (aceptaron un presupuesto y tienen un pago sin anular), hasta hoy.",
        nota: `Contando cualquier pago sin anular desde que escribieron, aunque no hayan aceptado un presupuesto: ${web.paidAny} de ${web.sought}. En los últimos 12 meses, por el chat de la web nos escribieron por primera vez ${webYear.sought} personas: ${webYear.paid} llegaron a «Pagó algo» (${w.pct(webYear.paid, webYear.sought)}) y ${webYear.paidAny} pagaron algo de cualquier forma.`,
        datos: { mes: web, doceMeses: webYear },
      }
    },

    g129: async () => {
      const yesterday = w.addDays(w.todayKey, -1)
      const start = await dayStart(h, yesterday)
      const end = await dayStart(h, w.todayKey)
      const rows = [...(await conversationsIn(start, end))]
      const wrote = rows.filter((row) => row.wrote > 0)
      const total = sumOf(rows, "wrote")
      const [people] = await tx.execute<{ count: number }>(sql`
        select count(distinct c.contact_id)::int as count from message m
        join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
        where m.organization_id = ${org} and m.direction = 'in' and not ${screenedSql(sql.raw("c"))}
          and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz`)
      return {
        respuesta: total
          ? `Ayer (${w.dayWords(yesterday)}) tuvimos ${howMany(total, "conversación", "conversaciones")} en las que la persona nos escribió: ${listOf(wrote.map((row) => ({ name: channelWords(row.channel), value: `${row.wrote}` })))}.`
          : `Ayer (${w.dayWords(yesterday)}) nadie nos escribió.`,
        criterio:
          "Conversaciones con al menos un mensaje de la persona ayer (día de la clínica), por canal; sin las de Spam ni bloqueados.",
        nota: `Contando también las que solo tuvieron mensajes nuestros (respuestas o avisos): ${sumOf(rows, "any")}. Conversaciones que empezaron ayer: ${sumOf(rows, "started")}. Personas distintas que escribieron: ${people?.count ?? 0}.`,
        datos: { dia: yesterday, porCanal: rows },
      }
    },

    g130: async () => {
      const rows = await tx.execute<{
        person: string
        channel: string | null
        since: string
        attend: boolean
      }>(sql`
        select pp.display_name as person, cc.channel, ${unansweredSinceSql(sql.raw("c"))} as since, ${needsPersonSql(sql.raw("c"))} as attend
        from conversation c
        join contact pp on pp.organization_id = c.organization_id and pp.id = c.contact_id
        left join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id
        where c.organization_id = ${org} and ${unansweredSql(sql.raw("c"))} and not ${screenedSql(sql.raw("c"))}
        order by ${unansweredSinceSql(sql.raw("c"))}`)
      const [spam] = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from conversation c where c.organization_id = ${org} and ${unansweredSql(sql.raw("c"))} and ${screenedSql(sql.raw("c"))}`)
      const waiting = (iso: string) => {
        const minutes = Math.max(
          0,
          Math.round((h.now.getTime() - new Date(iso).getTime()) / 60_000),
        )
        return minutes < 60
          ? howMany(minutes, "minuto", "minutos")
          : minutes < 48 * 60
            ? howMany(Math.round(minutes / 60), "hora", "horas")
            : howMany(Math.round(minutes / 1440), "día", "días")
      }
      const attend = rows.filter((row) => row.attend).length
      return {
        respuesta: rows.length
          ? `Hoy ${rows.length === 1 ? "1 conversación sigue" : `${rows.length} conversaciones siguen`} sin respuesta: ${listOf(rows.map((row) => ({ name: `${row.person} por ${channelWords(row.channel)}`, value: `espera hace ${waiting(row.since)}` })))}.`
          : "Hoy ninguna conversación abierta espera respuesta.",
        criterio:
          "La regla de la Bandeja: conversaciones abiertas cuyo último mensaje de la persona es posterior a la última respuesta aceptada por el canal, sin Spam ni bloqueados; de la que espera hace más a la más reciente.",
        nota: `De ellas, ${attend} ${attend === 1 ? "está" : "están"} en «Por atender» (esperan a una persona del equipo); las demás las atiende el agente.${spam?.count ? ` Aparte, ${howMany(spam.count, "conversación de Spam o bloqueados quedó", "conversaciones de Spam o bloqueados quedaron")} sin respuesta a propósito.` : ""}`,
        datos: { sinRespuesta: rows, enSpam: spam?.count ?? 0 },
      }
    },

    g131: async () => {
      const monthRows = [...(await funnelBy(h.scope.window))]
      const yearRows = [...(await funnelBy({ start: yearAgo, end: h.now }))]
      const wa = channelOf(monthRows, "whatsapp")
      const web = channelOf(monthRows, "webchat")
      const online = channelOf(monthRows, "registro_en_linea")
      const waYear = channelOf(yearRows, "whatsapp")
      const webYear = channelOf(yearRows, "webchat")
      const onlineYear = channelOf(yearRows, "registro_en_linea")
      const winner =
        wa.came === web.came
          ? wa.sought === web.sought
            ? null
            : wa.sought > web.sought
              ? "WhatsApp"
              : "el chat de la web"
          : wa.came > web.came
            ? "WhatsApp"
            : "el chat de la web"
      const words = (row: FunnelRow) =>
        row.sought
          ? `${howMany(row.sought, "persona nos buscó", "personas nos buscaron")} por primera vez y ${row.came ? `${row.came} ${row.came === 1 ? "vino" : "vinieron"}` : "ninguna vino todavía"}`
          : "nadie nos buscó por primera vez"
      return {
        respuesta: `${ThisMonth} ${winner ? `${capital(winner)} trae más pacientes nuevos que ${winner === "WhatsApp" ? "el chat de la web" : "WhatsApp"}` : "WhatsApp y el chat de la web traen los mismos pacientes nuevos"}: por WhatsApp ${words(wa)}; por el chat de la web ${words(web)}.`,
        criterio:
          "El embudo de Reportes por canal, del mes en curso: personas cuyo primer contacto fue ese canal y cuántas ya vinieron a atenderse (cita atendida o atención firmada), que son los pacientes nuevos que trajo; se compara por los que vinieron.",
        nota: `En los últimos 12 meses: por WhatsApp ${words(waYear)}; por el chat de la web ${words(webYear)}. Si «página web» incluye el registro en línea (formulario, enlace o código QR): ${online.sought || onlineYear.sought ? `este mes ${words(online)}; en 12 meses ${words(onlineYear)}` : "por ahí nadie llegó, ni este mes ni en los últimos 12 meses"}.`,
        datos: {
          mes: { whatsapp: wa, chatWeb: web, registroEnLinea: online },
          doceMeses: { whatsapp: waYear, chatWeb: webYear, registroEnLinea: onlineYear },
        },
      }
    },

    g132: async () => {
      const month = await promotionUses(h.monthStart, nowIso)
      const promotions = await tx.execute<{
        name: string
        starts: string | null
        ends: string | null
      }>(sql`
        select name, to_char(starts_at at time zone ${h.tz}, 'YYYY-MM-DD') as starts, to_char((ends_at - interval '1 second') at time zone ${h.tz}, 'YYYY-MM-DD') as ends
        from promotion where organization_id = ${org} order by starts_at`)
      const named = promotions.filter((row) => /limpieza/i.test(row.name))
      const cleaning = promotions.filter(
        (row) => /profilaxis/i.test(row.name) && !/limpieza/i.test(row.name),
      )
      const usesOf = (name: string) =>
        month.find((row) => row.name === name) ?? { name, uses: 0, lines: 0, people: 0 }
      const target = named[0]
      const used = target ? usesOf(target.name) : null
      // El último mes en que se usó, para decir lo más cercano si este mes no.
      const [lastUse] = target
        ? await tx.execute<{ month: string; uses: number; people: number }>(sql`
            select to_char(b.presented_at at time zone ${h.tz}, 'YYYY-MM') as month, count(distinct b.id)::int as uses, count(distinct b.patient_id)::int as people
            from treatment_budget b join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
              and i.option_id = ${budgetValueOptionSql({ id: sql`b.id`, organizationId: sql`b.organization_id` })}
              and i.price_cents is not null
            join promotion pr on pr.organization_id = i.organization_id and pr.id = i.promotion_id and pr.name = ${target.name}
            where b.organization_id = ${org} and b.status <> 'borrador' and b.presented_at < ${nowIso}::timestamptz
            group by 1 order by 1 desc limit 1`)
        : []
      const span = (row: { starts: string | null; ends: string | null }) =>
        row.ends
          ? `del ${dateWords(row.starts ?? "")} al ${dateWords(row.ends)}`
          : `desde el ${dateWords(row.starts ?? "")}, sin fecha de fin`
      return {
        respuesta:
          target && used
            ? used.uses
              ? `${ThisMonth} la promoción «${target.name}» se usó ${howMany(used.uses, "vez", "veces")} (${howMany(used.people, "persona", "personas")}).`
              : `${ThisMonth} la promoción «${target.name}» no se usó ninguna vez: estuvo vigente ${span(target)}.${lastUse ? ` En ${w.monthWords({ year: Number(lastUse.month.slice(0, 4)), month: Number(lastUse.month.slice(5, 7)) })} se usó ${howMany(lastUse.uses, "vez", "veces")} (${howMany(lastUse.people, "persona", "personas")}).` : ""}`
            : "No tienes ninguna promoción de limpieza.",
        criterio:
          "Usos de la promoción en el mes en curso como los cuenta Reportes › Finanzas › Promociones: cada presupuesto entregado que la lleva en su opción de valor y cada cobro suelto con ella; «personas», sin repetir.",
        nota: cleaning.length
          ? cleaning
              .map(
                (row) =>
                  `Si la de limpieza es «${row.name}» (vigente ${span(row)}): este mes se usó ${howMany(usesOf(row.name).uses, "vez", "veces")}.`,
              )
              .join(" ")
          : undefined,
        datos: {
          promocion: target ?? null,
          usosMes: month,
          ultimoMesConUso: lastUse ?? null,
          otrasDeLimpieza: cleaning.map((row) => ({ ...row, ...usesOf(row.name) })),
        },
      }
    },

    g133: async () => {
      const result = await getReportPromotions(tx, org, { period: "este_ano" }, h.now)
      const byCollected = [...result.promotions].sort(
        (a, b) => b.collectedCents - a.collectedCents || b.people - a.people,
      )
      const byFresh = [...result.promotions].sort(
        (a, b) => b.fresh - a.fresh || b.people - a.people,
      )
      const top = byCollected[0]
      const yearWords = `este año (del 1 de enero al ${w.dayWords(w.todayKey)})`
      return {
        respuesta: top
          ? `Por lo cobrado, la promoción que mejor funcionó ${yearWords} es «${top.name}»: quienes la usaron pagaron desde entonces ${money(top.collectedCents)} (${howMany(top.people, "persona", "personas")}, ${top.fresh} ${top.fresh === 1 ? "nueva" : "nuevas"}). Le siguen ${listOf(byCollected.slice(1, 4).map((row) => ({ name: `«${row.name}»`, value: `${money(row.collectedCents)}, ${howMany(row.people, "persona", "personas")}` })))}.`
          : `${capital(yearWords)} no se usó ninguna promoción.`,
        criterio:
          "Reportes › Finanzas › Promociones del año en curso: quiénes la usaron (presupuesto entregado o cobro con ella) y lo que pagaron desde que la usaron hasta hoy, sin anulados ni lo devuelto; la mejor es la que más se cobró.",
        nota: `Por cuántas personas la usaron: ${listOf([...result.promotions].slice(0, 4).map((row) => ({ name: `«${row.name}»`, value: `${row.people}` })))}. Por pacientes nuevos que trajo: ${listOf(byFresh.slice(0, 3).map((row) => ({ name: `«${row.name}»`, value: `${row.fresh}` })))}.`,
        datos: {
          promociones: result.promotions,
          personas: result.people,
          cobrado: result.collectedCents,
        },
      }
    },

    g134: async () => {
      const rows = await tx.execute<{
        stage: string
        position: number
        count: number
        withAmount: number
        cents: string
      }>(sql`
        select st.name as stage, st.position, count(*)::int as count, count(o.amount_cents)::int as "withAmount", coalesce(sum(o.amount_cents), 0)::text as cents
        from opportunity o join pipeline_stage st on st.organization_id = o.organization_id and st.id = o.stage_id
        where o.organization_id = ${org} and o.status = 'open' and (o.amount_cents is null or o.currency = ${currency})
        group by 1, 2 order by 2`)
      const count = rows.reduce((sum, row) => sum + row.count, 0)
      const withAmount = rows.reduce((sum, row) => sum + row.withAmount, 0)
      const cents = rows.reduce((sum, row) => sum + Number(row.cents), 0)
      return {
        respuesta: count
          ? `Hoy tienes ${howMany(count, "oportunidad abierta", "oportunidades abiertas")} y suman ${money(cents)}${withAmount < count ? `; solo ${withAmount} de las ${count} tienen valor anotado, las otras ${count - withAmount} no suman nada` : ""}.`
          : "Hoy no tienes oportunidades abiertas.",
        criterio:
          "Oportunidades abiertas a hoy y la suma de su valor, como el total del tablero de Oportunidades (solo lo abierto, en la moneda de la clínica).",
        nota: `Por etapa: ${listOf(rows.map((row) => ({ name: row.stage, value: `${row.count}, ${money(Number(row.cents))}` })))}.`,
        datos: { porEtapa: rows, abiertas: count, conValor: withAmount, centimos: cents },
      }
    },

    g135: async () => {
      const sept = await windowOf(monthKey(9))
      const name = w.monthWords(sept.from)
      const closed = (start: Date, end: Date) =>
        tx.execute<{ status: string; count: number; cents: string }>(sql`
          select status, count(*)::int as count, coalesce(sum(amount_cents), 0)::text as cents from opportunity
          where organization_id = ${org} and status in ('won', 'lost') and closed_at >= ${start.toISOString()}::timestamptz and closed_at < ${end.toISOString()}::timestamptz
          group by 1`)
      const rows = await closed(sept.start, sept.end)
      const now = await closed(h.scope.window.start, h.now)
      const of = (list: typeof rows, status: string) => list.find((row) => row.status === status)
      const won = of(rows, "won")?.count ?? 0
      const lost = of(rows, "lost")?.count ?? 0
      const [created] = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from opportunity where organization_id = ${org}
          and created_at >= ${sept.start.toISOString()}::timestamptz and created_at < ${sept.end.toISOString()}::timestamptz`)
      return {
        respuesta:
          won + lost
            ? `En ${name} se ganaron ${won} y se perdieron ${lost} oportunidades${won ? `; las ganadas suman ${money(Number(of(rows, "won")?.cents ?? 0))}` : ""}.`
            : `En ${name} no se ganó ni se perdió ninguna oportunidad: ninguna se cerró ese mes.`,
        criterio:
          "Oportunidades cerradas como ganadas o perdidas en ese mes (por el día en que se cerraron), en el día de la clínica.",
        nota: `Oportunidades creadas en ${name}: ${created?.count ?? 0}. ${ThisMonth} se ganaron ${of(now, "won")?.count ?? 0} (${money(Number(of(now, "won")?.cents ?? 0))}) y se perdieron ${of(now, "lost")?.count ?? 0}.`,
        datos: { setiembre: rows, esteMes: now, creadasEnSetiembre: created?.count ?? 0 },
      }
    },

    g136: async () => {
      const result = await getReportPromotions(tx, org, { period: "este_mes" }, h.now)
      const units = budgetLineUnitsSql({
        billingMode: sql`i.billing_mode`,
        sessionsPlanned: sql`i.sessions_planned`,
      })
      const [accepted] = await tx.execute<{ lines: number; cents: string }>(sql`
        select count(*)::int as lines, coalesce(sum(i.price_cents::bigint * ${units}), 0)::text as cents
        from treatment_budget b join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
          and i.option_id = ${budgetValueOptionSql({ id: sql`b.id`, organizationId: sql`b.organization_id` })}
          and i.promotion_id is not null and i.price_cents is not null
        where b.organization_id = ${org} and b.currency = ${currency} and b.status in ('aceptado', 'parcial') and i.decision = 'aceptado'
          and b.presented_at >= ${h.monthStart}::timestamptz and b.presented_at < ${nowIso}::timestamptz`)
      const [promoSales] = await tx.execute<{ cents: string; charges: number }>(sql`
        select coalesce(sum(a.amount_cents), 0)::text as cents, count(distinct c.id)::int as charges
        from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null and c.promotion_id is not null
        where a.organization_id = ${org} and a.voided_at is null and pay.currency = ${currency}
          and pay.paid_at >= ${h.monthStart}::timestamptz and pay.paid_at < ${nowIso}::timestamptz`)
      const best = [...result.promotions].sort((a, b) => b.collectedCents - a.collectedCents)
      return {
        respuesta: result.people
          ? `En octubre (${w.monthSoFar}), las ${howMany(result.people, "persona que usó", "personas que usaron")} una promoción pagaron desde entonces ${money(result.collectedCents)}: ${listOf(best.map((row) => ({ name: `«${row.name}»`, value: `${money(row.collectedCents)}, ${howMany(row.people, "persona", "personas")}` })))}.`
          : `En octubre (${w.monthSoFar}) nadie usó una promoción.`,
        criterio:
          "Reportes › Finanzas › Promociones del mes en curso (octubre): quienes usaron una promoción (presupuesto entregado o cobro con ella) y lo que pagaron desde que la usaron hasta hoy, cada persona una vez, sin anulados ni lo devuelto.",
        nota: `Si «vendido con promociones» es solo lo pagado en octubre de tratamientos cobrados con precio de promoción: ${money(Number(promoSales?.cents ?? 0))} (${howMany(promoSales?.charges ?? 0, "cobro", "cobros")}). Lo aceptado en presupuestos con precio de promoción en octubre: ${money(Number(accepted?.cents ?? 0))} en ${howMany(accepted?.lines ?? 0, "tratamiento", "tratamientos")}; el descuento frente a la tarifa, ${money(result.discountCents)}.`,
        datos: {
          promociones: result.promotions,
          personas: result.people,
          cobrado: result.collectedCents,
          cobrosConPromocion: promoSales ?? null,
          aceptadoConPromocion: accepted ?? null,
        },
      }
    },

    g137: async () => {
      const rows = await tx.execute<{
        title: string
        person: string
        stage: string
        cents: number | null
        ortho: boolean
      }>(sql`
        select o.title, pp.display_name as person, st.name as stage, o.amount_cents as cents,
          (concat_ws(' ', o.title, o.interest_text, s.name, sp.name) ~* '(ortodon|bracket|alineador)') as ortho
        from opportunity o
        join contact pp on pp.organization_id = o.organization_id and pp.id = o.contact_id
        join pipeline_stage st on st.organization_id = o.organization_id and st.id = o.stage_id
        left join service_catalog s on s.organization_id = o.organization_id and s.id = o.service_id
        left join org_specialty sp on sp.organization_id = s.organization_id and sp.id = s.specialty_id
        where o.organization_id = ${org} and o.status = 'open' and pp.screen is null
        order by st.position, o.created_at`)
      const ortho = rows.filter((row) => row.ortho)
      const cents = ortho.reduce((sum, row) => sum + (row.cents ?? 0), 0)
      return {
        respuesta: ortho.length
          ? `Hoy ${ortho.length === 1 ? "1 oportunidad abierta es" : `${ortho.length} oportunidades abiertas son`} de ortodoncia, de ${rows.length} abiertas: ${listOf(ortho.map((row) => ({ name: `${row.person} · ${row.title}`, value: `${row.stage}${row.cents !== null ? `, ${money(row.cents)}` : ", sin valor"}` })))}.`
          : `Hoy ninguna de tus ${rows.length} oportunidades abiertas es de ortodoncia.`,
        criterio:
          "Oportunidades abiertas a hoy cuyo título, interés, servicio o especialidad del servicio dice ortodoncia (o brackets, alineadores).",
        nota: ortho.length ? `Juntas suman ${money(cents)}.` : undefined,
        datos: { ortodoncia: ortho, abiertas: rows.length },
      }
    },

    g138: async () => {
      const byHour = (start: string) =>
        tx.execute<{ hour: number; messages: number; people: number }>(sql`
          select extract(hour from m.created_at at time zone ${h.tz})::int as hour, count(*)::int as messages, count(distinct c.contact_id)::int as people
          from message m
          join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
          join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id and cc.channel = 'whatsapp'
          where m.organization_id = ${org} and m.direction = 'in' and not ${screenedSql(sql.raw("c"))}
            and m.created_at >= ${start}::timestamptz and m.created_at < ${nowIso}::timestamptz
          group by 1 order by 2 desc, 3 desc, 1`)
      const month = [...(await byHour(h.monthStart))]
      const year = [...(await byHour(yearAgo.toISOString()))]
      const hourWords = (hour: number) =>
        `de ${String(hour).padStart(2, "0")}:00 a ${String(hour).padStart(2, "0")}:59`
      const total = month.reduce((sum, row) => sum + row.messages, 0)
      const top = month[0]
      const words = (rows: typeof month) =>
        listOf(
          rows.map((row) => ({
            name: hourWords(row.hour),
            value: howMany(row.messages, "mensaje", "mensajes"),
          })),
        )
      const byPeople = [...month].sort(
        (a, b) => b.people - a.people || b.messages - a.messages || a.hour - b.hour,
      )
      // Si varias horas empatan con el máximo, se dicen todas.
      const tied = month
        .filter((row) => row.messages === top?.messages)
        .sort((a, b) => a.hour - b.hour)
      const after = month.filter((row) => row.messages !== top?.messages).slice(0, 2)
      return {
        respuesta: top
          ? `${ThisMonth}, ${tied.length > 1 ? `las horas en que más nos escribe la gente por WhatsApp empatan: ${tied.map((row) => hourWords(row.hour)).join(" y ")}, con ${howMany(top.messages, "mensaje", "mensajes")} cada una` : `la hora en que más nos escribe la gente por WhatsApp es ${hourWords(top.hour)}: ${howMany(top.messages, "mensaje", "mensajes")}`}, de ${total} en el mes.${after.length ? ` Le siguen ${words(after)}.` : ""}`
          : `${ThisMonth} nadie nos escribió por WhatsApp.`,
        criterio:
          "Mensajes que la gente nos envió por WhatsApp en el mes en curso, por hora del día de la clínica; sin Spam ni bloqueados.",
        nota: `En los últimos 12 meses: ${words(year.slice(0, 3))}. Por personas distintas que escribieron (este mes): ${listOf(byPeople.slice(0, 3).map((row) => ({ name: hourWords(row.hour), value: howMany(row.people, "persona", "personas") })))}.`,
        datos: { mes: month, doceMeses: year.slice(0, 24) },
      }
    },

    g139: async () => {
      const august = await windowOf(monthKey(8))
      const name = w.monthWords(august.from)
      const rows = [...(await funnelBy(august))]
      const all = totalOf(rows)
      const notBooked = all.sought - all.booked
      return {
        respuesta: `De las ${all.sought} personas que nos escribieron o se registraron por primera vez en ${name}, ${notBooked} todavía no ${notBooked === 1 ? "agendó" : "agendan"} nada (${w.pct(notBooked, all.sought)}); ${all.booked} sí ${all.booked === 1 ? "sacó" : "sacaron"} una cita.`,
        criterio:
          "El embudo de Reportes de agosto (completo): personas cuyo primer contacto (conversación o registro) fue en el mes, menos las que agendaron hasta hoy una cita sin cancelar o ya vinieron; sin Spam ni bloqueados.",
        nota: `De las que no agendaron, ${all.stopped} dejaron de escribir (sin mensajes en más de 3 días y sin nada abierto con el equipo). Por canal, sin agendar: ${listOf(rows.filter((row) => row.sought > row.booked).map((row) => ({ name: channelWords(row.channel), value: `${row.sought - row.booked} de ${row.sought}` })))}.`,
        datos: { periodo: { start: august.start, end: august.end }, total: all, canales: rows },
      }
    },

    g140: async () => {
      const rows = [...(await conversationsIn(h.monthStart, nowIso))]
      const of = (channel: string) =>
        rows.find((row) => row.channel === channel) ?? {
          channel,
          wrote: 0,
          any: 0,
          started: 0,
          people: 0,
        }
      const wa = of("whatsapp")
      const web = of("webchat")
      const more =
        wa.wrote === web.wrote ? null : wa.wrote > web.wrote ? "WhatsApp" : "el chat de la web"
      return {
        respuesta: more
          ? `${ThisMonth} hubo más conversaciones por ${more}: ${wa.wrote} por WhatsApp y ${web.wrote} por el chat de la web.`
          : `${ThisMonth} hubo las mismas conversaciones por WhatsApp que por el chat de la web: ${wa.wrote}.`,
        criterio:
          "Conversaciones con al menos un mensaje de la persona en el mes en curso, por canal; sin Spam ni bloqueados.",
        nota: `Contando también las que solo tuvieron mensajes nuestros: WhatsApp ${wa.any}, chat web ${web.any}. Empezadas este mes: WhatsApp ${wa.started}, chat web ${web.started}. Todos los canales: ${listOf(rows.map((row) => ({ name: channelWords(row.channel), value: `${row.wrote}` })))}.`,
        datos: { porCanal: rows },
      }
    },

    g141: async () => {
      const { branches, found } = await bySede()
      const sede = sedeNamed(branches, /surco/i)
      if (!sede)
        return {
          respuesta: `No tienes una sede en Surco: tus sedes son ${branches.map((row) => row.name).join(", ")}.`,
          criterio: "La sede que nombra la pregunta no existe.",
          datos: { sedes: branches },
        }
      const here = found.filter((item) => item.branchId === sede.id)
      const short = here.filter((item) => item.needs)
      const empty = here.filter((item) => item.isActive && !item.needs && item.onHand <= 0)
      const words = listOf(
        short.map((row) => ({
          name: row.name,
          value:
            row.shortage > 0
              ? `se usaron o vendieron ${unitsWord(row.shortage, row.unit)} sin haber; mínimo ${row.minQuantity}`
              : `hay ${unitsWord(row.onHand, row.unit)}, mínimo ${row.minQuantity}`,
        })),
      )
      const active = here.filter((item) => item.isActive)
      const withMinimum = active.filter((item) => item.minQuantity > 0)
      return {
        respuesta: short.length
          ? `Hoy en ${sede.name} ${short.length === 1 ? "1 producto está" : `${short.length} productos están`} por debajo del mínimo: ${words}.${empty.length ? ` Sin mínimo puesto, tampoco hay nada de: ${empty.map((row) => row.name).join(", ")}.` : ""}`
          : withMinimum.length
            ? `Hoy en ${sede.name} ningún producto está por debajo de su mínimo.${empty.length ? ` Sin mínimo puesto, no hay nada de: ${empty.map((row) => row.name).join(", ")}.` : ""}`
            : `Hoy en ${sede.name} ningún producto tiene un mínimo puesto, así que ninguno figura por debajo de él; pero ${empty.length === active.length ? `no hay existencias de ninguno de tus ${active.length} productos activos` : `no hay nada de: ${empty.map((row) => row.name).join(", ")}`}.`,
        criterio:
          "«Hacen falta» de Inventario en la sede, a hoy: productos activos por debajo de su mínimo o usados sin haber (faltante), en su unidad de uso.",
        nota:
          !short.length && !withMinimum.length
            ? "Sin mínimos, Inventario no avisa de lo que falta en esta sede: se ponen en cada producto, por sede."
            : undefined,
        datos: {
          sede: sede.name,
          hacenFalta: short.map((row) => ({
            name: row.name,
            onHand: row.onHand,
            min: row.minQuantity,
            shortage: row.shortage,
            state: row.state,
          })),
          sinNadaSinMinimo: empty.map((row) => row.name),
        },
      }
    },

    g142: async () => {
      const all = [...(await lots())]
      const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
      const monthFirst = `${w.todayKey.slice(0, 7)}-01`
      const coming = all.filter(
        (row) => row.expires && row.expires >= w.todayKey && row.expires <= monthEnd,
      )
      const expiredThisMonth = all.filter(
        (row) => row.expires && row.expires >= monthFirst && row.expires < w.todayKey,
      )
      const expiredBefore = all.filter((row) => row.expires && row.expires < monthFirst)
      const next = all.filter((row) => row.expires && row.expires > monthEnd).slice(0, 3)
      const horizon = w.addDays(w.todayKey, 30)
      const in30 = all.filter(
        (row) => row.expires && row.expires >= w.todayKey && row.expires <= horizon,
      )
      const rest = `lo que queda de ${w.monthWords({ year, month }).replace(/ de \d+$/, "")} (${spanWords(w.todayKey, monthEnd)})`
      return {
        respuesta: `${coming.length ? `Sí: en ${rest} vence${coming.length === 1 ? "" : "n"} ${lotWords(coming)}.` : `En ${rest} no vence ningún lote con existencias.`}${expiredThisMonth.length ? ` Pero ya venció este mes y sigue en el almacén: ${lotWords(expiredThisMonth)}.` : ""}${!coming.length && next.length ? ` Lo próximo en vencer: ${lotWords(next.slice(0, 1))}.` : ""}`,
        criterio:
          "Lotes con existencias, a hoy, que vencen entre hoy y el último día del mes; lo que ya venció este mes y sigue en el almacén, aparte.",
        nota: `«Por vencer» de Inventario (los próximos 30 días): ${in30.length ? lotWords(in30) : "nada"}.${expiredBefore.length ? ` Vencido antes de este mes y aún en el almacén: ${lotWords(expiredBefore)}.` : ""}`,
        datos: {
          vencenEsteMes: coming,
          vencidoEsteMes: expiredThisMonth,
          vencidoAntes: expiredBefore,
          treintaDias: in30,
          siguientes: next,
        },
      }
    },

    g143: async () => {
      const all = [...(await lots())]
      const anesthesia = /anest|lidoca|artica|mepiva|priloca|bupiva/i
      const ofAnesthesia = all.filter((row) => anesthesia.test(row.product))
      const december = `${month === 12 ? year + 1 : year}-12-01`
      const expired = ofAnesthesia.filter((row) => row.expires && row.expires < w.todayKey)
      const before = ofAnesthesia.filter(
        (row) => row.expires && row.expires >= w.todayKey && row.expires < december,
      )
      const later = ofAnesthesia.filter((row) => !row.expires || row.expires >= december)
      const deadline = dateWords(w.addDays(december, -1))
      return {
        respuesta: ofAnesthesia.length
          ? `${before.length ? `Antes de diciembre vence${before.length === 1 ? "" : "n"} ${lotWords(before)}.` : `Ningún lote de anestesia con existencias vence de hoy al ${deadline}.`}${expired.length ? ` Pero hay ${expired.length === 1 ? "un lote ya vencido" : `${expired.length} lotes ya vencidos`} que sigue${expired.length === 1 ? "" : "n"} en el almacén: ${lotWords(expired)}.` : ""}`
          : "No tienes lotes de anestesia con existencias.",
        criterio:
          "Lotes con existencias, a hoy, de productos de anestesia (lidocaína, articaína, mepivacaína…), con vencimiento antes del 1 de diciembre; lo ya vencido que sigue en el almacén, aparte.",
        nota: later.length
          ? `Los demás lotes de anestesia vencen después: ${lotWords(later)}.`
          : undefined,
        datos: { antesDeDiciembre: before, vencidos: expired, despues: later },
      }
    },

    g144: async () => {
      const { branches, found } = await bySede()
      const sede = sedeNamed(branches, /miraflores/i)
      const gloves = found.filter((item) => /guante/i.test(item.name))
      const here = gloves.filter((item) => item.branchId === sede?.id)
      if (!sede)
        return {
          respuesta: `No tienes una sede en Miraflores: tus sedes son ${branches.map((row) => row.name).join(", ")}.`,
          criterio: "La sede que nombra la pregunta no existe.",
          datos: { sedes: branches },
        }
      /** «57 cajas de guantes de nitrilo (de 100 cada una) y 64 guantes sueltos: 5,764 guantes en total». */
      const plural = (count: number, unit: string) =>
        unitsWord(count, unit).replace(/^-?\d+/, num(count))
      const boxes = (item: ProductListItem) => {
        const factor = item.purchaseFactor > 1 ? item.purchaseFactor : null
        if (item.onHand <= 0)
          return `no queda nada de ${item.name}${item.onHand < 0 ? `: se usaron ${plural(-item.onHand, item.unit)} sin haber` : ""}`
        if (!factor || !item.purchaseUnit)
          return `${plural(item.onHand, item.unit)} de ${item.name}`
        const whole = Math.floor(item.onHand / factor)
        const loose = item.onHand - whole * factor
        return `${plural(whole, item.purchaseUnit)} de ${item.name} (de ${factor} cada una)${loose ? ` y ${plural(loose, item.unit)} suelto${loose === 1 ? "" : "s"}` : ""}: ${plural(item.onHand, item.unit)} en total`
      }
      const boxMinimum = (item: ProductListItem) =>
        `${plural(item.minQuantity, item.unit)}${item.purchaseFactor > 1 && item.purchaseUnit ? ` (${plural(Math.ceil(item.minQuantity / item.purchaseFactor), item.purchaseUnit)})` : ""}`
      return {
        respuesta: here.length
          ? `Hoy en ${sede.name} quedan ${here.map((item) => boxes(item)).join("; ")}.${
              here.some((item) => item.minQuantity > 0)
                ? ` El mínimo de la sede es ${here
                    .filter((item) => item.minQuantity > 0)
                    .map((item) => boxMinimum(item))
                    .join(", ")}.`
                : ""
            }`
          : `En ${sede.name} no hay guantes registrados en Inventario.`,
        criterio:
          "Lo que hay hoy en la sede (lotes − faltante, como Inventario), en la unidad de uso, pasado a cajas con el factor de compra del producto.",
        nota: `En las otras sedes: ${listOf(
          gloves
            .filter((item) => item.branchId !== sede.id)
            .map((item) => ({
              name: item.branch,
              value:
                item.onHand > 0 && item.purchaseFactor > 1 && item.purchaseUnit
                  ? `${plural(item.onHand, item.unit)}, ${plural(Math.floor(item.onHand / item.purchaseFactor), item.purchaseUnit)} y ${item.onHand % item.purchaseFactor} sueltos`
                  : item.onHand > 0
                    ? plural(item.onHand, item.unit)
                    : "no queda nada",
            })),
        )}.`,
        datos: {
          sede: sede.name,
          guantes: here.map((item) => ({
            name: item.name,
            onHand: item.onHand,
            unit: item.unit,
            purchaseUnit: item.purchaseUnit,
            factor: item.purchaseFactor,
            min: item.minQuantity,
          })),
          otras: gloves
            .filter((item) => item.branchId !== sede.id)
            .map((item) => ({ branch: item.branch, onHand: item.onHand })),
        },
      }
    },

    g145: async () => {
      const sept = await windowOf(monthKey(9))
      const name = w.monthWords(sept.from)
      const rows = (
        await consumedBy(sept.start.toISOString(), sept.end.toISOString(), "consumo")
      ).filter((row) => /resina/i.test(row.name))
      const used = (
        await consumedBy(sept.start.toISOString(), sept.end.toISOString(), "como_inventario")
      ).filter((row) => /resina/i.test(row.name))
      const units = rows.reduce((sum, row) => sum + row.units, 0)
      const usedUnits = used.reduce((sum, row) => sum + row.units, 0)
      const unit = rows[0]?.unit ?? used[0]?.unit ?? "unidad"
      const products = [...new Set(rows.map((row) => row.name))]
      const resinProducts = await tx.execute<{ name: string; unit: string }>(sql`
        select name, unit from product where organization_id = ${org} and name ~* 'resina' order by name`)
      // Los tratamientos con resina firmados ese mes y si lo que tienen configurado descuenta un producto de resina.
      const done = await tx.execute<{ name: string; times: number; resin: boolean }>(sql`
        select s.name, sum(ep.quantity)::int as times,
          exists (select 1 from service_material sm join product pr on pr.organization_id = sm.organization_id and pr.id = sm.product_id
            where sm.organization_id = s.organization_id and sm.service_id = s.id and pr.name ~* 'resina') as resin
        from encounter_procedure ep
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
        join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
        where ep.organization_id = ${org} and ep.voided_at is null and s.name ~* 'resina'
          and e.finalized_at >= ${sept.start.toISOString()}::timestamptz and e.finalized_at < ${sept.end.toISOString()}::timestamptz
        group by s.id, s.name, s.organization_id order by 2 desc, 1`)
      const resinNames =
        resinProducts.map((row) => row.name).join(", ") || "ningún producto de resina"
      return {
        respuesta: units
          ? `En ${name}, sumando las tres sedes, se usaron ${unitsWord(units, unit)} de resina (${products.join(", ")}): ${listOf(rows.map((row) => ({ name: row.branch, value: unitsWord(row.units, row.unit) })))}.`
          : `En ${name} no se descontó nada de resina (${resinNames}) de Inventario en ninguna de las sedes: 0 ${resinProducts[0] ? unitsWord(2, resinProducts[0].unit).replace(/^2 /, "") : "unidades"}.`,
        criterio:
          "Movimientos de consumo de Inventario (atenciones y usos sin atención) de los productos de resina en septiembre, en su unidad de uso, por sede y sumados.",
        nota: `${usedUnits !== units ? `Contando todo lo que salió como «Usado» de Inventario (también ventas y correcciones de una atención): ${unitsWord(usedUnits, unit)}. ` : ""}${done.length ? `Ese mes sí se firmaron tratamientos con resina: ${listOf(done.map((row) => ({ name: row.name, value: `${row.times}${row.resin ? "" : ", su configuración no descuenta resina"}` })))}; lo que se descuenta sale de los insumos configurados en cada servicio.` : "Ese mes no se firmó ningún tratamiento con resina."}`,
        datos: {
          periodo: { start: sept.start, end: sept.end },
          consumo: rows,
          usadoComoInventario: used,
          tratamientosConResina: done,
        },
      }
    },

    g146: async () => {
      const yearStart = new Date(await dayStart(h, `${year}-01-01`))
      const orders = (await purchaseBalances(tx, org, { currency })).filter(
        (row) =>
          row.createdAt >= yearStart &&
          row.createdAt < h.now &&
          row.status !== "borrador" &&
          row.status !== "cancelada",
      )
      const bySupplier = new Map<
        string,
        { name: string; orders: number; ordered: number; received: number; paid: number }
      >()
      for (const row of orders) {
        const entry = bySupplier.get(row.supplierId) ?? {
          name: row.supplierName,
          orders: 0,
          ordered: 0,
          received: 0,
          paid: 0,
        }
        entry.orders += 1
        entry.ordered += row.orderedCents
        entry.received += row.receivedCents
        entry.paid += row.paidCents
        bySupplier.set(row.supplierId, entry)
      }
      const ranked = [...bySupplier.values()].sort(
        (a, b) => b.ordered - a.ordered || a.name.localeCompare(b.name),
      )
      const byReceived = [...ranked].sort(
        (a, b) => b.received - a.received || a.name.localeCompare(b.name),
      )
      const byPaid = [...ranked].sort((a, b) => b.paid - a.paid || a.name.localeCompare(b.name))
      const top = ranked[0]
      return {
        respuesta: top
          ? `Este año (desde el 1 de enero) a quien más le compraste es ${top.name}: ${money(top.ordered)} en ${howMany(top.orders, "compra", "compras")}. Le siguen ${listOf(ranked.slice(1, 4).map((row) => ({ name: row.name, value: `${money(row.ordered)}, ${howMany(row.orders, "compra", "compras")}` })))}.`
          : "Este año no hay compras a proveedores.",
        criterio:
          "Compras de Inventario hechas este año (sin borradores ni canceladas), por proveedor: lo pedido por su costo, en la moneda de la clínica.",
        nota: `Por lo que ya llegó: ${listOf(byReceived.slice(0, 3).map((row) => ({ name: row.name, value: money(row.received) })))}. Por lo pagado: ${listOf(byPaid.slice(0, 3).map((row) => ({ name: row.name, value: money(row.paid) })))}.`,
        datos: { proveedores: ranked },
      }
    },

    g147: async () => {
      const monthStart = new Date(h.monthStart)
      const all = (await purchaseBalances(tx, org, { currency })).filter(
        (row) => row.createdAt >= monthStart && row.createdAt < h.now,
      )
      const made = all
        .filter((row) => row.status !== "borrador" && row.status !== "cancelada")
        .sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.orderNumber - b.orderNumber,
        )
      const others = all.filter((row) => row.status === "borrador" || row.status === "cancelada")
      const day = (date: Date) =>
        new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: h.tz }).format(
          date,
        )
      const total = made.reduce((sum, row) => sum + row.orderedCents, 0)
      return {
        respuesta: made.length
          ? `${ThisMonth} se hicieron ${howMany(made.length, "compra", "compras")} por ${money(total)}: ${made
              .map(
                (row) =>
                  `${purchaseOrderLabel(row.orderNumber)} a ${row.supplierName}, ${money(row.orderedCents)} (${day(row.createdAt)}, ${(PURCHASE_STATUS_WORDS[row.status] ?? row.status).toLowerCase()})`,
              )
              .join("; ")}.`
          : `${ThisMonth} no se hizo ninguna compra.`,
        criterio:
          "Compras de Inventario creadas en el mes en curso, sin borradores ni canceladas: número, proveedor, lo pedido por su costo, el día y su estado.",
        nota: others.length
          ? `Además hay ${listOf(others.map((row) => ({ name: `${purchaseOrderLabel(row.orderNumber)} a ${row.supplierName}`, value: `${(PURCHASE_STATUS_WORDS[row.status] ?? row.status).toLowerCase()}, ${money(row.orderedCents)}` })))}. De lo pedido este mes ya llegó ${money(made.reduce((sum, row) => sum + row.receivedCents, 0))}.`
          : `De lo pedido este mes ya llegó ${money(made.reduce((sum, row) => sum + row.receivedCents, 0))}.`,
        datos: {
          compras: made.map((row) => ({
            numero: purchaseOrderLabel(row.orderNumber),
            proveedor: row.supplierName,
            estado: row.status,
            pedido: row.orderedCents,
            recibido: row.receivedCents,
            pagado: row.paidCents,
            sede: row.branchName,
          })),
          otras: others.map((row) => ({
            numero: purchaseOrderLabel(row.orderNumber),
            estado: row.status,
          })),
        },
      }
    },

    g148: async () => {
      const { found } = await bySede()
      const expired = found.filter((item) => item.expired)
      const all = [...(await lots())].filter((row) => row.expires && row.expires < w.todayKey)
      return {
        respuesta: all.length
          ? `Sí: hoy hay ${howMany(all.length, "lote vencido", "lotes vencidos")} en el almacén: ${listOf(all.map((row) => ({ name: `${row.product} en ${row.branch}${row.code ? `, lote ${row.code}` : ""}`, value: `${unitsWord(row.quantity, row.unit)}, venció el ${dateWords(row.expires ?? "")}` })))}. Conviene retirarlo${all.length === 1 ? "" : "s"}.`
          : "No: hoy no queda ningún lote vencido en las sedes.",
        criterio:
          "Lotes con existencias y fecha de vencimiento anterior a hoy, en cada sede (los que Inventario marca «vencido»).",
        nota: expired.length
          ? `Cuentan en lo que hay: ${listOf(expired.map((item) => ({ name: `${item.name} en ${item.branch}`, value: `${unitsWord(item.expired?.quantity ?? 0, item.unit)} vencidos de ${item.onHand}` })))}.`
          : undefined,
        datos: {
          lotes: all,
          productos: expired.map((item) => ({
            name: item.name,
            branch: item.branch,
            expired: item.expired,
            onHand: item.onHand,
          })),
        },
      }
    },

    g149: async () => {
      const inEndo = (start: string) =>
        tx.execute<{ name: string; unit: string; units: number; encounters: number }>(sql`
          select pr.name, pr.unit, sum(-m.quantity_delta)::int as units, count(distinct m.encounter_id)::int as encounters
          from stock_movement m join product pr on pr.organization_id = m.organization_id and pr.id = m.product_id
          where m.organization_id = ${org} and m.kind = 'consumo' and m.encounter_id is not null
            and m.created_at >= ${start}::timestamptz and m.created_at < ${nowIso}::timestamptz
            and exists (select 1 from encounter_procedure ep join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
              where ep.organization_id = m.organization_id and ep.encounter_id = m.encounter_id and ep.voided_at is null and s.name ~* 'endodon')
          group by 1, 2 order by 3 desc, 1`)
      const encountersIn = async (start: string) => {
        const [row] = await tx.execute<{ count: number }>(sql`
          select count(distinct m.encounter_id)::int as count from stock_movement m
          where m.organization_id = ${org} and m.kind = 'consumo' and m.created_at >= ${start}::timestamptz and m.created_at < ${nowIso}::timestamptz
            and exists (select 1 from encounter_procedure ep join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
              where ep.organization_id = m.organization_id and ep.encounter_id = m.encounter_id and ep.voided_at is null and s.name ~* 'endodon')`)
        return row?.count ?? 0
      }
      const month = [...(await inEndo(h.monthStart))]
      const yearRows = [...(await inEndo(yearAgo.toISOString()))]
      const monthEncounters = await encountersIn(h.monthStart)
      const yearEncounters = await encountersIn(yearAgo.toISOString())
      const configured = await tx.execute<{
        service: string
        name: string
        unit: string
        quantity: number
      }>(sql`
        select s.name as service, pr.name, pr.unit, sm.quantity from service_material sm
        join service_catalog s on s.organization_id = sm.organization_id and s.id = sm.service_id
        join product pr on pr.organization_id = sm.organization_id and pr.id = sm.product_id
        where sm.organization_id = ${org} and s.name ~* 'endodon' order by s.name, sm.quantity desc, pr.name`)
      const words = (rows: typeof month) =>
        listOf(rows.map((row) => ({ name: row.name, value: unitsWord(row.units, row.unit) })))
      const services = [...new Set(configured.map((row) => row.service))]
      const configuredWords = services
        .map(
          (service) =>
            `${service}: ${configured
              .filter((row) => row.service === service)
              .map((row) => `${row.name} (${unitsWord(row.quantity, row.unit)})`)
              .join(" y ")}`,
        )
        .join("; ")
      return {
        respuesta: month.length
          ? `${ThisMonth}, en las ${howMany(monthEncounters, "atención con endodoncia", "atenciones con endodoncia")} ${month.length <= 3 ? `solo se usaron ${howMany(month.length, "insumo", "insumos")}` : "los insumos que más se usaron son"}: ${words(month)}.`
          : `${ThisMonth} no se descontó ningún insumo en atenciones con endodoncia.`,
        criterio:
          "Movimientos de consumo de Inventario de las atenciones del mes en curso que tuvieron una endodoncia (el consumo se registra por atención, no por procedimiento), por producto y en su unidad de uso.",
        nota: `En los últimos 12 meses (${howMany(yearEncounters, "atención", "atenciones")}): ${words(yearRows) || "nada"}. Lo que la clínica dejó configurado que usa cada una: ${configuredWords || "nada"}.`,
        datos: {
          mes: month,
          atencionesMes: monthEncounters,
          doceMeses: yearRows,
          atencionesDoceMeses: yearEncounters,
          configurado: configured,
        },
      }
    },

    g150: async () => {
      const { branches, found } = await bySede()
      const sede = sedeNamed(branches, /isidro/i)
      const electric = found.filter(
        (item) => /cepillo/i.test(item.name) && /el[eé]ctric/i.test(item.name),
      )
      const brushes = found.filter((item) => /cepillo/i.test(item.name) && item.forSale)
      const brushNames = [...new Set(brushes.map((item) => item.name))]
      const here = (list: typeof found) => list.filter((item) => item.branchId === sede?.id)
      const stockWords = (item: ProductListItem) =>
        item.onHand < 0
          ? `ninguno: se vendieron o usaron ${unitsWord(-item.onHand, item.unit)} sin haber`
          : item.onHand === 0
            ? "ninguno"
            : unitsWord(item.onHand, item.unit)
      if (!sede)
        return {
          respuesta: `No tienes una sede en San Isidro: tus sedes son ${branches.map((row) => row.name).join(", ")}.`,
          criterio: "La sede que nombra la pregunta no existe.",
          datos: { sedes: branches },
        }
      if (electric.length) {
        return {
          respuesta: `Hoy en ${sede.name} quedan para vender ${listOf(here(electric).map((item) => ({ name: item.name, value: stockWords(item) })))}.`,
          criterio:
            "Lo que hay hoy en la sede (lotes − faltante, como Inventario) de los cepillos eléctricos a la venta.",
          datos: {
            cepillos: here(electric).map((item) => ({ name: item.name, onHand: item.onHand })),
          },
        }
      }
      const brushHere = here(brushes)
      return {
        respuesta: `No vendes cepillos eléctricos: no hay ningún cepillo eléctrico en Inventario.${brushNames.length ? ` El cepillo que tienes a la venta es ${brushNames.join(", ")}: en ${sede.name} ${brushHere.length && brushHere.some((item) => item.onHand > 0) ? `quedan ${brushHere.map((item) => stockWords(item)).join(", ")}` : "no queda ninguno"}.` : ""}`,
        criterio:
          "Productos de Inventario: ninguno es un cepillo eléctrico. Se ofrece lo que hay hoy en la sede del cepillo que sí se vende (lotes − faltante, como Inventario).",
        nota: brushes.length
          ? `En las otras sedes: ${listOf(brushes.filter((item) => item.branchId !== sede.id).map((item) => ({ name: item.branch, value: stockWords(item) }))) || "no hay"}.`
          : undefined,
        datos: {
          cepillosElectricos: 0,
          cepillos: brushes.map((item) => ({
            name: item.name,
            branch: item.branch,
            onHand: item.onHand,
            shortage: item.shortage,
            min: item.minQuantity,
          })),
        },
      }
    },
  }
}

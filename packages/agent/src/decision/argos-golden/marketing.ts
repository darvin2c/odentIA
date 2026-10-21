/**
 * Respuestas correctas del marketing (eval/argos-owner.json). De dónde viene
 * un paciente tiene dos lecturas: «Cómo nos conoció» del registro y el canal
 * por el que nos buscó por primera vez (el embudo de Reportes). odentIA no
 * registra campañas, gasto en publicidad ni costo de adquisición: esas
 * preguntas son trampas y se responden con lo más cercano y su cifra.
 */
import { channelWords, firstContactSql, funnelMany, funnelSql, getReportPromotions } from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"

const DAY_MS = 86_400_000

/** «Cómo nos conoció» con las palabras de Reportes (`REFERRAL_KIND_LABELS`). */
const REFERRAL_WORDS: Record<string, string> = {
  recomendacion: "Recomendación de alguien",
  redes_sociales: "Redes sociales",
  google_mapas: "Google o mapas",
  paso_por_aqui: "Pasaba por aquí",
  convenio: "Convenio o empresa",
  otro: "Otro",
}
const referralWords = (kind: string | null): string => (kind ? (REFERRAL_WORDS[kind] ?? kind) : "No lo dijeron")

export function marketingSolvers(h: GoldenHelpers): GoldenSolvers {
  const { tx, org } = h
  const { locale, currency } = h.scope
  const nowIso = h.now.toISOString()
  const monthStart = h.monthStart
  const yearAgo = new Date(h.now.getTime() - 365 * DAY_MS).toISOString()
  const pct = (part: number, total: number): string => (total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato")
  const monthName = (month: { year: number; month: number }): string =>
    new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(month.year, month.month - 1, 15)))
  const thisMonth = `este mes (${monthName(h.scope.window.from)}, hasta hoy)`
  const ThisMonth = `${thisMonth.charAt(0).toUpperCase()}${thisMonth.slice(1)}`
  /** Pacientes nuevos (primera cita atendida) sin Spam ni bloqueados: `fresh(patient_id, starts_at, kind)`. */
  const fresh = (from: string) => sql`first_visit as (
      select distinct on (a.patient_id) a.patient_id, a.starts_at, a.id from appointment a
      join patient p on p.organization_id = ${org} and p.id = a.patient_id
      join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.screen is null
      where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz
      order by a.patient_id, a.starts_at, a.id
    ), fresh as (
      select v.patient_id, v.starts_at, p.referral_kind as kind from first_visit v
      join patient p on p.organization_id = ${org} and p.id = v.patient_id
      where v.starts_at >= ${from}::timestamptz)`
  /** Lo que pagó un paciente desde `from` hasta ahora: pagos vigentes menos lo devuelto, en la moneda de la clínica. */
  const paidSince = (patientColumn: SQL, from: SQL) => sql`(
    coalesce((select sum(pay.amount_cents) from patient_payment pay where pay.organization_id = ${org} and pay.patient_id = ${patientColumn}
      and pay.currency = ${currency} and pay.voided_at is null and pay.paid_at >= ${from} and pay.paid_at < ${nowIso}::timestamptz), 0)
    - coalesce((select sum(r.amount_cents) from patient_payment_refund r
        join patient_payment pay on pay.organization_id = r.organization_id and pay.id = r.payment_id and pay.voided_at is null and pay.currency = ${currency}
        where r.organization_id = ${org} and r.patient_id = ${patientColumn} and r.refunded_at >= ${from} and r.refunded_at < ${nowIso}::timestamptz), 0))`
  /** Pacientes nuevos desde `from`, por «Cómo nos conoció». */
  const referralSince = (from: string) =>
    tx.execute<{ kind: string | null; patients: number }>(sql`
      with ${fresh(from)} select kind, count(*)::int as patients from fresh group by 1 order by 2 desc, 1`)
  const referralList = (rows: Array<{ kind: string | null; patients: number }>, count = 6) => {
    const total = rows.reduce((sum, row) => sum + row.patients, 0)
    return h.listOf(rows.slice(0, count).map((row) => ({ name: referralWords(row.kind), value: `${row.patients}, ${pct(row.patients, total)}` })))
  }
  const yearSpan = { start: new Date(yearAgo), end: h.now }

  return {
    m1: async () => {
      const result = await h.fig("como_nos_conocieron")
      const total = result.total.value ?? 0
      const channels = await h.fig("nos_buscaron", "canal")
      const year = await referralSince(yearAgo)
      return {
        respuesta: `${ThisMonth} tus ${total} pacientes nuevos llegaron por ${h.listOf(result.rows.map((row) => ({ name: row.label, value: `${row.value.value ?? 0}, ${pct(row.value.value ?? 0, total)}` })))}.`,
        criterio: "«Cómo nos conocieron» de Reportes › Pacientes: lo que eligió en el registro cada paciente nuevo del mes (su primera cita atendida en el mes).",
        nota: `Por el canal por el que nos buscaron por primera vez este mes (y cuántos ya vinieron): ${h.listOf(channels.rows.map((row) => ({ name: row.label, value: `${row.value.value ?? 0}, ${row.value.part ?? 0} vinieron` })))}. En los últimos 12 meses, por cómo nos conocieron: ${referralList(year)}.`,
        datos: { mes: result.rows, canales: channels.rows, doceMeses: year },
      }
    },

    m2: async () => {
      const channels = await h.fig("nos_buscaron", "canal")
      const instagram = channels.rows.find((row) => row.key === "instagram")
      const referral = await h.fig("como_nos_conocieron")
      const social = referral.rows.find((row) => row.key === "redes_sociales")
      const [year] = await funnelMany(tx, org, [yearSpan], h.now)
      const yearInstagram = year?.channels.find((row) => row.channel === "instagram")
      const yearReferral = await referralSince(yearAgo)
      const yearSocial = yearReferral.find((row) => row.kind === "redes_sociales")?.patients ?? 0
      const sought = instagram?.value.value ?? 0
      const came = instagram?.value.part ?? 0
      return {
        respuesta: `${ThisMonth}, ${sought} personas nos escribieron por primera vez por Instagram y ${came} de ellas ya vinieron a atenderse (${pct(came, sought)}).`,
        criterio: "El embudo de Reportes › Pacientes por canal: personas cuyo primer contacto fue una conversación de Instagram en el mes y cuántas tuvieron una cita atendida o una atención firmada, hasta hoy.",
        nota: `Por «Cómo nos conoció» = Redes sociales (Instagram y otras redes, sin separar): ${social?.value.value ?? 0} pacientes nuevos este mes. En los últimos 12 meses: por Instagram nos escribieron por primera vez ${yearInstagram?.sought ?? 0} personas y vinieron ${yearInstagram?.came ?? 0}; por Redes sociales llegaron ${yearSocial} pacientes nuevos.`,
        datos: { mes: instagram ?? null, canales: channels.rows, redesSocialesMes: social ?? null, doceMeses: { instagram: yearInstagram ?? null, redesSociales: yearSocial } },
      }
    },

    m3: async () => {
      const value = (by: "kind" | "channel") =>
        tx.execute<{ key: string | null; patients: number; average: number | null; total: string }>(sql`
          with ${firstContactSql(org)}, ${fresh(yearAgo)}, tagged as (
            select f.patient_id, f.kind, (select k.channel from first_contact k where k.patient_id = f.patient_id order by k.first_at limit 1) as channel
            from fresh f)
          select ${by === "kind" ? sql`kind` : sql`channel`} as key, count(*)::int as patients,
            avg(${paidSince(sql`tagged.patient_id`, sql`'-infinity'::timestamptz`)})::float as average,
            sum(${paidSince(sql`tagged.patient_id`, sql`'-infinity'::timestamptz`)})::text as total
          from tagged group by 1 order by 3 desc nulls last, 1`)
      const byKind = await value("kind")
      const byChannel = await value("channel")
      const byTotal = [...byKind].sort((a, b) => Number(b.total) - Number(a.total))
      const words = (rows: typeof byKind, name: (key: string | null) => string) =>
        h.listOf(rows.slice(0, 4).map((row) => ({ name: name(row.key), value: `${h.money(Math.round(row.average ?? 0))} por paciente, ${row.patients} pacientes` })))
      return {
        respuesta: `En los últimos 12 meses, los pacientes nuevos que más pagan en promedio llegaron por ${words(byKind, referralWords)}.`,
        criterio: "Pacientes nuevos de los últimos 365 días (primera cita atendida, sin Spam ni bloqueados) por «Cómo nos conoció»: lo que pagó cada uno hasta hoy, sin anulados ni lo devuelto, en promedio.",
        nota: `Por el canal por el que nos buscaron por primera vez: ${words(byChannel, channelWords)}. Por lo pagado en total (no por paciente): ${h.listOf(byTotal.slice(0, 3).map((row) => ({ name: referralWords(row.key), value: h.money(Number(row.total)) })))}.`,
        datos: { comoNosConocio: byKind, canal: byChannel },
      }
    },

    m4: async () => {
      const result = await h.fig("como_nos_conocieron")
      const total = result.total.value ?? 0
      const channels = await h.fig("nos_buscaron", "canal")
      return {
        respuesta: `No lo sé: odentIA no registra lo que gastas en publicidad, así que no puede calcular el costo de adquirir un paciente. Lo que sí tengo: ${thisMonth} llegaron ${total} pacientes nuevos, por ${h.listOf(result.rows.slice(0, 4).map((row) => ({ name: row.label, value: `${row.value.value ?? 0}` })))}. Si me dices cuánto invertiste, se divide entre esos ${total}.`,
        criterio: "Trampa: sin gasto de publicidad no hay costo por paciente. Se ofrecen los pacientes nuevos del mes por «Cómo nos conocieron».",
        nota: `Por canal del primer contacto este mes (nos buscaron / vinieron): ${h.listOf(channels.rows.map((row) => ({ name: row.label, value: `${row.value.value ?? 0} / ${row.value.part ?? 0}` })))}.`,
        datos: { nuevos: total, comoNosConocieron: result.rows, canales: channels.rows },
      }
    },

    m5: async () => {
      const promotions = await getReportPromotions(tx, org, { period: "este_mes" }, h.now)
      const referral = await h.fig("como_nos_conocieron")
      const booked = await tx.execute<{ channel: string | null; sought: number; booked: number }>(sql`
        ${funnelSql(org, h.scope.window, h.now)}
        select f.channel, count(*)::int as sought, count(*) filter (where f.booked)::int as booked from funnel f
        group by 1 order by 3 desc, 2 desc, 1`)
      const top = referral.rows[0]
      return {
        respuesta: `odentIA no registra campañas, así que no sé cuál generó más citas. Lo más parecido: ${thisMonth} las promociones las usaron ${h.listOf(promotions.promotions.slice(0, 3).map((row) => ({ name: row.name, value: `${row.people} ${row.people === 1 ? "persona" : "personas"}, ${row.fresh} nuevas` })))}; y los pacientes nuevos llegaron sobre todo por ${top ? `${top.label} (${top.value.value ?? 0} de ${referral.total.value ?? 0})` : "—"}.`,
        criterio: "Trampa: sin campañas. Se ofrecen las promociones usadas en el mes (Reportes › Finanzas) y «Cómo nos conocieron».",
        nota: `Por el canal del primer contacto, quienes nos buscaron este mes y agendaron una cita: ${h.listOf(booked.map((row) => ({ name: channelWords(row.channel), value: `${row.booked} de ${row.sought}` })))}.`,
        datos: { promociones: promotions.promotions, comoNosConocieron: referral.rows, agendaronPorCanal: booked },
      }
    },

    m6: async () => {
      const [month] = await funnelMany(tx, org, [h.scope.window], h.now)
      const last = await h.fig("nos_buscaron", "total", "mes_pasado")
      const sought = month?.counts.sought ?? 0
      const came = month?.counts.came ?? 0
      const booked = month?.counts.booked ?? 0
      const wrote = (month?.channels ?? []).filter((row) => row.channel !== "recepcion" && row.channel !== "registro_en_linea")
      const wroteSought = wrote.reduce((sum, row) => sum + row.sought, 0)
      const wroteCame = wrote.reduce((sum, row) => sum + row.came, 0)
      return {
        respuesta: `${ThisMonth}, de las ${sought} personas que nos buscaron por primera vez, ${came} ya vinieron a atenderse: el ${pct(came, sought)}. El mes todavía corre: en ${monthName(h.scope.window.previous.from)}, completo, fue el ${pct(last.total.part ?? 0, last.total.value ?? 0)} (${last.total.part ?? 0} de ${last.total.value ?? 0}).`,
        criterio: "El embudo de Reportes › Pacientes: personas cuyo primer contacto (conversación o registro) fue en el mes y cuántas tuvieron una cita atendida o una atención firmada, hasta hoy.",
        nota: `Contando a quien agendó aunque aún no venga: ${booked} de ${sought} (${pct(booked, sought)}). Solo quienes escribieron por un canal (sin los registrados en recepción o en línea): ${wroteCame} de ${wroteSought} (${pct(wroteCame, wroteSought)}). Si «consulta» es la primera visita: de los ${came} que vinieron, ${month?.counts.accepted ?? 0} aceptaron un presupuesto (${pct(month?.counts.accepted ?? 0, came)}).`,
        datos: { mes: month?.counts, canales: month?.channels, mesPasado: last.total },
      }
    },

    m7: async () => {
      const promotions = await getReportPromotions(tx, org, { period: "este_mes" }, h.now)
      const collected = await h.fig("cobrado")
      const paid = await tx.execute<{ kind: string | null; patients: number; cents: string }>(sql`
        with ${fresh(monthStart)}
        select kind, count(*)::int as patients, sum(${paidSince(sql`fresh.patient_id`, sql`${monthStart}::timestamptz`)})::text as cents
        from fresh group by 1`)
      paid.sort((a, b) => Number(b.cents) - Number(a.cents))
      const freshTotal = paid.reduce((sum, row) => sum + Number(row.cents), 0)
      const best = [...promotions.promotions].sort((a, b) => b.collectedCents - a.collectedCents)
      return {
        respuesta: `odentIA no registra campañas (ni emite facturas: solo tickets de pago), así que no sé cuánto vino de ellas. Lo más cercano: ${thisMonth} las ${promotions.people} personas que usaron una promoción pagaron desde entonces ${h.money(promotions.collectedCents)}, sobre todo ${h.listOf(best.slice(0, 3).map((row) => ({ name: row.name, value: h.money(row.collectedCents) })))}. Los pacientes nuevos del mes pagaron ${h.money(freshTotal)}, de ${h.show(collected)} cobrados en el mes.`,
        criterio: "Trampa: sin campañas ni facturas. Se ofrece lo pagado por quienes usaron una promoción en el mes (Reportes › Finanzas) y lo pagado este mes por los pacientes nuevos del mes.",
        nota: `Lo pagado por los pacientes nuevos del mes, por cómo nos conocieron: ${h.listOf(paid.map((row) => ({ name: referralWords(row.kind), value: `${h.money(Number(row.cents))}, ${row.patients} ${row.patients === 1 ? "paciente" : "pacientes"}` })))}.`,
        datos: { promociones: promotions.promotions, pagaronConPromocion: promotions.collectedCents, nuevosPorComoNosConocio: paid, cobradoMes: collected.total },
      }
    },

    m8: async () => {
      const referral = await h.fig("como_nos_conocieron")
      const channels = await h.fig("nos_buscaron", "canal")
      const [year] = await funnelMany(tx, org, [yearSpan], h.now)
      const yearReferral = await referralSince(yearAgo)
      // Recepción y el registro en línea no son un medio por el que se anuncie la clínica: quedan fuera de la comparación.
      const conversion = (year?.channels ?? [])
        .filter((row) => row.sought >= 5 && row.channel !== "recepcion" && row.channel !== "registro_en_linea")
        .sort((a, b) => b.came / b.sought - a.came / a.sought)
      return {
        respuesta: `No lo puedo saber: odentIA no registra cuánto inviertes en publicidad ni tus campañas, así que no hay costo por paciente ni retorno. Lo que sí tengo: ${thisMonth} tus ${referral.total.value ?? 0} pacientes nuevos llegaron por ${h.listOf(referral.rows.slice(0, 4).map((row) => ({ name: row.label, value: `${row.value.value ?? 0}` })))}; y de quienes nos escribieron por primera vez, vinieron ${h.listOf(channels.rows.map((row) => ({ name: row.label, value: `${row.value.part ?? 0} de ${row.value.value ?? 0}` })))}. Con lo que gastaste en cada medio se puede comparar.`,
        criterio: "Trampa: sin gasto de publicidad no se puede juzgar la inversión. Se ofrecen «Cómo nos conocieron» de los nuevos del mes y el embudo por canal del mes.",
        nota: `En los últimos 12 meses, por cómo nos conocieron: ${referralList(yearReferral)}. Por canal de conversación, el porcentaje de quienes nos escribieron por primera vez en esos 12 meses y vinieron: ${h.listOf(conversion.map((row) => ({ name: channelWords(row.channel), value: `${pct(row.came, row.sought)}, ${row.came} de ${row.sought}` })))}.`,
        datos: { comoNosConocieron: referral.rows, canales: channels.rows, doceMeses: { comoNosConocieron: yearReferral, canales: year?.channels ?? [] } },
      }
    },
  }
}

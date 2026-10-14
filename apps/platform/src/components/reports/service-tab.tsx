/**
 * Reportes › Atención: cómo se respondió a quien escribió. Cuenta las
 * conversaciones que empezaron en el periodo; la primera respuesta es la que
 * el canal aceptó, no la que se encoló.
 */
import { EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { channelLabel } from "../../lib/channels"
import { ReceptionOffNotice } from "../agent/reception-off-notice"
import { usePermission } from "../../lib/crm"
import { QueryErrorState } from "../../lib/query-error"
import {
  absoluteChange,
  fetchReport,
  POINTS,
  previousPhrase,
  rateOf,
  relativeChange,
  reportKey,
  type ReportQuery,
  type ReportService,
  spanLabel,
} from "../../lib/reports"
import { MonthBars } from "./month-bars"
import { type BarRow, BarRows, Figure, ReportCard } from "./report-parts"

export function ServiceTab({ query }: { query: ReportQuery }) {
  const navigate = useNavigate()
  const canChannels = usePermission("settings.write")
  const canAgent = usePermission("agent.read")
  const report = useQuery({ queryKey: reportKey("service", query), queryFn: () => fetchReport<ReportService>("service", query), retry: false })

  if (report.isPending) return <LoadingState />
  if (report.isError) return <QueryErrorState error={report.error} onRetry={() => void report.refetch()} />

  const data = report.data.data
  const locale = data.locale
  const period = spanLabel(data.period, locale)
  const phrase = previousPhrase(data, locale)
  const { responses: now, previousResponses: before } = data
  const waiting = now.conversations - now.responded

  if (now.conversations === 0) {
    return (
      <EmptyState
        title={`Nadie escribió en ${period}`}
        description="Con un canal conectado, aquí se ve cuánto se tarda en responder y quién responde primero."
        actionLabel={canChannels ? "Conectar un canal" : undefined}
        onAction={() => void navigate({ to: "/settings/integrations" })}
      />
    )
  }

  const respondedRate = rateOf(now.responded, now.conversations)
  const previousRate = rateOf(before.responded, before.conversations)
  const responders: BarRow[] = [
    { key: "agent", label: "El agente", value: String(now.byAgent), share: rateOf(now.byAgent, now.conversations) ?? 0, percent: rateOf(now.byAgent, now.conversations) },
    { key: "team", label: "El equipo", value: String(now.byTeam), share: rateOf(now.byTeam, now.conversations) ?? 0, percent: rateOf(now.byTeam, now.conversations) },
  ]
  if (waiting > 0)
    responders.push({ key: "none", label: "Nadie todavía", value: String(waiting), share: rateOf(waiting, now.conversations) ?? 0, percent: rateOf(waiting, now.conversations), tone: "attention" })
  const channels: BarRow[] = data.byChannel.map((row) => ({
    key: row.channel ?? "sin-canal",
    label: row.channel ? channelLabel(row.channel) : "Canal retirado",
    value: String(row.count),
    share: rateOf(row.count, now.conversations) ?? 0,
    percent: rateOf(row.count, now.conversations),
  }))

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {data.wholeClinic.length > 0 ? (
        <p className="text-sm text-muted-foreground">Las conversaciones son de toda la clínica: no pertenecen a una sede.</p>
      ) : null}

      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Figure title="Conversaciones nuevas" value={now.conversations} change={relativeChange(now.conversations, before.conversations, phrase, locale)} />
        <Figure
          title="Recibieron respuesta"
          value={`${respondedRate} %`}
          detail={`· ${now.responded} de ${now.conversations}`}
          change={absoluteChange(respondedRate ?? 0, previousRate, phrase, locale, POINTS)}
          better="up"
        />
        {waiting > 0 ? (
          <Figure tone="attention" title="Siguen sin respuesta" value={waiting}>
            <Link to="/inbox" search={{ conversation: undefined }} className="self-start text-sm font-semibold text-warning underline">
              Ver en la Bandeja
            </Link>
          </Figure>
        ) : (
          <Figure title="Siguen sin respuesta" value={0} note="Todas recibieron respuesta." />
        )}
      </div>

      {/* Con gente sin respuesta, si Recepción está apagada se dice aquí, con su salida. */}
      {waiting > 0 ? <ReceptionOffNotice /> : null}

      {data.series.length > 1 ? (
        <MonthBars
          title="Conversaciones nuevas por mes"
          months={data.series}
          locale={locale}
          compact={String}
          series={[
            { key: "conversations", label: "Nuevas", tone: "primary", display: String, values: data.series.map((row) => row.conversations) },
            { key: "responded", label: "Con respuesta", tone: "muted", display: String, values: data.series.map((row) => row.responded) },
          ]}
        />
      ) : null}

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
        <ReportCard title="Quién respondió primero">
          <BarRows rows={responders} />
          {now.byAgent > 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {now.byAgent === 1
                ? `La que respondió primero el agente ${now.handedOff === 1 ? "pasó después al equipo" : "no pasó al equipo"}.`
                : `De las ${now.byAgent} que respondió primero el agente, ${now.handedOff === 1 ? "1 pasó" : `${now.handedOff} pasaron`} después al equipo.`}
            </p>
          ) : null}
          {canAgent ? (
            <Link to="/agent" className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-primary underline sm:min-h-8">
              Ver cómo va el agente
            </Link>
          ) : null}
        </ReportCard>
        <ReportCard title="Por dónde escribieron">
          <BarRows rows={channels} />
          <p className="text-[13px] text-muted-foreground">Los canales que la clínica tiene conectados.</p>
        </ReportCard>
      </div>
    </div>
  )
}

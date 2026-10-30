/**
 * El administrador junto a la cifra: dice un hecho del sistema (la cifra y la
 * línea que lo atendería, que está apagada) y lleva a la recomendación que ya
 * existe, con su lista y lo que se puede hacer. No usa un modelo y nunca dice
 * «porque»: no afirma causas.
 */
import { Button } from "@odentia/ui"
import { AgentMark, AgentSurface, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { refreshAdmin } from "../../lib/admin"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { fetchReportAdvice, type ReportAdvice, type ReportAdviceTab, reportKey, type ReportQuery } from "../../lib/reports"
import { ADMIN_NAME } from "../../lib/agent-names"

/** Los avisos del periodo; sin el administrador encendido no hay ninguno. */
export function useReportAdvice(query: ReportQuery, enabled: boolean) {
  return useQuery({ queryKey: reportKey("advice", query), queryFn: () => fetchReportAdvice(query), enabled, retry: false })
}

export function adviceFor(notices: ReportAdvice[] | undefined, tab: ReportAdviceTab): ReportAdvice | null {
  return notices?.find((item) => item.tab === tab) ?? null
}

/** El hecho, con sus cifras; la línea apagada se dice como dato, no como causa. */
function headline(advice: ReportAdvice): string {
  const off = ` «${advice.line}» está apagada.`
  if (advice.rate === null) return `${advice.title}.${off}`
  const rose = advice.previousRate !== null && advice.rate > advice.previousRate
  return `${rose ? `La inasistencia subió de ${advice.previousRate} % a ${advice.rate} %.` : `La inasistencia está en ${advice.rate} %.`}${off}`
}

export function AdviceNote({ advice, onOpen }: { advice: ReportAdvice; onOpen: (key: string) => void }) {
  const queryClient = useQueryClient()
  const canAdmin = usePermission("agent.write")
  // «No recomendarla más» vale para toda la clínica, igual que en Inicio: la línea sigue en su página.
  const snooze = useMutation({
    retry: false,
    mutationFn: () => apiFetch(`/api/agent/admin/lines/${advice.key}`, { method: "PATCH", body: JSON.stringify({ noRecommend: true }) }),
    onSuccess: () => refreshAdmin(queryClient),
  })

  return (
    <AgentSurface aria-label={`Aviso de ${ADMIN_NAME}`} className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-3 p-3.5">
      <AgentMark />
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <span className="text-xs font-bold tracking-wider text-primary-soft-foreground uppercase">{ADMIN_NAME}</span>
        <span className="text-[15px] font-bold">{headline(advice)}</span>
        {advice.rate !== null ? <span className="text-[13px] text-muted-foreground">{advice.title}.</span> : null}
        {snooze.isError ? (
          <span role="alert" className="text-[13px] text-destructive">
            {submitErrorMessage(snooze.error)}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <Button type="button" className="min-h-11 sm:min-h-10" onClick={() => onOpen(advice.key)}>
          Ver qué hacer
        </Button>
        {canAdmin ? (
          <Button type="button" variant="ghost" className="min-h-11 text-primary-soft-foreground sm:min-h-10" disabled={snooze.isPending} onClick={() => snooze.mutate()}>
            No recomendarla más
          </Button>
        ) : null}
      </div>
    </AgentSurface>
  )
}

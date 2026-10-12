/**
 * El asesor junto a la cifra: dice un hecho del sistema (la cifra, lo que está
 * apagado) y lleva a la recomendación que ya existe, con su lista y su acción.
 * No usa un modelo y nunca dice «porque»: no afirma causas.
 */
import { Button } from "@odentia/ui"
import { AgentMark, AgentSurface } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { mutationErrorMessage } from "../../lib/query-error"
import { fetchReportAdvice, type ReportAdvice, type ReportAdviceTab, reportKey, type ReportQuery } from "../../lib/reports"

/** Los avisos del periodo; sin el asesor encendido no hay ninguno. */
export function useReportAdvice(query: ReportQuery, enabled: boolean) {
  return useQuery({ queryKey: reportKey("advice", query), queryFn: () => fetchReportAdvice(query), enabled, retry: false })
}

export function adviceFor(notices: ReportAdvice[] | undefined, tab: ReportAdviceTab): ReportAdvice | null {
  return notices?.find((item) => item.tab === tab) ?? null
}

/** El hecho, con sus cifras; la automatización apagada se dice como dato, no como causa. */
function headline(advice: ReportAdvice): string {
  const off = advice.automation && !advice.automation.enabled ? ` El ${advice.automation.label} está apagado.` : ""
  if (advice.rate === null) return `${advice.title}.${off}`
  const rose = advice.previousRate !== null && advice.rate > advice.previousRate
  return `${rose ? `La inasistencia subió de ${advice.previousRate} % a ${advice.rate} %.` : `La inasistencia está en ${advice.rate} %.`}${off}`
}

export function AdviceNote({ advice, onOpen }: { advice: ReportAdvice; onOpen: (key: string) => void }) {
  const queryClient = useQueryClient()
  const canAdmin = usePermission("agent.write")
  // «No me interesa» lo pospone una semana para toda la clínica, igual que en Inicio.
  const snooze = useMutation({
    retry: false,
    mutationFn: () =>
      apiFetch("/api/agent/advisor/settings", { method: "PUT", body: JSON.stringify({ detections: { [advice.key]: { snoozeDays: 7 } } }) }),
    onSuccess: () => {
      for (const key of ["report", "agent-advisor", "agent-advisor-settings", "workspace-home"]) void queryClient.invalidateQueries({ queryKey: [key] })
    },
  })

  return (
    <AgentSurface aria-label="Aviso del asesor" className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-3 p-3.5">
      <AgentMark />
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <span className="text-xs font-bold tracking-wider text-primary-soft-foreground uppercase">El asesor</span>
        <span className="text-[15px] font-bold">{headline(advice)}</span>
        {advice.rate !== null ? <span className="text-[13px] text-muted-foreground">{advice.title}.</span> : null}
        {snooze.isError ? (
          <span role="alert" className="text-[13px] text-destructive">
            {mutationErrorMessage(snooze.error)}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <Button type="button" className="min-h-11 sm:min-h-10" onClick={() => onOpen(advice.key)}>
          Ver qué hacer
        </Button>
        {canAdmin ? (
          <Button type="button" variant="ghost" className="min-h-11 text-primary-soft-foreground sm:min-h-10" disabled={snooze.isPending} onClick={() => snooze.mutate()}>
            No me interesa
          </Button>
        ) : null}
      </div>
    </AgentSurface>
  )
}

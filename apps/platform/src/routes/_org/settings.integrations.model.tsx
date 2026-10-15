import { Alert, AlertDescription, AlertTitle, cn, FieldLabel, RadioGroup, RadioGroupItem, Skeleton, toast } from "@odentia/ui"
import { PageHeader, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useId, useState } from "react"
import { IntegrationsCrumb } from "../../components/integrations/integrations-crumb"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { ApiError, apiFetch } from "../../lib/api"
import { AGENT_LLMS, type AgentConfig, type AgentLlm, usePermission } from "../../lib/crm"
import { PageDraftGuard } from "../../lib/page-draft-guard"

export const Route = createFileRoute("/_org/settings/integrations/model")({
  component: AgentModelPage,
})

const TITLE = "Modelo del agente"
const SUBTITLE = "La inteligencia con la que el agente entiende y escribe."

/** La tarjeta de página, la misma en toda la plataforma. */
const CARD = "elevated flex flex-col gap-5 rounded-xl border bg-card p-5 sm:p-6"

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
}

function AgentModelPage() {
  const canWrite = usePermission("agent.write")
  if (!canWrite) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <IntegrationsCrumb current={TITLE} />
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }
  return <ModelSettings />
}

/**
 * Modelo del agente: la clínica elige uno de los dos modelos que odentIA
 * validó, con su nombre simple; la cuenta la pone odentIA y el modelo exacto lo
 * fija el servidor (ADR 0022). Encender el agente, su tope diario y sus
 * indicaciones se deciden en Agente › Recepción.
 */
function ModelSettings() {
  const ids = useId()
  const queryClient = useQueryClient()
  const configQuery = useQuery({
    queryKey: ["agent-config"],
    queryFn: () => apiFetch<{ data: AgentConfig }>("/api/agent/config"),
    retry: 1,
  })
  const saved = configQuery.data?.data ?? null
  // El formulario parte de lo guardado y solo se separa cuando alguien elige otro.
  const [edited, setEdited] = useState<AgentLlm | null>(null)

  const saveMutation = useMutation({
    mutationFn: (llm: AgentLlm) =>
      apiFetch<{ data: AgentConfig }>("/api/agent/config", { method: "PUT", body: JSON.stringify({ llm }) }),
    onSuccess: (result) => {
      queryClient.setQueryData(["agent-config"], result)
      setEdited(null)
      toast.success("Modelo del agente guardado")
      void queryClient.invalidateQueries({ queryKey: ["agent-config"] })
      void queryClient.invalidateQueries({ queryKey: ["agent-overview"] })
    },
  })

  if (!saved) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <IntegrationsCrumb current={TITLE} />
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        {configQuery.isError ? (
          <SettingsLoadError what="el modelo del agente" onRetry={() => void configQuery.refetch()} />
        ) : (
          <div className={CARD}>
            <p role="status" className="sr-only">
              Cargando el modelo del agente…
            </p>
            <Skeleton className="h-5 w-64" aria-hidden />
            <Skeleton className="h-12 w-full rounded-xl" aria-hidden />
            <Skeleton className="h-12 w-full rounded-xl" aria-hidden />
          </div>
        )}
      </div>
    )
  }

  const chosen = edited ?? saved.llm
  const dirty = chosen !== saved.llm

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageDraftGuard dirty={dirty} />
      <IntegrationsCrumb current={TITLE} />
      <PageHeader title={TITLE} subtitle={SUBTITLE} />

      {configQuery.isError ? (
        <SettingsLoadError stale what="el modelo del agente" onRetry={() => void configQuery.refetch()} />
      ) : null}

      <section className={CARD} aria-labelledby={`${ids}-modelo`}>
        <h2 id={`${ids}-modelo`} className="font-heading text-base font-medium">
          Con qué modelo trabaja el agente
        </h2>
        <RadioGroup
          aria-labelledby={`${ids}-modelo`}
          value={chosen}
          onValueChange={(value) => {
            saveMutation.reset()
            setEdited(AGENT_LLMS.find((item) => item.id === value)?.id ?? saved.llm)
          }}
        >
          {AGENT_LLMS.map((option) => (
            <FieldLabel
              key={option.id}
              className={cn(
                "flex h-auto min-h-12 w-full cursor-pointer items-center gap-3 rounded-xl border px-3 text-sm font-semibold",
                chosen === option.id && "border-primary bg-primary-soft",
              )}
            >
              <RadioGroupItem value={option.id} />
              {option.label}
            </FieldLabel>
          ))}
        </RadioGroup>
      </section>

      {saveMutation.isError ? (
        <Alert variant="destructive">
          <AlertTitle>No pudimos guardar el modelo del agente</AlertTitle>
          <AlertDescription>{errorText(saveMutation.error, "Tu elección sigue aquí: vuelve a intentarlo.")}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <SubmitButton
          className="min-h-11"
          pending={saveMutation.isPending}
          disabled={!dirty}
          onClick={() => saveMutation.mutate(chosen)}
        >
          Guardar
        </SubmitButton>
      </div>
    </div>
  )
}

import { Badge, Button, Field, FieldDescription, FieldLabel, Input } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import { AdvisorPreview, type AdvisorSettings } from "../../components/agent/advisor"
import type { AgentRoles } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/agent/asesor")({
  component: AdvisorPage,
})

const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-8"

function Card({ id, title, hint, children }: { id: string; title: string; hint: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5 sm:p-6">
      <div>
        <h2 id={id} className="font-heading text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}

function AdvisorPage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  // Umbral que se está escribiendo, por detección; se guarda al salir del campo.
  const [days, setDays] = useState<Record<string, string>>({})

  const settingsQuery = useQuery({
    queryKey: ["agent-advisor-settings"],
    queryFn: () => apiFetch<{ data: AdvisorSettings }>("/api/agent/advisor/settings"),
    enabled: canRead,
    retry: false,
  })
  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => apiFetch<{ data: AgentRoles }>("/api/agent/roles"),
    enabled: canRead,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const save = useMutation({
    retry: false,
    mutationFn: (patch: unknown) => apiFetch("/api/agent/advisor/settings", { method: "PUT", body: JSON.stringify(patch) }),
    onSettled: () => {
      for (const key of ["agent-advisor-settings", "agent-advisor-preview", "agent-advisor"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
    },
  })

  if (!canRead) {
    return (
      <PageShell>
        <ErrorState title="Sin acceso" message="No tienes acceso a la configuración del agente." />
      </PageShell>
    )
  }
  const settings = settingsQuery.data?.data
  const role = rolesQuery.data?.data.roles.find((item) => item.id === "asesor")

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Asesor"
        subtitle={role?.audience ?? "Para quien administra, en Inicio"}
        actions={
          settings && canWrite ? (
            <label htmlFor="asesor-encendido" className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold sm:min-h-8">
              {settings.enabled ? "Encendido" : "Apagado"}
              <Switch
                id="asesor-encendido"
                checked={settings.enabled}
                disabled={save.isPending}
                aria-label={settings.enabled ? "Apagar el Asesor" : "Encender el Asesor"}
                onCheckedChange={(next) => save.mutate({ enabled: next })}
              />
            </label>
          ) : settings ? (
            <Badge variant={settings.enabled ? "success" : "secondary"}>{settings.enabled ? "Encendido" : "Apagado"}</Badge>
          ) : null
        }
      />
      <Link to="/agent" className={`-mt-3 w-fit ${LINK}`}>
        Volver al resumen del agente
      </Link>
      {role ? <p className="-mt-2 max-w-prose text-sm">{role.role}</p> : null}

      {settingsQuery.isPending ? (
        <LoadingState message="Cargando al Asesor…" />
      ) : settingsQuery.isError || !settings ? (
        <QueryErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />
      ) : (
        <>
          {save.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationErrorMessage(save.error)}
            </p>
          ) : null}
          <Card id="asesor-detecta" title="Qué detecta" hint="Cada detección se enciende por separado. Muestra hasta tres recomendaciones a la vez en Inicio.">
            <ul className="flex flex-col divide-y">
              {settings.detections.map((detection) => (
                <li key={detection.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="font-semibold">{detection.label}</p>
                    <p className="text-sm text-muted-foreground">{detection.on ? detection.description : "Apagada: no la calcula ni la muestra."}</p>
                    {detection.on && detection.snoozedUntil ? (
                      <p className="text-sm">
                        Oculta hasta el {new Date(detection.snoozedUntil).toLocaleDateString("es-PE", { day: "numeric", month: "long" })}.{" "}
                        {canWrite ? (
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="h-auto p-0"
                            onClick={() => save.mutate({ detections: { [detection.key]: { snoozeDays: null } } })}
                          >
                            Volver a mostrarla
                          </Button>
                        ) : null}
                      </p>
                    ) : null}
                    {detection.on && detection.defaultDays !== null ? (
                      <Field className="mt-1 max-w-56">
                        <FieldLabel htmlFor={`umbral-${detection.key}`}>Días desde que se aceptó</FieldLabel>
                        <Input
                          id={`umbral-${detection.key}`}
                          type="number"
                          min={1}
                          max={365}
                          disabled={!canWrite}
                          value={days[detection.key] ?? String(detection.days ?? detection.defaultDays)}
                          onChange={(event) => setDays({ ...days, [detection.key]: event.target.value })}
                          onBlur={() => {
                            const value = Number(days[detection.key])
                            if (days[detection.key] === undefined || value === detection.days) return
                            if (Number.isInteger(value) && value >= 1 && value <= 365) save.mutate({ detections: { [detection.key]: { days: value } } })
                            setDays(({ [detection.key]: _done, ...rest }) => rest)
                          }}
                        />
                        <FieldDescription>Avisa cuando pasen más de estos días. Por defecto, {detection.defaultDays}.</FieldDescription>
                      </Field>
                    ) : null}
                  </div>
                  <Switch
                    checked={detection.on}
                    disabled={!canWrite || save.isPending}
                    aria-label={detection.label}
                    onCheckedChange={(next) => save.mutate({ detections: { [detection.key]: { on: next } } })}
                  />
                </li>
              ))}
            </ul>
          </Card>

          <Card
            id="asesor-llega"
            title="Hasta dónde llega solo"
            hint="Solo recomienda. La acción queda lista y la ejecuta una persona."
          >
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Qué sabe</dt>
                <dd className="text-muted-foreground">{role?.sees}</dd>
              </div>
              <div>
                <dt className="font-semibold">No ve</dt>
                <dd className="text-muted-foreground">{role?.notSees}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="font-semibold">Nunca</dt>
                <dd className="text-muted-foreground">{role?.never}</dd>
              </div>
            </dl>
            <p className="text-sm text-muted-foreground">
              Cada persona ve solo las recomendaciones de lo que su rol ya puede ver: caja no ve atenciones y recepción no ve cobranza.
            </p>
          </Card>

          {canWrite ? (
            <Card
              id="asesor-vista-previa"
              title={settings.enabled ? "Lo que recomienda hoy" : "Lo que recomendaría hoy"}
              hint={settings.enabled ? "Todas las que encuentra ahora, no solo las tres de Inicio." : "Una vista previa con tus datos de ahora, antes de encenderlo. Nadie más la ve."}
            >
              <AdvisorPreview />
            </Card>
          ) : null}
        </>
      )}
    </PageShell>
  )
}

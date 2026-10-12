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
        <ErrorState title="No tienes acceso a esta sección" message="Pídelo a quien administra la clínica. Tus aprobaciones siguen en su pestaña." />
      </PageShell>
    )
  }
  const settings = settingsQuery.data?.data
  const role = rolesQuery.data?.data.roles.find((item) => item.id === "asesor")
  const principles = rolesQuery.data?.data.principles ?? []

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Asesor"
        subtitle={role?.audience}
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

      {settingsQuery.isPending || rolesQuery.isPending ? (
        <LoadingState message="Cargando al Asesor…" />
      ) : settingsQuery.isError || !settings || !role ? (
        <QueryErrorState error={settingsQuery.error ?? rolesQuery.error} onRetry={() => void (settingsQuery.isError ? settingsQuery : rolesQuery).refetch()} />
      ) : (
        <>
          {save.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationErrorMessage(save.error)}
            </p>
          ) : null}
          <Card id="asesor-hace" title="Qué hace" hint="Cada detección se enciende por separado. Muestra hasta tres recomendaciones a la vez en Inicio.">
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
                <dt className="font-semibold">Quién confirma</dt>
                <dd className="text-muted-foreground">{role.confirms}</dd>
              </div>
              <div>
                <dt className="font-semibold">Nunca</dt>
                <dd className="text-muted-foreground">{role.never}</dd>
              </div>
            </dl>
          </Card>

          <Card id="asesor-sabe" title="Qué sabe" hint="De dónde salen sus números, y lo que no lee.">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Puede ver</dt>
                <dd className="text-muted-foreground">{role.sees}</dd>
              </div>
              <div>
                <dt className="font-semibold">No ve</dt>
                <dd className="text-muted-foreground">{role.notSees}</dd>
              </div>
            </dl>
            <p className="text-sm text-muted-foreground">
              Cada persona ve solo las recomendaciones de lo que su rol ya puede ver: caja no ve atenciones y recepción no ve cobranza.
            </p>
          </Card>

          <Card id="asesor-comporta" title="Cómo se comporta" hint="Primero la base que comparten todos los agentes; después cómo recomienda.">
            <div className="flex flex-col gap-1 text-sm">
              <p className="font-semibold">La base</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
                {principles.map((principle) => (
                  <li key={principle}>{principle}</li>
                ))}
              </ul>
            </div>
            {role.behaves ? (
              <div className="flex flex-col gap-1 text-sm">
                <p className="font-semibold">Al recomendar</p>
                <p className="text-muted-foreground">{role.behaves}</p>
              </div>
            ) : null}
          </Card>

          <Card
            id="asesor-prueba"
            title="Cómo se prueba"
            hint={
              !canWrite
                ? (role.testedWith ?? "Con una vista previa de lo que recomendaría hoy.")
                : settings.enabled
                  ? "Ya está encendido: esto es todo lo que encuentra ahora, no solo las tres de Inicio."
                  : `${role.testedWith ?? "Con una vista previa de lo que recomendaría hoy."} Usa tus datos de ahora y nadie más la ve.`
            }
          >
            {canWrite ? <AdvisorPreview /> : <p className="text-sm text-muted-foreground">La vista previa la ve quien administra el agente.</p>}
          </Card>

          <Card id="asesor-aprende" title="Qué aprende, y de quién es" hint="Lo que cambia con el uso, y a quién le pertenece.">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Qué aprende</dt>
                <dd className="text-muted-foreground">{role.learnsFrom}</dd>
              </div>
              {role.learningOwner ? (
                <div>
                  <dt className="font-semibold">De quién es</dt>
                  <dd className="text-muted-foreground">{role.learningOwner}</dd>
                </div>
              ) : null}
            </dl>
            {role.learnsLater ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">Más adelante:</span> {role.learnsLater}
              </p>
            ) : null}
          </Card>
        </>
      )}
    </PageShell>
  )
}

import { Badge, Field, FieldDescription, FieldLabel, Textarea } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ErrorState, LoadingState, PageHeader, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import { type AgentRoles, namedAgentRoles } from "../../lib/agent"
import { CLINICAL_NAME, clinicalNameReason, useReceptionName } from "../../lib/agent-names"
import { ApiError, apiFetch } from "../../lib/api"
import { type AgentConfig, usePermission } from "../../lib/crm"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/agent/asistente-clinico")({
  component: ClinicalAssistantPage,
})

const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-8"
const KIND_LABEL: Record<string, string> = { nota: "Consulta", diagnostico: "Diagnóstico", plan: "Plan de tratamiento", control: "Controles" }

interface PracticeSuggestion {
  kind: string
  status: "lista" | "por_revisar"
  note: string | null
  summary: string
  sourceText: string
}

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

function ClinicalAssistantPage() {
  const queryClient = useQueryClient()
  const canRead = usePermission("agent.read")
  const canWrite = usePermission("agent.write")
  const receptionName = useReceptionName()
  const [practice, setPractice] = useState("")

  const configQuery = useQuery({
    queryKey: ["agent-config"],
    queryFn: () => apiFetch<{ data: AgentConfig }>("/api/agent/config"),
    enabled: canRead,
  })
  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => apiFetch<{ data: AgentRoles }>("/api/agent/roles"),
    select: (body) => ({ data: namedAgentRoles(body.data, receptionName) }),
    enabled: canRead,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const toggle = useMutation({
    retry: false,
    mutationFn: (enabled: boolean) => apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify({ clinicalAssistantEnabled: enabled }) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["agent-config"] }),
  })
  const tryIt = useMutation({
    retry: false,
    mutationFn: () =>
      apiFetch<{ data: { model: string; suggestions: PracticeSuggestion[] } }>("/api/agent/clinical/practice", {
        method: "POST",
        body: JSON.stringify({ transcript: practice.trim() }),
      }),
  })

  if (!canRead) {
    return (
      <PageShell>
        <ErrorState title="No tienes acceso a esta sección" message="Pídelo a quien administra la clínica. Las citas que esperan su sí siguen en «Esperan su sí»." />
      </PageShell>
    )
  }
  const config = configQuery.data?.data
  const role = rolesQuery.data?.data.roles.find((item) => item.id === "asistente_clinico")
  const on = config?.clinicalAssistantEnabled === true
  const result = tryIt.data?.data
  const principles = rolesQuery.data?.data.principles ?? []

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title={`${CLINICAL_NAME}, tu agente clínico`}
        subtitle={
          <>
            <p className="min-w-0">{clinicalNameReason()}</p>
            {config && canWrite ? (
              <label htmlFor="asistente-clinico-encendido" className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold sm:min-h-8">
                {on ? "Encendido" : "Apagado"}
                <Switch
                  id="asistente-clinico-encendido"
                  checked={on}
                  disabled={toggle.isPending}
                  aria-label={on ? `Apagar a ${CLINICAL_NAME}` : `Encender a ${CLINICAL_NAME}`}
                  onCheckedChange={(next) => toggle.mutate(next)}
                />
              </label>
            ) : config ? (
              <Badge variant={on ? "success" : "secondary"}>{on ? "Encendido" : "Apagado"}</Badge>
            ) : null}
          </>
        }
      />
      <Link to="/agent" className={`-mt-3 w-fit ${LINK}`}>
        Volver al resumen del agente
      </Link>
      {role ? <p className="-mt-2 max-w-prose text-sm">{role.role}</p> : null}

      {configQuery.isPending || rolesQuery.isPending ? (
        <LoadingState message={`Cargando a ${CLINICAL_NAME}…`} />
      ) : configQuery.isError || !config || !role ? (
        <QueryErrorState error={configQuery.error ?? rolesQuery.error} onRetry={() => void configQuery.refetch()} />
      ) : (
        <>
          {toggle.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationErrorMessage(toggle.error)}
            </p>
          ) : null}
          <Card
            id="clinico-hace"
            title="Qué hace"
            hint={on ? "En cada atención en borrador aparece «Dictar la atención» para quien la lleva." : "Al encenderlo, cada atención en borrador ofrece «Dictar la atención» a quien la lleva."}
          >
            <ul className="flex flex-col divide-y">
              {role.functions.map((fn) => (
                <li key={fn.id} className="py-3 first:pt-0 last:pb-0">
                  <p className="font-semibold">{fn.label}</p>
                  <p className="text-sm text-muted-foreground">{fn.description}</p>
                </li>
              ))}
            </ul>
            {role.later ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">Más adelante:</span> {role.later} Hoy no lo hace.
              </p>
            ) : null}
          </Card>

          <Card id="clinico-llega" title="Hasta dónde llega solo" hint="Nunca guarda: siempre sugiere. No tiene niveles.">
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

          <Card id="clinico-sabe" title="Qué sabe" hint="Lo que recibe para ordenar un dictado, y lo que no.">
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
              Lo dictado se envía al proveedor del modelo configurado para ordenarlo. El dictado completo no se guarda: de cada sugerencia queda solo
              la frase que la originó.
            </p>
          </Card>

          <Card id="clinico-comporta" title="Cómo se comporta" hint="Primero la base que comparten todos los agentes; después cómo ordena un dictado.">
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
                <p className="font-semibold">Al ordenar un dictado</p>
                <p className="text-muted-foreground">{role.behaves}</p>
              </div>
            ) : null}
          </Card>

          <Card id="clinico-prueba" title="Cómo se prueba" hint={role.testedWith ?? "Con un dictado de práctica."}>
            {canWrite ? (
              <>
                <Field>
                  <FieldLabel htmlFor="clinico-practica">Dictado de ejemplo</FieldLabel>
                  <Textarea
                    id="clinico-practica"
                    rows={4}
                    maxLength={12_000}
                    value={practice}
                    onChange={(event) => setPractice(event.target.value)}
                    placeholder="Viene por dolor al masticar. En la dieciséis hay caries en dentina, le ponemos una resina en la cara oclusal. Control en seis meses."
                  />
                  <FieldDescription>Usa nombres de tus propios servicios para ver cómo los reconoce.</FieldDescription>
                </Field>
                <SubmitButton
                  type="button"
                  className="min-h-11 self-start sm:min-h-9"
                  pending={tryIt.isPending}
                  disabled={practice.trim().length < 3}
                  onClick={() => tryIt.mutate()}
                >
                  Ver qué sugeriría
                </SubmitButton>
                {tryIt.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {tryIt.error instanceof ApiError && tryIt.error.status < 500 && tryIt.error.shape.message
                      ? tryIt.error.shape.message
                      : "No pudimos ordenar ese dictado. Vuelve a intentarlo."}
                  </p>
                ) : null}
                {result ? (
                  <div className="flex flex-col gap-2" aria-live="polite">
                    {result.suggestions.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No sugeriría nada con ese texto.</p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {result.suggestions.map((item, index) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: resultado de una práctica; la lista se reemplaza entera.
                          <li key={`${item.kind}-${index}`} className="flex flex-col gap-1 rounded-xl border bg-card p-3 text-sm">
                            <p className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold">{KIND_LABEL[item.kind] ?? item.kind}</span>
                              <Badge variant={item.status === "lista" ? "secondary" : "default"}>{item.status === "lista" ? "Sugerido" : "Por revisar"}</Badge>
                            </p>
                            <p className="whitespace-pre-wrap">{item.summary}</p>
                            {item.note ? <p>{item.note}</p> : null}
                            {item.sourceText ? <p className="text-muted-foreground">Lo que dijiste: «{item.sourceText}»</p> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {result.model === "fake" ? (
                      <p className="text-xs text-muted-foreground">
                        Modelo de demostración: reconoce solo unas pocas frases y no dice cómo entendería un dictado un proveedor real.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">El dictado de práctica lo usa quien administra el agente.</p>
            )}
          </Card>

          <Card id="clinico-aprende" title="Qué aprende, y de quién es" hint="Lo que cambia con el uso, y a quién le pertenece.">
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

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  cn,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  toast,
} from "@odentia/ui"
import { PageHeader, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useId, useState } from "react"
import { IntegrationsCrumb } from "../../components/integrations/integrations-crumb"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { ApiError, apiFetch } from "../../lib/api"
import { type AgentConfig, type LlmConnectionTest, usePermission } from "../../lib/crm"
import { useOrgLocale } from "../../lib/locale"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"

export const Route = createFileRoute("/_org/settings/integrations/model")({
  component: AgentModelPage,
})

const TITLE = "Modelo del agente"
const SUBTITLE = "La inteligencia con la que el agente entiende y escribe."

/** La tarjeta de página, la misma en toda la plataforma. */
const CARD = "elevated flex flex-col gap-5 rounded-xl border bg-card p-5 sm:p-6"

type Account = "incluido" | "propia"

const ACCOUNTS: Array<{ id: Account; label: string; hint: string }> = [
  {
    id: "incluido",
    label: "Incluido con odentIA",
    hint: "El agente trabaja con la cuenta de odentIA. No hay nada más que configurar.",
  },
  {
    id: "propia",
    label: "Cuenta propia de la clínica",
    hint: "Lo que escriben tus pacientes viaja al proveedor que elijas, con tu clave y tu modelo.",
  },
]

/** Lo único que esta pantalla edita: con qué cuenta trabaja el agente. */
interface ModelDraft {
  account: Account
  /** Dirección del proveedor («URL base»). */
  baseUrl: string
  /** Solo viaja si se escribe; la guardada nunca vuelve del servidor. */
  apiKey: string
  model: string
}

function toDraft(config: AgentConfig): ModelDraft {
  const own = config.llmBaseUrl !== null
  return {
    account: own ? "propia" : "incluido",
    baseUrl: config.llmBaseUrl ?? "",
    apiKey: "",
    // El modelo de la cuenta incluida lo fija odentIA: aquí no se muestra ni se cambia.
    model: own ? (config.model ?? "") : "",
  }
}

/** Qué falta para guardar o probar la cuenta propia; null si está completo. */
function missing(draft: ModelDraft, saved: AgentConfig): string | null {
  if (draft.account === "incluido") return null
  if (!draft.baseUrl.trim()) return "Escribe la dirección del proveedor."
  if (!draft.model.trim()) return "Escribe el modelo que usará ese proveedor."
  const urlChanged = draft.baseUrl.trim() !== (saved.llmBaseUrl ?? "")
  if (!draft.apiKey.trim() && (!saved.hasLlmApiKey || urlChanged)) {
    return urlChanged && saved.hasLlmApiKey
      ? "Cambiaste la dirección: vuelve a escribir la clave. La guardada no se envía a otro proveedor."
      : "Escribe la clave del proveedor."
  }
  return null
}

/**
 * Solo viaja lo de la cuenta. Los demás ajustes del agente no se tocan desde
 * aquí: siguen guardados y funcionando con el valor que tengan. Al volver a la
 * cuenta incluida, el servidor retira también el modelo de la cuenta propia.
 */
function toPatch(draft: ModelDraft, saved: AgentConfig): Record<string, string | null> {
  if (draft.account === "incluido") return { llmBaseUrl: null, llmApiKey: null }
  const baseUrl = draft.baseUrl.trim()
  return {
    model: draft.model.trim(),
    // La dirección solo viaja si cambió: así no se vuelve a validar la guardada.
    ...(baseUrl !== (saved.llmBaseUrl ?? "") ? { llmBaseUrl: baseUrl } : {}),
    ...(draft.apiKey.trim() ? { llmApiKey: draft.apiKey.trim() } : {}),
  }
}

/** Lo que se prueba: lo escrito en el formulario, aunque aún no esté guardado. */
function toTest(draft: ModelDraft, saved: AgentConfig): Record<string, string | null> {
  if (draft.account === "incluido") {
    // Viniendo de la cuenta propia, el modelo guardado es el de ese proveedor: no se prueba con él.
    return { llmBaseUrl: null, ...(saved.llmBaseUrl !== null ? { model: null } : {}) }
  }
  return {
    model: draft.model.trim(),
    llmBaseUrl: draft.baseUrl.trim(),
    ...(draft.apiKey.trim() ? { llmApiKey: draft.apiKey.trim() } : {}),
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
}

function seconds(ms: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(ms / 1000)
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
 * Modelo del agente: la clínica solo elige con qué cuenta trabaja —la incluida
 * con odentIA o la suya— y puede probar la conexión. Encender el agente, su
 * tope diario, sus indicaciones y hasta dónde llega solo se deciden en
 * Agente › Recepción; lo demás lo fija odentIA.
 */
function ModelSettings() {
  const ids = useId()
  const locale = useOrgLocale()
  const queryClient = useQueryClient()
  const configQuery = useQuery({
    queryKey: ["agent-config"],
    queryFn: () => apiFetch<{ data: AgentConfig }>("/api/agent/config"),
    retry: 1,
  })
  const saved = configQuery.data?.data ?? null
  // El formulario parte de lo guardado y solo se separa cuando alguien escribe.
  const [edited, setEdited] = useState<ModelDraft | null>(null)

  const saveMutation = useMutation({
    mutationFn: (patch: Record<string, string | null>) =>
      apiFetch<{ data: AgentConfig }>("/api/agent/config", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: (result) => {
      queryClient.setQueryData(["agent-config"], result)
      setEdited(null)
      testMutation.reset()
      toast.success("Modelo del agente guardado")
      void queryClient.invalidateQueries({ queryKey: ["agent-config"] })
      void queryClient.invalidateQueries({ queryKey: ["agent-overview"] })
    },
  })
  const testMutation = useMutation({
    mutationFn: (body: Record<string, string | null>) =>
      apiFetch<{ data: LlmConnectionTest }>("/api/agent/config/llm/test", { method: "POST", body: JSON.stringify(body) }),
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
            <Skeleton className="h-16 w-full rounded-xl" aria-hidden />
            <Skeleton className="h-16 w-full rounded-xl" aria-hidden />
            <Skeleton className="h-9 w-40" aria-hidden />
          </div>
        )}
      </div>
    )
  }

  const baseline = toDraft(saved)
  const draft = edited ?? baseline
  const dirty = !sameDraft(draft, baseline)
  const issue = missing(draft, saved)
  const own = draft.account === "propia"

  const set = (patch: Partial<ModelDraft>) => {
    // Un resultado de prueba vale para lo que se probó: al cambiar algo, se retira.
    testMutation.reset()
    saveMutation.reset()
    setEdited({ ...draft, ...patch })
  }

  const test = testMutation.data?.data ?? null

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageDraftGuard dirty={dirty} />
      <IntegrationsCrumb current={TITLE} />
      <PageHeader title={TITLE} subtitle={SUBTITLE} />

      {configQuery.isError ? (
        <SettingsLoadError stale what="el modelo del agente" onRetry={() => void configQuery.refetch()} />
      ) : null}

      <section className={CARD} aria-labelledby={`${ids}-cuenta`}>
        <div className="flex flex-col gap-1.5">
          <h2 id={`${ids}-cuenta`} className="font-heading text-base font-medium">
            Con qué cuenta trabaja el agente
          </h2>
          <p className="text-sm text-muted-foreground">
            Encenderlo, su tope diario, sus indicaciones y hasta dónde llega solo se deciden en Agente › Recepción.
          </p>
        </div>

        <RadioGroup
          aria-labelledby={`${ids}-cuenta`}
          value={draft.account}
          onValueChange={(value) => set({ account: value === "propia" ? "propia" : "incluido" })}
        >
          {ACCOUNTS.map((account) => (
            <FieldLabel
              key={account.id}
              className={cn(
                "flex h-auto min-h-11 w-full cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm font-normal",
                draft.account === account.id && "border-primary bg-primary-soft",
              )}
            >
              <RadioGroupItem value={account.id} className="mt-0.5" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-semibold">{account.label}</span>
                <span className="text-muted-foreground">{account.hint}</span>
              </span>
            </FieldLabel>
          ))}
        </RadioGroup>

        {own ? (
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor={`${ids}-direccion`}>Dirección del proveedor</FieldLabel>
              <Input
                id={`${ids}-direccion`}
                type="url"
                inputMode="url"
                autoComplete="off"
                value={draft.baseUrl}
                placeholder="https://"
                onChange={(event) => set({ baseUrl: event.target.value })}
              />
              <FieldDescription>
                El proveedor la llama «URL base» (base URL). Empieza con https y debe ser compatible con OpenAI.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${ids}-clave`}>Clave</FieldLabel>
              <Input
                id={`${ids}-clave`}
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                placeholder={saved.hasLlmApiKey ? "Guardada. Escribe otra para cambiarla." : ""}
                onChange={(event) => set({ apiKey: event.target.value })}
              />
              <FieldDescription>
                El proveedor la llama «API key». Se guarda cifrada y no vuelve a mostrarse.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${ids}-modelo`}>Modelo</FieldLabel>
              <Input
                id={`${ids}-modelo`}
                autoComplete="off"
                value={draft.model}
                onChange={(event) => set({ model: event.target.value })}
              />
              <FieldDescription>
                El nombre tal como lo escribe el proveedor. Debe poder usar herramientas («tool calling»).
              </FieldDescription>
            </Field>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={testMutation.isPending || issue !== null}
              onClick={() => testMutation.mutate(toTest(draft, saved))}
            >
              {testMutation.isPending ? "Probando…" : "Probar conexión"}
            </Button>
          </div>
          {testMutation.isError ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorText(testMutation.error, "No pudimos hacer la prueba. Vuelve a intentarlo.")}
            </p>
          ) : test?.ok ? (
            <p role="status" className="text-sm font-medium text-success">
              Funciona: el proveedor respondió en {seconds(test.latencyMs, locale)} s
              {test.model ? ` con ${test.model}` : ""}.
              La prueba dice que hay conexión; no mide la calidad de las respuestas.
            </p>
          ) : test ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              No hay conexión: {(test.error ?? "el proveedor no respondió").replace(/\.$/, "")}.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Envía una pregunta mínima al proveedor con lo que ves aquí, aunque no lo hayas guardado.
            </p>
          )}
        </div>
      </section>

      {saveMutation.isError ? (
        <Alert variant="destructive">
          <AlertTitle>No pudimos guardar el modelo del agente</AlertTitle>
          <AlertDescription>
            {errorText(saveMutation.error, "Lo que escribiste sigue aquí: vuelve a intentarlo.")}
          </AlertDescription>
        </Alert>
      ) : null}
      {dirty && issue ? <p className="text-sm text-muted-foreground">{issue}</p> : null}
      <div>
        <SubmitButton
          className="min-h-11"
          pending={saveMutation.isPending}
          disabled={!dirty || issue !== null}
          onClick={() => saveMutation.mutate(toPatch(draft, saved))}
        >
          Guardar
        </SubmitButton>
      </div>
    </div>
  )
}

import { Checkbox, Input, Label } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageHeader, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { type ConnectionItem, usePermission } from "../../lib/crm"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"
import {
  fetchPortalPolicyApi,
  savePortalPolicyApi,
  type PortalPolicy,
  type PortalPolicyInput,
} from "../../lib/portal"

export const Route = createFileRoute("/_org/settings/patient-access")({
  component: PortalPolicyPage,
})

function mutationMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.shape.message ?? fallback
  return fallback
}

const VERIFIED_METHODS_HELP =
  "La aprobación manual exige identidad y representación verificadas por el personal " +
  "(documento presencial o evidencia registrada). La coincidencia de teléfono nunca basta, " +
  "en ningún modo."

function PortalPolicyPage() {
  const canRead = usePermission("settings.read")
  const canWrite = usePermission("settings.write")
  if (!canRead) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Acceso de pacientes"
          subtitle="Políticas del portal del paciente."
        />
        <EmptyState
          title="Sin acceso a la configuración"
          description="Necesitas el permiso settings.read para ver las políticas del portal."
        />
      </div>
    )
  }
  return <PolicyForm canWrite={canWrite} />
}

function PolicyForm({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient()
  const policyQuery = useQuery({ queryKey: ["portal-policy"], queryFn: fetchPortalPolicyApi, retry: false })
  const connectionsQuery = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiFetch<{ data: ConnectionItem[] }>("/api/channels/connections"),
    retry: false,
  })
  const [saved, setSaved] = useState(false)
  const [form, setForm] = useState<PortalPolicyInput | null>(null)
  const [errors, setErrors] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<PortalPolicyInput | null>(null)

  useEffect(() => {
    if (policyQuery.data && form === null) {
      const { updatedAt: _ignored, ...input } = policyQuery.data
      setForm({ ...input, allowedConnectionIds: [...input.allowedConnectionIds] })
      setBaseline(input)
    }
  }, [policyQuery.data, form])

  const saveMutation = useMutation({
    mutationFn: (input: PortalPolicyInput) => savePortalPolicyApi(input),
    onSuccess: (policy: PortalPolicy, submitted) => {
      const { updatedAt: _ignored, ...input } = policy
      setForm((current) => sameDraft(current, submitted) ? { ...input, allowedConnectionIds: [...input.allowedConnectionIds] } : current)
      setBaseline(input)
      setSaved(true)
      setErrors(null)
      void queryClient.invalidateQueries({ queryKey: ["portal-policy"] })
    },
  })

  if (policyQuery.isPending) return <LoadingState message="Cargando políticas del portal…" />
  if (policyQuery.isError || form === null) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Acceso de pacientes"
          subtitle="Políticas del portal: solicitudes, verificación, vigencias y alcance."
        />
        <ErrorState
          title="No se pudieron cargar las políticas"
          message={mutationMessage(policyQuery.error, "Intenta de nuevo.")}
        />
      </div>
    )
  }

  const set = <K extends keyof PortalPolicyInput>(key: K, value: PortalPolicyInput[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
    setSaved(false)
  }

  function toggleConnection(id: string) {
    setForm((prev) => {
      if (!prev) return prev
      const next = prev.allowedConnectionIds.includes(id)
        ? prev.allowedConnectionIds.filter((c) => c !== id)
        : [...prev.allowedConnectionIds, id]
      return { ...prev, allowedConnectionIds: next }
    })
    setSaved(false)
  }

  function validate(): string | null {
    const current = form
    if (current === null) return "Las políticas aún no terminan de cargar."
    if (!Number.isInteger(current.linkTtlMinutes) || current.linkTtlMinutes < 1 || current.linkTtlMinutes > 43200)
      return "La vigencia del enlace debe estar entre 1 y 43200 minutos."
    if (!Number.isInteger(current.sessionTtlHours) || current.sessionTtlHours < 1 || current.sessionTtlHours > 168)
      return "La vigencia de la sesión debe estar entre 1 y 168 horas."
    if (
      current.grantTtlDays !== null &&
      (!Number.isInteger(current.grantTtlDays) || current.grantTtlDays < 1 || current.grantTtlDays > 3650)
    )
      return "La vigencia del permiso debe estar entre 1 y 3650 días, o vacía para sin caducidad."
    return null
  }

  function onSave() {
    const current = form
    if (current === null || !canWrite) return
    const problem = validate()
    setErrors(problem)
    if (problem) return
    saveMutation.mutate(current)
  }

  const connections = connectionsQuery.data?.data ?? []

  return (
    <div className="flex flex-col gap-5">
      <PageDraftGuard dirty={form !== null && !sameDraft(
        { ...form, allowedConnectionIds: [...form.allowedConnectionIds].sort() },
        baseline && { ...baseline, allowedConnectionIds: [...baseline.allowedConnectionIds].sort() },
      )} />
      <PageHeader
        title="Acceso de pacientes"
        subtitle="Políticas del portal: solicitudes, verificación, vigencias y alcance. La emisión y los permisos por paciente se gestionan en la ficha del paciente."
      />
      {!canWrite && (
        <p className="text-sm text-muted-foreground" role="note">
          Solo lectura: necesitas settings.write para guardar cambios.
        </p>
      )}

      <section className="grid gap-3 rounded-md border p-4" aria-labelledby="portal-policy-estado">
        <h2 id="portal-policy-estado" className="text-sm font-medium">Estado</h2>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={form.enabled}
            disabled={!canWrite}
            onCheckedChange={(v) => set("enabled", v === true)}
          />
          <span>
            Portal habilitado
            <span className="block text-muted-foreground">
              Apagado: no se emiten enlaces, ni se canjean, ni se aceptan solicitudes o passkeys.
            </span>
          </span>
        </label>
      </section>

      <section className="grid gap-3 rounded-md border p-4" aria-labelledby="portal-policy-solicitudes">
        <h2 id="portal-policy-solicitudes" className="text-sm font-medium">Solicitudes iniciadas por el paciente</h2>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={form.requestsEnabled}
            disabled={!canWrite}
            onCheckedChange={(v) => set("requestsEnabled", v === true)}
          />
          <span>
            Aceptar solicitudes
            <span className="block text-muted-foreground">
              Interruptor global. Las solicitudes nunca revelan si el paciente existe ni crean pacientes.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={form.publicRequestsEnabled}
            disabled={!canWrite || !form.requestsEnabled}
            onCheckedChange={(v) => set("publicRequestsEnabled", v === true)}
          />
          <span>
            Vía web pública
            <span className="block text-muted-foreground">
              Formulario público con identificación explícita de la organización.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={form.channelRequestsEnabled}
            disabled={!canWrite || !form.requestsEnabled}
            onCheckedChange={(v) => set("channelRequestsEnabled", v === true)}
          />
          <span>
            Vía conversaciones oficiales
            <span className="block text-muted-foreground">
              Solo mensajes explícitos en conexiones autorizadas. Sin datos clínicos en el canal.
            </span>
          </span>
        </label>
        <div className="grid gap-2">
          <Label>Conexiones autorizadas para solicitudes por canal</Label>
          {connectionsQuery.isPending ? (
            <LoadingState message="Cargando conexiones…" />
          ) : connectionsQuery.isError ? (
            <p className="text-sm text-muted-foreground" role="alert">
              No se pudieron cargar las conexiones. Puedes guardar el resto de la política.
            </p>
          ) : connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Sin conexiones. Configúralas en Canales antes de autorizar la vía de conversaciones.
            </p>
          ) : (
            <div className="grid gap-1">
              {connections.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.allowedConnectionIds.includes(c.id)}
                    disabled={!canWrite}
                    onCheckedChange={() => toggleConnection(c.id)}
                  />
                  {c.displayName} · {c.channel}
                </label>
              ))}
            </div>
          )}
          {form.channelRequestsEnabled && form.allowedConnectionIds.length === 0 && (
            <p className="text-sm text-muted-foreground" role="note">
              Sin conexiones autorizadas la vía de conversaciones queda inoperante.
            </p>
          )}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={form.autoApproveVerified}
            disabled={!canWrite}
            onCheckedChange={(v) => set("autoApproveVerified", v === true)}
          />
          <span>
            Aprobación automática solo con identidad ya verificada
            <span className="block text-muted-foreground">
              Apagado: el personal verifica cada solicitud a mano. Encendido: solo se aprueba si ya
              existe identidad verificada (permiso o vínculo verificado previo). {VERIFIED_METHODS_HELP}
            </span>
          </span>
        </label>
      </section>

      <section className="grid gap-3 rounded-md border p-4" aria-labelledby="portal-policy-vigencias">
        <h2 id="portal-policy-vigencias" className="text-sm font-medium">Vigencias</h2>
        <div className="grid gap-2">
          <Label htmlFor="portal-policy-link-ttl">Enlace de activación (minutos, 1–43200)</Label>
          <Input
            id="portal-policy-link-ttl"
            inputMode="numeric"
            value={String(form.linkTtlMinutes)}
            disabled={!canWrite}
            onChange={(e) => {
              const next = Number(e.target.value.replace(/\D/g, ""))
              set("linkTtlMinutes", Number.isSafeInteger(next) ? next : form.linkTtlMinutes)
            }}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="portal-policy-session-ttl">Sesión (horas, 1–168)</Label>
          <Input
            id="portal-policy-session-ttl"
            inputMode="numeric"
            value={String(form.sessionTtlHours)}
            disabled={!canWrite}
            onChange={(e) => {
              const next = Number(e.target.value.replace(/\D/g, ""))
              set("sessionTtlHours", Number.isSafeInteger(next) ? next : form.sessionTtlHours)
            }}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="portal-policy-grant-ttl">Permiso persistente (días, 1–3650; vacío = sin caducidad)</Label>
          <Input
            id="portal-policy-grant-ttl"
            inputMode="numeric"
            placeholder="Sin caducidad"
            value={form.grantTtlDays === null ? "" : String(form.grantTtlDays)}
            disabled={!canWrite}
            onChange={(e) => {
              const raw = e.target.value.replace(/\D/g, "")
              set("grantTtlDays", raw === "" ? null : Number(raw))
            }}
          />
        </div>
      </section>

      <section className="grid gap-3 rounded-md border p-4" aria-labelledby="portal-policy-alcance">
        <h2 id="portal-policy-alcance" className="text-sm font-medium">Alcance máximo permitido</h2>
        <p className="text-sm text-muted-foreground">
          Tope para emisiones y aprobaciones: un permiso nunca puede exceder lo marcado aquí.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={form.allowedScope.appointments}
            disabled={!canWrite}
            onCheckedChange={(v) =>
              set("allowedScope", { ...form.allowedScope, appointments: v === true })
            }
          />
          Citas
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={form.allowedScope.budgets}
            disabled={!canWrite}
            onCheckedChange={(v) => set("allowedScope", { ...form.allowedScope, budgets: v === true })}
          />
          Presupuestos
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={form.allowedScope.account}
            disabled={!canWrite}
            onCheckedChange={(v) => set("allowedScope", { ...form.allowedScope, account: v === true })}
          />
          Cuenta y saldo
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={form.allowedScope.documents}
            disabled={!canWrite}
            onCheckedChange={(v) => set("allowedScope", { ...form.allowedScope, documents: v === true })}
          />
          Documentos
        </label>
      </section>

      <section className="grid gap-3 rounded-md border p-4" aria-labelledby="portal-policy-acceso">
        <h2 id="portal-policy-acceso" className="text-sm font-medium">Acceso repetido y recuperación</h2>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={form.passkeysEnabled}
            disabled={!canWrite}
            onCheckedChange={(v) => set("passkeysEnabled", v === true)}
          />
          <span>
            Passkeys para accesos repetidos
            <span className="block text-muted-foreground">
              El paciente registra su dispositivo tras activar con enlace y código; luego entra con su
              passkey y elige entre sus pacientes autorizados.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={form.assistedRecoveryEnabled}
            disabled={!canWrite}
            onCheckedChange={(v) => set("assistedRecoveryEnabled", v === true)}
          />
          <span>
            Código asistido para activación y recuperación
            <span className="block text-muted-foreground">
              El código de 6 dígitos solo activa o recupera con ayuda del personal, por vía
              independiente del mensaje. Nunca sirve como acceso repetido.
            </span>
          </span>
        </label>
      </section>

      {errors && (
        <ErrorState title="Revisa los valores" message={errors} />
      )}
      {saveMutation.isError && (
        <ErrorState
          title="No se pudo guardar"
          message={mutationMessage(saveMutation.error, "Revisa los datos e intenta de nuevo.")}
        />
      )}
      {saved && (
        <p className="text-sm text-muted-foreground" role="status">
          Políticas guardadas.
        </p>
      )}
      <div>
        <SubmitButton pending={saveMutation.isPending} disabled={!canWrite} onClick={onSave}>
          Guardar políticas
        </SubmitButton>
      </div>
    </div>
  )
}

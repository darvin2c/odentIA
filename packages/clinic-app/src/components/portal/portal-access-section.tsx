import { Badge, Button, Checkbox, Field, FieldDescription, FieldLabel, FieldLegend, FieldSet, RadioGroup, RadioGroupItem } from "@odentia/ui"
import { ConfirmDialog, EmptyState, ErrorState, FormDrawer, LoadingState, SkeletonRegion } from "@odentia/ui-patterns"
import { PortalAccessSkeleton } from "../skeletons/person-sections"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import type { PatientDocument } from "../../lib/patients"
import {
  changePortalAccessApi,
  fetchPortalAccessApi,
  formatPortalDate,
  givePortalAccessApi,
  type PortalAccessGiven,
  type PortalAccessRow,
  type PortalAccessScopeDraft,
  type PortalAccessSummary,
  type PortalScope,
  resendPortalAccessApi,
  revokePortalAccessApi,
} from "../../lib/portal"

/** «Citas, presupuestos y documentos»: lo que verá, dicho como en la fila. */
export function scopeText(scope: PortalScope): string {
  const parts = [
    scope.appointments ? "citas" : null,
    scope.budgets ? "presupuestos" : null,
    scope.documents.length > 0 ? "documentos" : null,
    scope.account ? "su cuenta" : null,
  ].filter((part): part is string => part !== null)
  if (parts.length === 0) return "Nada por ahora"
  const text = parts.length === 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function problemOf(error: unknown): string | null {
  if (!error) return null
  return error instanceof ApiError ? (error.shape.message ?? "No pudimos completar la acción.") : "No pudimos completar la acción. Revisa tu conexión."
}

/**
 * Datos › Acceso al portal (decisión 9, ADR 0037): una sola fila por quien
 * entra, en lugar de las listas de permisos, sesiones y llaves. «Dar acceso al
 * portal» son cuatro preguntas en una pantalla; «Cambiar» lo que verá;
 * «Enviar nuevo enlace» para volver a entrar, sin volver a comprobar su
 * identidad; «Quitar acceso» cierra todo. Lo que se puede compartir lo decide
 * el servidor con los permisos de quien lo da.
 */
export function PatientPortalAccessSection({ patientId }: { patientId: string }) {
  const canManage = usePermission("patients.write")
  const canConfigure = usePermission("settings.write")
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const key = ["portal-access", patientId]
  const query = useQuery({ queryKey: key, queryFn: () => fetchPortalAccessApi(patientId), enabled: canManage, retry: false })
  const [drawer, setDrawer] = useState<{ kind: "give" } | { kind: "change" | "resend"; row: PortalAccessRow } | null>(null)
  const [revoking, setRevoking] = useState<PortalAccessRow | null>(null)
  const revoke = useMutation({
    mutationFn: (grantId: string) => revokePortalAccessApi(grantId),
    onSuccess: () => {
      setRevoking(null)
      void queryClient.invalidateQueries({ queryKey: key })
    },
  })
  if (!canManage) {
    return <EmptyState title="Acceso al portal" description="El acceso de un paciente al portal lo gestiona quien puede editar su ficha." />
  }
  if (query.isPending)
    return (
      <SkeletonRegion message="Cargando el acceso al portal…">
        <PortalAccessSkeleton />
      </SkeletonRegion>
    )
  if (query.isError) return <ErrorState title="No pudimos cargar el acceso al portal" message={problemOf(query.error) ?? ""} onRetry={() => void query.refetch()} />
  const summary = query.data
  if (!summary.enabled) {
    return (
      <EmptyState
        title="El portal está apagado"
        description="«Su enlace» cubre la cita, los datos y el presupuesto. Encienda el portal si sus pacientes piden ver sus documentos cuando quieran."
        actionLabel={canConfigure ? "Encender el portal" : undefined}
        onAction={canConfigure ? () => void navigate({ to: "/settings/patient-access" }) : undefined}
      />
    )
  }
  const pendingCandidates = summary.candidates.filter((candidate) => !summary.access.some((row) => row.contactId === candidate.contactId))
  return (
    <section aria-label="Acceso al portal" className="flex flex-col gap-3">
      {summary.access.length === 0 ? (
        <EmptyState
          title="Sin acceso al portal"
          description="Con el portal ve sus citas, presupuestos y documentos cuando quiera. Se da en persona, con su documento."
          actionLabel={summary.candidates.length > 0 ? "Dar acceso al portal" : undefined}
          onAction={summary.candidates.length > 0 ? () => setDrawer({ kind: "give" }) : undefined}
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {summary.access.map((row) => (
            <li key={row.grantId} className="flex flex-wrap items-center gap-3 p-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-sm font-medium">
                  {row.name}
                  {row.relation === "representante" ? " (representante)" : ""} · {scopeText(row.scope)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {[
                    row.saved ? "Acceso guardado en su teléfono" : "Aún no guardó su acceso",
                    row.lastEntryAt ? `entró el ${formatPortalDate(row.lastEntryAt)}` : "aún no entra",
                  ].join(" · ")}
                </p>
                {row.reentryRequested ? (
                  <Badge variant="secondary" className="self-start">
                    Pidió volver a entrar
                  </Badge>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant={row.reentryRequested ? "default" : "outline"} size="sm" onClick={() => setDrawer({ kind: "resend", row })}>
                  Enviar nuevo enlace
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setDrawer({ kind: "change", row })}>
                  Cambiar
                </Button>
                <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setRevoking(row)}>
                  Quitar acceso
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {summary.access.length > 0 && pendingCandidates.length > 0 ? (
        <Button type="button" variant="outline" className="self-start" onClick={() => setDrawer({ kind: "give" })}>
          Dar acceso a otra persona
        </Button>
      ) : null}
      {summary.candidates.length === 0 && summary.access.length === 0 ? (
        <p className="text-sm text-muted-foreground">Entra la propia persona si es mayor de edad, o su representante legal si es menor. Registre a su representante en «Responsables».</p>
      ) : null}
      {drawer ? (
        <AccessDrawer
          patientId={patientId}
          summary={summary}
          mode={drawer}
          onClose={() => {
            setDrawer(null)
            void queryClient.invalidateQueries({ queryKey: key })
          }}
        />
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        title={`¿Quitar el acceso de ${revoking?.name ?? ""}?`}
        description="Se cierra todo: sus sesiones, su acceso guardado y los enlaces sin usar. Para volver a entrar habrá que darle acceso otra vez."
        confirmLabel="Quitar acceso"
        variant="destructive"
        pending={revoke.isPending}
        onClose={() => {
          if (!revoke.isPending) setRevoking(null)
        }}
        onConfirm={() => revoking && revoke.mutate(revoking.grantId)}
      />
      {revoke.isError ? <p className="text-sm text-destructive">{problemOf(revoke.error)}</p> : null}
    </section>
  )
}

/** El QR del enlace (una sola vez) y el código, que se dice aparte. */
function Delivered({ given }: { given: PortalAccessGiven }) {
  const qr = useQuery({
    queryKey: ["portal-qr", given.grantId, given.activationUrlOnce],
    // Importación dinámica: qrcode no debe entrar al bundle inicial.
    queryFn: async () => {
      const { default: QRCode } = await import("qrcode")
      return QRCode.toDataURL(given.activationUrlOnce ?? "", { width: 512, margin: 4, errorCorrectionLevel: "M" })
    },
    enabled: given.activationUrlOnce !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  return (
    <div className="flex flex-col gap-4" role="status">
      {given.activationUrlOnce ? (
        <div className="flex flex-col items-center gap-2">
          {qr.data ? <img src={qr.data} alt="Código QR para entrar al portal" className="size-56 rounded-lg border bg-white" /> : <LoadingState message="Generando el QR…" />}
          <p className="text-center text-sm text-muted-foreground">Que lo escanee con la cámara de su teléfono. Sirve una sola vez y vale 3 días.</p>
        </div>
      ) : (
        <p className="text-sm">Le enviamos el enlace por WhatsApp{given.sentTo ? ` a ${given.sentTo}` : ""}. Vale 3 días.</p>
      )}
      <div className="flex flex-col items-center gap-1 rounded-xl bg-muted p-4">
        <p className="text-sm text-muted-foreground">Su código</p>
        <p className="font-mono text-3xl font-semibold tracking-widest">{given.pinOnce}</p>
        <p className="text-center text-sm text-muted-foreground">Díselo en persona o por llamada. Nunca va con el enlace: tener su chat no prueba que sea ella.</p>
      </div>
    </div>
  )
}

/** Lo que verá: lo que la clínica permite y quien lo da puede compartir. */
function ScopeFields({ summary, draft, onChange, patientId }: { summary: PortalAccessSummary; draft: PortalAccessScopeDraft; onChange: (next: PortalAccessScopeDraft) => void; patientId: string }) {
  const allowed = summary.allowedScope
  const docs = useQuery({
    queryKey: ["portal-documents", patientId],
    queryFn: () => apiFetch<{ data: PatientDocument[] }>(`/api/patients/${patientId}/documents`),
    enabled: allowed.documents && summary.rights.canShareDocuments,
    retry: false,
  })
  const box = (key: "appointments" | "budgets" | "account", label: string, can: boolean) =>
    allowed[key] && can ? (
      <label key={key} htmlFor={`portal-scope-${key}`} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <Checkbox id={`portal-scope-${key}`} checked={draft[key] === true} onCheckedChange={(next) => onChange({ ...draft, [key]: next === true })} />
        {label}
      </label>
    ) : null
  const documents = (docs.data?.data ?? []).filter((doc) => !doc.retiredAt)
  const chosen = new Set(draft.documentIds ?? [])
  return (
    <FieldSet>
      <FieldLegend variant="label">Qué verá</FieldLegend>
      {box("appointments", "Sus citas", true)}
      {box("budgets", "Sus presupuestos", summary.rights.canShareBudgets)}
      {box("account", "Su cuenta", summary.rights.canShareAccount)}
      {allowed.documents && summary.rights.canShareDocuments ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Documentos</p>
          {docs.isPending ? (
            <LoadingState message="Cargando documentos…" />
          ) : documents.length === 0 ? (
            <FieldDescription>Aún no tiene documentos.</FieldDescription>
          ) : (
            documents.map((doc) => (
              <label key={doc.id} htmlFor={`portal-doc-${doc.id}`} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                <Checkbox
                  id={`portal-doc-${doc.id}`}
                  checked={chosen.has(doc.id)}
                  onCheckedChange={(next) => {
                    const copy = new Set(chosen)
                    if (next === true) copy.add(doc.id)
                    else copy.delete(doc.id)
                    onChange({ ...draft, documentIds: [...copy] })
                  }}
                />
                {doc.label}
              </label>
            ))
          )}
        </div>
      ) : null}
    </FieldSet>
  )
}

function draftOf(scope: PortalScope): PortalAccessScopeDraft {
  return { appointments: scope.appointments, budgets: scope.budgets, account: scope.account, documentIds: scope.documents }
}

function AccessDrawer({
  patientId,
  summary,
  mode,
  onClose,
}: {
  patientId: string
  summary: PortalAccessSummary
  mode: { kind: "give" } | { kind: "change" | "resend"; row: PortalAccessRow }
  onClose: () => void
}) {
  const free = summary.candidates.filter((candidate) => !summary.access.some((row) => row.contactId === candidate.contactId))
  const [contactId, setContactId] = useState(mode.kind === "give" ? (free[0]?.contactId ?? "") : mode.row.contactId)
  const [scope, setScope] = useState<PortalAccessScopeDraft>(
    mode.kind === "give" ? { appointments: summary.allowedScope.appointments, budgets: summary.allowedScope.budgets && summary.rights.canShareBudgets, documentIds: [] } : draftOf(mode.row.scope),
  )
  const [checked, setChecked] = useState(false)
  const navigate = useNavigate()
  const candidate = summary.candidates.find((item) => item.contactId === contactId)
  const [delivery, setDelivery] = useState<"qr" | "whatsapp">("qr")
  const [given, setGiven] = useState<PortalAccessGiven | null>(null)
  const act = useMutation({
    mutationFn: async () => {
      if (mode.kind === "give") return givePortalAccessApi({ patientId, contactId, scope, identityChecked: checked, delivery })
      if (mode.kind === "resend") return resendPortalAccessApi(mode.row.grantId, delivery)
      await changePortalAccessApi(mode.row.grantId, scope)
      return null
    },
    onSuccess: (result) => {
      if (result) setGiven(result)
      else onClose()
    },
  })
  const title = mode.kind === "give" ? "Dar acceso al portal" : mode.kind === "resend" ? `Enviar nuevo enlace a ${mode.row.name}` : `Cambiar lo que ve ${mode.row.name}`
  const anything = scope.appointments || scope.budgets || scope.account || (scope.documentIds?.length ?? 0) > 0
  const ready = mode.kind === "give" ? contactId !== "" && !!candidate?.document && checked && anything : mode.kind === "change" ? anything : true
  const whatsappReady = candidate?.whatsappReady ?? false

  if (given) {
    return (
      <FormDrawer open onClose={onClose} title={title} onSubmit={(event) => event.preventDefault()} hideSubmit cancelLabel="Listo">
        <Delivered given={given} />
      </FormDrawer>
    )
  }
  return (
    <FormDrawer
      open
      onClose={onClose}
      title={title}
      description={mode.kind === "resend" ? "Para volver a entrar. Su acceso sigue vigente: no hace falta volver a comprobar su identidad." : undefined}
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) act.mutate()
      }}
      isSubmitting={act.isPending}
      submitDisabled={!ready}
      error={problemOf(act.error)}
      submitLabel={mode.kind === "give" ? "Dar acceso" : mode.kind === "resend" ? "Enviar" : "Guardar"}
      dock={false}
    >
      <div className="flex flex-col gap-5">
        {mode.kind === "give" ? (
          <FieldSet>
            <FieldLegend variant="label">¿Quién entra?</FieldLegend>
            <RadioGroup
              value={contactId}
              onValueChange={(value) => {
                setContactId(typeof value === "string" ? value : "")
                setChecked(false)
              }}
            >
              {free.map((item) => (
                <label key={item.contactId} htmlFor={`portal-who-${item.contactId}`} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                  <RadioGroupItem id={`portal-who-${item.contactId}`} value={item.contactId} />
                  {item.name} {item.relation === "self" ? "(la propia persona)" : "(representante legal)"}
                </label>
              ))}
            </RadioGroup>
          </FieldSet>
        ) : null}
        {mode.kind !== "resend" ? <ScopeFields summary={summary} draft={scope} onChange={setScope} patientId={patientId} /> : null}
        {mode.kind === "give" ? (
          candidate?.document ? (
            <label htmlFor="portal-identity" className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <Checkbox id="portal-identity" checked={checked} onCheckedChange={(next) => setChecked(next === true)} />
              Comprobé su identidad: vi su {candidate.document}
            </label>
          ) : candidate ? (
            // Sin documento no se comprueba en persona: «Completar» lleva a sus datos.
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm">
              <span>Primero completa su documento.</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  onClose()
                  void navigate({ to: "/people/$personId", params: { personId: candidate.contactId }, search: { tab: "filiacion" } as never })
                }}
              >
                Completar
              </Button>
            </div>
          ) : null
        ) : null}
        {mode.kind !== "change" ? (
          <Field>
            <FieldLabel>¿Cómo le llega?</FieldLabel>
            <RadioGroup value={delivery} onValueChange={(value) => setDelivery(value === "whatsapp" ? "whatsapp" : "qr")}>
              <label htmlFor="portal-delivery-qr" className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                <RadioGroupItem id="portal-delivery-qr" value="qr" />
                Está aquí: mostrar QR
              </label>
              <label htmlFor="portal-delivery-whatsapp" className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                <RadioGroupItem id="portal-delivery-whatsapp" value="whatsapp" disabled={!whatsappReady} />
                Por su WhatsApp
              </label>
            </RadioGroup>
            {!whatsappReady ? <FieldDescription>Por WhatsApp solo si escribió en las últimas 24 horas.</FieldDescription> : null}
            <FieldDescription>El código de 6 dígitos se lo dices tú, en persona o por llamada.</FieldDescription>
          </Field>
        ) : null}
      </div>
    </FormDrawer>
  )
}

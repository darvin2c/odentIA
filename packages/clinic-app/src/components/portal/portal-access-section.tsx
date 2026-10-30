import { Badge, Button, Checkbox, FieldDescription, RadioGroup, RadioGroupItem } from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
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
  if (query.isPending) return <LoadingState message="Cargando el acceso al portal…" />
  if (query.isError) return <ErrorState title="No pudimos cargar el acceso al portal" error={query.error} onRetry={() => void query.refetch()} />
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
        error={revoke.error ? submitErrorMessage(revoke.error) : null}
        onClose={() => {
          if (revoke.isPending) return
          revoke.reset()
          setRevoking(null)
        }}
        onConfirm={() => revoking && revoke.mutate(revoking.grantId)}
      />
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
function ScopeOptions({
  summary,
  draft,
  onChange,
  patientId,
  invalid,
}: {
  summary: PortalAccessSummary
  draft: PortalAccessScopeDraft
  onChange: (next: PortalAccessScopeDraft) => void
  patientId: string
  invalid: boolean
}) {
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
        <Checkbox
          id={`portal-scope-${key}`}
          checked={draft[key] === true}
          aria-invalid={invalid || undefined}
          onCheckedChange={(next) => onChange({ ...draft, [key]: next === true })}
        />
        {label}
      </label>
    ) : null
  const documents = (docs.data?.data ?? []).filter((doc) => !doc.retiredAt)
  const chosen = new Set(draft.documentIds ?? [])
  return (
    <>
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
                  aria-invalid={invalid || undefined}
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
    </>
  )
}

function draftOf(scope: PortalScope): PortalAccessScopeDraft {
  return { appointments: scope.appointments, budgets: scope.budgets, account: scope.account, documentIds: scope.documents }
}

type AccessMode = { kind: "give" } | { kind: "change" | "resend"; row: PortalAccessRow }

/**
 * Lo que hace falta para dar acceso, cambiarlo o reenviarlo, dicho en su
 * grupo: quién entra (y que tenga su documento), qué verá y la comprobación
 * de identidad. Reenviar no pide nada más que cómo le llega.
 */
function accessSchema(mode: AccessMode, summary: PortalAccessSummary) {
  return z
    .object({
      contactId: z.string(),
      scope: z.custom<PortalAccessScopeDraft>(),
      identityChecked: z.boolean(),
      delivery: z.enum(["qr", "whatsapp"]),
    })
    .superRefine((value, ctx) => {
      if (mode.kind === "resend") return
      const scope = value.scope
      if (!(scope.appointments || scope.budgets || scope.account || (scope.documentIds?.length ?? 0) > 0))
        ctx.addIssue({ code: "custom", path: ["scope"], message: "Elige al menos una cosa que verá." })
      if (mode.kind !== "give") return
      const candidate = summary.candidates.find((item) => item.contactId === value.contactId)
      if (!candidate) ctx.addIssue({ code: "custom", path: ["contactId"], message: "Elige quién entra." })
      else if (!candidate.document)
        ctx.addIssue({ code: "custom", path: ["contactId"], message: "Primero completa su documento." })
      else if (!value.identityChecked)
        ctx.addIssue({ code: "custom", path: ["identityChecked"], message: "Marca que comprobaste su identidad con su documento." })
    })
}

function AccessDrawer({
  patientId,
  summary,
  mode,
  onClose,
}: {
  patientId: string
  summary: PortalAccessSummary
  mode: AccessMode
  onClose: () => void
}) {
  const free = summary.candidates.filter((candidate) => !summary.access.some((row) => row.contactId === candidate.contactId))
  const navigate = useNavigate()
  const [given, setGiven] = useState<PortalAccessGiven | null>(null)
  const act = useMutation({
    mutationFn: async (value: {
      contactId: string
      scope: PortalAccessScopeDraft
      identityChecked: boolean
      delivery: "qr" | "whatsapp"
    }) => {
      if (mode.kind === "give")
        return givePortalAccessApi({ patientId, contactId: value.contactId, scope: value.scope, identityChecked: value.identityChecked, delivery: value.delivery })
      if (mode.kind === "resend") return resendPortalAccessApi(mode.row.grantId, value.delivery)
      await changePortalAccessApi(mode.row.grantId, value.scope)
      return null
    },
  })
  const form = useAppForm({
    defaultValues: {
      contactId: mode.kind === "give" ? (free[0]?.contactId ?? "") : mode.row.contactId,
      scope:
        mode.kind === "give"
          ? ({ appointments: summary.allowedScope.appointments, budgets: summary.allowedScope.budgets && summary.rights.canShareBudgets, documentIds: [] } as PortalAccessScopeDraft)
          : draftOf(mode.row.scope),
      identityChecked: false,
      delivery: "qr" as "qr" | "whatsapp",
    },
    validators: { onSubmit: accessSchema(mode, summary) },
    onSubmit: async ({ value }) => {
      const result = await act.mutateAsync(value)
      if (result) setGiven(result)
      else onClose()
    },
  })
  const surface = useFormSurface(form)
  const contactId = useStore(form.store, (state) => state.values.contactId)
  const candidate = summary.candidates.find((item) => item.contactId === contactId)
  const title = mode.kind === "give" ? "Dar acceso al portal" : mode.kind === "resend" ? `Enviar nuevo enlace a ${mode.row.name}` : `Cambiar lo que ve ${mode.row.name}`
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
      {...surface}
      open
      onClose={onClose}
      title={title}
      description={mode.kind === "resend" ? "Para volver a entrar. Su acceso sigue vigente: no hace falta volver a comprobar su identidad." : undefined}
      submitLabel={mode.kind === "give" ? "Dar acceso" : mode.kind === "resend" ? "Enviar" : "Guardar"}
      dock={false}
    >
      <div className="flex flex-col gap-5">
        {mode.kind === "give" ? (
          <form.AppField name="contactId">
            {(field) => (
              <field.Group legend="¿Quién entra?">
                {(control) => (
                  <RadioGroup
                    name={control.name}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    value={field.state.value}
                    onValueChange={(value) => {
                      field.handleChange(typeof value === "string" ? value : "")
                      field.handleBlur()
                      form.setFieldValue("identityChecked", false)
                    }}
                  >
                    {free.map((item) => (
                      <label key={item.contactId} htmlFor={`portal-who-${item.contactId}`} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                        <RadioGroupItem id={`portal-who-${item.contactId}`} value={item.contactId} aria-invalid={control.invalid || undefined} />
                        {item.name} {item.relation === "self" ? "(la propia persona)" : "(representante legal)"}
                      </label>
                    ))}
                  </RadioGroup>
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
        {mode.kind !== "resend" ? (
          <form.AppField name="scope">
            {(field) => (
              <field.Group legend="Qué verá">
                {(control) => (
                  <ScopeOptions
                    summary={summary}
                    draft={field.state.value}
                    invalid={control.invalid}
                    onChange={(next) => {
                      field.handleChange(next)
                      field.handleBlur()
                    }}
                    patientId={patientId}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
        {mode.kind === "give" ? (
          candidate?.document ? (
            <form.AppField name="identityChecked">
              {(field) => <field.CheckboxField id="portal-identity" label={`Comprobé su identidad: vi su ${candidate.document}`} />}
            </form.AppField>
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
          <form.AppField name="delivery">
            {(field) => (
              <field.Group legend="¿Cómo le llega?">
                {(control) => (
                  <>
                    <RadioGroup
                      name={control.name}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      value={field.state.value}
                      onValueChange={(value) => {
                        field.handleChange(value === "whatsapp" ? "whatsapp" : "qr")
                        field.handleBlur()
                      }}
                    >
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
                  </>
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
      </div>
    </FormDrawer>
  )
}

import { Badge, Button, FieldDescription, RadioGroup, RadioGroupItem } from "@odentia/ui"
import {
  ConfirmDialog,
  DetailDrawer,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useId, useState } from "react"
import { z } from "zod"
import { usePermission } from "../../lib/crm"
import {
  fetchPortalAccessApi,
  formatPortalDate,
  givePortalAccessApi,
  type PortalAccessGiven,
  type PortalAccessRow,
  type PortalAccessSummary,
  portalSeesText,
  resendPortalAccessApi,
  revokePortalAccessApi,
} from "../../lib/portal"
import { PersonalLinkSummary } from "../patient/send-personal-link"
import { PortalAccessSkeleton } from "../skeletons/person-sections"

/**
 * Datos › Enlace y portal (decisión 9, ADR 0037): primero su enlace; después, una sola fila por quien
 * entra, en lugar de las listas de permisos, sesiones y llaves. «Dar acceso al
 * portal» son tres preguntas en una pantalla (quién entra, comprobé su
 * identidad, cómo le llega); lo que verá no se elige (ADR 0152): es todo lo
 * suyo, con el límite de la clínica, y se dice en una línea. «Enviar nuevo
 * enlace» para volver a entrar, sin volver a comprobar su identidad (el
 * anterior deja de servir); «Quitar acceso» cierra todo.
 */
export function PatientPortalAccessSection({
  patientId,
  withLink = true,
}: {
  patientId: string
  /** Sin «Su enlace»: abierta desde «Portal del paciente» del «…», que ya tiene el suyo. */
  withLink?: boolean
}) {
  // Dar el acceso, mostrar el QR, decir el código y quitarlo es de quien ve la historia
  // (ADR 0152); recepción solo envía el enlace de un acceso ya dado por su WhatsApp.
  const canGive = usePermission("clinical.read")
  const canEditRecord = usePermission("patients.write")
  const canManage = canGive || canEditRecord
  const canConfigure = usePermission("settings.write")
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const key = ["portal-access", patientId]
  const query = useQuery({ queryKey: key, queryFn: () => fetchPortalAccessApi(patientId), enabled: canManage, retry: false })
  const [drawer, setDrawer] = useState<{ kind: "give" } | { kind: "resend"; row: PortalAccessRow } | null>(null)
  const [revoking, setRevoking] = useState<PortalAccessRow | null>(null)
  const uid = useId()
  const revoke = useMutation({
    mutationFn: (grantId: string) => revokePortalAccessApi(grantId),
    onSuccess: () => {
      setRevoking(null)
      void queryClient.invalidateQueries({ queryKey: key })
    },
  })
  if (!canManage) {
    return <EmptyState title="Enlace y portal" description="Su enlace y su acceso al portal los gestiona quien puede editar su ficha." />
  }
  // «Su enlace» va siempre primero: es lo que ya tiene y no depende del portal (ni de que cargue).
  const linkBlock = !withLink || !canEditRecord ? null : (
    <section aria-labelledby={`${uid}-enlace`} className="flex flex-col gap-2 rounded-lg border p-3">
      <h3 id={`${uid}-enlace`} className="text-sm font-medium">
        Su enlace
      </h3>
      <PersonalLinkSummary patientId={patientId} />
    </section>
  )
  const portalTitle = (
    <h3 id={`${uid}-portal`} className="sr-only">
      Portal
    </h3>
  )
  if (query.isPending)
    return (
      <div className="flex flex-col gap-3">
        {linkBlock}
        <SkeletonRegion message="Cargando el acceso al portal…">
          <PortalAccessSkeleton />
        </SkeletonRegion>
      </div>
    )
  if (query.isError)
    return (
      <div className="flex flex-col gap-3">
        {linkBlock}
        <ErrorState title="No pudimos cargar el acceso al portal" error={query.error} onRetry={() => void query.refetch()} />
      </div>
    )
  const summary = query.data
  if (!summary.enabled) {
    return (
      <div className="flex flex-col gap-3">
        {linkBlock}
        <EmptyState
          title="El portal está apagado"
          description={
            canConfigure
              ? "El portal es para que entre cuando quiera a ver además sus documentos. Está apagado para toda la clínica."
              : "El portal es para que entre cuando quiera a ver además sus documentos. Lo enciende quien administra la clínica."
          }
          actionLabel={canConfigure ? "Ir a Configuración" : undefined}
          onAction={canConfigure ? () => void navigate({ to: "/settings/patient-access" }) : undefined}
        />
      </div>
    )
  }
  const pendingCandidates = summary.candidates.filter((candidate) => !summary.access.some((row) => row.contactId === candidate.contactId))
  return (
    <div className="flex flex-col gap-3">
      {linkBlock}
      <section aria-labelledby={`${uid}-portal`} className="flex flex-col gap-3">
        {portalTitle}
        {summary.access.length === 0 ? (
          <EmptyState
            title="Sin acceso al portal"
            description="Con el portal ve lo suyo cuando quiera, desde su teléfono. Se da en persona, con su documento."
            actionLabel={canGive && summary.candidates.length > 0 ? "Dar acceso al portal" : undefined}
            onAction={canGive && summary.candidates.length > 0 ? () => setDrawer({ kind: "give" }) : undefined}
          />
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {summary.access.map((row) => (
              <li key={row.grantId} className="flex flex-wrap items-center gap-3 p-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="text-sm font-medium">
                    {row.name}
                    {row.relation === "representante" ? " (representante legal)" : ""}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {[
                      row.lastEntryAt ? `Entró por última vez el ${formatPortalDate(row.lastEntryAt)}` : "Aún no entra",
                      row.saved ? "acceso guardado en su teléfono" : "aún no guardó su acceso",
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
                  {canGive ? (
                    <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setRevoking(row)}>
                      Quitar acceso
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted-foreground">{portalSeesText(summary.allowedScope)}</p>
        {!canGive ? (
          <p className="text-sm text-muted-foreground">
            El acceso lo da quien puede ver la historia, porque el portal muestra sus documentos. Tú puedes enviarle el enlace por su WhatsApp.
          </p>
        ) : null}
        {canGive && summary.access.length > 0 && pendingCandidates.length > 0 ? (
          <Button type="button" variant="outline" className="self-start" onClick={() => setDrawer({ kind: "give" })}>
            Dar acceso a otra persona
          </Button>
        ) : null}
        {summary.candidates.length === 0 && summary.access.length === 0 ? (
          <p className="text-sm text-muted-foreground">Entra la propia persona si es mayor de edad, o su representante legal si es menor. Registra a su representante en «Responsables».</p>
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
    </div>
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
        <p className="text-sm">
          {given.pinOnce
            ? `Le enviamos el enlace por WhatsApp${given.sentTo ? ` a ${given.sentTo}` : ""}. Vale 3 días.`
            : `Le enviamos el enlace y su código por WhatsApp${given.sentTo ? ` a ${given.sentTo}` : ""}, en dos mensajes. Vale 3 días.`}
        </p>
      )}
      {given.pinOnce ? (
        <div className="flex flex-col items-center gap-1 rounded-xl bg-muted p-4">
          <p className="text-sm text-muted-foreground">Su código</p>
          <p className="font-mono text-3xl font-semibold tracking-widest">{given.pinOnce}</p>
          <p className="text-center text-sm text-muted-foreground">Díselo en persona o por llamada. Nunca va con el enlace: tener su chat no prueba que sea ella.</p>
        </div>
      ) : null}
    </div>
  )
}

type AccessMode = { kind: "give" } | { kind: "resend"; row: PortalAccessRow }

/**
 * «Enviar nuevo enlace» desde «Te espera»: el mismo formulario de la ficha, sin
 * salir de Inicio. Su acceso sigue vigente: no se vuelve a comprobar su identidad.
 */
export function PortalResendDrawer({ patientId, grantId, onClose }: { patientId: string; grantId: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const key = ["portal-access", patientId]
  const query = useQuery({ queryKey: key, queryFn: () => fetchPortalAccessApi(patientId), retry: false })
  const row = query.data?.access.find((item) => item.grantId === grantId) ?? null
  if (!query.data || !row) {
    return (
      <DetailDrawer open title="Enviar nuevo enlace" isLoading={query.isPending} onClose={onClose}>
        {query.isError ? (
          <ErrorState title="No pudimos cargar su acceso" error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isPending ? null : (
          <EmptyState title="Ya no tiene acceso al portal" description="Se lo quitaron desde que se abrió la pantalla." />
        )}
      </DetailDrawer>
    )
  }
  return (
    <AccessDrawer
      patientId={patientId}
      summary={query.data}
      mode={{ kind: "resend", row }}
      onClose={() => {
        void queryClient.invalidateQueries({ queryKey: key })
        onClose()
      }}
    />
  )
}

/**
 * Lo que hace falta para dar acceso o reenviarlo, dicho en su grupo: quién
 * entra (y que tenga su documento) y la comprobación de identidad. Reenviar no
 * pide nada más que cómo le llega.
 */
function accessSchema(mode: AccessMode, summary: PortalAccessSummary) {
  return z
    .object({
      contactId: z.string(),
      identityChecked: z.boolean(),
      delivery: z.enum(["qr", "whatsapp"]),
    })
    .superRefine((value, ctx) => {
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
  const canGive = usePermission("clinical.read")
  const free = summary.candidates.filter((candidate) => !summary.access.some((row) => row.contactId === candidate.contactId))
  const navigate = useNavigate()
  const [given, setGiven] = useState<PortalAccessGiven | null>(null)
  const act = useMutation({
    mutationFn: async (value: { contactId: string; identityChecked: boolean; delivery: "qr" | "whatsapp" }) =>
      mode.kind === "give"
        ? givePortalAccessApi({ patientId, contactId: value.contactId, identityChecked: value.identityChecked, delivery: value.delivery })
        : resendPortalAccessApi(mode.row.grantId, value.delivery),
  })
  const form = useAppForm({
    defaultValues: {
      contactId: mode.kind === "give" ? (free[0]?.contactId ?? "") : mode.row.contactId,
      identityChecked: false,
      // Recepción solo envía por su WhatsApp: el QR y el código no van a su pantalla.
      delivery: (canGive ? "qr" : "whatsapp") as "qr" | "whatsapp",
    },
    validators: { onSubmit: accessSchema(mode, summary) },
    onSubmit: async ({ value }) => {
      setGiven(await act.mutateAsync(value))
    },
  })
  const surface = useFormSurface(form)
  const contactId = useStore(form.store, (state) => state.values.contactId)
  const candidate = summary.candidates.find((item) => item.contactId === contactId)
  const title = mode.kind === "give" ? "Dar acceso al portal" : `Enviar nuevo enlace a ${mode.row.name}`
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
      description={
        mode.kind === "resend"
          ? canGive
            ? "Para volver a entrar. Su acceso sigue vigente: no hace falta volver a comprobar su identidad. El enlace anterior y las sesiones abiertas dejan de servir."
            : "Le llegan por su WhatsApp el enlace y, en otro mensaje, su código: no los verás. El enlace anterior y las sesiones abiertas dejan de servir."
          : undefined
      }
      submitLabel={mode.kind === "give" ? "Dar acceso" : "Enviar"}
      dock={false}
    >
      <div className="flex flex-col gap-5">
        {mode.kind === "give" && free.length === 1 ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">¿Quién entra?</p>
            <p className="text-sm">
              {free[0]?.name} {free[0]?.relation === "self" ? "(la propia persona)" : "(representante legal)"}
            </p>
          </div>
        ) : mode.kind === "give" ? (
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
        {mode.kind === "give" ? (
          candidate?.document ? (
            <form.AppField name="identityChecked">
              {(field) => (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-sm font-medium">¿Comprobaste su identidad?</legend>
                  <field.CheckboxField
                    id="portal-identity"
                    label={`Vi su ${candidate.document} y es la misma persona`}
                    description="Compara el número con el del documento que tiene en la mano."
                  />
                </fieldset>
              )}
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
        {mode.kind === "give" ? (
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm">{portalSeesText(summary.allowedScope)}</p>
        ) : null}
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
                      {canGive ? (
                        <label htmlFor="portal-delivery-qr" className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                          <RadioGroupItem id="portal-delivery-qr" value="qr" />
                          Está aquí: mostrar QR
                        </label>
                      ) : null}
                    <label htmlFor="portal-delivery-whatsapp" className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
                      <RadioGroupItem id="portal-delivery-whatsapp" value="whatsapp" disabled={!whatsappReady} className="mt-0.5" />
                      <span className="flex flex-col gap-0.5">
                        Por su WhatsApp
                        {!whatsappReady ? (
                          <span className="text-muted-foreground">No sale: no te escribió en las últimas 24 horas. Muéstrale el QR, o pídele que te escriba.</span>
                        ) : null}
                      </span>
                    </label>
                  </RadioGroup>
                    <FieldDescription>
                      {canGive
                        ? "El código de 6 dígitos se lo dices tú, en persona o por llamada."
                        : "El código de 6 dígitos le llega en otro mensaje de su WhatsApp."}
                    </FieldDescription>
                </>
              )}
            </field.Group>
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

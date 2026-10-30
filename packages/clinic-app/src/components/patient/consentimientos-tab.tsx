import { Button, buttonVariants, toast } from "@odentia/ui"
import {
  applySubmitError,
  ConfirmDialog,
  clearSubmitErrors,
  FormDrawer,
  focusFirstInvalid,
  LoadingState,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useId, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import {
  type ConsentDocument,
  cancelConsent,
  consentSignatureWords,
  createConsent,
  fetchConsentHistory,
  fetchConsentTemplates,
  generateConsentPdf,
  revokeConsent,
} from "../../lib/clinical-forms"
import { DiagnosisSearch } from "./diagnosis-search"
import { ConsentSheet } from "./consent-sheet"
import { ConsentSigningScreen, PaperSignDrawer, type SignerChoice, useSignerChoices } from "./consent-signing"
import { FirmaPad } from "./firma-pad"
import { activeOrgLocale } from "../../lib/locale"
import { ConsentLinkActions, consentLinkWords } from "./consent-link-actions"
import { appWords } from "../../lib/product-words"

const cancelSchema = z.object({
  reason: z.string().trim().min(1, "Escribe el motivo").max(2000, "Escribe como mucho 2000 caracteres."),
})

const EVENT_LABELS: Record<string, string> = {
  pendiente: "Creado (pendiente de firma)",
  informado: "Informado por el profesional",
  firmado: "Firmado",
  revocado: "Revocado",
  anulado: "Anulado",
}

interface NewConsentValues {
  templateId: string
  procedureRef: string
  diagnosisCode: string
  diagnosisSystem: string | null
}

/** Los mismos límites que `consentCreate` de la API. */
const newConsentSchema = z.object({
  templateId: z.string().min(1, "Elige una plantilla publicada"),
  procedureRef: z.string().trim().max(500, "Escribe como mucho 500 caracteres."),
  diagnosisCode: z.string(),
  diagnosisSystem: z.string().nullable(),
})

export function NewConsentDrawer({
  open,
  onClose,
  patientId,
  encounterId,
  planItemId,
  defaultProcedureRef,
  defaultDiagnosisCode,
  defaultDiagnosisSystem,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  patientId: string
  encounterId?: string
  planItemId?: string
  /** Desde la atención: lo que se registró (procedimiento y pieza) y su diagnóstico. */
  defaultProcedureRef?: string
  defaultDiagnosisCode?: string
  defaultDiagnosisSystem?: string
  onCreated: (id: string) => Promise<void>
}) {
  const templatesQuery = useQuery({
    queryKey: ["consent-templates-published"],
    queryFn: () => fetchConsentTemplates({ status: "publicado" }),
    enabled: open,
  })
  const templates = templatesQuery.data?.data ?? []
  const create = useMutation({ mutationFn: createConsent })
  const defaultValues: NewConsentValues = {
    templateId: "",
    procedureRef: defaultProcedureRef ?? "",
    diagnosisCode: defaultDiagnosisCode ?? "",
    diagnosisSystem: defaultDiagnosisSystem ?? null,
  }
  const form = useAppForm({
    defaultValues,
    validators: {
      // Desde la atención o el tratamiento, el procedimiento ya va unido; si no, se escribe.
      onSubmit: newConsentSchema.superRefine((value, ctx) => {
        if (!encounterId && !planItemId && !value.procedureRef.trim())
          ctx.addIssue({ code: "custom", path: ["procedureRef"], message: "Indica el procedimiento al que aplica" })
      }),
    },
    onSubmit: async ({ value }) => {
      const result = await create.mutateAsync({
        templateId: value.templateId,
        patientId,
        encounterId: encounterId ?? null,
        planItemId: planItemId ?? null,
        procedureRef: value.procedureRef.trim() || null,
        diagnosisCode: value.diagnosisCode || null,
        diagnosisSystem: value.diagnosisCode ? value.diagnosisSystem : null,
      })
      toast.success("Consentimiento generado: pendiente de firma")
      form.reset({ templateId: "", procedureRef: "", diagnosisCode: "", diagnosisSystem: value.diagnosisSystem })
      await onCreated(result.data.id)
    },
  })
  const surface = useFormSurface(form)
  const diagnosisSystem = useStore(form.store, (state) => state.values.diagnosisSystem)
  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={() => {
        clearSubmitErrors(form)
        onClose()
      }}
      title="Nuevo consentimiento"
      description="La plantilla publicada se copia al documento: lo que se firma no cambia aunque la plantilla se actualice."
      submitLabel="Generar consentimiento"
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="templateId">
          {(field) => (
            <field.SelectField
              label="Plantilla"
              placeholder={templatesQuery.isPending ? "Cargando…" : "Elige una plantilla"}
              options={templates.map((t) => ({ value: t.id, label: t.title }))}
              description={
                templatesQuery.isSuccess && templates.length === 0
                  ? "No hay plantillas publicadas. Se publican en Configuración → Formularios y consentimientos."
                  : undefined
              }
            />
          )}
        </form.AppField>
        <form.AppField name="procedureRef">
          {(field) => (
            <field.TextField
              label="Procedimiento al que aplica"
              maxLength={500}
              placeholder={`p. ej. ${appWords().examples.consentProcedure}`}
            />
          )}
        </form.AppField>
        <form.AppField name="diagnosisCode">
          {(field) => (
            <field.Control label="Diagnóstico que lo motiva (opcional)">
              {(control) => (
                <DiagnosisSearch
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  system={diagnosisSystem}
                  onChange={(code, _description, system) => {
                    form.setFieldValue("diagnosisSystem", system)
                    field.handleChange(code)
                  }}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

export function ConsentDetail({
  document,
  canWrite,
  onChanged,
}: {
  document: ConsentDocument
  canWrite: boolean
  onChanged: () => Promise<void>
}) {
  const historyQuery = useQuery({
    queryKey: ["consent-history", document.id, document.status],
    queryFn: () => fetchConsentHistory(document.id),
  })
  const [cancelOpen, setCancelOpen] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [signing, setSigning] = useState(false)
  const [paperOpen, setPaperOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const signatureWords = consentSignatureWords(document)
  const cancel = useMutation({ mutationFn: (reason: string) => cancelConsent(document.id, reason) })
  const cancelForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: cancelSchema },
    onSubmit: async ({ value }) => {
      await cancel.mutateAsync(value.reason.trim())
      setCancelOpen(false)
      toast.success("Consentimiento anulado")
      await onChanged()
    },
  })
  const cancelError = useFormSubmitError(cancelForm)
  const cancelPending = useStore(cancelForm.store, (state) => state.isSubmitting)
  // Revocado, el PDF que se ve es el de la revocación (lleva el documento entero).
  const pdfIdOf = (doc: ConsentDocument) =>
    doc.status === "revocado" ? (doc.revokePdfDocumentId ?? null) : doc.pdfDocumentId
  const pdfId = pdfIdOf(document)
  const pdf = useMutation({
    mutationFn: async () => {
      const id = pdfId ?? pdfIdOf((await generateConsentPdf(document.id)).data)
      if (!id) throw new Error("Sin PDF")
      const signed = await apiFetch<{ data: { url: string } }>(
        `/api/patients/${document.patientId}/documents/${id}/url`,
      )
      return { url: signed.data.url, generated: !pdfId }
    },
    onSuccess: async ({ url, generated }) => {
      window.open(url, "_blank", "noopener")
      if (generated) await onChanged()
    },
    onError: (e) => setActionError(submitErrorMessage(e)),
  })
  const signed = document.status === "firmado" || document.status === "revocado"

  return (
    <div className="flex flex-col gap-4 border-t p-3">
      <ConsentSheet document={document} />
      <div className="flex flex-wrap gap-2">
        <Link
          to="/patients/$patientId/consents/$consentId/print"
          params={{ patientId: document.patientId, consentId: document.id }}
          className={buttonVariants({ size: "sm", variant: "outline" })}
        >
          {document.status === "pendiente" ? "Imprimir para firma en papel" : "Imprimir"}
        </Link>
        {signed ? (
          <Button size="sm" variant="outline" disabled={pdf.isPending} onClick={() => pdf.mutate()}>
            {pdfId ? "Ver PDF" : pdf.isPending ? "Generando PDF…" : "Generar PDF"}
          </Button>
        ) : null}
        {canWrite && document.status === "pendiente" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              cancelForm.reset()
              setCancelOpen(true)
            }}
          >
            Anular pendiente…
          </Button>
        ) : null}
        {canWrite && document.status === "firmado" && !revokeOpen ? (
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            onClick={() => setRevokeOpen(true)}
          >
            Revocar…
          </Button>
        ) : null}
      </div>
      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {canWrite && document.status === "pendiente" ? (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          <p className="text-sm">
            {consentLinkWords(document) ??
              `Falta la firma. En la ${appWords().room.one}, la persona firma con el dedo en pantalla completa y tú confirmas con tu perfil; si la firmó en papel, sube la foto de la hoja. También puedes enviárselo para que lo firme desde su teléfono.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {/* Si ya lo firmó desde su enlace, solo falta confirmarlo: no se firma dos veces. */}
            {document.personSignedAt ? null : (
              <>
                <Button size="sm" onClick={() => setSigning(true)}>
                  Firmar ahora
                </Button>
                <Button size="sm" variant="outline" onClick={() => setPaperOpen(true)}>
                  Firmado en papel
                </Button>
              </>
            )}
            <ConsentLinkActions document={document} onChanged={onChanged} />
          </div>
        </div>
      ) : null}
      {signatureWords ? <p className="text-xs text-muted-foreground">{signatureWords}</p> : null}
      <ConsentSigningScreen
        open={signing}
        documents={[document]}
        patientId={document.patientId}
        onClose={() => setSigning(false)}
        onSigned={onChanged}
      />
      <PaperSignDrawer
        open={paperOpen}
        document={document}
        patientId={document.patientId}
        encounterId={document.encounterId}
        onClose={() => setPaperOpen(false)}
        onSigned={onChanged}
      />
      {canWrite && document.status === "firmado" && revokeOpen ? (
        <RevokeForm
          document={document}
          onCancel={() => setRevokeOpen(false)}
          onChanged={onChanged}
        />
      ) : null}
      <section aria-label="Historia del documento">
        <h4 className="text-sm font-semibold">Historia del documento</h4>
        <ol className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
          {(historyQuery.data?.data ?? []).map((event) => (
            <li key={event.id}>
              {new Date(event.createdAt).toLocaleString(activeOrgLocale(), {
                dateStyle: "medium",
                timeStyle: "short",
              })}{" "}
              · {EVENT_LABELS[event.toStatus] ?? event.toStatus}
              {event.reason && event.reason !== "Documento creado" ? ` · ${event.reason}` : ""}
            </li>
          ))}
        </ol>
      </section>
      <ConfirmDialog
        open={cancelOpen}
        title="Anular consentimiento pendiente"
        description="Desaparece de los pendientes y no cuenta como consentimiento. Queda en la historia con el motivo."
        confirmLabel="Anular"
        pending={cancelPending}
        error={cancelError}
        onClose={() => {
          if (!cancelPending) setCancelOpen(false)
        }}
        onConfirm={() => void submitForm(cancelForm)}
      >
        <cancelForm.AppField name="reason">
          {(field) => (
            <field.TextareaField
              label="Motivo"
              aria-required
              maxLength={2000}
              placeholder="p. ej. Plantilla equivocada"
            />
          )}
        </cancelForm.AppField>
      </ConfirmDialog>
    </div>
  )
}

interface RevokeValues {
  revokerContactId: string
  reason: string
  signatureData: number[][][]
}

/** Los mismos límites que `consentRevoke` de la API. */
const revokeSchema = z.object({
  revokerContactId: z.string().min(1, "Indica quién revoca"),
  reason: z
    .string()
    .trim()
    .min(1, "La revocación necesita un motivo")
    .max(2000, "Escribe como mucho 2000 caracteres."),
  signatureData: z.array(z.array(z.array(z.number()))),
})

/** Quién puede revocar llega del servidor; el formulario empieza cuando se sabe. */
function RevokeForm({
  document,
  onCancel,
  onChanged,
}: {
  document: ConsentDocument
  onCancel: () => void
  onChanged: () => Promise<void>
}) {
  const { choices, loading } = useSignerChoices(document.patientId)
  if (loading) return <LoadingState message="Buscando quién puede revocar…" />
  const initial = choices.find((c) => c.contactId === document.signerContactId) ?? choices[0]
  if (!initial)
    return (
      <p role="alert" className="text-sm text-destructive">
        No hay una persona habilitada para revocar (la propia persona o su representante legal
        vigente).
      </p>
    )
  return (
    <RevokeFields
      document={document}
      choices={choices}
      initialContactId={initial.contactId}
      onCancel={onCancel}
      onChanged={onChanged}
    />
  )
}

function RevokeFields({
  document,
  choices,
  initialContactId,
  onCancel,
  onChanged,
}: {
  document: ConsentDocument
  choices: SignerChoice[]
  initialContactId: string
  onCancel: () => void
  onChanged: () => Promise<void>
}) {
  const ids = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const nameOf = (contactId: string) => (choices.find((c) => c.contactId === contactId) ?? choices[0])?.name ?? ""
  const revoke = useMutation({
    mutationFn: (value: RevokeValues) =>
      revokeConsent(document.id, {
        reason: value.reason.trim(),
        revokerContactId: value.revokerContactId,
        signatureData: { strokes: value.signatureData },
      }),
  })
  const defaultValues: RevokeValues = { revokerContactId: initialContactId, reason: "", signatureData: [] }
  const form = useAppForm({
    defaultValues,
    validators: {
      onSubmit: revokeSchema.superRefine((value, ctx) => {
        if (value.signatureData.length === 0)
          ctx.addIssue({
            code: "custom",
            path: ["signatureData"],
            message: `Falta la firma de ${nameOf(value.revokerContactId)}`,
          })
      }),
    },
    // Lo escrito está completo: falta la confirmación, que es la que revoca.
    onSubmit: () => setConfirmOpen(true),
  })
  const onSubmit = useFormSubmit(form)
  const error = useFormSubmitError(form)
  const revokerContactId = useStore(form.store, (state) => state.values.revokerContactId)
  const revokerName = nameOf(revokerContactId)
  // Si el servidor lo rechaza, el diálogo se cierra y cada dato se dice junto a su campo.
  const confirm = async () => {
    try {
      await revoke.mutateAsync(form.state.values)
    } catch (rejection) {
      setConfirmOpen(false)
      applySubmitError(form, rejection)
      focusFirstInvalid(formRef.current)
      return
    }
    setConfirmOpen(false)
    toast.success("Consentimiento revocado")
    await onChanged()
  }
  return (
    <form
      ref={formRef}
      noValidate
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-3 rounded-md border border-destructive/40 p-3"
      onSubmit={onSubmit}
    >
      <h4 id={`${ids}-title`} className="text-sm font-semibold">
        Revocar consentimiento
      </h4>
      <form.AppField name="revokerContactId">
        {(field) => (
          <field.SelectField
            label="Quién revoca"
            options={choices.map((c) => ({ value: c.contactId, label: c.label }))}
          />
        )}
      </form.AppField>
      <form.AppField name="reason">
        {(field) => <field.TextareaField label="Motivo" aria-required rows={2} maxLength={2000} />}
      </form.AppField>
      <form.AppField name="signatureData">
        {(field) => (
          <field.Group legend={`Firma de ${revokerName}`}>
            {(control) => (
              <FirmaPad
                label={`Firma de ${revokerName} para revocar`}
                id={control.id}
                invalid={control.invalid}
                describedBy={control.describedBy}
                onChange={(strokes) => {
                  field.handleChange(strokes)
                  field.handleBlur()
                }}
              />
            )}
          </field.Group>
        )}
      </form.AppField>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant="destructive">
          Revocar…
        </Button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="¿Revocar el consentimiento?"
        description="El documento firmado se conserva tal cual; queda marcado como revocado con el motivo y la firma, y el tratamiento vuelve a requerir consentimiento."
        confirmLabel="Revocar"
        pending={revoke.isPending}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void confirm()}
      />
    </form>
  )
}

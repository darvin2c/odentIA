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
import { activeOrgLocale } from "../../lib/locale"
import { appWords } from "../../lib/product-words"
import { ConsentLinkActions, consentLinkWords } from "./consent-link-actions"
import {
  ConsentSigningScreen,
  PaperSignDrawer,
  type SignerChoice,
  useSignerChoices,
} from "./consent-signing"
import { DiagnosisSearch } from "./diagnosis-search"
import { FirmaPad } from "./firma-pad"

const cancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Escribe el motivo")
    .max(2000, "Escribe como mucho 2000 caracteres."),
})

export const CONSENT_EVENT_LABELS: Record<string, string> = {
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
          ctx.addIssue({
            code: "custom",
            path: ["procedureRef"],
            message: "Indica el procedimiento al que aplica",
          })
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
      form.reset({
        templateId: "",
        procedureRef: "",
        diagnosisCode: "",
        diagnosisSystem: value.diagnosisSystem,
      })
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
export function RevokeForm({
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
  const nameOf = (contactId: string) =>
    (choices.find((c) => c.contactId === contactId) ?? choices[0])?.name ?? ""
  const revoke = useMutation({
    mutationFn: (value: RevokeValues) =>
      revokeConsent(document.id, {
        reason: value.reason.trim(),
        revokerContactId: value.revokerContactId,
        signatureData: { strokes: value.signatureData },
      }),
  })
  const defaultValues: RevokeValues = {
    revokerContactId: initialContactId,
    reason: "",
    signatureData: [],
  }
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

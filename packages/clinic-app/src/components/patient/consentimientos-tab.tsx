import {
  Button,
  buttonVariants,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  FormDrawer,
  LoadingState,
} from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
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
import { ConsentSigningScreen, PaperSignDrawer, useSignerChoices } from "./consent-signing"
import { FirmaPad } from "./firma-pad"
import { activeOrgLocale } from "../../lib/locale"
import { ConsentLinkActions, consentLinkWords } from "./consent-link-actions"
import { appWords } from "../../lib/product-words"

const errorMessage = (e: unknown) =>
  e instanceof ApiError
    ? (e.shape.message ?? "No se pudo completar la acción")
    : "No se pudo completar la acción"

export const CONSENT_EVENT_LABELS: Record<string, string> = {
  pendiente: "Creado (pendiente de firma)",
  informado: "Informado por el profesional",
  firmado: "Firmado",
  revocado: "Revocado",
  anulado: "Anulado",
}

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
  const ids = useId()
  const [templateId, setTemplateId] = useState("")
  const [procedureRef, setProcedureRef] = useState(defaultProcedureRef ?? "")
  const [diagnosisCode, setDiagnosisCode] = useState(defaultDiagnosisCode ?? "")
  const [diagnosisSystem, setDiagnosisSystem] = useState<string | null>(defaultDiagnosisSystem ?? null)
  const [error, setError] = useState<string | null>(null)
  const templatesQuery = useQuery({
    queryKey: ["consent-templates-published"],
    queryFn: () => fetchConsentTemplates({ status: "publicado" }),
    enabled: open,
  })
  const templates = templatesQuery.data?.data ?? []
  const create = useMutation({
    mutationFn: () =>
      createConsent({
        templateId,
        patientId,
        encounterId: encounterId ?? null,
        planItemId: planItemId ?? null,
        procedureRef: procedureRef.trim() || null,
        diagnosisCode: diagnosisCode || null,
        diagnosisSystem: diagnosisCode ? diagnosisSystem : null,
      }),
    onSuccess: async (result) => {
      toast.success("Consentimiento generado: pendiente de firma")
      setTemplateId("")
      setProcedureRef("")
      setDiagnosisCode("")
      await onCreated(result.data.id)
    },
    onError: (e) => setError(errorMessage(e)),
  })
  return (
    <FormDrawer
      open={open}
      onClose={() => {
        setError(null)
        onClose()
      }}
      title="Nuevo consentimiento"
      description="La plantilla publicada se copia al documento: lo que se firma no cambia aunque la plantilla se actualice."
      onSubmit={(event) => {
        event.preventDefault()
        if (!templateId) {
          setError("Elige una plantilla publicada")
          return
        }
        if (!procedureRef.trim() && !encounterId && !planItemId) {
          setError("Indica el procedimiento al que aplica")
          return
        }
        setError(null)
        create.mutate()
      }}
      isDirty={Boolean(templateId || procedureRef || diagnosisCode)}
      isSubmitting={create.isPending}
      error={error}
      submitLabel="Generar consentimiento"
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`${ids}-template`}>Plantilla</FieldLabel>
          <Select
            items={Object.fromEntries(templates.map((t) => [t.id, t.title]))}
            value={templateId}
            onValueChange={(v) => setTemplateId(v ?? "")}
          >
            <SelectTrigger id={`${ids}-template`} aria-required="true">
              <SelectValue
                placeholder={templatesQuery.isPending ? "Cargando…" : "Elige una plantilla"}
              />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {templatesQuery.isSuccess && templates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No hay plantillas publicadas. Se publican en Configuración → Formularios y
              consentimientos.
            </p>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-procedure`}>Procedimiento al que aplica</FieldLabel>
          <Input
            id={`${ids}-procedure`}
            value={procedureRef}
            onChange={(event) => setProcedureRef(event.target.value)}
            maxLength={500}
            placeholder={`p. ej. ${appWords().examples.consentProcedure}`}
          />
        </Field>
        <DiagnosisSearch
          value={diagnosisCode}
          system={diagnosisSystem}
          onChange={(code, _description, system) => {
            setDiagnosisCode(code)
            setDiagnosisSystem(system)
          }}
          label="Diagnóstico que lo motiva (opcional)"
        />
      </div>
    </FormDrawer>
  )
}

export function RevokeForm({
  document,
  onCancel,
  onChanged,
}: {
  document: ConsentDocument
  onCancel: () => void
  onChanged: () => Promise<void>
}) {
  const ids = useId()
  const { choices, loading } = useSignerChoices(document.patientId)
  const [choiceId, setChoiceId] = useState("")
  const selected =
    choices.find((c) => c.contactId === choiceId) ??
    choices.find((c) => c.contactId === document.signerContactId) ??
    choices[0] ??
    null
  const [reason, setReason] = useState("")
  const [strokes, setStrokes] = useState<number[][][]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revoke = useMutation({
    mutationFn: () =>
      revokeConsent(document.id, {
        reason: reason.trim(),
        revokerContactId: selected!.contactId,
        signatureData: { strokes },
      }),
    onSuccess: async () => {
      setConfirmOpen(false)
      toast.success("Consentimiento revocado")
      await onChanged()
    },
    onError: (e) => {
      setConfirmOpen(false)
      setError(errorMessage(e))
    },
  })
  if (loading) return <LoadingState message="Buscando quién puede revocar…" />
  if (!selected)
    return (
      <p role="alert" className="text-sm text-destructive">
        No hay una persona habilitada para revocar (la propia persona o su representante legal
        vigente).
      </p>
    )
  return (
    <form
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-3 rounded-md border border-destructive/40 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!reason.trim()) {
          setError("La revocación necesita un motivo")
          return
        }
        if (strokes.length === 0) {
          setError(`Falta la firma de ${selected.name}`)
          return
        }
        setError(null)
        setConfirmOpen(true)
      }}
    >
      <h4 id={`${ids}-title`} className="text-sm font-semibold">
        Revocar consentimiento
      </h4>
      <Field>
        <FieldLabel htmlFor={`${ids}-who`}>Quién revoca</FieldLabel>
        <Select
          items={Object.fromEntries(choices.map((c) => [c.contactId, c.label]))}
          value={selected.contactId}
          onValueChange={(v) => setChoiceId(v ?? "")}
        >
          <SelectTrigger id={`${ids}-who`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((c) => (
              <SelectItem key={c.contactId} value={c.contactId}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${ids}-reason`}>Motivo</FieldLabel>
        <Textarea
          id={`${ids}-reason`}
          aria-required="true"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={2000}
        />
      </Field>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Firma de {selected.name}</p>
        <FirmaPad label={`Firma de ${selected.name} para revocar`} onChange={setStrokes} />
      </div>
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
        onConfirm={() => revoke.mutate()}
      />
    </form>
  )
}

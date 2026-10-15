import { CONSENT_DECLARATION } from "@odentia/clinical"
import {
  Badge,
  Button,
  buttonVariants,
  Checkbox,
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
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import {
  CONSENT_STATUS_LABELS,
  type ConsentDocument,
  cancelConsent,
  createConsent,
  fetchConsentHistory,
  fetchConsents,
  fetchConsentTemplates,
  generateConsentPdf,
  revokeConsent,
  signConsent,
} from "../../lib/clinical-forms"
import { fetchResponsibilities } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { ageFrom, type PatientFull } from "../../lib/patients"
import { Cie10Search } from "./cie10-search"
import { ConsentSheet } from "./consent-sheet"
import { FirmaPad } from "./firma-pad"
import { activeOrgLocale } from "../../lib/locale"

const errorMessage = (e: unknown) =>
  e instanceof ApiError
    ? (e.shape.message ?? "No se pudo completar la acción")
    : "No se pudo completar la acción"

const STATUS_TONE: Record<
  ConsentDocument["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  pendiente: "secondary",
  firmado: "default",
  revocado: "destructive",
  anulado: "outline",
}

const EVENT_LABELS: Record<string, string> = {
  pendiente: "Creado (pendiente de firma)",
  informado: "Informado por el profesional",
  firmado: "Firmado",
  revocado: "Revocado",
  anulado: "Anulado",
}

/**
 * Consentimientos informados por procedimiento: plantilla estructurada,
 * firma de la propia persona o de su representante legal vigente y del
 * profesional que informa, PDF con huella, anulación de pendientes y
 * revocación firmada. Sin firma certificada ni firma digital.
 */
export function ConsentimientosTab({
  patientId,
  encounterId,
  planItemId,
}: {
  patientId: string
  encounterId?: string
  planItemId?: string
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canRead = usePermission("clinical.read")
  const canWrite = usePermission("clinical.write")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const listQuery = useQuery({
    queryKey: ["consents", patientId],
    queryFn: () => fetchConsents({ patientId }),
    enabled: canRead,
  })
  const documents = listQuery.data?.data ?? []
  const invalidate = async () => {
    await Promise.all(
      [
        ["consents", patientId],
        ["patient-summary", patientId],
        ["patient-documents", patientId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    )
  }

  return (
    <section aria-labelledby="consents-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="consents-title" className="text-base font-semibold">
            Consentimientos informados
          </h2>
          <p className="text-sm text-muted-foreground">
            Por procedimiento, con la firma de quien puede decidir y del profesional que informa.
          </p>
        </div>
        {canWrite ? (
          <Button type="button" onClick={() => setDrawerOpen(true)}>
            Nuevo consentimiento
          </Button>
        ) : null}
      </div>
      {listQuery.isPending ? (
        <LoadingState message="Cargando consentimientos…" />
      ) : listQuery.isError ? (
        <ErrorState
          message="No se pudieron cargar los consentimientos"
          onRetry={() => void listQuery.refetch()}
        />
      ) : documents.length === 0 ? (
        <EmptyState
          title="Sin consentimientos"
          description="Genera el primero desde una plantilla publicada, indicando el procedimiento."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {documents.map((document) => {
            const open = selectedId === document.id
            return (
              <li key={document.id} className="rounded-md border">
                <button
                  type="button"
                  aria-expanded={open}
                  className="flex w-full flex-wrap items-center justify-between gap-2 p-3 text-left"
                  onClick={() => setSelectedId(open ? null : document.id)}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{document.titleSnapshot}</span>
                    <span className="text-xs text-muted-foreground">
                      {document.procedureRef ? `${document.procedureRef} · ` : ""}
                      {new Date(document.signedAt ?? document.createdAt).toLocaleDateString(
                        activeOrgLocale(),
                        {
                          dateStyle: "medium",
                        },
                      )}
                    </span>
                  </span>
                  <Badge variant={STATUS_TONE[document.status]}>
                    {CONSENT_STATUS_LABELS[document.status]}
                  </Badge>
                </button>
                {open ? (
                  <ConsentDetail document={document} canWrite={canWrite} onChanged={invalidate} />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <NewConsentDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        patientId={patientId}
        encounterId={encounterId}
        planItemId={planItemId}
        onCreated={async (id) => {
          setDrawerOpen(false)
          setSelectedId(id)
          await invalidate()
        }}
      />
    </section>
  )
}

function NewConsentDrawer({
  open,
  onClose,
  patientId,
  encounterId,
  planItemId,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  patientId: string
  encounterId?: string
  planItemId?: string
  onCreated: (id: string) => Promise<void>
}) {
  const ids = useId()
  const [templateId, setTemplateId] = useState("")
  const [procedureRef, setProcedureRef] = useState("")
  const [diagnosisCode, setDiagnosisCode] = useState("")
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
            placeholder="p. ej. Exodoncia pieza 38"
          />
        </Field>
        <Cie10Search
          value={diagnosisCode}
          onChange={(code) => setDiagnosisCode(code)}
          label="Diagnóstico que lo motiva (opcional)"
        />
      </div>
    </FormDrawer>
  )
}

interface SignerChoice {
  kind: "paciente" | "representante"
  contactId: string
  name: string
  label: string
}

/** Quién puede firmar o revocar: la propia persona (mayor de edad) o su representante legal vigente. */
function useSignerChoices(patientId: string) {
  const canPatients = usePermission("patients.read")
  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: canPatients,
  })
  const responsibilitiesQuery = useQuery({
    queryKey: ["responsibilities", patientId],
    queryFn: () => fetchResponsibilities(patientId),
    enabled: canPatients,
  })
  const detail = patientQuery.data?.data
  const own = detail?.contacts.find((link) => link.relationship === "self")
  const age = Number(ageFrom(detail?.patient.birthDate))
  const isMinor = detail?.patient.birthDate != null && Number.isFinite(age) && age < 18
  const representatives = (responsibilitiesQuery.data?.data ?? []).filter(
    (row) => row.isCurrent && row.kind === "representante_legal",
  )
  const choices: SignerChoice[] = [
    ...(own && !isMinor
      ? [
          {
            kind: "paciente" as const,
            contactId: own.contactId,
            name: own.displayName,
            label: `${own.displayName} · paciente`,
          },
        ]
      : []),
    ...representatives.map(
      (row): SignerChoice => ({
        kind: "representante",
        contactId: row.contact.id,
        name: row.contact.displayName,
        label: `${row.contact.displayName} · representante legal`,
      }),
    ),
  ]
  return {
    choices,
    isMinor,
    loading: patientQuery.isPending || responsibilitiesQuery.isPending,
  }
}

function ConsentDetail({
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
  const [cancelReason, setCancelReason] = useState("")
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const cancelId = useId()
  const cancel = useMutation({
    mutationFn: () => cancelConsent(document.id, cancelReason.trim()),
    onSuccess: async () => {
      setCancelOpen(false)
      toast.success("Consentimiento anulado")
      await onChanged()
    },
    onError: (e) => setActionError(errorMessage(e)),
  })
  const pdf = useMutation({
    mutationFn: async () => {
      const current = document.pdfDocumentId
        ? document
        : (await generateConsentPdf(document.id)).data
      if (!current.pdfDocumentId) throw new Error("Sin PDF")
      const signed = await apiFetch<{ data: { url: string } }>(
        `/api/patients/${document.patientId}/documents/${current.pdfDocumentId}/url`,
      )
      return { url: signed.data.url, generated: !document.pdfDocumentId }
    },
    onSuccess: async ({ url, generated }) => {
      window.open(url, "_blank", "noopener")
      if (generated) await onChanged()
    },
    onError: (e) => setActionError(errorMessage(e)),
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
            {document.pdfDocumentId ? "Ver PDF" : pdf.isPending ? "Generando PDF…" : "Generar PDF"}
          </Button>
        ) : null}
        {canWrite && document.status === "pendiente" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setCancelReason("")
              setActionError(null)
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
        <SignForm document={document} onChanged={onChanged} />
      ) : null}
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
        pending={cancel.isPending}
        confirmDisabled={!cancelReason.trim()}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => cancel.mutate()}
      >
        <Field>
          <FieldLabel htmlFor={cancelId}>Motivo</FieldLabel>
          <Textarea
            id={cancelId}
            aria-required="true"
            value={cancelReason}
            maxLength={2000}
            onChange={(event) => setCancelReason(event.target.value)}
            placeholder="p. ej. Plantilla equivocada"
          />
        </Field>
      </ConfirmDialog>
    </div>
  )
}

function SignForm({
  document,
  onChanged,
}: {
  document: ConsentDocument
  onChanged: () => Promise<void>
}) {
  const ids = useId()
  const { choices, isMinor, loading } = useSignerChoices(document.patientId)
  const [choiceId, setChoiceId] = useState<string>("")
  const selected = choices.find((c) => c.contactId === choiceId) ?? choices[0] ?? null
  const [signerDoc, setSignerDoc] = useState("")
  const [relation, setRelation] = useState("")
  const [understood, setUnderstood] = useState(false)
  const [strokes, setStrokes] = useState<number[][][]>([])
  const [professionalStrokes, setProfessionalStrokes] = useState<number[][][]>([])
  const [withWitness, setWithWitness] = useState(false)
  const [witnessName, setWitnessName] = useState("")
  const [witnessDoc, setWitnessDoc] = useState("")
  const [error, setError] = useState<string | null>(null)
  const sign = useMutation({
    mutationFn: () =>
      signConsent(document.id, {
        signerKind: selected!.kind,
        signerContactId: selected!.contactId,
        signerDoc: signerDoc.trim() || null,
        representativeRelation:
          selected!.kind === "representante" ? relation.trim() || "Representante legal" : null,
        signatureData: { strokes },
        comprehensionConfirmed: true,
        professionalSignature: { strokes: professionalStrokes },
        witness:
          withWitness && witnessName.trim()
            ? { name: witnessName.trim(), doc: witnessDoc.trim() || null }
            : null,
      }),
    onSuccess: async () => {
      toast.success("Firmas registradas; el PDF quedó en Documentos")
      await onChanged()
    },
    onError: (e) => setError(errorMessage(e)),
  })

  if (loading) return <LoadingState message="Buscando quién puede firmar…" />
  if (!selected)
    return (
      <p role="alert" className="rounded-md bg-warning-soft p-3 text-sm">
        {isMinor
          ? "El paciente es menor de edad y no tiene representante legal vigente. Regístralo en Datos → Responsables para que pueda firmar por él."
          : "No hay una persona habilitada para firmar. Revisa los vínculos y responsables en Datos."}
      </p>
    )
  return (
    <form
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-4 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!understood) {
          setError("La persona que firma debe confirmar que comprendió la información")
          return
        }
        if (strokes.length === 0) {
          setError(`Falta la firma de ${selected.name}`)
          return
        }
        if (professionalStrokes.length === 0) {
          setError("Falta la firma del profesional que informa")
          return
        }
        if (withWitness && !witnessName.trim()) {
          setError("Ingresa el nombre del testigo o quítalo")
          return
        }
        setError(null)
        sign.mutate()
      }}
    >
      <h4 id={`${ids}-title`} className="text-sm font-semibold">
        Registrar firmas
      </h4>
      <Field>
        <FieldLabel htmlFor={`${ids}-signer`}>Quién firma</FieldLabel>
        <Select
          items={Object.fromEntries(choices.map((c) => [c.contactId, c.label]))}
          value={selected.contactId}
          onValueChange={(v) => setChoiceId(v ?? "")}
        >
          <SelectTrigger id={`${ids}-signer`}>
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
        <p className="text-xs text-muted-foreground">
          {isMinor
            ? "Paciente menor de edad: solo firma su representante legal vigente."
            : "Firma la propia persona o su representante legal vigente; el nombre y documento salen de su ficha."}
        </p>
      </Field>
      {selected.kind === "representante" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${ids}-relation`}>Parentesco o relación</FieldLabel>
            <Input
              id={`${ids}-relation`}
              value={relation}
              onChange={(event) => setRelation(event.target.value)}
              maxLength={120}
              placeholder="p. ej. Madre"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-doc`}>Documento (si su ficha no lo tiene)</FieldLabel>
            <Input
              id={`${ids}-doc`}
              value={signerDoc}
              onChange={(event) => setSignerDoc(event.target.value)}
              maxLength={40}
            />
          </Field>
        </div>
      ) : null}
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={understood} onCheckedChange={(value) => {
            setUnderstood(value === true)
            setError(null)
          }} />
        <span>{CONSENT_DECLARATION}</span>
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <p id={`${ids}-sig1`} className="text-sm font-medium">
            Firma de {selected.name}
          </p>
          <FirmaPad label={`Firma de ${selected.name}`} onChange={setStrokes} />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Firma del profesional que informa</p>
          <FirmaPad label="Firma del profesional que informa" onChange={setProfessionalStrokes} />
          <p className="text-xs text-muted-foreground">
            Tu nombre y colegiatura se toman de tu perfil profesional.
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Firma manuscrita capturada, no certificada. Alternativa: «Imprimir para firma en papel» y
        adjunta el escaneo en Documentos.
      </p>
      {withWitness ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${ids}-witness`}>Nombre del testigo</FieldLabel>
            <Input
              id={`${ids}-witness`}
              value={witnessName}
              maxLength={200}
              onChange={(event) => setWitnessName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-witness-doc`}>Documento del testigo</FieldLabel>
            <Input
              id={`${ids}-witness-doc`}
              value={witnessDoc}
              maxLength={40}
              onChange={(event) => setWitnessDoc(event.target.value)}
            />
          </Field>
          <Button type="button" size="sm" variant="ghost" onClick={() => setWithWitness(false)}>
            Quitar testigo
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => setWithWitness(true)}
        >
          Añadir testigo (nombre y documento)
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="self-end" disabled={sign.isPending}>
        {sign.isPending ? "Registrando…" : "Registrar firmas"}
      </Button>
    </form>
  )
}

function RevokeForm({
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

import {
  Badge,
  Button,
  Field,
  FieldError,
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
import { EmptyState, ErrorState, FormDrawer, PageHeader } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import {
  CONSENT_STATUS_LABELS,
  createConsent,
  fetchConsentHistory,
  fetchConsents,
  fetchConsentTemplates,
  revokeConsent,
  signConsent,
  type ConsentDocument,
} from "../../lib/clinical-forms"
import { usePermission } from "../../lib/crm"
import { FirmaPad, FirmaView } from "./firma-pad"

/**
 * Consentimientos informados por procedimiento o plan: plantilla versionada,
 * firma manuscrita del paciente o su representante verificado, inmutabilidad
 * del documento aceptado, historia de estados y acceso/impresión.
 * Sin afirmación de firma certificada ni firma digital.
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
  const submitRef = useRef<() => void>(() => {})

  const listQuery = useQuery({
    queryKey: ["consents", patientId],
    queryFn: () => fetchConsents({ patientId }),
    enabled: canRead,
  })
  const documents = listQuery.data?.data ?? []
  const selected = documents.find((d) => d.id === selectedId) ?? null
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["consents", patientId] })
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Consentimientos informados"
        subtitle="Documento por procedimiento o plan, con firma manuscrita y trazabilidad."
        actions={
          canWrite ? (
            <Button type="button" onClick={() => setDrawerOpen(true)}>
              Nuevo consentimiento
            </Button>
          ) : undefined
        }
      />
      {listQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : listQuery.isError ? (
        <ErrorState message="No se pudieron cargar los consentimientos" onRetry={() => void listQuery.refetch()} />
      ) : documents.length === 0 ? (
        <EmptyState
          title="Sin consentimientos"
          description="Genera el primero desde una plantilla publicada, indicando el procedimiento o el plan."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {documents.map((document) => (
            <li key={document.id} className="rounded-md border p-3">
              <button
                type="button"
                className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
                onClick={() => setSelectedId(document.id)}
              >
                <span className="text-sm font-medium">
                  {document.titleSnapshot} · v{document.templateVersion}
                </span>
                <Badge
                  variant={document.status === "firmado" ? "default" : document.status === "revocado" ? "destructive" : "secondary"}
                >
                  {CONSENT_STATUS_LABELS[document.status]}
                </Badge>
              </button>
              {selected?.id === document.id ? (
                <ConsentDetail document={selected} canWrite={canWrite} onChanged={invalidate} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nuevo consentimiento"
        onSubmit={() => submitRef.current()}
        submitLabel="Generar consentimiento"
      >
        <NewConsentForm
          patientId={patientId}
          encounterId={encounterId}
          planItemId={planItemId}
          registerSubmit={(fn) => {
            submitRef.current = fn
          }}
          onDone={(id) => {
            setDrawerOpen(false)
            setSelectedId(id)
            invalidate()
          }}
        />
      </FormDrawer>
    </div>
  )
}

function NewConsentForm({
  patientId,
  encounterId,
  planItemId,
  registerSubmit,
  onDone,
}: {
  patientId: string
  encounterId?: string
  planItemId?: string
  registerSubmit: (fn: () => void) => void
  onDone: (id: string) => void
}) {
  const [templateId, setTemplateId] = useState("")
  const [procedureRef, setProcedureRef] = useState("")
  const [error, setError] = useState<string | null>(null)
  const templatesQuery = useQuery({
    queryKey: ["consent-templates-published"],
    queryFn: () => fetchConsentTemplates({ status: "publicado" }),
  })
  const templates = templatesQuery.data?.data ?? []
  const createMutation = useMutation({
    mutationFn: () =>
      createConsent({
        templateId,
        patientId,
        encounterId: encounterId ?? null,
        planItemId: planItemId ?? null,
        procedureRef: procedureRef.trim() ? procedureRef.trim() : null,
      }),
    onSuccess: (result) => {
      toast.success("Consentimiento generado (pendiente de firma)")
      onDone(result.data.id)
    },
    onError: (e: unknown) => {
      setError(e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación")
    },
  })

  useEffect(() => {
    registerSubmit(() => {
      if (!templateId) {
        setError("Elige una plantilla publicada")
        return
      }
      setError(null)
      createMutation.mutate()
    })
  })

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel>Plantilla publicada</FieldLabel>
        <Select value={templateId} onValueChange={(v: string | null) => setTemplateId(v ?? "")}>
          <SelectTrigger aria-label="Plantilla de consentimiento">
            <SelectValue placeholder="Elige una plantilla" />
          </SelectTrigger>
          <SelectContent>
            {templates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.title} (v{t.version})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="consent-procedure">Procedimiento o plan al que aplica</FieldLabel>
        <Input
          id="consent-procedure"
          value={procedureRef}
          onChange={(event) => setProcedureRef(event.target.value)}
          maxLength={500}
          placeholder="p. ej. Tratamiento de conducto pieza 36"
        />
      </Field>
      {error ? <FieldError>{error}</FieldError> : null}
      {createMutation.isPending ? (
        <p className="text-sm text-muted-foreground">Generando…</p>
      ) : null}
    </div>
  )
}

function ConsentDetail({
  document,
  canWrite,
  onChanged,
}: {
  document: ConsentDocument
  canWrite: boolean
  onChanged: () => void
}) {
  const printRef = useRef<HTMLDivElement | null>(null)
  const historyQuery = useQuery({
    queryKey: ["consent-history", document.id],
    queryFn: () => fetchConsentHistory(document.id),
  })

  return (
    <div className="mt-3 flex flex-col gap-4 border-t pt-3">
      <div ref={printRef} className="rounded-md border bg-white p-4 text-sm text-black">
        <h4 className="font-semibold">{document.titleSnapshot}</h4>
        <p className="mt-1 text-xs text-neutral-600">
          Versión aceptada v{document.templateVersion} · Documento inmutable desde su generación.
        </p>
        <p className="mt-3 whitespace-pre-wrap">{document.bodySnapshot}</p>
        {document.procedureRef ? (
          <p className="mt-3">
            <strong>Aplica a:</strong> {document.procedureRef}
          </p>
        ) : null}
        <div className="mt-4 border-t pt-3">
          {document.status === "pendiente" ? (
            <p className="text-neutral-600">Pendiente de firma manuscrita.</p>
          ) : (
            <>
              <p>
                <strong>Firmante:</strong> {document.signerName} ({document.signerKind}
                {document.signerKind === "representante" && document.representativeRelation
                  ? ` · ${document.representativeRelation}`
                  : ""}
                {document.signerDoc ? ` · doc. ${document.signerDoc}` : ""})
              </p>
              <p>
                <strong>Firmado:</strong>{" "}
                {document.signedAt ? new Date(document.signedAt).toLocaleString("es-PE") : "—"}
              </p>
              {document.signatureData?.strokes ? (
                <div className="mt-2 max-w-sm">
                  <FirmaView strokes={document.signatureData.strokes} />
                </div>
              ) : null}
              {document.status === "revocado" ? (
                <p className="mt-2">
                  <strong>Revocado:</strong>{" "}
                  {document.revokedAt ? new Date(document.revokedAt).toLocaleString("es-PE") : "—"} ·{" "}
                  {document.revokeReason}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => window.print()}>
          Imprimir
        </Button>
      </div>
      {document.status === "pendiente" && canWrite ? (
        <SignForm documentId={document.id} onChanged={onChanged} />
      ) : null}
      {document.status === "firmado" && canWrite ? (
        <RevokeForm documentId={document.id} onChanged={onChanged} />
      ) : null}
      <div>
        <h4 className="text-sm font-semibold">Historia</h4>
        <ul className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
          {(historyQuery.data?.data ?? []).map((event) => (
            <li key={event.id}>
              {new Date(event.createdAt).toLocaleString("es-PE")} · {event.fromStatus ?? "—"} →{" "}
              {event.toStatus}
              {event.reason ? ` · ${event.reason}` : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function SignForm({ documentId, onChanged }: { documentId: string; onChanged: () => void }) {
  const [signerKind, setSignerKind] = useState<"paciente" | "representante">("paciente")
  const [signerName, setSignerName] = useState("")
  const [signerDoc, setSignerDoc] = useState("")
  const [relation, setRelation] = useState("")
  const [strokes, setStrokes] = useState<number[][][]>([])
  const [error, setError] = useState<string | null>(null)
  const signMutation = useMutation({
    mutationFn: () =>
      signConsent(documentId, {
        signerKind,
        signerName: signerName.trim(),
        signerDoc: signerDoc.trim() ? signerDoc.trim() : null,
        representativeRelation: signerKind === "representante" && relation.trim() ? relation.trim() : null,
        signatureData: { strokes },
      }),
    onSuccess: () => {
      toast.success("Consentimiento firmado")
      onChanged()
    },
    onError: (e: unknown) => {
      setError(e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación")
    },
  })

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!signerName.trim()) {
          setError("Ingresa el nombre de quien firma")
          return
        }
        if (strokes.length === 0) {
          setError("La firma manuscrita es obligatoria")
          return
        }
        setError(null)
        signMutation.mutate()
      }}
    >
      <h4 className="text-sm font-semibold">Firma manuscrita</h4>
      <Field>
        <FieldLabel>¿Quién firma?</FieldLabel>
        <Select value={signerKind} onValueChange={(v) => setSignerKind(v as "paciente" | "representante")}>
          <SelectTrigger aria-label="Firmante">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="paciente">El paciente</SelectItem>
            <SelectItem value="representante">Representante verificado</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="signer-name">Nombre de quien firma</FieldLabel>
        <Input
          id="signer-name"
          value={signerName}
          onChange={(event) => setSignerName(event.target.value)}
          maxLength={200}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="signer-doc">
          Documento {signerKind === "representante" ? "(verificado, obligatorio)" : "(opcional)"}
        </FieldLabel>
        <Input
          id="signer-doc"
          value={signerDoc}
          onChange={(event) => setSignerDoc(event.target.value)}
          maxLength={40}
        />
      </Field>
      {signerKind === "representante" ? (
        <Field>
          <FieldLabel htmlFor="signer-relation">Parentesco o relación verificada</FieldLabel>
          <Input
            id="signer-relation"
            value={relation}
            onChange={(event) => setRelation(event.target.value)}
            maxLength={120}
            placeholder="p. ej. Madre, apoderado"
          />
        </Field>
      ) : null}
      <FirmaPad onChange={setStrokes} />
      {error ? <FieldError>{error}</FieldError> : null}
      <Button type="submit" disabled={signMutation.isPending}>
        {signMutation.isPending ? "Firmando…" : "Firmar consentimiento"}
      </Button>
    </form>
  )
}

function RevokeForm({ documentId, onChanged }: { documentId: string; onChanged: () => void }) {
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const revokeMutation = useMutation({
    mutationFn: () => revokeConsent(documentId, reason.trim()),
    onSuccess: () => {
      toast.success("Consentimiento revocado")
      onChanged()
    },
    onError: (e: unknown) => {
      setError(e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación")
    },
  })
  return (
    <form
      className="flex flex-col gap-2 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!reason.trim()) {
          setError("La revocación necesita un motivo")
          return
        }
        setError(null)
        revokeMutation.mutate()
      }}
    >
      <h4 className="text-sm font-semibold">Revocar</h4>
      <Textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="Motivo de la revocación"
        aria-label="Motivo de revocación"
      />
      {error ? <FieldError>{error}</FieldError> : null}
      <Button type="submit" size="sm" variant="outline" disabled={revokeMutation.isPending}>
        Revocar consentimiento
      </Button>
    </form>
  )
}

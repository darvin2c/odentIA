import { Badge, Button, Checkbox, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@odentia/ui"
import { ErrorState, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { type ContactFull, usePermission } from "../../lib/crm"
import { type Patient, type PatientDocument, type PatientFull } from "../../lib/patients"
import {
  approvePortalRequestApi,
  formatPortalDate,
  listPortalRequestsApi,
  rejectPortalRequestApi,
  type ApprovedPortalRequest,
  type PortalAccessRequest,
  type PortalRelationship,
} from "../../lib/portal"

const CHANNEL_LABEL: Record<string, string> = {
  web_publica: "Web pública",
  conversacion: "Conversación",
}

const RELATIONSHIP_LABEL: Record<PortalRelationship, string> = {
  self: "El propio paciente",
  guardian: "Tutor legal",
  family: "Familiar",
  other: "Otro",
}
const VERIFIED_METHOD_LABEL: Record<string, string> = {
  presencial_documento: "Presencial con documento",
  representacion_verificada: "Representación verificada",
}

function mutationMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.shape.message ?? fallback
  return fallback
}

/**
 * Cola de solicitudes de acceso al portal dentro de Tareas: el personal con
 * patients.write verifica identidad y representación (documento presencial o
 * evidencia registrada; el teléfono nunca basta) y aprueba o rechaza.
 */
export function PortalRequestsSection() {
  const canManage = usePermission("patients.write")
  const requestsQuery = useQuery({
    queryKey: ["portal-requests", "pendiente"],
    queryFn: () => listPortalRequestsApi("pendiente"),
    enabled: canManage,
    retry: false,
  })
  if (!canManage) return null
  return (
    <section className="grid gap-3 rounded-md border p-4" aria-labelledby="portal-requests-title">
      <div>
        <h2 id="portal-requests-title" className="text-sm font-medium">
          Solicitudes de acceso al portal
        </h2>
        <p className="text-sm text-muted-foreground">
          Verifica la identidad antes de aprobar. La coincidencia de teléfono nunca basta.
        </p>
      </div>
      {requestsQuery.isPending ? (
        <LoadingState message="Cargando solicitudes…" />
      ) : requestsQuery.isError ? (
        <ErrorState
          title="No se pudieron cargar las solicitudes"
          message={mutationMessage(requestsQuery.error, "Intenta de nuevo.")}
        />
      ) : requestsQuery.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin solicitudes pendientes.</p>
      ) : (
        <div className="grid gap-3">
          {requestsQuery.data.map((request) => (
            <RequestCard key={request.id} request={request} />
          ))}
        </div>
      )}
    </section>
  )
}

function RequestCard({ request }: { request: PortalAccessRequest }) {
  const [mode, setMode] = useState<"none" | "approve" | "reject">("none")
  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{request.contactName}</p>
          <p className="text-xs text-muted-foreground">
            {CHANNEL_LABEL[request.channel] ?? request.channel} · recibida el{" "}
            {formatPortalDate(request.createdAt)} · vence el {formatPortalDate(request.expiresAt)}
            {request.patientName ? ` · dice representar a ${request.patientName}` : ""}
            {request.contactText ? ` · contacto: ${request.contactText}` : ""}
          </p>
        </div>
        <Badge variant="secondary">Pendiente</Badge>
      </div>
      {mode === "none" && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setMode("approve")}>
            Verificar y aprobar
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMode("reject")}>
            Rechazar
          </Button>
        </div>
      )}
      {mode === "approve" && (
        <ApproveForm request={request} onDone={() => setMode("none")} onCancel={() => setMode("none")} />
      )}
      {mode === "reject" && (
        <RejectForm requestId={request.id} onDone={() => setMode("none")} onCancel={() => setMode("none")} />
      )}
    </div>
  )
}

function ApproveForm({
  request,
  onDone,
  onCancel,
}: {
  request: PortalAccessRequest
  onDone: () => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const canAuthorizeDocs = usePermission("clinical.read")
  const canShareFinance = usePermission("finance.read")
  const [q, setQ] = useState("")
  const [patientId, setPatientId] = useState("")
  const [contactId, setContactId] = useState("")
  const [conversationId, setConversationId] = useState("")
  const [relationship, setRelationship] = useState<PortalRelationship>("self")
  const [verifiedMethod, setVerifiedMethod] = useState("presencial_documento")
  const [evidenceNote, setEvidenceNote] = useState("")
  const [scopeAppointments, setScopeAppointments] = useState(true)
  const [scopeBudgets, setScopeBudgets] = useState(false)
  const [scopeAccount, setScopeAccount] = useState(false)
  const [documentIds, setDocumentIds] = useState<string[]>([])

  const searchQuery = useQuery({
    queryKey: ["portal-patient-search", q.trim()],
    queryFn: () =>
      apiFetch<{ data: Patient[] }>(`/api/patients?q=${encodeURIComponent(q.trim())}&limit=10`),
    enabled: q.trim().length >= 2 && patientId === "",
    retry: false,
  })
  const patientQuery = useQuery({
    queryKey: ["portal-patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: patientId !== "",
    retry: false,
  })
  const contactQuery = useQuery({
    queryKey: ["portal-contact", contactId],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${contactId}`),
    enabled: contactId !== "",
    retry: false,
  })
  const documentsQuery = useQuery({
    queryKey: ["portal-documents", patientId],
    queryFn: () => apiFetch<{ data: PatientDocument[] }>(`/api/patients/${patientId}/documents`),
    enabled: patientId !== "" && canAuthorizeDocs,
    retry: false,
  })

  const contacts = patientQuery.data?.data.contacts ?? []
  const conversations = (contactQuery.data?.data.conversations ?? []).filter((c) => c.status === "open")
  const documents = documentsQuery.data?.data ?? []
  const [result, setResult] = useState<ApprovedPortalRequest | null>(null)

  const approveMutation = useMutation({
    mutationFn: () =>
      approvePortalRequestApi(request.id, {
        patientId,
        contactId,
        relationship,
        scope: {
          appointments: scopeAppointments,
          budgets: canShareFinance && scopeBudgets,
          account: canShareFinance && scopeAccount,
          documentIds: canAuthorizeDocs ? documentIds : [],
        },
        verifiedMethod,
        evidenceNote: evidenceNote.trim() === "" ? undefined : evidenceNote.trim(),
        conversationId,
      }),
    onSuccess: (data) => {
      setResult(data)
      void queryClient.invalidateQueries({ queryKey: ["portal-requests"] })
    },
  })

  const canSubmit =
    patientId !== "" &&
    contactId !== "" &&
    conversationId !== "" &&
    evidenceNote.trim() !== "" &&
    (scopeAppointments ||
      (canShareFinance && (scopeBudgets || scopeAccount)) ||
      (canAuthorizeDocs && documentIds.length > 0)) &&
    !approveMutation.isPending

  if (result) {
    return (
      <div className="grid gap-2 rounded-md border p-3" role="status">
        <p className="text-sm font-medium">Solicitud aprobada</p>
        <p className="text-sm text-muted-foreground">
          Permiso creado para {result.grant.contactName}. Enlace enviado por la conversación; vence
          el {formatPortalDate(result.link.link.expiresAt)}. El enlace no se muestra aquí por seguridad.
        </p>
        {result.link.pinOnce && (
          <p className="text-sm font-medium">
            Código de 6 dígitos (una sola vez, no vuelve a mostrarse): {result.link.pinOnce}.
            Comunícalo al contacto por vía independiente de la bandeja; sin este código el enlace
            no abre.
          </p>
        )}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setResult(null)
              onDone()
            }}
          >
            Listo
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <p className="text-sm font-medium">
        Aprobar con identidad verificada
        <span className="block text-xs font-normal text-muted-foreground">
          El enlace asistido se envía por la conversación elegida; el código va por vía
          independiente.
        </span>
      </p>
      <div className="grid gap-2">
        <Label htmlFor={`portal-approve-patient-${request.id}`}>Paciente verificado</Label>
        {patientId === "" ? (
          <>
            <Input
              id={`portal-approve-patient-${request.id}`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Busca por nombre o documento…"
            />
            {searchQuery.data && (
              <div className="grid gap-1">
                {searchQuery.data.data.map((p) => (
                  <Button
                    key={p.id}
                    variant="ghost"
                    className="justify-start"
                    onClick={() => {
                      setPatientId(p.id)
                      setContactId("")
                      setConversationId("")
                      setDocumentIds([])
                    }}
                  >
                    {p.displayName} · N.º {p.patientNumber}
                  </Button>
                ))}
                {searchQuery.data.data.length === 0 && (
                  <p className="text-sm text-muted-foreground">Sin resultados.</p>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{patientQuery.data?.data.patient.displayName ?? "Paciente"}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPatientId("")
                setContactId("")
                setConversationId("")
                setDocumentIds([])
                setQ("")
              }}
            >
              Cambiar
            </Button>
          </div>
        )}
      </div>

      {patientId !== "" && (
        <div className="grid gap-2">
          <Label htmlFor={`portal-approve-contact-${request.id}`}>Contacto (representante vinculado)</Label>
          {patientQuery.isPending ? (
            <LoadingState message="Cargando contactos…" />
          ) : contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="alert">
              Sin contactos vinculados: vincula un contacto al paciente antes de aprobar.
            </p>
          ) : (
            <Select
              value={contactId}
              onValueChange={(value) => {
                if (value === null) return
                setContactId(value)
                setConversationId("")
              }}
            >
              <SelectTrigger id={`portal-approve-contact-${request.id}`}>
                <SelectValue placeholder="Elige el contacto" />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((c) => (
                  <SelectItem key={c.contactId} value={c.contactId}>
                    {c.displayName} · {c.relationship}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {contactId !== "" && (
        <div className="grid gap-2">
          <Label htmlFor={`portal-approve-conversation-${request.id}`}>Conversación de entrega</Label>
          {contactQuery.isPending ? (
            <LoadingState message="Cargando conversaciones…" />
          ) : conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="alert">
              Sin conversación abierta para este contacto.
            </p>
          ) : (
            <Select
              value={conversationId}
              onValueChange={(value) => {
                if (value !== null) setConversationId(value)
              }}
            >
              <SelectTrigger id={`portal-approve-conversation-${request.id}`}>
                <SelectValue placeholder="Elige la conversación" />
              </SelectTrigger>
              <SelectContent>
                {conversations.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.channel} · {c.connectionName ?? "sin conexión"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor={`portal-approve-relationship-${request.id}`}>Vínculo con el paciente</Label>
        <Select
          value={relationship}
          onValueChange={(value) => {
            if (value !== null) setRelationship(value as PortalRelationship)
          }}
        >
          <SelectTrigger id={`portal-approve-relationship-${request.id}`}>
            <SelectValue>{RELATIONSHIP_LABEL[relationship]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(RELATIONSHIP_LABEL) as PortalRelationship[]).map((r) => (
              <SelectItem key={r} value={r}>
                {RELATIONSHIP_LABEL[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`portal-approve-method-${request.id}`}>Identidad verificada mediante</Label>
        <Select value={verifiedMethod} onValueChange={(value) => { if (value !== null) setVerifiedMethod(value) }}>
          <SelectTrigger id={`portal-approve-method-${request.id}`}>
            <SelectValue>{VERIFIED_METHOD_LABEL[verifiedMethod] ?? verifiedMethod}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="presencial_documento">Presencial con documento</SelectItem>
            <SelectItem value="representacion_verificada">Representación verificada</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`portal-approve-evidence-${request.id}`}>Cómo verificaste la identidad *</Label>
        <Textarea
          id={`portal-approve-evidence-${request.id}`}
          value={evidenceNote}
          maxLength={500}
          required
          placeholder="Ej.: DNI verificado en recepción el …"
          onChange={(e) => setEvidenceNote(e.target.value)}
        />
      </div>

      {conversationId !== "" && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Alcance autorizado</legend>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={scopeAppointments} onCheckedChange={(v) => setScopeAppointments(v === true)} />
            Citas: ver, confirmar y reprogramar
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={canShareFinance && scopeBudgets}
              disabled={!canShareFinance}
              onCheckedChange={(v) => setScopeBudgets(v === true)}
            />
            Presupuestos: ver y decidir {!canShareFinance && "(requiere finance.read)"}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={canShareFinance && scopeAccount}
              disabled={!canShareFinance}
              onCheckedChange={(v) => setScopeAccount(v === true)}
            />
            Cuenta y saldo (solo lectura) {!canShareFinance && "(requiere finance.read)"}
          </label>
        </fieldset>
      )}

      {canAuthorizeDocs && conversationId !== "" && (
        <div className="grid gap-2">
          <Label>Documentos autorizados</Label>
          {documentsQuery.isPending ? (
            <LoadingState message="Cargando documentos…" />
          ) : documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">El paciente no tiene documentos.</p>
          ) : (
            <div className="grid gap-1">
              {documents.map((doc) => (
                <label key={doc.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={documentIds.includes(doc.id)}
                    onCheckedChange={() =>
                      setDocumentIds((prev) =>
                        prev.includes(doc.id) ? prev.filter((d) => d !== doc.id) : [...prev, doc.id],
                      )
                    }
                  />
                  {doc.label} · {doc.category}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {approveMutation.isError && (
        <ErrorState
          title="No se pudo aprobar"
          message={mutationMessage(approveMutation.error, "Revisa los datos e intenta de nuevo.")}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={approveMutation.isPending} disabled={!canSubmit} onClick={() => approveMutation.mutate()}>
          Aprobar y enviar enlace
        </SubmitButton>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

function RejectForm({
  requestId,
  onDone,
  onCancel,
}: {
  requestId: string
  onDone: () => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState("")
  const rejectMutation = useMutation({
    mutationFn: () => rejectPortalRequestApi(requestId, note.trim() === "" ? undefined : note.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["portal-requests"] })
      onDone()
    },
  })
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <Label htmlFor={`portal-reject-note-${requestId}`}>Motivo (opcional, interno)</Label>
      <Input
        id={`portal-reject-note-${requestId}`}
        value={note}
        maxLength={200}
        placeholder="Ej.: no se pudo verificar la identidad"
        onChange={(e) => setNote(e.target.value)}
      />
      {rejectMutation.isError && (
        <ErrorState
          title="No se pudo rechazar"
          message={mutationMessage(rejectMutation.error, "Intenta de nuevo.")}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          size="sm"
          disabled={rejectMutation.isPending}
          onClick={() => rejectMutation.mutate()}
        >
          Confirmar rechazo
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

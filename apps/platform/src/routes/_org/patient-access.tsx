import { Badge, Button, Checkbox, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsContent, TabsList, TabsTrigger } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { type ContactFull, usePermission } from "../../lib/crm"
import { type Patient, type PatientDocument, type PatientFull } from "../../lib/patients"
import {
  formatPortalDate,
  issuePortalLinkApi,
  listPortalLinksApi,
  revokePortalLinkApi,
  type IssuedPortalLink,
} from "../../lib/portal"

export const Route = createFileRoute("/_org/patient-access")({
  component: PortalStaffPage,
})

const LINK_STATUS_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  usado: "Usado",
  revocado: "Revocado",
}

function mutationMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.shape.message ?? fallback
  return fallback
}

function PortalStaffPage() {
  const canIssue = usePermission("patients.write")
  const canAuthorizeDocs = usePermission("clinical.read")
  const canShareFinance = usePermission("finance.read")
  if (!canIssue) {
    return (
      <PageShell maxWidth="md">
        <EmptyState
          title="Sin acceso al portal"
          description="Necesitas el permiso patients.write para emitir accesos del portal."
        />
      </PageShell>
    )
  }
  return (
    <PageShell maxWidth="lg">
      <PageHeader
        title="Portal del paciente"
        subtitle="Emite accesos de un solo uso: el enlace viaja por la conversación del contacto, nunca se muestra aquí."
      />
      <Tabs defaultValue="emitir">
        <TabsList>
          <TabsTrigger value="emitir">Emitir acceso</TabsTrigger>
          <TabsTrigger value="enlaces">Enlaces recientes</TabsTrigger>
        </TabsList>
        <TabsContent value="emitir">
          <IssuePanel canAuthorizeDocs={canAuthorizeDocs} canShareFinance={canShareFinance} />
        </TabsContent>
        <TabsContent value="enlaces">
          <LinksPanel />
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}

function IssuePanel({ canAuthorizeDocs, canShareFinance }: { canAuthorizeDocs: boolean; canShareFinance: boolean }) {
  const queryClient = useQueryClient()
  const [q, setQ] = useState("")
  const [patientId, setPatientId] = useState("")
  const [contactId, setContactId] = useState("")
  const [conversationId, setConversationId] = useState("")
  const [scopeAppointments, setScopeAppointments] = useState(true)
  const [scopeBudgets, setScopeBudgets] = useState(true)
  const [scopeAccount, setScopeAccount] = useState(true)
  const [documentIds, setDocumentIds] = useState<string[]>([])
  const [ttlHours, setTtlHours] = useState("72")
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [issued, setIssued] = useState<IssuedPortalLink | null>(null)

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
  const selectedConversation = conversations.find((c) => c.id === conversationId) ?? null

  const issueMutation = useMutation({
    mutationFn: () =>
      issuePortalLinkApi({
        patientId,
        contactId,
        conversationId,
        scope: {
          appointments: scopeAppointments,
          budgets: canShareFinance && scopeBudgets,
          account: canShareFinance && scopeAccount,
          documentIds: canAuthorizeDocs ? documentIds : [],
        },
        ttlHours: Number(ttlHours),
        idempotencyKey,
      }),
    onSuccess: (result) => {
      setIssued(result)
      setIdempotencyKey(crypto.randomUUID())
      void queryClient.invalidateQueries({ queryKey: ["portal-links"] })
    },
  })

  const canSubmit =
    patientId !== "" &&
    contactId !== "" &&
    conversationId !== "" &&
    (scopeAppointments ||
      (canShareFinance && (scopeBudgets || scopeAccount)) ||
      (canAuthorizeDocs && documentIds.length > 0)) &&
    !issueMutation.isPending

  function toggleDocument(id: string) {
    setDocumentIds((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]))
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Label htmlFor="portal-patient-q">Paciente</Label>
        {patientId === "" ? (
          <>
            <Input
              id="portal-patient-q"
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
                      setIssued(null)
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
          <Label htmlFor="portal-contact">Contacto (representante vinculado)</Label>
          {patientQuery.isPending ? (
            <LoadingState message="Cargando contactos…" />
          ) : contacts.length === 0 ? (
            <EmptyState
              title="Sin contactos vinculados"
              description="Vincula un contacto al paciente antes de emitir un acceso."
            />
          ) : (
            <Select
              value={contactId}
              onValueChange={(value) => {
                if (value === null) return
                setContactId(value)
                setConversationId("")
                setIssued(null)
              }}
            >
              <SelectTrigger id="portal-contact">
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
          <Label htmlFor="portal-conversation">Conversación de entrega (canal validado)</Label>
          {contactQuery.isPending ? (
            <LoadingState message="Cargando conversaciones…" />
          ) : conversations.length === 0 ? (
            <EmptyState
              title="Sin conversación abierta"
              description="El contacto necesita una conversación abierta para recibir el enlace."
            />
          ) : (
            <Select
              value={conversationId}
              onValueChange={(value) => {
                if (value === null) return
                setConversationId(value)
                setIssued(null)
              }}
            >
              <SelectTrigger id="portal-conversation">
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

      {conversationId !== "" && (
        <>
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

          {canAuthorizeDocs && (
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
                        onCheckedChange={() => toggleDocument(doc.id)}
                      />
                      {doc.label} · {doc.category}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="portal-ttl">Vigencia del enlace</Label>
            <Select value={ttlHours} onValueChange={(value) => { if (value !== null) setTtlHours(value) }}>
              <SelectTrigger id="portal-ttl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24">24 horas</SelectItem>
                <SelectItem value="72">72 horas</SelectItem>
                <SelectItem value="168">7 días</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {issueMutation.isError && (
            <ErrorState
              title="No se pudo emitir"
              message={mutationMessage(issueMutation.error, "Revisa los datos e intenta de nuevo.")}
            />
          )}
          {issued && (
            <div className="rounded-md border p-3 text-sm" role="status">
              {issued.replay ? "Ya existía un enlace vigente: se reutilizó. " : ""}
              Enlace enviado a {issued.link.contactName} por {selectedConversation?.channel ?? "la conversación"}.{" "}
              Vence el {formatPortalDate(issued.link.expiresAt)}. El enlace no se muestra aquí por seguridad.
              {issued.pinOnce && (
                <p className="mt-2 font-medium">
                  Código de 6 dígitos (una sola vez): {issued.pinOnce}. Comunícalo al contacto por vía
                  independiente de la bandeja; sin este código el enlace no abre.
                </p>
              )}
            </div>
          )}
          <div>
            <SubmitButton pending={issueMutation.isPending} disabled={!canSubmit} onClick={() => issueMutation.mutate()}>
              Enviar enlace por la conversación
            </SubmitButton>
          </div>
        </>
      )}
    </div>
  )
}

function LinksPanel() {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState("")
  const linksQuery = useQuery({
    queryKey: ["portal-links"],
    queryFn: () => listPortalLinksApi(),
  })
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokePortalLinkApi(id),
    onSuccess: () => {
      setConfirming("")
      void queryClient.invalidateQueries({ queryKey: ["portal-links"] })
    },
  })

  if (linksQuery.isPending) return <LoadingState message="Cargando enlaces…" />
  if (linksQuery.isError) {
    return (
      <ErrorState
        title="No se pudieron cargar los enlaces"
        message={mutationMessage(linksQuery.error, "Intenta de nuevo.")}
      />
    )
  }
  const links = linksQuery.data
  if (links.length === 0) {
    return <EmptyState title="Sin enlaces" description="Aún no se emitió ningún acceso al portal." />
  }
  return (
    <div className="grid gap-2">
      {revokeMutation.isError && (
        <ErrorState
          title="No se pudo revocar"
          message={mutationMessage(revokeMutation.error, "Intenta de nuevo.")}
        />
      )}
      {links.map((link) => (
        <div key={link.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {link.patientName} → {link.contactName}
            </p>
            <p className="text-xs text-muted-foreground">
              Vence el {formatPortalDate(link.expiresAt)}
              {link.usedAt ? ` · usado el ${formatPortalDate(link.usedAt)}` : ""}
              {link.revokedAt ? ` · revocado el ${formatPortalDate(link.revokedAt)}` : ""}
            </p>
          </div>
          <Badge variant={link.status === "pendiente" ? "default" : "secondary"}>
            {LINK_STATUS_LABEL[link.status] ?? link.status}
          </Badge>
          {link.status === "pendiente" && confirming !== link.id && (
            <Button variant="outline" size="sm" onClick={() => setConfirming(link.id)}>
              Revocar
            </Button>
          )}
          {link.status === "pendiente" && confirming === link.id && (
            <>
              <Button
                variant="destructive"
                size="sm"
                disabled={revokeMutation.isPending}
                onClick={() => revokeMutation.mutate(link.id)}
              >
                Confirmar revocación
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming("")}>
                Cancelar
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

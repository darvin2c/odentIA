import { Badge, Button, Checkbox, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@odentia/ui"
import { ErrorState, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import type { PatientDocument, PatientFull } from "../../lib/patients"
import {
  createPortalGrantApi,
  formatPortalDate,
  listPortalGrantsApi,
  listPortalPasskeysApi,
  listPortalSessionsApi,
  revokePortalGrantApi,
  revokePortalPasskeyApi,
  revokePortalSessionApi,
  type PortalRelationship,
} from "../../lib/portal"

const RELATIONSHIP_LABEL: Record<PortalRelationship, string> = {
  self: "El propio paciente",
  guardian: "Tutor legal",
  family: "Familiar",
  other: "Otro",
}

const VERIFIED_METHOD_LABEL: Record<string, string> = {
  presencial_documento: "Presencial con documento",
  representacion_verificada: "Representación verificada",
  asistida_pin: "Asistida con código",
  passkey: "Passkey",
}

const GRANT_STATUS_LABEL: Record<string, string> = {
  activo: "Activo",
  revocado: "Revocado",
}

function mutationMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.shape.message ?? fallback
  return fallback
}

/**
 * Permisos persistentes, sesiones y passkeys del paciente en su ficha.
 * La identidad y la representación se verifican aquí con documento presencial
 * o evidencia de representación: la coincidencia de teléfono nunca basta.
 * La cola de solicitudes entrantes se atiende desde Tareas.
 */
export function PortalGrantsPanel({ patientId }: { patientId: string }) {
  const canManage = usePermission("patients.write")
  const canAuthorizeDocs = usePermission("clinical.read")
  const canShareFinance = usePermission("finance.read")
  if (!canManage) return null
  return (
    <div className="grid gap-3 rounded-md border p-3">
      <p className="text-sm font-medium">Paso 1 · Permiso verificado y sesiones</p>
      <p className="text-sm text-muted-foreground">
        Los permisos son revocables y sobreviven a los enlaces. Revocar un permiso también revoca
        sus sesiones activas y bloquea sus enlaces pendientes.
      </p>
      <GrantCreateForm
        patientId={patientId}
        canAuthorizeDocs={canAuthorizeDocs}
        canShareFinance={canShareFinance}
      />
      <GrantsList patientId={patientId} />
      <SessionsList patientId={patientId} />
      <PasskeysSection patientId={patientId} />
    </div>
  )
}

function GrantCreateForm({
  patientId,
  canAuthorizeDocs,
  canShareFinance,
}: {
  patientId: string
  canAuthorizeDocs: boolean
  canShareFinance: boolean
}) {
  const queryClient = useQueryClient()
  const [contactId, setContactId] = useState("")
  const [relationship, setRelationship] = useState<PortalRelationship>("self")
  const [verifiedMethod, setVerifiedMethod] = useState("presencial_documento")
  const [evidenceNote, setEvidenceNote] = useState("")
  const [scopeAppointments, setScopeAppointments] = useState(true)
  const [scopeBudgets, setScopeBudgets] = useState(false)
  const [scopeAccount, setScopeAccount] = useState(false)
  const [documentIds, setDocumentIds] = useState<string[]>([])
  const [created, setCreated] = useState<string | null>(null)

  const patientQuery = useQuery({
    queryKey: ["portal-patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    retry: false,
  })
  const documentsQuery = useQuery({
    queryKey: ["portal-documents", patientId],
    queryFn: () => apiFetch<{ data: PatientDocument[] }>(`/api/patients/${patientId}/documents`),
    enabled: canAuthorizeDocs,
    retry: false,
  })
  const contacts = patientQuery.data?.data.contacts ?? []
  const documents = documentsQuery.data?.data ?? []

  const createMutation = useMutation({
    mutationFn: () =>
      createPortalGrantApi({
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
      }),
    onSuccess: (grant) => {
      setCreated(`Permiso creado para ${grant.contactName}, verificado: ${VERIFIED_METHOD_LABEL[grant.verifiedMethod] ?? grant.verifiedMethod}.`)
      setEvidenceNote("")
      setDocumentIds([])
      void queryClient.invalidateQueries({ queryKey: ["portal-grants", patientId] })
    },
  })

  const canSubmit =
    contactId !== "" &&
    evidenceNote.trim() !== "" &&
    (scopeAppointments ||
      (canShareFinance && (scopeBudgets || scopeAccount)) ||
      (canAuthorizeDocs && documentIds.length > 0)) &&
    !createMutation.isPending

  if (patientQuery.isPending) return <LoadingState message="Cargando contactos…" />
  if (patientQuery.isError || contacts.length === 0) return null

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <p className="text-sm font-medium">Crear permiso verificado</p>
      <div className="grid gap-2">
        <Label htmlFor="portal-grant-contact">Contacto (representante)</Label>
        <Select
          value={contactId}
          onValueChange={(value) => {
            if (value === null) return
            setContactId(value)
            setCreated(null)
          }}
        >
          <SelectTrigger id="portal-grant-contact">
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
      </div>
      <div className="grid gap-2">
        <Label htmlFor="portal-grant-relationship">Vínculo con el paciente</Label>
        <Select
          value={relationship}
          onValueChange={(value) => {
            if (value === null) return
            setRelationship(value as PortalRelationship)
          }}
        >
          <SelectTrigger id="portal-grant-relationship">
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
        <Label htmlFor="portal-grant-method">Identidad verificada mediante</Label>
        <Select value={verifiedMethod} onValueChange={(value) => { if (value !== null) setVerifiedMethod(value) }}>
          <SelectTrigger id="portal-grant-method">
            <SelectValue>{VERIFIED_METHOD_LABEL[verifiedMethod] ?? verifiedMethod}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="presencial_documento">Presencial con documento</SelectItem>
            <SelectItem value="representacion_verificada">Representación verificada</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Solo estos dos métodos. La coincidencia de teléfono nunca verifica identidad.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="portal-grant-evidence">Cómo verificaste la identidad *</Label>
        <Textarea
          id="portal-grant-evidence"
          value={evidenceNote}
          maxLength={500}
          required
          placeholder="Ej.: DNI verificado en recepción el …"
          onChange={(e) => setEvidenceNote(e.target.value)}
        />
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Alcance del permiso</legend>
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
          <Label>Documentos incluidos</Label>
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
      {createMutation.isError && (
        <ErrorState
          title="No se pudo crear el permiso"
          message={mutationMessage(createMutation.error, "Revisa los datos e intenta de nuevo.")}
        />
      )}
      {created && (
        <p className="text-sm text-muted-foreground" role="status">{created}</p>
      )}
      <div>
        <SubmitButton size="sm" pending={createMutation.isPending} disabled={!canSubmit} onClick={() => createMutation.mutate()}>
          Crear permiso
        </SubmitButton>
      </div>
    </div>
  )
}

function GrantsList({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState("")
  const [reason, setReason] = useState("")
  const grantsQuery = useQuery({
    queryKey: ["portal-grants", patientId],
    queryFn: () => listPortalGrantsApi(patientId),
    retry: false,
  })
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokePortalGrantApi(id, reason.trim() === "" ? undefined : reason.trim()),
    onSuccess: () => {
      setConfirming("")
      setReason("")
      void queryClient.invalidateQueries({ queryKey: ["portal-grants", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["portal-sessions", patientId] })
    },
  })

  if (grantsQuery.isPending) return <LoadingState message="Cargando permisos…" />
  if (grantsQuery.isError) {
    return (
      <ErrorState
        title="No se pudieron cargar los permisos"
        message={mutationMessage(grantsQuery.error, "Intenta de nuevo.")}
      />
    )
  }
  if (grantsQuery.data.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin permisos para este paciente.</p>
  }
  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">Permisos</p>
      {revokeMutation.isError && (
        <ErrorState
          title="No se pudo revocar"
          message={mutationMessage(revokeMutation.error, "Intenta de nuevo.")}
        />
      )}
      {grantsQuery.data.map((grant) => (
        <div key={grant.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {grant.contactName} · {VERIFIED_METHOD_LABEL[grant.verifiedMethod] ?? grant.verifiedMethod}
            </p>
            <p className="text-xs text-muted-foreground">
              Verificado el {formatPortalDate(grant.verifiedAt)}
              {grant.expiresAt ? ` · vence el ${formatPortalDate(grant.expiresAt)}` : " · sin caducidad"}
              {grant.revokedAt ? ` · revocado el ${formatPortalDate(grant.revokedAt)}` : ""}
            </p>
          </div>
          <Badge variant={grant.status === "activo" ? "default" : "secondary"}>
            {GRANT_STATUS_LABEL[grant.status] ?? grant.status}
          </Badge>
          {grant.status === "activo" && confirming !== grant.id && (
            <Button variant="outline" size="sm" onClick={() => setConfirming(grant.id)}>
              Revocar
            </Button>
          )}
          {grant.status === "activo" && confirming === grant.id && (
            <div className="grid w-full gap-2">
              <p className="text-xs text-muted-foreground">
                Revocar también cierra sus sesiones activas y bloquea sus enlaces pendientes.
              </p>
              <Input
                value={reason}
                maxLength={200}
                placeholder="Motivo (opcional)"
                onChange={(e) => setReason(e.target.value)}
                aria-label="Motivo de la revocación"
              />
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={revokeMutation.isPending}
                  onClick={() => revokeMutation.mutate(grant.id)}
                >
                  Confirmar revocación
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setConfirming(""); setReason("") }}>
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function SessionsList({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState("")
  const sessionsQuery = useQuery({
    queryKey: ["portal-sessions", patientId],
    queryFn: () => listPortalSessionsApi({ patientId }),
    retry: false,
  })
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokePortalSessionApi(id),
    onSuccess: () => {
      setConfirming("")
      void queryClient.invalidateQueries({ queryKey: ["portal-sessions", patientId] })
    },
  })

  if (sessionsQuery.isPending) return <LoadingState message="Cargando sesiones…" />
  if (sessionsQuery.isError) {
    return (
      <ErrorState
        title="No se pudieron cargar las sesiones"
        message={mutationMessage(sessionsQuery.error, "Intenta de nuevo.")}
      />
    )
  }
  const active = sessionsQuery.data.filter((s) => new Date(s.expiresAt).getTime() > Date.now())
  if (active.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin sesiones activas para este paciente.</p>
  }
  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">Sesiones activas</p>
      {revokeMutation.isError && (
        <ErrorState
          title="No se pudo revocar la sesión"
          message={mutationMessage(revokeMutation.error, "Intenta de nuevo.")}
        />
      )}
      {active.map((session) => (
        <div key={session.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">
              {session.authMethod === "passkey" ? "Passkey" : "Enlace y código"} · vence el{" "}
              {formatPortalDate(session.expiresAt)}
            </p>
          </div>
          {confirming !== session.id && (
            <Button variant="outline" size="sm" onClick={() => setConfirming(session.id)}>
              Revocar
            </Button>
          )}
          {confirming === session.id && (
            <>
              <Button
                variant="destructive"
                size="sm"
                disabled={revokeMutation.isPending}
                onClick={() => revokeMutation.mutate(session.id)}
              >
                Confirmar
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

function PasskeysSection({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient()
  const [contactId, setContactId] = useState("")
  const [confirming, setConfirming] = useState("")
  const patientQuery = useQuery({
    queryKey: ["portal-patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    retry: false,
  })
  const contacts = patientQuery.data?.data.contacts ?? []
  const passkeysQuery = useQuery({
    queryKey: ["portal-passkeys", contactId],
    queryFn: () => listPortalPasskeysApi(contactId),
    enabled: contactId !== "",
    retry: false,
  })
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokePortalPasskeyApi(id),
    onSuccess: () => {
      setConfirming("")
      void queryClient.invalidateQueries({ queryKey: ["portal-passkeys", contactId] })
      void queryClient.invalidateQueries({ queryKey: ["portal-sessions", patientId] })
    },
  })

  if (patientQuery.isPending) return <LoadingState message="Cargando contactos…" />
  if (patientQuery.isError || contacts.length === 0) return null

  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">Passkeys del representante</p>
      <p className="text-xs text-muted-foreground">
        Si pierde el teléfono, revoca su passkey aquí: también se cierran sus sesiones. Para volver
        a entrar necesita un permiso verificado nuevo o un enlace asistido; nunca por teléfono.
      </p>
      <div className="grid gap-2">
        <Label htmlFor="portal-passkey-contact">Contacto</Label>
        <Select
          value={contactId}
          onValueChange={(value) => {
            if (value === null) return
            setContactId(value)
            setConfirming("")
          }}
        >
          <SelectTrigger id="portal-passkey-contact">
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
      </div>
      {contactId !== "" && (
        <>
          {passkeysQuery.isPending ? (
            <LoadingState message="Cargando passkeys…" />
          ) : passkeysQuery.isError ? (
            <ErrorState
              title="No se pudieron cargar las passkeys"
              message={mutationMessage(passkeysQuery.error, "Intenta de nuevo.")}
            />
          ) : passkeysQuery.data.filter((k) => k.revokedAt === null).length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin passkeys activas para este contacto.</p>
          ) : (
            <div className="grid gap-2">
              {revokeMutation.isError && (
                <ErrorState
                  title="No se pudo revocar"
                  message={mutationMessage(revokeMutation.error, "Intenta de nuevo.")}
                />
              )}
              {passkeysQuery.data
                .filter((k) => k.revokedAt === null)
                .map((key) => (
                  <div key={key.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{key.nickname ?? "Dispositivo sin nombre"}</p>
                      <p className="text-xs text-muted-foreground">
                        Creada el {formatPortalDate(key.createdAt)}
                        {key.lastUsedAt ? ` · último uso el ${formatPortalDate(key.lastUsedAt)}` : ""}
                      </p>
                    </div>
                    {confirming !== key.id && (
                      <Button variant="outline" size="sm" onClick={() => setConfirming(key.id)}>
                        Revocar
                      </Button>
                    )}
                    {confirming === key.id && (
                      <>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={revokeMutation.isPending}
                          onClick={() => revokeMutation.mutate(key.id)}
                        >
                          Confirmar
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirming("")}>
                          Cancelar
                        </Button>
                      </>
                    )}
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

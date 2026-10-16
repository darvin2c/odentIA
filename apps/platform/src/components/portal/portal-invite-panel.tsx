import { Badge, Button, Checkbox, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { ErrorState, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { type ContactFull, usePermission } from "../../lib/crm"
import { channelLabel } from "../../lib/channels"
import { type PatientFull } from "../../lib/patients"
import { relationshipText } from "../../lib/people"
import { formatPortalDate, issuePortalActivationQrApi, issuePortalLinkApi, listPortalGrantsApi, listPortalLinksApi, revokePortalLinkApi } from "../../lib/portal"

/**
 * Panel compacto para la ficha del paciente (lo monta ClinicalForms donde
 * decida, p. ej. junto a responsables): emite un acceso al portal para un
 * contacto vinculado, entregado por su conversación abierta.
 */
export function PortalInvitePanel({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient()
  const canIssue = usePermission("patients.write")
  const canShareFinance = usePermission("finance.read")
  const [contactId, setContactId] = useState("")
  const [conversationId, setConversationId] = useState("")
  const [scopeAppointments, setScopeAppointments] = useState(true)
  const [scopeBudgets, setScopeBudgets] = useState(false)
  const [scopeAccount, setScopeAccount] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [pinOnce, setPinOnce] = useState<string | null>(null)
  const [deliveryMode, setDeliveryMode] = useState<"conversacion" | "qr">("conversacion")
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrPin, setQrPin] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)
  const [qrPending, setQrPending] = useState(false)

  const patientQuery = useQuery({
    queryKey: ["portal-patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    retry: false,
  })
  const contactQuery = useQuery({
    queryKey: ["portal-contact", contactId],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${contactId}`),
    enabled: contactId !== "",
    retry: false,
  })

  const contacts = patientQuery.data?.data.contacts ?? []
  const conversations = (contactQuery.data?.data.conversations ?? []).filter((c) => c.status === "open")
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
        },
        ttlHours: 72,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (result) => {
      setSent(
        `Enlace enviado a ${result.link.contactName} por ${selectedConversation ? channelLabel(selectedConversation.channel) : "la conversación"}. Vence el ${formatPortalDate(result.link.expiresAt)}.`,
      )
      setPinOnce(result.pinOnce)
      void queryClient.invalidateQueries({ queryKey: ["portal-links"] })
    },
  })
  const linksQuery = useQuery({
    queryKey: ["portal-links", patientId],
    queryFn: () => listPortalLinksApi(patientId),
    retry: false,
  })
  const [confirming, setConfirming] = useState("")
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokePortalLinkApi(id),
    onSuccess: () => {
      setConfirming("")
      void queryClient.invalidateQueries({ queryKey: ["portal-links", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["portal-links"] })
    },
  })
  const grantsQuery = useQuery({
    queryKey: ["portal-grants", patientId],
    queryFn: () => listPortalGrantsApi(patientId),
    retry: false,
  })
  const verifiedGrant = grantsQuery.data?.some(
    (g) => g.contactId === contactId && g.status === "activo",
  ) ?? false

  function clearQr() {
    setQrUrl(null)
    setQrDataUrl(null)
    setQrPin(null)
    setQrError(null)
  }

  // El secreto vive solo en memoria: al desmontar se descarta con el estado.
  useEffect(() => () => {
    setQrUrl(null)
    setQrDataUrl(null)
    setQrPin(null)
  }, [])

  const qrMutation = useMutation({
    mutationFn: () =>
      issuePortalActivationQrApi({
        patientId,
        contactId,
        scope: {
          appointments: scopeAppointments,
          budgets: canShareFinance && scopeBudgets,
          account: canShareFinance && scopeAccount,
        },
        ttlHours: 72,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async (result) => {
      setQrUrl(result.activationUrlOnce)
      setQrPin(result.pinOnce)
      setQrError(null)
      void queryClient.invalidateQueries({ queryKey: ["portal-links", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["portal-links"] })
      setQrPending(true)
      try {
        // Importación dinámica: qrcode no debe entrar al bundle inicial.
        const { default: QRCode } = await import("qrcode")
        setQrDataUrl(
          await QRCode.toDataURL(result.activationUrlOnce, {
            width: 512,
            margin: 4,
            errorCorrectionLevel: "M",
          }),
        )
      } catch {
        setQrError("No pudimos generar el QR. Inténtalo de nuevo.")
      } finally {
        setQrPending(false)
      }
    },
  })

  const hasScope =
    scopeAppointments || (canShareFinance && (scopeBudgets || scopeAccount))
  const canSubmitQr =
    contactId !== "" && hasScope && verifiedGrant && !qrMutation.isPending && !qrPending

  if (!canIssue) return null
  if (patientQuery.isPending) return <LoadingState message="Cargando contactos…" />
  if (patientQuery.isError) return null
  if (contacts.length === 0) return null

  const canSubmit =
    contactId !== "" &&
    conversationId !== "" &&
    (scopeAppointments || (canShareFinance && (scopeBudgets || scopeAccount))) &&
    !issueMutation.isPending

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <p className="text-sm font-medium">Paso 2 · Enlace asistido</p>
      <div className="grid gap-2">
        <Label htmlFor="portal-invite-contact">Contacto</Label>
        <Select
          value={contactId}
          onValueChange={(value) => {
            if (value === null) return
            setContactId(value)
            setConversationId("")
            setSent(null)
            setPinOnce(null)
            clearQr()
          }}
        >
          <SelectTrigger id="portal-invite-contact">
            <SelectValue placeholder="Elige el contacto" />
          </SelectTrigger>
          <SelectContent>
            {contacts.map((c) => (
              <SelectItem key={c.contactId} value={c.contactId}>
                {c.displayName} · {relationshipText(c.relationship, c.relationshipDetail)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {contactId !== "" && (
        <fieldset className="grid gap-1">
          <legend className="text-sm font-medium">Entrega</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`portal-delivery-${patientId}`}
              checked={deliveryMode === "conversacion"}
              onChange={() => {
                setDeliveryMode("conversacion")
                clearQr()
              }}
            />
            Por conversación del contacto
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`portal-delivery-${patientId}`}
              checked={deliveryMode === "qr"}
              onChange={() => {
                setDeliveryMode("qr")
                setSent(null)
                setPinOnce(null)
              }}
            />
            Mostrar QR en recepción
          </label>
        </fieldset>
      )}
      {contactId !== "" && deliveryMode === "conversacion" && (
        <div className="grid gap-2">
          <Label htmlFor="portal-invite-conversation">Conversación de entrega</Label>
          {contactQuery.isPending ? (
            <LoadingState message="Cargando conversaciones…" />
          ) : conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin conversación abierta para este contacto.</p>
          ) : (
            <Select
              value={conversationId}
              onValueChange={(value) => {
                if (value === null) return
                setConversationId(value)
                setSent(null)
                setPinOnce(null)
              }}
            >
              <SelectTrigger id="portal-invite-conversation">
                <SelectValue placeholder="Elige la conversación" />
              </SelectTrigger>
              <SelectContent>
                {conversations.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {channelLabel(c.channel)} · {c.connectionName ?? "sin conexión"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      {conversationId !== "" && deliveryMode === "conversacion" && (
        <>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={scopeAppointments} onCheckedChange={(v) => setScopeAppointments(v === true)} />
              Citas
            </label>
            {canShareFinance && (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={scopeBudgets} onCheckedChange={(v) => setScopeBudgets(v === true)} />
                  Presupuestos
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={scopeAccount} onCheckedChange={(v) => setScopeAccount(v === true)} />
                  Cuenta
                </label>
              </>
            )}
          </div>
          <div>
            <SubmitButton size="sm" pending={issueMutation.isPending} disabled={!canSubmit} onClick={() => issueMutation.mutate()}>
              Enviar enlace
            </SubmitButton>
          </div>
        </>
      )}
      {contactId !== "" && deliveryMode === "qr" && (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="text-sm font-medium">QR en recepción</p>
          {grantsQuery.isPending ? (
            <LoadingState message="Verificando permiso…" />
          ) : !verifiedGrant ? (
            <p className="text-sm text-muted-foreground" role="note">
              Este contacto aún no tiene permiso verificado. Créalo en el Paso 1 antes de mostrar
              el QR.
            </p>
          ) : qrUrl === null ? (
            <>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={scopeAppointments} onCheckedChange={(v) => setScopeAppointments(v === true)} />
                  Citas
                </label>
                {canShareFinance && (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={scopeBudgets} onCheckedChange={(v) => setScopeBudgets(v === true)} />
                      Presupuestos
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={scopeAccount} onCheckedChange={(v) => setScopeAccount(v === true)} />
                      Cuenta
                    </label>
                  </>
                )}
              </div>
              {qrMutation.isError && (
                <ErrorState
                  title="No se pudo generar el acceso"
                  message={
                    qrMutation.error instanceof ApiError
                      ? (qrMutation.error.shape.message ?? "Revisa los datos.")
                      : "Revisa los datos."
                  }
                />
              )}
              <div>
                <SubmitButton
                  size="sm"
                  pending={qrMutation.isPending || qrPending}
                  disabled={!canSubmitQr}
                  onClick={() => qrMutation.mutate()}
                >
                  Mostrar QR en recepción
                </SubmitButton>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm font-medium" role="alert">
                Muéstralo solo con el paciente o su representante presente. Al ocultar se borra y
                no queda guardado en este equipo.
              </p>
              {qrPending ? (
                <LoadingState message="Generando QR…" />
              ) : qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="QR de activación del portal"
                  width={256}
                  height={256}
                  className="rounded-md border"
                />
              ) : null}
              {qrError && (
                <ErrorState title="No pudimos generar el QR" message={qrError} />
              )}
              {qrPin && (
                <p className="text-sm font-medium">
                  Código (una sola vez): {qrPin}. Díctalo en persona; nunca por mensaje.
                </p>
              )}
              <div>
                <Button variant="outline" size="sm" onClick={clearQr}>
                  Ocultar y borrar
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {issueMutation.isError && (
        <ErrorState
          title="No se pudo enviar"
          message={
            issueMutation.error instanceof ApiError
              ? (issueMutation.error.shape.message ?? "Revisa los datos.")
              : "Revisa los datos."
          }
        />
      )}
      {sent && (
        <p className="text-sm text-muted-foreground" role="status">
          {sent}
          {pinOnce && ` Código (una sola vez): ${pinOnce}. Comunícalo por vía independiente de la bandeja.`}
        </p>
      )}
      <div className="grid gap-2 border-t pt-3">
        <p className="text-sm font-medium">Accesos emitidos para este paciente</p>
        {linksQuery.isPending ? (
          <LoadingState message="Cargando accesos…" />
        ) : linksQuery.isError ? (
          <ErrorState
            title="No se pudieron cargar los accesos"
            message={
              linksQuery.error instanceof ApiError
                ? (linksQuery.error.shape.message ?? "Intenta de nuevo.")
                : "Intenta de nuevo."
            }
          />
        ) : linksQuery.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no se emitió ningún acceso para este paciente.</p>
        ) : (
          <div className="grid gap-2">
            {revokeMutation.isError && (
              <ErrorState
                title="No se pudo revocar"
                message={
                  revokeMutation.error instanceof ApiError
                    ? (revokeMutation.error.shape.message ?? "Intenta de nuevo.")
                    : "Intenta de nuevo."
                }
              />
            )}
            {linksQuery.data.map((link) => (
              <div key={link.id} className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {link.contactName} · vence el {formatPortalDate(link.expiresAt)}
                    {link.usedAt ? ` · usado el ${formatPortalDate(link.usedAt)}` : ""}
                    {link.revokedAt ? ` · revocado el ${formatPortalDate(link.revokedAt)}` : ""}
                  </p>
                </div>
                <Badge variant={link.status === "pendiente" ? "default" : "secondary"}>
                  {link.status === "pendiente" ? "Pendiente" : link.status === "usado" ? "Usado" : "Revocado"}
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
        )}
      </div>
    </div>
  )
}

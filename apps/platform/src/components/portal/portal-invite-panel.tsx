import { Checkbox, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { ErrorState, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { type ContactFull, usePermission } from "../../lib/crm"
import { type PatientFull } from "../../lib/patients"
import { formatPortalDate, issuePortalLinkApi } from "../../lib/portal"

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
        `Enlace enviado a ${result.link.contactName} por ${selectedConversation?.channel ?? "la conversación"}. Vence el ${formatPortalDate(result.link.expiresAt)}.`,
      )
      setPinOnce(result.pinOnce)
      void queryClient.invalidateQueries({ queryKey: ["portal-links"] })
    },
  })

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
      <p className="text-sm font-medium">Acceso al portal</p>
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
          }}
        >
          <SelectTrigger id="portal-invite-contact">
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
    </div>
  )
}

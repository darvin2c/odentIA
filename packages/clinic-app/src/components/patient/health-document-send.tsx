import {
  Field,
  FieldLabel,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from "@odentia/ui"
import { ErrorState, FormDrawer, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError } from "../../lib/api"
import {
  CHANNEL_WORDS,
  fetchHealthDocumentOptions,
  type HealthDocumentType,
  sendHealthDocument,
} from "../../lib/encounter-documents"

const RELATION_WORDS: Record<string, string> = {
  paciente: "la propia persona",
  representante_legal: "representante legal",
}

/**
 * «Enviar a Lucía»: una receta, una orden o un consentimiento firmado van solo
 * al chat de la propia persona o al de su representante legal. WhatsApp
 * primero; sin WhatsApp, por correo; sin ninguno, el servidor dice que solo se
 * imprime. Lo enviado queda encolado en su conversación: no se dice entregado.
 */
export function HealthDocumentSendDrawer({
  open,
  patientId,
  documentType,
  documentId,
  onClose,
}: {
  open: boolean
  patientId: string
  documentType: HealthDocumentType
  documentId: string
  onClose: () => void
}): React.JSX.Element {
  const ids = useId()
  const [recipientId, setRecipientId] = useState<string | undefined>(undefined)
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Una clave por apertura: un doble clic o un reintento no lo envía dos veces.
  const [requestId] = useState(() => crypto.randomUUID())
  const options = useQuery({
    queryKey: ["health-document-options", patientId, documentType, documentId, recipientId ?? ""],
    queryFn: () =>
      fetchHealthDocumentOptions(patientId, { documentType, documentId, recipientContactId: recipientId }),
    enabled: open,
  })
  const data = options.data?.data
  const usable = (data?.channels ?? []).filter((channel) => channel.usable)
  const chosen = usable.find((c) => c.connectionId === connectionId) ?? data?.proposed ?? null
  const send = useMutation({
    mutationFn: () =>
      sendHealthDocument(patientId, {
        documentType,
        documentId,
        recipientContactId: data?.recipient?.contactId ?? null,
        connectionId: chosen!.connectionId,
        message: (message ?? data?.message ?? "").trim() || null,
        requestId,
      }),
    onSuccess: (result) => {
      toast.success(
        `Va por ${CHANNEL_WORDS[result.data.channel] ?? result.data.channel} a ${result.data.recipientName}; queda en su conversación.`,
      )
      onClose()
    },
    onError: (e) =>
      setError(e instanceof ApiError ? (e.shape.message ?? "No se pudo enviar") : "No se pudo enviar"),
  })
  const first = data?.recipient?.displayName.trim().split(/\s+/)[0]
  return (
    <FormDrawer
      open={open}
      onClose={() => {
        if (!send.isPending) onClose()
      }}
      title={first ? `Enviar a ${first}` : "Enviar"}
      description={data?.document.label}
      isSubmitting={send.isPending}
      error={error}
      submitLabel="Enviar"
      submitDisabled={!chosen || !data?.recipient}
      onSubmit={(event) => {
        event.preventDefault()
        if (!chosen || !data?.recipient) return
        setError(null)
        send.mutate()
      }}
    >
      {options.isPending ? (
        <LoadingState message="Buscando por dónde enviarlo…" />
      ) : options.isError ? (
        <ErrorState
          message={
            options.error instanceof ApiError
              ? (options.error.shape.message ?? "No se pudo preparar el envío")
              : "No se pudo preparar el envío"
          }
          onRetry={() => void options.refetch()}
        />
      ) : data ? (
        <div className="flex flex-col gap-4">
          {data.recipients.length > 1 ? (
            <Field>
              <FieldLabel htmlFor={`${ids}-to`}>A quién</FieldLabel>
              <Select
                items={Object.fromEntries(
                  data.recipients.map((r) => [r.contactId, `${r.displayName} · ${RELATION_WORDS[r.relation] ?? r.relation}`]),
                )}
                value={data.recipient?.contactId ?? ""}
                onValueChange={(value) => {
                  setRecipientId(value ?? undefined)
                  setConnectionId(null)
                  setMessage(null)
                }}
              >
                <SelectTrigger id={`${ids}-to`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.recipients.map((r) => (
                    <SelectItem key={r.contactId} value={r.contactId}>
                      {r.displayName} · {RELATION_WORDS[r.relation] ?? r.relation}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : data.recipient ? (
            <p className="text-sm">
              Para <strong>{data.recipient.displayName}</strong> ·{" "}
              {RELATION_WORDS[data.recipient.relation] ?? data.recipient.relation}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Un papel de salud solo va a la propia persona o a su representante legal, nunca a otro número.
          </p>
          {data.printOnly ? (
            <p role="status" className="rounded-md bg-warning-soft p-3 text-sm">
              {data.printOnly}.
            </p>
          ) : (
            <>
              {usable.length > 1 ? (
                <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                  <legend className="mb-1 text-sm font-medium">Por dónde</legend>
                  <RadioGroup
                    value={chosen?.connectionId ?? ""}
                    onValueChange={(value) => setConnectionId(String(value))}
                  >
                    {usable.map((channel) => (
                      <label key={channel.connectionId} className="flex items-center gap-2 text-sm">
                        <RadioGroupItem value={channel.connectionId} />
                        {CHANNEL_WORDS[channel.channel] ?? channel.channel} · {channel.connectionName}
                      </label>
                    ))}
                  </RadioGroup>
                </fieldset>
              ) : chosen ? (
                <p className="text-sm">
                  Por {CHANNEL_WORDS[chosen.channel] ?? chosen.channel} · {chosen.connectionName}
                </p>
              ) : null}
              {(data.channels ?? [])
                .filter((channel) => !channel.usable && channel.reason)
                .map((channel) => (
                  <p key={channel.connectionId} className="text-xs text-muted-foreground">
                    {CHANNEL_WORDS[channel.channel] ?? channel.channel}: {channel.reason}
                  </p>
                ))}
              <Field>
                <FieldLabel htmlFor={`${ids}-message`}>Mensaje</FieldLabel>
                <Textarea
                  id={`${ids}-message`}
                  rows={3}
                  maxLength={500}
                  value={message ?? data.message}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </Field>
            </>
          )}
        </div>
      ) : null}
    </FormDrawer>
  )
}

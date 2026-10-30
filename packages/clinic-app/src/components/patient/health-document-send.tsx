import { FieldError, toast } from "@odentia/ui"
import {
  ErrorState,
  FormDrawer,
  LoadingState,
  useAppForm,
  useFieldControl,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
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

/** Los mismos límites que `POST /api/patients/:id/health-documents/send`. */
const sendSchema = z.object({
  recipientId: z.string(),
  connectionId: z.string().min(1, { error: "Elige por dónde enviarlo." }),
  message: z.string().max(500, { error: "El mensaje admite hasta 500 caracteres." }),
})

type SendValues = z.infer<typeof sendSchema>

const EMPTY: SendValues = { recipientId: "", connectionId: "", message: "" }

/** El canal único, dicho en una línea, con el error del servidor debajo si lo hay. */
function SingleChannel({ text }: { text: string }) {
  const { control, errors, errorId } = useFieldControl({ hasDescription: false })
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm">{text}</p>
      {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
    </div>
  )
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
  // A quién se le piden las opciones: lo cambia quien envía; sin elegir, el que propone el servidor.
  const [asked, setAsked] = useState<string | undefined>(undefined)
  // Una clave por apertura: un doble clic o un reintento no lo envía dos veces.
  const [requestId] = useState(() => crypto.randomUUID())
  const options = useQuery({
    queryKey: ["health-document-options", patientId, documentType, documentId, asked ?? ""],
    queryFn: () => fetchHealthDocumentOptions(patientId, { documentType, documentId, recipientContactId: asked }),
    enabled: open,
  })
  const data = options.data?.data
  const usable = (data?.channels ?? []).filter((channel) => channel.usable)
  const send = useMutation({
    mutationFn: (value: SendValues) =>
      sendHealthDocument(patientId, {
        documentType,
        documentId,
        recipientContactId: value.recipientId || data?.recipient?.contactId || null,
        connectionId: value.connectionId,
        message: value.message.trim() || null,
        requestId,
      }),
  })
  const form = useAppForm({
    defaultValues: EMPTY,
    validators: { onSubmit: sendSchema },
    onSubmit: async ({ value }) => {
      const result = await send.mutateAsync(value)
      toast.success(
        `Va por ${CHANNEL_WORDS[result.data.channel] ?? result.data.channel} a ${result.data.recipientName}; queda en su conversación.`,
      )
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { recipientContactId: "recipientId" } })

  // Lo que propone el servidor entra una vez por destinatario: un refresco no pisa lo escrito.
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (!data) return
    const recipientId = data.recipient?.contactId ?? ""
    if (seededFor.current === recipientId) return
    seededFor.current = recipientId
    form.reset(
      { recipientId, connectionId: data.proposed?.connectionId ?? "", message: data.message },
      { keepDefaultValues: true },
    )
  }, [data, form])

  const connectionId = useStore(form.store, (state) => state.values.connectionId)
  const chosen = usable.find((c) => c.connectionId === connectionId) ?? data?.proposed ?? null
  const first = data?.recipient?.displayName.trim().split(/\s+/)[0]
  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
      title={first ? `Enviar a ${first}` : "Enviar"}
      description={data?.document.label}
      submitLabel="Enviar"
      // Sin opciones cargadas o sin canal no hay nada que enviar; el motivo está a la vista.
      submitDisabled={!data || Boolean(data.printOnly)}
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
            <form.AppField
              name="recipientId"
              listeners={{
                onChange: ({ value }) => setAsked(value || undefined),
              }}
            >
              {(field) => (
                <field.SelectField
                  label="A quién"
                  options={data.recipients.map((r) => ({
                    value: r.contactId,
                    label: `${r.displayName} · ${RELATION_WORDS[r.relation] ?? r.relation}`,
                  }))}
                />
              )}
            </form.AppField>
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
              <form.AppField name="connectionId">
                {(field) =>
                  usable.length > 1 ? (
                    <field.RadioGroupField
                      legend="Por dónde"
                      options={usable.map((channel) => ({
                        value: channel.connectionId,
                        label: `${CHANNEL_WORDS[channel.channel] ?? channel.channel} · ${channel.connectionName}`,
                      }))}
                    />
                  ) : chosen ? (
                    <SingleChannel
                      text={`Por ${CHANNEL_WORDS[chosen.channel] ?? chosen.channel} · ${chosen.connectionName}`}
                    />
                  ) : null
                }
              </form.AppField>
              {(data.channels ?? [])
                .filter((channel) => !channel.usable && channel.reason)
                .map((channel) => (
                  <p key={channel.connectionId} className="text-xs text-muted-foreground">
                    {CHANNEL_WORDS[channel.channel] ?? channel.channel}: {channel.reason}
                  </p>
                ))}
              <form.AppField name="message">
                {(field) => <field.TextareaField label="Mensaje" rows={3} maxLength={500} />}
              </form.AppField>
            </>
          )}
        </div>
      ) : null}
    </FormDrawer>
  )
}

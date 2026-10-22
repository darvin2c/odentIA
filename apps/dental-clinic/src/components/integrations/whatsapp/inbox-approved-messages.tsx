import { Button, buttonVariants, cn, FieldLabel, Input, RadioGroup, RadioGroupItem, Skeleton } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Fragment, useId, useState } from "react"
import { ApiError, apiFetch } from "../../../lib/api"
import { sinceWords } from "../../../lib/integrations"
import { activeOrgTimeZone, useOrgLocale } from "../../../lib/locale"
import {
  type ApprovedMessageOption,
  type ApprovedMessages,
  approvedMessagesKey,
  approvedValues,
  closedWindowNotice,
} from "../../../lib/whatsapp"
import { Note } from "./note"
import { PreviewText } from "./message-preview"

/**
 * El texto de un mensaje aprobado tal como saldrá. Si el mensaje se creó en la
 * página de Meta y pide un dato, ese dato se escribe aquí, dentro del texto y
 * con su nombre: no hay «parámetros» aparte.
 */
function OptionText({
  option,
  typed,
  disabled,
  onType,
}: {
  option: ApprovedMessageOption
  typed: Record<number, string>
  disabled: boolean
  onType: (index: number, value: string) => void
}) {
  if (option.fields.length === 0) return <PreviewText parts={option.previewParts} />
  const labels = new Map(option.fields.map((field) => [field.index, field.label]))
  return (
    <>
      {option.previewParts.map((part, index) => {
        const label = part.index === undefined ? undefined : labels.get(part.index)
        if (part.index === undefined || label === undefined) return <Fragment key={index}>{part.text}</Fragment>
        return (
          <Input
            key={index}
            aria-label={`${label} de «${option.title}»`}
            placeholder={label}
            className="mx-1 inline-flex h-9 w-44 max-w-full align-middle"
            value={typed[part.index] ?? ""}
            disabled={disabled}
            onChange={(event) => onType(part.index as number, event.target.value)}
          />
        )
      })}
    </>
  )
}

/**
 * La zona de escritura de un hilo de WhatsApp cuando ya pasaron las 24 horas:
 * lo dice antes de escribir, ofrece los mensajes aprobados por lo que dicen —con
 * los datos de esa persona ya puestos— y envía el elegido. Lo que hay y por qué
 * no hay ninguno lo decide el servidor; aquí solo se muestra.
 */
export function InboxApprovedMessages({
  conversationId,
  contactName,
  lastInboundAt,
  draft,
  onSent,
}: {
  conversationId: string
  contactName: string
  /** Cuándo escribió la persona por última vez; `null` si nunca escribió por aquí; ausente si el servidor no lo dijo. */
  lastInboundAt: string | null | undefined
  /** Lo que ya estaba escrito en el campo libre: se conserva para cuando responda. */
  draft: string
  onSent: () => void
}) {
  const queryClient = useQueryClient()
  const locale = useOrgLocale()
  const legendId = useId()
  const since = (iso: string) => sinceWords(iso, Date.now(), locale, activeOrgTimeZone())
  const [chosen, setChosen] = useState<string | null>(null)
  const [typed, setTyped] = useState<Record<string, Record<number, string>>>({})
  const [error, setError] = useState<string | null>(null)

  const query = useQuery({
    queryKey: approvedMessagesKey(conversationId),
    queryFn: () => apiFetch<ApprovedMessages>(`/api/conversations/${conversationId}/approved-messages`),
    retry: 1,
  })
  const options = query.data?.data ?? []
  const none = query.data?.none ?? null
  // Sin elegir todavía, el primero: es el que la persona tiene delante.
  const selected = options.find((option) => option.id === chosen) ?? options[0] ?? null

  const send = useMutation({
    mutationFn: (option: ApprovedMessageOption) => {
      const values = approvedValues(option, typed[option.id] ?? {})
      return apiFetch(`/api/conversations/${conversationId}/messages/approved`, {
        method: "POST",
        body: JSON.stringify({ messageId: option.id, ...(values ? { values } : {}) }),
      })
    },
    onSuccess: async () => {
      setError(null)
      setChosen(null)
      setTyped({})
      onSent()
      // Tras enviar, el servidor dice cuándo se le podrá escribir de nuevo.
      await queryClient.invalidateQueries({ queryKey: approvedMessagesKey(conversationId) })
    },
    onError: (failure) => {
      // El servidor dice por qué no se pudo: ya no está aprobado, falta un dato, ya se envió uno hoy.
      setError(
        failure instanceof ApiError && failure.shape.message
          ? failure.shape.message
          : "No pudimos enviar el mensaje. Vuelve a intentarlo.",
      )
      void queryClient.invalidateQueries({ queryKey: approvedMessagesKey(conversationId) })
    },
  })

  const notice = closedWindowNotice(contactName, lastInboundAt, since)

  return (
    <div className="flex flex-col gap-3">
      <Note tone="waiting" icon live>
        <span>
          <strong className="font-semibold">{notice.lead}</strong> {notice.rest}
        </span>
      </Note>

      {query.isPending ? (
        <>
          <p role="status" className="sr-only">
            Cargando los mensajes aprobados…
          </p>
          <div aria-hidden className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </>
      ) : query.isError && !query.data ? (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">No pudimos cargar los mensajes aprobados.</p>
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : options.length === 0 ? (
        none ? (
          <Note tone="waiting" live>
            <span>{none.text}</span>
            {/* El servidor solo entrega la dirección a quien puede abrir Configuración. */}
            {none.fixHref ? (
              <Link
                to={none.fixHref}
                className={cn(buttonVariants({ variant: "outline" }), "mt-1 min-h-11 self-start bg-card text-foreground sm:min-h-9")}
              >
                Ver los mensajes
              </Link>
            ) : null}
          </Note>
        ) : null
      ) : (
        <>
          <span id={legendId} className="text-sm font-semibold">
            Elige el mensaje
          </span>
          {/* La lista no tiene desplazamiento propio: en la Bandeja se desplaza toda la zona de
              escritura (aviso, lista y botón), con su tope, y el historial queda a la vista. */}
          <div>
          <RadioGroup
            aria-labelledby={legendId}
            className="gap-2 py-0.5 pr-3 pl-0.5"
            value={selected?.id ?? ""}
            onValueChange={(value) => {
              setChosen(String(value))
              setError(null)
            }}
          >
            {options.map((option) => {
              const isSelected = selected?.id === option.id
              const withFields = option.fields.length > 0
              const text = (
                <OptionText
                  option={option}
                  typed={typed[option.id] ?? {}}
                  disabled={send.isPending}
                  onType={(index, value) => {
                    setChosen(option.id)
                    setTyped((current) => ({ ...current, [option.id]: { ...current[option.id], [index]: value } }))
                  }}
                />
              )
              return (
                <div
                  key={option.id}
                  className={cn(
                    "flex flex-col gap-2 rounded-xl border p-3",
                    isSelected ? "border-primary bg-primary-soft/40" : "border-border",
                  )}
                >
                  <FieldLabel className="w-full cursor-pointer items-start gap-3 font-normal has-data-checked:bg-transparent">
                    <RadioGroupItem value={option.id} className="mt-0.5" disabled={send.isPending} />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="font-semibold [overflow-wrap:anywhere]">{option.title}</span>
                      {/* Sin datos que escribir, el texto es parte de lo que se elige. */}
                      {withFields ? null : <span className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>}
                    </span>
                  </FieldLabel>
                  {/* Con un dato que escribir, el texto va fuera de la etiqueta: su campo no debe activar la opción al pulsarlo. */}
                  {withFields ? <p className="pl-7 text-sm leading-10 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p> : null}
                  {option.buttons.length > 0 ? (
                    <ul aria-label={`Botones de «${option.title}»`} className="flex flex-wrap gap-1.5 pl-7">
                      {option.buttons.map((button) => (
                        <li key={button} className="rounded-lg border bg-card px-3 py-1 text-sm font-semibold text-primary">
                          {button}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )
            })}
          </RadioGroup>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 basis-64 text-sm text-muted-foreground">
              {selected && selected.fields.length > 0
                ? "Lo que escribas va dentro del mensaje, tal como se ve arriba."
                : selected?.previewParts.some((part) => part.data)
                  ? "El nombre de la persona y el de la clínica ya están puestos: los pone el sistema."
                  : "Sale tal como se ve."}
            </p>
            <SubmitButton
              className="h-11 shrink-0 px-5"
              pending={send.isPending}
              disabled={!selected}
              onClick={() => {
                if (selected) send.mutate(selected)
              }}
            >
              Enviar mensaje
            </SubmitButton>
          </div>
        </>
      )}
      {error && options.length === 0 ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {draft.trim() ? (
        <div className="flex flex-col gap-1 rounded-xl bg-muted px-3.5 py-3 text-sm">
          <strong className="font-semibold">Lo que habías escrito se conserva</strong>
          <span className="text-muted-foreground">Vuelve al campo de escritura cuando {contactName} responda:</span>
          <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{draft}</span>
        </div>
      ) : null}
    </div>
  )
}

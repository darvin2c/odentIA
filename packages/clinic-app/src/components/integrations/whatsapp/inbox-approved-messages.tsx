import { Button, buttonVariants, cn, Input, ScrollArea, Skeleton } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Search, X } from "lucide-react"
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
 * lo dice en una línea y la lista se abre solo al pedirla, para no comerse el
 * hilo: los títulos a un lado, con buscador, y al otro el mensaje tal como
 * saldrá, con los datos de esa persona ya puestos. Lo que hay y por qué no hay
 * ninguno lo decide el servidor; aquí solo se muestra.
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
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")

  const query = useQuery({
    queryKey: approvedMessagesKey(conversationId),
    queryFn: () => apiFetch<ApprovedMessages>(`/api/conversations/${conversationId}/approved-messages`),
    retry: 1,
  })
  const options = query.data?.data ?? []
  const none = query.data?.none ?? null
  const text = search.trim().toLowerCase()
  const shown = text ? options.filter((option) => option.title.toLowerCase().includes(text)) : options
  // Sin elegir todavía, el primero: su texto está a la vista antes de enviar.
  const selected = shown.find((option) => option.id === chosen) ?? shown[0] ?? null

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
      setOpen(false)
      setSearch("")
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
        <div className="flex flex-col gap-2">
          {!open ? (
            <Button type="button" size="sm" className="min-h-11 w-fit sm:min-h-8" onClick={() => setOpen(true)}>
              Elegir un mensaje aprobado
            </Button>
          ) : (
            <div className="flex h-[19rem] flex-col overflow-hidden rounded-2xl border bg-card max-sm:h-[24rem]">
              <div className="flex shrink-0 items-center gap-2 border-b py-1 pr-1 pl-3">
                <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <Input
                  aria-label="Buscar un mensaje aprobado"
                  placeholder="Buscar un mensaje"
                  className="h-9 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <Button type="button" variant="ghost" size="icon-sm" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" aria-label="Cerrar la lista de mensajes" onClick={() => setOpen(false)}>
                  <X className="size-4" />
                </Button>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] max-sm:grid-cols-1 max-sm:grid-rows-[minmax(0,2fr)_minmax(0,3fr)]">
                <ScrollArea className="min-h-0 border-r max-sm:border-r-0 max-sm:border-b">
                  <div role="radiogroup" aria-labelledby={legendId} className="flex flex-col gap-0.5 p-1.5">
                    <span id={legendId} className="sr-only">
                      Elige el mensaje
                    </span>
                    {shown.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={selected?.id === option.id}
                        disabled={send.isPending}
                        className={cn(
                          "min-h-11 rounded-xl px-3 py-2 text-left text-sm outline-none [overflow-wrap:anywhere] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9",
                          selected?.id === option.id && "bg-primary-soft font-semibold text-primary-soft-foreground hover:bg-primary-soft",
                        )}
                        onClick={() => {
                          setChosen(option.id)
                          setError(null)
                        }}
                      >
                        {option.title}
                      </button>
                    ))}
                    {shown.length === 0 ? <p className="px-3 py-2 text-sm text-muted-foreground">Ningún mensaje coincide.</p> : null}
                  </div>
                </ScrollArea>
                <div className="flex min-h-0 min-w-0 flex-col bg-canvas/60">
                  <ScrollArea className="min-h-0 flex-1">
                    {selected ? (
                      <div className="flex flex-col gap-2 p-3">
                        <div className="ml-auto flex max-w-full flex-col gap-2 rounded-2xl rounded-br-md bg-secondary px-3.5 py-2.5 text-sm leading-relaxed">
                          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                            <OptionText
                              option={selected}
                              typed={typed[selected.id] ?? {}}
                              disabled={send.isPending}
                              onType={(index, value) => {
                                setChosen(selected.id)
                                setTyped((current) => ({ ...current, [selected.id]: { ...current[selected.id], [index]: value } }))
                              }}
                            />
                          </p>
                          {selected.buttons.length > 0 ? (
                            <ul aria-label={`Botones de «${selected.title}»`} className="flex flex-col gap-1">
                              {selected.buttons.map((button) => (
                                <li key={button} className="rounded-lg bg-card px-3 py-1 text-center text-[13px] font-semibold text-primary">
                                  {button}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </ScrollArea>
                  <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2">
                    <p className="min-w-0 flex-1 basis-40 text-xs text-muted-foreground">
                      {selected && selected.fields.length > 0
                        ? "Lo que escribas va dentro del mensaje."
                        : selected?.previewParts.some((part) => part.data)
                          ? "Su nombre y el de la clínica ya están puestos."
                          : "Sale tal como se ve."}
                    </p>
                    <SubmitButton
                      size="sm"
                      className="min-h-11 shrink-0 sm:min-h-8"
                      pending={send.isPending}
                      disabled={!selected}
                      onClick={() => {
                        if (selected) send.mutate(selected)
                      }}
                    >
                      Enviar mensaje
                    </SubmitButton>
                  </div>
                </div>
              </div>
            </div>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      )}
      {error && options.length === 0 ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {draft.trim() ? (
        <p className="text-xs text-muted-foreground">
          <strong className="font-semibold">Lo que habías escrito se conserva</strong> para cuando {contactName} responda: <span>{draft}</span>
        </p>
      ) : null}
    </div>
  )
}

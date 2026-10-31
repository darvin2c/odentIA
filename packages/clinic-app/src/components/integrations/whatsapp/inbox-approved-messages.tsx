import { Button, buttonVariants, cn, Input, ScrollArea, Skeleton } from "@odentia/ui"
import { clearSubmitErrors, SubmitButton, submitForm, useAppForm, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Search, X } from "lucide-react"
import { Fragment, useId, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../../lib/api"
import { sinceWords } from "../../../lib/integrations"
import { activeOrgTimeZone, useOrgLocale } from "../../../lib/locale"
import {
  type ApprovedMessageOption,
  type ApprovedMessages,
  approvedFields,
  approvedMessagesKey,
  approvedValues,
  closedWindowNotice,
} from "../../../lib/whatsapp"
import { PreviewText } from "./message-preview"
import { Note } from "./note"

/** Tope de cada dato en la ruta (`approvedInput`, `routes/conversations.ts`). */
const VALUE_MAX = 1000

interface ApprovedDraft {
  /** El mensaje elegido; vacío: el primero de la lista, el que la persona tiene delante. */
  messageId: string
  /** Lo escrito en cada mensaje, por su id y en el orden de `approvedFields` (`values[i]` al enviar). */
  typed: Record<string, (string | undefined)[]>
}

const EMPTY_DRAFT: ApprovedDraft = { messageId: "", typed: {} }

function chosenOption(options: ApprovedMessageOption[], messageId: string): ApprovedMessageOption | null {
  return options.find((option) => option.id === messageId) ?? options[0] ?? null
}

/** El nombre en el formulario del dato `at` de un mensaje (`values[at]` en el cuerpo). */
function typedName(messageId: string, at: number) {
  return `typed.${messageId}[${at}]` as const
}

/** Cada dato del mensaje elegido, escrito y dentro del tope de la ruta; los de los otros no cuentan. */
function approvedSchema(options: ApprovedMessageOption[]) {
  return z
    .object({ messageId: z.string(), typed: z.record(z.string(), z.array(z.string().optional())) })
    .superRefine((value, ctx) => {
      const option = chosenOption(options, value.messageId)
      if (!option) return
      option.fields.forEach((_, at) => {
        const text = (value.typed[option.id]?.[at] ?? "").trim()
        const message = !text
          ? "Completa este dato."
          : text.length > VALUE_MAX
            ? `Escribe como mucho ${VALUE_MAX} caracteres.`
            : null
        if (message) ctx.addIssue({ code: "custom", message, path: ["typed", option.id, at] })
      })
    })
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
  const zone = useRef<HTMLDivElement>(null)
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

  const send = useMutation({
    mutationFn: ({ option, values }: { option: ApprovedMessageOption; values?: string[] }) =>
      apiFetch(`/api/conversations/${conversationId}/messages/approved`, {
        method: "POST",
        body: JSON.stringify({ messageId: option.id, ...(values ? { values } : {}) }),
      }),
    onSuccess: async () => {
      setOpen(false)
      setSearch("")
      onSent()
      // Tras enviar, el servidor dice cuándo se le podrá escribir de nuevo.
      await queryClient.invalidateQueries({ queryKey: approvedMessagesKey(conversationId) })
    },
    // El servidor dice por qué no se pudo (ya no está aprobado, falta un dato, ya se envió uno hoy)
    // y la lista puede haber cambiado.
    onError: () => void queryClient.invalidateQueries({ queryKey: approvedMessagesKey(conversationId) }),
  })

  const form = useAppForm({
    defaultValues: EMPTY_DRAFT,
    validators: { onSubmit: approvedSchema(options) },
    onSubmit: async ({ value, formApi }) => {
      const option = chosenOption(options, value.messageId)
      if (!option) return
      await send.mutateAsync({ option, values: approvedValues(option, value.typed[option.id]) })
      formApi.reset()
    },
  })
  const messageId = useStore(form.store, (state) => state.values.messageId)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const formError = useFormSubmitError(form)
  // Sin elegir todavía, el primero de lo que se ve: su texto está a la vista antes de enviar.
  const selected = chosenOption(shown, messageId)

  /** Elegir otro mensaje empieza de cero: lo que se dijo del anterior ya no vale. */
  function choose(id: string) {
    if (form.getFieldValue("messageId") === id) return
    form.setFieldValue("messageId", id)
    clearSubmitErrors(form)
  }

  function submit() {
    // Lo que se envía es lo que se ve (el buscador puede dejar otro primero).
    if (selected) choose(selected.id)
    void submitForm(form, {
      root: zone.current,
      // El servidor nombra cada dato por su posición en `values`: es el del mensaje elegido.
      fieldMap: (key) => {
        const at = /^values\[(\d+)\]$/.exec(key)?.[1]
        const option = chosenOption(options, form.getFieldValue("messageId"))
        return at !== undefined && option ? typedName(option.id, Number(at)) : undefined
      },
    })
  }

  /**
   * El texto de un mensaje aprobado tal como saldrá. Si el mensaje se creó en la
   * página de Meta y pide un dato, ese dato se escribe aquí, dentro del texto y
   * con su nombre: no hay «parámetros» aparte.
   */
  function optionText(option: ApprovedMessageOption) {
    if (option.fields.length === 0) return <PreviewText parts={option.previewParts} />
    const positions = new Map(approvedFields(option).map((field, at) => [field.index, { at, label: field.label }]))
    return option.previewParts.map((part, index) => {
      const field = part.index === undefined ? undefined : positions.get(part.index)
      if (!field) return <Fragment key={index}>{part.text}</Fragment>
      return (
        <form.AppField
          key={index}
          name={typedName(option.id, field.at)}
          // Escribir en un mensaje lo elige.
          listeners={{ onChange: () => choose(option.id) }}
        >
          {(input) => (
            <input.TextField
              label={
                <>
                  {field.label}
                  <span className="sr-only"> de «{option.title}»</span>
                </>
              }
              className="mx-1 inline-flex w-44 max-w-full align-middle"
              inputClassName="h-9"
              maxLength={VALUE_MAX}
              disabled={isSubmitting}
            />
          )}
        </form.AppField>
      )
    })
  }

  const notice = closedWindowNotice(contactName, lastInboundAt, since)

  return (
    <div ref={zone} className="flex flex-col gap-3">
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
                        disabled={isSubmitting}
                        className={cn(
                          "min-h-11 rounded-xl px-3 py-2 text-left text-sm outline-none [overflow-wrap:anywhere] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9",
                          selected?.id === option.id && "bg-primary-soft font-semibold text-primary-soft-foreground hover:bg-primary-soft",
                        )}
                        onClick={() => choose(option.id)}
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
                          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{optionText(selected)}</div>
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
                      pending={isSubmitting}
                      disabled={!selected}
                      onClick={submit}
                    >
                      Enviar mensaje
                    </SubmitButton>
                  </div>
                </div>
              </div>
            </div>
          )}
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
        </div>
      )}
      {formError && options.length === 0 ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
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

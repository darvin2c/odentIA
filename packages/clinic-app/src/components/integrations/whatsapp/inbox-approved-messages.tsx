import { Button, buttonVariants, cn, FieldLabel, RadioGroup, RadioGroupItem, Skeleton } from "@odentia/ui"
import { clearSubmitErrors, SubmitButton, submitForm, useAppForm, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Fragment, useRef } from "react"
import { z } from "zod"
import { apiFetch } from "../../../lib/api"
import { sinceWords } from "../../../lib/integrations"
import { activeOrgTimeZone, useOrgLocale } from "../../../lib/locale"
import {
  type ApprovedMessageOption,
  type ApprovedMessages,
  approvedFields,
  approvedMessagesKey,
  closedWindowNotice,
} from "../../../lib/whatsapp"
import { Note } from "./note"
import { PreviewText } from "./message-preview"

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
  const since = (iso: string) => sinceWords(iso, Date.now(), locale, activeOrgTimeZone())
  const zone = useRef<HTMLDivElement>(null)

  const query = useQuery({
    queryKey: approvedMessagesKey(conversationId),
    queryFn: () => apiFetch<ApprovedMessages>(`/api/conversations/${conversationId}/approved-messages`),
    retry: 1,
  })
  const options = query.data?.data ?? []
  const none = query.data?.none ?? null

  const send = useMutation({
    mutationFn: ({ option, values }: { option: ApprovedMessageOption; values?: string[] }) =>
      apiFetch(`/api/conversations/${conversationId}/messages/approved`, {
        method: "POST",
        body: JSON.stringify({ messageId: option.id, ...(values ? { values } : {}) }),
      }),
    onSuccess: async () => {
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
      const values =
        option.fields.length > 0 ? option.fields.map((_, at) => (value.typed[option.id]?.[at] ?? "").trim()) : undefined
      await send.mutateAsync({ option, values })
      formApi.reset()
    },
  })
  const messageId = useStore(form.store, (state) => state.values.messageId)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const formError = useFormSubmitError(form)
  // Sin elegir todavía, el primero: es el que la persona tiene delante.
  const selected = chosenOption(options, messageId)

  /** Elegir otro mensaje empieza de cero: lo que se dijo del anterior ya no vale. */
  function choose(id: string) {
    if (form.getFieldValue("messageId") === id) return
    form.setFieldValue("messageId", id)
    clearSubmitErrors(form)
  }

  function submit() {
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
        <>
          <form.AppField name="messageId">
            {(field) => (
              <field.Group legend="Elige el mensaje">
                {(control) => (
                  // La lista no tiene desplazamiento propio: en la Bandeja se desplaza toda la zona de
                  // escritura (aviso, lista y botón), con su tope, y el historial queda a la vista.
                  <div>
                    <RadioGroup
                      aria-label="Elige el mensaje"
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      className="gap-2 py-0.5 pr-3 pl-0.5"
                      value={selected?.id ?? ""}
                      onValueChange={(value) => choose(String(value))}
                    >
                      {options.map((option) => {
                        const isSelected = selected?.id === option.id
                        const withFields = option.fields.length > 0
                        const text = optionText(option)
                        return (
                          <div
                            key={option.id}
                            className={cn(
                              "flex flex-col gap-2 rounded-xl border p-3",
                              isSelected ? "border-primary bg-primary-soft/40" : "border-border",
                            )}
                          >
                            <FieldLabel className="w-full cursor-pointer items-start gap-3 font-normal has-data-checked:bg-transparent">
                              <RadioGroupItem value={option.id} className="mt-0.5" disabled={isSubmitting} />
                              <span className="flex min-w-0 flex-1 flex-col gap-1">
                                <span className="font-semibold [overflow-wrap:anywhere]">{option.title}</span>
                                {/* Sin datos que escribir, el texto es parte de lo que se elige. */}
                                {withFields ? null : (
                                  <span className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
                                )}
                              </span>
                            </FieldLabel>
                            {/* Con un dato que escribir, el texto va fuera de la etiqueta: su campo no debe activar la opción al pulsarlo. */}
                            {withFields ? (
                              <div className="pl-7 text-sm leading-10 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</div>
                            ) : null}
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
                )}
              </field.Group>
            )}
          </form.AppField>
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
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
            <SubmitButton className="h-11 shrink-0 px-5" pending={isSubmitting} disabled={!selected} onClick={submit}>
              Enviar mensaje
            </SubmitButton>
          </div>
        </>
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

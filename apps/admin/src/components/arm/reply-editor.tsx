/**
 * El editor de respuesta (ADR 0196): el mismo en la Bandeja, en la ficha y en «Escribir», para el
 * correo y los chats. Se escribe como en WhatsApp —*negrita*, _cursiva_, ~tachado~— y el formato se
 * ve mientras se escribe, con las marcas a la vista y más tenues.
 *
 * Por dentro es un `<textarea>` de verdad, con el texto transparente, sobre una copia dibujada del
 * mismo texto: deshacer, pegar, el teclado, el dictado y el lector de pantalla son los del
 * navegador. La negrita de la copia se dibuja con un trazo, sin cambiar el ancho de las letras, para
 * que el cursor caiga siempre sobre la letra que se ve.
 *
 * Avisa antes de enviar lo que el canal no acepta (el largo de cada uno lo dice el servidor) y, con
 * «Mejorar con Kairós», muestra lo que cambiaría para que la persona elija. Nunca envía.
 */
import { Button, cn, toast } from "@odentia/ui"
import type { FieldControl } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { Bold, Italic, Link2, List, Sparkles, Strikethrough } from "lucide-react"
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"
import { insertLink, wrapSelection } from "./formatted-body"
import {
  type ChannelRules,
  type DiffPart,
  type Edit,
  editorSegments,
  hasMarks,
  lengthOf,
  type SegmentStyle,
  textProblem,
  toggleList,
  wordDiff,
} from "./reply-text"

export type { ChannelRules } from "./reply-text"

export type ReplyChannel = "correo" | "whatsapp" | "instagram" | "messenger"

const CHANNEL_WORDS: Record<ReplyChannel, string> = {
  correo: "correo",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

/** Lo que falta corregir del texto para su canal (para la validación del formulario). */
export function replyTextProblem(value: string, channel: ReplyChannel, rules: ChannelRules | null) {
  return textProblem(value, rules, CHANNEL_WORDS[channel])
}

const SEGMENT_CLASS: Record<SegmentStyle, string> = {
  plain: "",
  mark: "text-muted-foreground/70",
  bold: "[-webkit-text-stroke:0.4px_currentColor] [paint-order:stroke_fill]",
  italic: "italic",
  strike: "line-through decoration-foreground/60",
  link: "text-primary underline underline-offset-2",
  list: "text-muted-foreground",
}

/** La tipografía y el relleno que comparten la copia dibujada y el `<textarea>`: deben calzar. */
const TEXT_BOX =
  "whitespace-pre-wrap break-words [overflow-wrap:anywhere] px-3 py-3 text-base md:text-sm [tab-size:4]"

const improveSchema = z.object({
  text: z.string(),
  changed: z.boolean(),
  drafter: z.string().optional(),
})

export interface ImproveContext {
  chatId?: string | null
  emailId?: string | null
}

export function ReplyEditor({
  value,
  onChange,
  channel,
  rules,
  control,
  label = "Respuesta",
  placeholder,
  rows = 5,
  disabled = false,
  autoFocus = false,
  improve,
  tools,
  below,
  appended,
}: {
  value: string
  onChange: (value: string) => void
  channel: ReplyChannel
  /** El largo y el formato del canal, como los dice el servidor; sin ellos no se cuenta. */
  rules: ChannelRules | null
  /** Lo que entrega `field.Control` (id, error, ayuda, al salir); sin él, un id propio. */
  control?: FieldControl["props"]
  label?: string
  placeholder?: string
  rows?: number
  disabled?: boolean
  autoFocus?: boolean
  /** Con qué conversación se lee el contexto de «Mejorar con Kairós»; nulo, sin el botón. */
  improve?: ImproveContext | null
  /** Botones propios en la barra (adjuntar). */
  tools?: ReactNode
  /** Lo que va debajo del campo (los adjuntos). */
  below?: ReactNode
  /** Lo que el envío agrega al final (la firma de un chat): cuenta para el largo del canal. */
  appended?: string | null
}) {
  const ownId = useId()
  const id = control?.id ?? ownId
  const area = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [review, setReview] = useState<{ before: string; after: string } | null>(null)
  const invalid = Boolean(control?.["aria-invalid"])

  // Lo que propuso Kairós es para el texto de ese momento: si cambió (se siguió escribiendo o se
  // envió), la propuesta ya no vale.
  useEffect(() => {
    if (review && value !== review.before) setReview(null)
  }, [value, review])

  // Lo que se escribe al final queda a la vista aunque el campo ya tenga barra.
  useLayoutEffect(() => {
    const el = area.current
    const box = scroller.current
    if (!el || !box || document.activeElement !== el) return
    if (el.selectionEnd >= value.length - 1) box.scrollTop = box.scrollHeight
  }, [value])

  /** Un cambio de la barra: con `insertText`, para que «deshacer» lo deshaga. */
  const apply = (edit: (value: string, start: number, end: number) => Edit) => {
    const el = area.current
    if (!el || disabled) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const next = edit(value, start, end)
    if (next.value === value) {
      el.focus()
      el.setSelectionRange(next.selectionStart, next.selectionEnd)
      return
    }
    let prefix = 0
    while (
      prefix < value.length &&
      prefix < next.value.length &&
      value[prefix] === next.value[prefix]
    )
      prefix++
    let suffix = 0
    while (
      suffix < value.length - prefix &&
      suffix < next.value.length - prefix &&
      value[value.length - 1 - suffix] === next.value[next.value.length - 1 - suffix]
    )
      suffix++
    el.focus()
    el.setSelectionRange(prefix, value.length - suffix)
    const inserted = next.value.slice(prefix, next.value.length - suffix)
    const native = inserted
      ? document.execCommand("insertText", false, inserted)
      : document.execCommand("delete", false)
    if (!native || el.value !== next.value) onChange(next.value)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(next.selectionStart, next.selectionEnd)
    })
  }

  const improver = useMutation({
    mutationFn: async (text: string) =>
      improveSchema.parse(
        await api<unknown>("/api/admin/kairos/improve", {
          method: "POST",
          body: JSON.stringify({
            text,
            channel,
            ...(improve?.chatId ? { chatId: improve.chatId } : {}),
            ...(improve?.emailId ? { emailId: improve.emailId } : {}),
          }),
        }),
      ),
    onSuccess: (result, text) => {
      if (!result.changed || result.text.trim() === text.trim()) {
        toast.info("Kairós no encontró nada que mejorar: puedes enviarlo así.")
        return
      }
      setReview({ before: text, after: result.text })
    },
    onError: (error) => {
      if (error instanceof ApiError && (error.status === 422 || error.status === 429)) {
        toast.info(error.message)
        return
      }
      toast.error("Kairós no pudo mejorarlo ahora. Envíalo como está o inténtalo en un momento.")
    },
  })

  /** Reemplaza todo el texto como si se escribiera: «deshacer» lo vuelve atrás. */
  const replaceAll = (next: string) => {
    const el = area.current
    if (!el) return onChange(next)
    el.focus()
    el.setSelectionRange(0, el.value.length)
    const native = document.execCommand("insertText", false, next)
    if (!native || el.value !== next) onChange(next)
  }

  // Lo que se cuenta es lo que sale: el texto y lo que el envío agrega al final.
  const counted = appended ? `${value.trim()}\n\n${appended}` : value
  const length = lengthOf(counted, rules)
  const problem = value.trim() ? replyTextProblem(counted, channel, rules) : null
  const counterId = `${id}-largo`
  const notes: string[] = []
  if (rules?.formatting === "texto" && hasMarks(value))
    notes.push(`${CHANNEL_WORDS[channel]} no muestra negritas ni cursivas: sale como texto limpio.`)
  const showCounter =
    Boolean(length.max) && (channel !== "correo" || length.used > (length.max ?? 0) * 0.8)
  const describedBy = [control?.["aria-describedby"], showCounter || problem ? counterId : null]
    .filter(Boolean)
    .join(" ")

  const segments = editorSegments(value)

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        role="toolbar"
        aria-label="Formato de la respuesta"
        aria-controls={id}
        className="flex flex-wrap items-center gap-1"
      >
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Negrita"
          title="Negrita: *texto*"
          disabled={disabled}
          onClick={() => apply((v, s, e) => wrapSelection(v, s, e, "*"))}
        >
          <Bold aria-hidden />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Cursiva"
          title="Cursiva: _texto_"
          disabled={disabled}
          onClick={() => apply((v, s, e) => wrapSelection(v, s, e, "_"))}
        >
          <Italic aria-hidden />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Tachado"
          title="Tachado: ~texto~"
          disabled={disabled}
          onClick={() => apply((v, s, e) => wrapSelection(v, s, e, "~"))}
        >
          <Strikethrough aria-hidden />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Lista"
          title="Lista: «- » al empezar la línea"
          disabled={disabled}
          onClick={() => apply(toggleList)}
        >
          <List aria-hidden />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Enlace"
          title="Enlace: [texto](https://…)"
          disabled={disabled}
          onClick={() => apply(insertLink)}
        >
          <Link2 aria-hidden />
        </Button>
        {tools}
        {improve ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="ml-auto"
            disabled={disabled || improver.isPending || !value.trim()}
            onClick={() => {
              setReview(null)
              improver.mutate(value)
            }}
          >
            <Sparkles aria-hidden />
            {improver.isPending ? "Kairós lo está mejorando…" : "Mejorar con Kairós"}
          </Button>
        ) : null}
      </div>

      {/* scroll-nativo: es una caja de texto; como un textarea, el cursor y la copia dibujada se
          desplazan juntos con la barra del navegador. */}
      <div
        ref={scroller}
        className={cn(
          "max-h-80 min-w-0 overflow-y-auto rounded-2xl border border-input-border bg-input/50 transition-[color,box-shadow,background-color] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30",
          invalid && "border-destructive ring-3 ring-destructive/20",
          disabled && "opacity-50",
        )}
      >
        <div className="relative">
          <div
            aria-hidden
            className={cn(TEXT_BOX, "pointer-events-none text-foreground")}
            style={{ minHeight: `calc(${rows} * 1.5em + 1.5rem)` }}
          >
            {segments.map((segment, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: los trozos no tienen otra identidad.
                key={index}
                className={SEGMENT_CLASS[segment.style]}
              >
                {segment.text}
              </span>
            ))}
            {/* La línea vacía del final también ocupa su alto. */}
            {value.endsWith("\n") || !value ? "​" : null}
          </div>
          <textarea
            ref={area}
            id={id}
            name={control?.name}
            aria-label={control ? undefined : label}
            aria-invalid={control?.["aria-invalid"]}
            aria-describedby={describedBy || undefined}
            onBlur={control?.onBlur}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            // biome-ignore lint/a11y/noAutofocus: se abre para responder: el foco va donde se escribe.
            autoFocus={autoFocus}
            spellCheck
            className={cn(
              TEXT_BOX,
              "absolute inset-0 size-full resize-none overflow-hidden bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground selection:bg-primary/25 disabled:cursor-not-allowed",
            )}
          />
        </div>
      </div>

      {showCounter || problem || notes.length ? (
        <div
          id={counterId}
          className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs"
        >
          <span className={problem ? "text-destructive" : "text-muted-foreground"}>
            {problem ?? notes.join(" ")}
          </span>
          {showCounter ? (
            <span
              className={cn(
                "tabular-nums",
                length.over ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {length.used} de {length.max} {length.unit} de {CHANNEL_WORDS[channel]}
              {appended ? " (con tu firma)" : ""}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Lo que propone Kairós va pegado al texto que cambia, antes de los adjuntos. */}
      {review ? (
        <ImproveReview
          before={review.before}
          after={review.after}
          onUse={() => {
            const after = review.after
            setReview(null)
            replaceAll(after)
          }}
          onDiscard={() => {
            setReview(null)
            requestAnimationFrame(() => area.current?.focus())
          }}
        />
      ) : null}

      {below}
    </div>
  )
}

const DIFF_CLASS: Record<DiffPart["kind"], string> = {
  same: "",
  del: "text-destructive line-through decoration-destructive/70",
  ins: "rounded-sm bg-primary/15 text-foreground",
}

/** Lo que cambiaría Kairós: tachado lo que sale, resaltado lo que entra. La persona elige. */
function ImproveReview({
  before,
  after,
  onUse,
  onDiscard,
}: {
  before: string
  after: string
  onUse: () => void
  onDiscard: () => void
}) {
  const parts = wordDiff(before, after)
  return (
    <section
      aria-label="Lo que propone Kairós"
      className="flex flex-col gap-3 rounded-2xl border border-primary/40 bg-primary/5 p-3"
    >
      <p className="text-sm font-medium">Kairós propone</p>
      <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
        {parts.map((part, index) =>
          part.kind === "del" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: las partes no tienen otra identidad.
            <del key={index} className={DIFF_CLASS.del}>
              {part.text}
            </del>
          ) : part.kind === "ins" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: las partes no tienen otra identidad.
            <ins key={index} className={cn(DIFF_CLASS.ins, "no-underline")}>
              {part.text}
            </ins>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: las partes no tienen otra identidad.
            <span key={index}>{part.text}</span>
          ),
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={onUse}>
          Usar esto
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDiscard}>
          Descartar
        </Button>
        <span className="text-xs text-muted-foreground">
          Corrige y aclara sin cambiar lo que quisiste decir. Nada sale sin «Enviar».
        </span>
      </div>
    </section>
  )
}

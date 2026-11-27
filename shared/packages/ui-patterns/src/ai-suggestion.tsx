import {
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Textarea,
} from "@odentia/ui"
import { Check, MessageCircleQuestion, Pencil, Sparkles, X } from "lucide-react"
import { type ReactNode, useId, useState } from "react"

/*
 * La propuesta de la IA. La IA propone y nunca guarda sola: cada propuesta lleva ✦ y la persona la
 * usa, la cambia o la descarta. Estas piezas no llaman a ningún modelo: muestran lo que la pantalla
 * les da y devuelven lo elegido; guardar, deshacer y avisar son de la pantalla.
 *
 * ✦ y no el robot de `AgentMark`: el robot nombra a un agente (Sofi, Kairós) que hace algo; ✦ marca
 * un dato que todavía no es de la persona. Comparten el acento del agente (`--agent`,
 * `--agent-soft`), que sigue el color de la marca de cada app.
 */

const PROPOSAL_TITLE = "Propuesta de la IA"
const PROPOSAL_READY = "La IA terminó su propuesta."

/**
 * El borde punteado y el tinte de lo propuesto, para un campo que ya trae el valor de la IA (un
 * `Input`, el contorno de unas `RadioChips`). Solo cambia el trazo y el color: el campo conserva su
 * grosor, su foco y su error.
 */
export const aiSuggestedClass = "border-dashed border-agent/70 bg-agent-soft"

const ACTION = {
  accept: "Usar",
  change: "Cambiar",
  discard: "Descartar",
} as const

export interface AiSuggestionMarkProps {
  /** De dónde salió: «Visto en las fotos: «Lona».». Se lee también sin abrir el globo. */
  reason: string
  onAccept: () => void
  onDiscard: () => void
  /** «Cambiar»: lo que hace la pantalla además de llevar el foco al campo (`fieldId`). */
  onChange?: () => void
  /**
   * Id del campo propuesto. Al usar, cambiar o descartar, la marca desaparece y el foco va a ese
   * campo, no al vacío. Con él se ofrece «Cambiar» aunque no haya `onChange`.
   */
  fieldId?: string
  /** El título del globo. */
  label?: string
  acceptLabel?: string
  disabled?: boolean
  className?: string
}

/**
 * La marca ✦ IA junto a la etiqueta de un campo propuesto. Al tocarla dice de dónde salió y deja
 * usarlo, cambiarlo o descartarlo.
 */
export function AiSuggestionMark({
  reason,
  onAccept,
  onDiscard,
  onChange,
  fieldId,
  label = PROPOSAL_TITLE,
  acceptLabel = ACTION.accept,
  disabled,
  className,
}: AiSuggestionMarkProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const run = (action: () => void) => () => {
    setOpen(false)
    action()
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            aria-label={`${label}: ${reason}`}
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-agent-soft px-2 text-xs font-semibold text-primary-soft-foreground outline-none ring-1 ring-agent-border transition-shadow hover:ring-primary/50 focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50",
              className,
            )}
          />
        }
      >
        <Sparkles className="size-3" aria-hidden />
        IA
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[22rem] max-w-[calc(100vw-2rem)] gap-3 rounded-2xl p-3"
        finalFocus={() => (fieldId ? document.getElementById(fieldId) : null) ?? true}
      >
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-sm font-semibold">{label}</p>
            <p className="text-sm text-muted-foreground">{reason}</p>
          </div>
        </div>
        <SuggestionActions
          acceptLabel={acceptLabel}
          onAccept={run(onAccept)}
          onDiscard={run(onDiscard)}
          onChange={onChange || fieldId ? run(onChange ?? (() => {})) : undefined}
        />
      </PopoverContent>
    </Popover>
  )
}

function SuggestionActions({
  acceptLabel,
  onAccept,
  onDiscard,
  onChange,
  size = "sm",
}: {
  acceptLabel: string
  onAccept: () => void
  onDiscard: () => void
  onChange?: () => void
  size?: "sm" | "xs"
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" size={size} variant="ghost" onClick={onDiscard}>
        <X aria-hidden />
        {ACTION.discard}
      </Button>
      {onChange ? (
        <Button type="button" size={size} variant="outline" onClick={onChange}>
          <Pencil aria-hidden />
          {ACTION.change}
        </Button>
      ) : null}
      <Button type="button" size={size} onClick={onAccept}>
        <Check aria-hidden />
        {acceptLabel}
      </Button>
    </div>
  )
}

export interface AiSuggestionProps {
  /** Lo propuesto cuando no es un texto suelto: una fila de precio, una promoción. */
  children?: ReactNode
  /**
   * Un texto propuesto (una descripción). «Cambiar» lo deja editar aquí mismo y «Usar» devuelve el
   * texto como quedó; nada se guarda antes.
   */
  text?: string
  /** De dónde salió («Visto en las fotos…», «Quien compra 3 o más…»). Va a la vista, sin tocar nada. */
  reason?: ReactNode
  /** Default «Propuesta de la IA · no se guarda hasta que la uses». */
  title?: string
  /** Mientras la IA trabaja: lo que está haciendo («Completando con las fotos…»). */
  pending?: string | false
  /**
   * «Usar». Con `text`, recibe el texto final (cambiado o no). Al usar o descartar la pantalla quita
   * la propuesta y lleva el foco a su campo.
   */
  onAccept: (text?: string) => void
  onDiscard: () => void
  /** «Cambiar» para lo que no es texto: la pantalla abre su editor. */
  onChange?: () => void
  acceptLabel?: string
  /**
   * `block` (default): una tarjeta punteada con título, lo propuesto y los botones abajo.
   * `row`: una fila de una lista (precio por cantidad, promoción), con los botones al final.
   */
  layout?: "block" | "row"
  className?: string
}

/**
 * Una propuesta de la IA a la vista: punteada, con ✦, lo propuesto, el «porque» y «Usar»,
 * «Cambiar» y «Descartar». Con `pending` muestra que la IA está trabajando.
 */
export function AiSuggestion({
  children,
  text,
  reason,
  title = `${PROPOSAL_TITLE} · no se guarda hasta que la uses`,
  pending,
  onAccept,
  onDiscard,
  onChange,
  acceptLabel = ACTION.accept,
  layout = "block",
  className,
}: AiSuggestionProps): React.JSX.Element {
  const titleId = useId()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text ?? "")
  // Una propuesta nueva reemplaza el borrador de la anterior.
  const [shownText, setShownText] = useState(text)
  if (text !== shownText) {
    setShownText(text)
    setDraft(text ?? "")
    setEditing(false)
  }

  const isText = text !== undefined
  const change = isText ? () => setEditing(true) : onChange
  const accept = () => onAccept(isText ? draft : undefined)
  const row = layout === "row"

  return (
    // biome-ignore lint/a11y/useSemanticElements: un fieldset trae un ancho mínimo que rompe la fila en el celular.
    <div
      role="group"
      aria-labelledby={titleId}
      aria-busy={pending ? true : undefined}
      className={cn(
        "flex border text-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1",
        aiSuggestedClass,
        row
          ? "flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3 py-2"
          : "flex-col gap-2 rounded-2xl p-3",
        className,
      )}
    >
      {/* Solo esta línea es viva: dice que la IA terminó sin leer de nuevo todo el bloque. */}
      <span className="sr-only" aria-live="polite">
        {pending ? "" : PROPOSAL_READY}
      </span>
      <div
        className={cn(
          "flex min-w-0 flex-col gap-1.5",
          // En la fila, lo propuesto no baja de 16rem: en el celular los botones pasan abajo.
          row && "flex-1 basis-64",
        )}
      >
        {pending ? (
          <>
            <span
              id={titleId}
              className="flex items-center gap-1.5 text-xs font-medium text-primary-soft-foreground"
            >
              <Sparkles className="size-3.5 shrink-0 motion-safe:animate-pulse" aria-hidden />
              {pending}
            </span>
            <Skeleton className="h-3 w-11/12 rounded-full" />
            <Skeleton className="h-3 w-8/12 rounded-full" />
          </>
        ) : (
          <>
            {row ? (
              <span id={titleId} className="sr-only">
                {PROPOSAL_TITLE}
              </span>
            ) : (
              <span
                id={titleId}
                className="flex items-center gap-1.5 text-xs font-medium text-primary-soft-foreground"
              >
                <Sparkles className="size-3.5 shrink-0" aria-hidden />
                {title}
              </span>
            )}
            {editing ? (
              <Textarea
                aria-label="Cambiar la propuesta"
                autoFocus
                rows={3}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            ) : (
              <div className={cn("flex min-w-0 items-start gap-2", row && "items-center")}>
                {row ? <Sparkles className="size-4 shrink-0 text-primary" aria-hidden /> : null}
                <div className="min-w-0 flex-1">
                  {isText ? (
                    <p className="leading-relaxed whitespace-pre-line">{text}</p>
                  ) : (
                    children
                  )}
                </div>
              </div>
            )}
            {reason ? (
              <p className={cn("text-muted-foreground", row ? "pl-6 text-xs" : "text-sm")}>
                {reason}
              </p>
            ) : null}
          </>
        )}
      </div>
      {pending ? null : (
        <div className={cn(row && "ml-auto")}>
          <SuggestionActions
            acceptLabel={acceptLabel}
            onAccept={accept}
            onDiscard={onDiscard}
            onChange={editing ? undefined : change}
            size={row ? "xs" : "sm"}
          />
        </div>
      )}
    </div>
  )
}

export interface AiSuggestionChipsProps {
  /** Lo propuesto, uno por pastilla (palabras con que la buscan, etiquetas). */
  items: ReadonlyArray<{ id: string; label: string }>
  onAccept: (id: string) => void
  onDiscard: (id: string) => void
  /** Nombre de la lista para el lector de pantalla. */
  "aria-label"?: string
  className?: string
}

/** Varias propuestas cortas como pastillas punteadas, cada una con «Usar» (✓) y «Descartar» (×). */
export function AiSuggestionChips({
  items,
  onAccept,
  onDiscard,
  "aria-label": ariaLabel = "Propuestas de la IA",
  className,
}: AiSuggestionChipsProps): React.JSX.Element | null {
  if (!items.length) return null
  return (
    // biome-ignore lint/a11y/noRedundantRoles: sin viñetas, Safari deja de anunciarla como lista.
    <ul role="list" aria-label={ariaLabel} className={cn("flex flex-wrap gap-1.5", className)}>
      {items.map((item) => (
        <li
          key={item.id}
          className={cn(
            "inline-flex h-8 items-center gap-1 rounded-full border pr-1 pl-2.5 text-[13px] font-medium motion-safe:animate-in motion-safe:fade-in-0",
            aiSuggestedClass,
          )}
        >
          <Sparkles className="size-3 shrink-0 text-primary" aria-hidden />
          <span className="text-primary-soft-foreground">{item.label}</span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`${ACTION.accept} «${item.label}»`}
            onClick={() => onAccept(item.id)}
          >
            <Check aria-hidden />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`${ACTION.discard} «${item.label}»`}
            onClick={() => onDiscard(item.id)}
          >
            <X aria-hidden />
          </Button>
        </li>
      ))}
    </ul>
  )
}

export interface AiSuggestionBarProps {
  /** Cuántas propuestas quedan sin decidir. Con 0 no se muestra. */
  count: number
  onAcceptAll: () => void
  /** Default «La IA propone N cambios.». */
  children?: ReactNode
  acceptAllLabel?: string
  className?: string
}

/** Con varias propuestas a la vista, una línea que las cuenta y las usa todas de una vez. */
export function AiSuggestionBar({
  count,
  onAcceptAll,
  children,
  acceptAllLabel = "Aplicar todos",
  className,
}: AiSuggestionBarProps): React.JSX.Element | null {
  if (count < 1) return null
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-agent-border bg-agent-soft px-3 py-2 text-sm",
        className,
      )}
    >
      <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1">
        {children ?? `La IA propone ${count} ${count === 1 ? "cambio" : "cambios"}.`}
      </span>
      <Button type="button" size="sm" onClick={onAcceptAll}>
        <Check aria-hidden />
        {acceptAllLabel}
      </Button>
    </div>
  )
}

interface AiQuestionBaseProps {
  /** Lo que la IA no ve y pregunta: «¿Cómo calza?». */
  question: string
  /** Por qué pregunta: «No se ve en las fotos.». */
  reason?: string
  /** El dato que falta, si es otro que la pregunta: «largo de la plantilla, en cm». */
  missing?: ReactNode
  /** Otro control para responder (un campo, unas `RadioChips`). */
  children?: ReactNode
  className?: string
}

type AiQuestionAnswers =
  | {
      /** Respuestas a un toque. */
      options: ReadonlyArray<{ value: string; label: string }>
      onAnswer: (value: string) => void
    }
  | { options?: undefined; onAnswer?: undefined }

export type AiQuestionProps = AiQuestionBaseProps & AiQuestionAnswers

/**
 * Lo que la IA no pudo ver, en amarillo: la pregunta, por qué la hace y lo que falta, con la
 * respuesta a la mano. No traba nada: la persona responde cuando quiera.
 */
export function AiQuestion({
  question,
  reason,
  missing,
  options,
  onAnswer,
  children,
  className,
}: AiQuestionProps): React.JSX.Element {
  const questionId = useId()
  const reasonId = useId()
  return (
    // biome-ignore lint/a11y/useSemanticElements: un fieldset trae un ancho mínimo que rompe las respuestas en el celular.
    <div
      role="group"
      aria-labelledby={questionId}
      aria-describedby={reason ? reasonId : undefined}
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-warning/25 bg-warning-soft px-3 py-2.5 text-sm",
        className,
      )}
    >
      <p className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <span>
          <span id={questionId} className="font-semibold text-warning">
            {question}
          </span>
          {reason ? (
            <>
              {" "}
              <span id={reasonId}>{reason}</span>
            </>
          ) : null}
        </span>
      </p>
      {missing ? (
        <p className="pl-6 text-xs text-warning">
          <span className="font-medium">Falta:</span> {missing}
        </p>
      ) : null}
      {options?.length ? (
        <div className="flex flex-wrap gap-1.5 pl-6">
          {options.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant="outline"
              className="bg-card"
              onClick={() => onAnswer?.(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
      {children ? <div className="pl-6">{children}</div> : null}
    </div>
  )
}

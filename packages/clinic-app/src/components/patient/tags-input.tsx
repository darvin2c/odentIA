import { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from "@odentia/clinical"
import { Badge, Button, Input } from "@odentia/ui"
import { X } from "lucide-react"
import { type FocusEvent, useId, useState } from "react"

export interface TagsInputProps {
  value: string[]
  onChange: (tags: string[]) => void
  disabled?: boolean
  suggestions?: string[]
  /** Va al campo de escritura (para `FieldLabel htmlFor`). */
  id?: string
  invalid?: boolean
  "aria-describedby"?: string
  /** Al salir del campo entero (escritura, chips y sugerencias). */
  onBlur?: () => void
}

/** La ayuda del campo: la pantalla la muestra como su descripción. */
export const TAGS_INPUT_HELP = `Máx. ${MAX_TAGS} etiquetas de hasta ${MAX_TAG_LENGTH} caracteres. Espacios, guiones y guiones bajos se unifican (“Tag 1”, “tag-1” y “tag_1” son la misma).`

/** El contador «(3/20)» que acompaña a la etiqueta «Etiquetas» de la pantalla. */
export function TagsCount({ count }: { count: number }) {
  return (
    <span className="font-normal text-muted-foreground">
      ({count}/{MAX_TAGS})
    </span>
  )
}

function canonicalTag(raw: string): string | null {
  try {
    return normalizeTags([raw])[0] ?? null
  } catch {
    return null
  }
}

/**
 * Campo de etiquetas compartido: chips removibles, sugerencias de etiquetas
 * existentes. Los duplicados canónicos no se crean. No pinta su etiqueta ni su
 * ayuda: la pantalla lo nombra (`FieldLabel htmlFor={id}` con `TagsCount`) y
 * muestra `TAGS_INPUT_HELP`.
 */
export function TagsInput({
  value,
  onChange,
  disabled = false,
  suggestions = [],
  id: idProp,
  invalid = false,
  "aria-describedby": describedBy,
  onBlur,
}: TagsInputProps) {
  const fallbackId = useId()
  const inputId = idProp ?? fallbackId
  const hintId = `${inputId}-aviso`
  const [draft, setDraft] = useState("")
  // Aviso informativo (duplicado o etiqueta no admitida): no es error del campo.
  const [hint, setHint] = useState<string | null>(null)

  const commit = (raw: string) => {
    if (!raw.trim()) return false
    try {
      const next = normalizeTags([...value, raw])
      const duplicate = next.length === value.length
      onChange(next)
      setDraft("")
      setHint(duplicate ? "La etiqueta ya estaba agregada; no se ha duplicado." : null)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : "Etiqueta inválida"
      setHint(message)
      return false
    }
  }

  const remove = (tag: string) => {
    onChange(value.filter((t) => t !== tag))
    setHint(null)
  }

  const draftCanon = draft.trim() ? (canonicalTag(draft) ?? draft.trim().toLowerCase()) : null
  const visibleSuggestions = suggestions
    .map((s) => canonicalTag(s))
    .filter((canon): canon is string => !!canon && !value.includes(canon))
    .filter((canon) => !draftCanon || canon.includes(draftCanon))
    .slice(0, 8)

  // `onBlur` solo al salir del campo entero, no al pasar a «Agregar» o a un chip.
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!onBlur || event.currentTarget.contains(event.relatedTarget as Node | null)) return
    onBlur()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: solo escucha cuándo el foco sale de lo que tiene dentro, para dar el campo por visitado.
    <div className="flex flex-col gap-3" onBlur={handleBlur}>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Etiquetas agregadas">
          {value.map((tag) => (
            <li key={tag}>
              <Badge variant="secondary" className="gap-1 pr-1">
                {tag}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-4 w-4 p-0"
                  disabled={disabled}
                  aria-label={`Quitar etiqueta ${tag}`}
                  onClick={() => remove(tag)}
                >
                  <X className="size-3" aria-hidden="true" />
                </Button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={draft}
          disabled={disabled || value.length >= MAX_TAGS}
          onChange={(e) => {
            setDraft(e.currentTarget.value)
            setHint(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault()
              commit(draft)
            } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
              remove(value[value.length - 1]!)
            }
          }}
          onBlur={() => {
            if (draft.trim()) commit(draft)
          }}
          placeholder="Escribe y pulsa Enter"
          maxLength={200}
          aria-invalid={invalid || undefined}
          aria-describedby={[describedBy, hint ? hintId : undefined].filter(Boolean).join(" ") || undefined}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !draft.trim()}
          onClick={() => commit(draft)}
        >
          Agregar
        </Button>
      </div>
      {visibleSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Sugerencias">
          {visibleSuggestions.map((canon) => (
            <Button
              key={canon}
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              title={`Agregar ${canon}`}
              onClick={() => commit(canon)}
            >
              + {canon}
            </Button>
          ))}
        </div>
      )}
      <p id={hintId} aria-live="polite" className="text-xs text-muted-foreground empty:hidden">
        {hint}
      </p>
    </div>
  )
}

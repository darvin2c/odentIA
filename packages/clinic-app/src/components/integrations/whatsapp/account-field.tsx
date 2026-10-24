import { Button, Field, FieldDescription, FieldError, FieldLabel, Input } from "@odentia/ui"
import type { ChannelField } from "../../../lib/integrations"

/**
 * Un dato de la cuenta de WhatsApp: su nombre en palabras, cómo se llama en
 * Meta y, si es una clave, oculto con «Ver». El nombre técnico del dato nunca
 * llega a la pantalla.
 */
export function AccountField({
  id,
  field,
  value,
  shown,
  error,
  extraHint,
  onChange,
  onToggleShown,
}: {
  id: string
  field: ChannelField
  value: string
  /** La clave está a la vista. */
  shown: boolean
  /** Qué falta, si falta. */
  error: string | null
  /** Aclaración que se suma a cómo se llama en Meta. */
  extraHint?: string
  onChange: (value: string) => void
  onToggleShown: () => void
}) {
  const invalid = error !== null
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={id}
          type={field.secret && !shown ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-ayuda`}
          className="h-11 min-w-0 flex-1 sm:h-9"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {field.secret ? (
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0 sm:h-9"
            aria-pressed={shown}
            aria-label={`${shown ? "Ocultar" : "Ver"} ${field.label.toLowerCase()}`}
            onClick={onToggleShown}
          >
            {shown ? "Ocultar" : "Ver"}
          </Button>
        ) : null}
      </div>
      <FieldDescription id={`${id}-ayuda`}>
        {field.hint}
        {extraHint ? ` ${extraHint}` : ""}
      </FieldDescription>
      {invalid ? <FieldError>{error}</FieldError> : null}
    </Field>
  )
}

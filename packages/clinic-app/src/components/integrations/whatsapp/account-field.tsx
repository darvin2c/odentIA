import { Button, Input } from "@odentia/ui"
import { FormField, useFieldContext } from "@odentia/ui-patterns"
import type { ChannelField } from "../../../lib/integrations"

/**
 * Un dato de la cuenta (WhatsApp, Instagram, Messenger, Telegram) como campo de
 * `useAppForm` (`<form.AppField name={field.key}>{() => <AccountField … />}`):
 * su nombre en palabras, cómo se llama en el proveedor y, si es una clave,
 * oculto con «Ver». El error (que falta, o lo que el proveedor no aceptó) va
 * junto a él. El nombre técnico del dato nunca llega a la pantalla.
 */
export function AccountField({
  id,
  field,
  shown,
  extraHint,
  onToggleShown,
}: {
  id: string
  field: ChannelField
  /** La clave está a la vista. */
  shown: boolean
  /** Aclaración que se suma a cómo se llama en el proveedor. */
  extraHint?: string
  onToggleShown: () => void
}) {
  const value = useFieldContext<string>()
  return (
    <FormField
      id={id}
      label={field.label}
      description={
        <>
          {field.hint}
          {extraHint ? ` ${extraHint}` : ""}
        </>
      }
    >
      {(control) => (
        <div className="flex gap-2">
          <Input
            {...control.props}
            type={field.secret && !shown ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 sm:h-9"
            value={value.state.value ?? ""}
            onChange={(event) => value.handleChange(event.target.value)}
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
      )}
    </FormField>
  )
}

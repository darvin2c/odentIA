/**
 * Selector buscable de un recurso dinámico de la agenda (profesional, unidad dental,
 * paciente). Las opciones llegan del consumidor; el componente no decide datos.
 * Las opciones estáticas (p.ej. estado) usan radios, no este combobox.
 */
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  FieldLabel,
} from "@odentia/ui"
import * as React from "react"

export interface ResourceSelectOption {
  id: string
  label: string
  detail?: string
}

export function ResourceSelect({
  id,
  label,
  options,
  value,
  onChange,
  onQueryChange,
  empty,
}: {
  id: string
  label: string
  options: ResourceSelectOption[]
  value: string
  onChange: (value: string) => void
  /** Opcional: avisa del texto de búsqueda para recargar opciones en servidor. */
  onQueryChange?: (query: string) => void
  /**
   * Lo que se ofrece cuando la búsqueda no encuentra a nadie, en lugar de «Sin
   * resultados.»: la lista vacía tapa lo que hay debajo del campo, así que la
   * salida (p. ej. registrar a quien se busca) tiene que ir dentro.
   */
  empty?: React.ReactNode
}) {
  // Lo elegido se conserva aunque la búsqueda en servidor deje de devolverlo. Sin esto,
  // el campo se vacía, la búsqueda vuelve a traerlo y el campo se rellena, sin fin.
  const [picked, setPicked] = React.useState<ResourceSelectOption | null>(null)
  const selected =
    options.find((item) => item.id === value) ?? (picked?.id === value ? picked : null)
  const items =
    selected && !options.some((item) => item.id === selected.id)
      ? [selected, ...options]
      : options
  return (
    <div className="grid gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox
        items={items}
        value={selected}
        isItemEqualToValue={(a, b) => a.id === b.id}
        itemToStringLabel={(item) => item.label}
        onValueChange={(item) => {
          setPicked(item)
          onChange(item?.id ?? "")
        }}
        onInputValueChange={(text) => onQueryChange?.(text)}
      >
        <ComboboxInput id={id} placeholder={`Buscar ${label.toLocaleLowerCase("es")}…`} />
        <ComboboxContent>
          <ComboboxEmpty>{empty ?? "Sin resultados."}</ComboboxEmpty>
          <ComboboxList>
            {(item: ResourceSelectOption) => (
              <ComboboxItem key={item.id} value={item}>
                <span className="grid">
                  <span>{item.label}</span>
                  <span className="text-xs text-muted-foreground">{item.detail}</span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  )
}

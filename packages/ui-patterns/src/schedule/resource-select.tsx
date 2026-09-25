/**
 * Selector buscable de un recurso dinámico de la agenda (profesional, sillón,
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
}: {
  id: string
  label: string
  options: ResourceSelectOption[]
  value: string
  onChange: (value: string) => void
  /** Opcional: avisa del texto de búsqueda para recargar opciones en servidor. */
  onQueryChange?: (query: string) => void
}) {
  return (
    <div className="grid gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox
        items={options}
        value={options.find((item) => item.id === value) ?? null}
        isItemEqualToValue={(a, b) => a.id === b.id}
        itemToStringLabel={(item) => item.label}
        onValueChange={(item) => onChange(item?.id ?? "")}
        onInputValueChange={(text) => onQueryChange?.(text)}
      >
        <ComboboxInput id={id} placeholder={`Buscar ${label.toLocaleLowerCase("es")}…`} />
        <ComboboxContent>
          <ComboboxEmpty>Sin resultados.</ComboboxEmpty>
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

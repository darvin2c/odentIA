import {
  Badge,
  Button,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  Field,
  FieldLabel,
} from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { apiFetch } from "../../lib/api"

interface Cie10Result {
  code: string
  description: string
  /** Categoría de tres caracteres con subcódigos: se codifica con el subcódigo. */
  isCategory?: boolean
}

export function Cie10Search({
  value,
  onChange,
  label = "Diagnóstico CIE-10",
  disabled = false,
}: {
  value: string
  onChange: (code: string, description: string) => void
  label?: string
  disabled?: boolean
}) {
  const id = useId()
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [debounced, setDebounced] = useState("")
  const [selected, setSelected] = useState<Cie10Result | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])
  const results = useQuery({
    queryKey: ["cie10", debounced],
    queryFn: () =>
      apiFetch<{ data: Cie10Result[] }>(`/api/cie10?q=${encodeURIComponent(debounced)}`),
    enabled: !disabled && debounced.length > 0,
    staleTime: 60_000,
  })

  const items = results.data?.data ?? []
  const searching = results.isFetching || query.trim() !== debounced
  // El combobox trabaja con el objeto resultado; `value` público sigue siendo
  // solo el código. Se sintetiza el item cuando viene de fuera (modo edición).
  const selectedItem = value
    ? selected?.code === value
      ? selected
      : { code: value, description: "" }
    : null

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox
        items={items}
        filter={null}
        disabled={disabled}
        open={open && !disabled && query.trim().length > 0}
        onOpenChange={setOpen}
        value={selectedItem}
        isItemEqualToValue={(a, b) => a.code === b.code}
        itemToStringValue={(item) => item.code}
        inputValue={query}
        onInputValueChange={(next, details) => {
          const { reason } = details
          if (reason === "input-change") {
            setQuery(next)
            setOpen(next.trim().length > 0)
            return
          }
          // Al elegir un item Base UI rellena el input con su label; se vacía
          // igual que hacía el buscador anterior y no se reabre el popup.
          if (reason === "item-press" || reason === "input-clear" || reason === "clear-press") {
            setQuery("")
            setOpen(false)
          }
        }}
        onValueChange={(item) => {
          if (item) {
            setSelected(item)
            onChange(item.code, item.description)
          } else {
            setSelected(null)
            onChange("", "")
          }
          setQuery("")
          setOpen(false)
        }}
      >
        <ComboboxInput
          id={id}
          disabled={disabled}
          placeholder="Buscar código o descripción…"
          showTrigger={false}
        />
        <ComboboxContent>
          {searching ? (
            <p className="p-2 text-sm text-muted-foreground">Buscando…</p>
          ) : results.isError ? (
            <p role="alert" className="p-2 text-sm text-destructive">
              {results.error.message}
            </p>
          ) : (
            <>
              <ComboboxList aria-label="Diagnósticos disponibles">
                {items.map((item) => (
                  <ComboboxItem
                    key={item.code}
                    value={item}
                    disabled={item.isCategory}
                    className="flex-col items-start gap-0 py-2"
                  >
                    <span className="font-medium">{item.code}</span>
                    <span className="text-muted-foreground">{item.description}</span>
                    {item.isCategory ? (
                      <span className="text-xs text-muted-foreground">
                        Categoría: elige uno de sus subcódigos
                      </span>
                    ) : null}
                  </ComboboxItem>
                ))}
              </ComboboxList>
              <ComboboxEmpty>Sin resultados.</ComboboxEmpty>
            </>
          )}
        </ComboboxContent>
      </Combobox>
      {value && (
        <div className="flex items-center gap-2">
          <Badge>{value}</Badge>
          {!disabled && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange("", "")
                setSelected(null)
                setQuery("")
              }}
            >
              Quitar código
            </Button>
          )}
        </div>
      )}
    </Field>
  )
}

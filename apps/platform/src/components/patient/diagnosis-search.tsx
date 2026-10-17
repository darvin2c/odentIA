import { diagnosisCodeLabel } from "@odentia/clinical"
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
import { useDiagnosisSystem } from "../../lib/org"

/** Un código de la lista de la clínica, como lo devuelve el buscador. */
export interface DiagnosisOption {
  system: string
  code: string
  description: string
  /** Categoría con subcódigos: se codifica con el subcódigo. */
  isCategory?: boolean
}

/**
 * Buscador de toda la lista de diagnósticos de la clínica (CIE-10 o CIE-11,
 * ADR 0041): ignora tildes y mayúsculas y pone primero lo odontológico; el
 * orden lo decide el servidor. `value` es el código y `system` su lista (un
 * código ya guardado conserva la suya); un código nuevo es de la lista de la
 * clínica.
 */
export function DiagnosisSearch({
  value,
  system = null,
  onChange,
  label = "Diagnóstico",
  disabled = false,
}: {
  value: string
  system?: string | null
  onChange: (code: string, description: string, system: string | null) => void
  label?: string
  disabled?: boolean
}) {
  const id = useId()
  const list = useDiagnosisSystem()
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [debounced, setDebounced] = useState("")
  const [selected, setSelected] = useState<DiagnosisOption | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])
  const results = useQuery({
    queryKey: ["diagnosis-codes", debounced],
    queryFn: () =>
      apiFetch<{ data: DiagnosisOption[] }>(
        `/api/diagnosis-codes?q=${encodeURIComponent(debounced)}`,
      ),
    enabled: !disabled && debounced.length > 0,
    staleTime: 60_000,
  })

  const items = results.data?.data ?? []
  const searching = results.isFetching || query.trim() !== debounced
  // El combobox trabaja con el objeto resultado; `value` público sigue siendo
  // el código. Se sintetiza el item cuando viene de fuera (modo edición).
  const selectedItem = value
    ? selected?.code === value
      ? selected
      : { system: system ?? list.key, code: value, description: "" }
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
        isItemEqualToValue={(a, b) => a.code === b.code && a.system === b.system}
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
            onChange(item.code, item.description, item.system)
          } else {
            setSelected(null)
            onChange("", "", null)
          }
          setQuery("")
          setOpen(false)
        }}
      >
        <ComboboxInput
          id={id}
          disabled={disabled}
          placeholder={`Buscar en la ${list.short} por código o nombre…`}
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
              <ComboboxList aria-label={`Diagnósticos de la ${list.short}`}>
                {items.map((item) => (
                  <ComboboxItem
                    key={`${item.system}:${item.code}`}
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
              <ComboboxEmpty>{`Sin resultados en la ${list.title}.`}</ComboboxEmpty>
            </>
          )}
        </ComboboxContent>
      </Combobox>
      {value && (
        <div className="flex items-center gap-2">
          <Badge>{diagnosisCodeLabel(system ?? list.key, value)}</Badge>
          {!disabled && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange("", "", null)
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

import {
  Button,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  Field,
  FieldError,
  FieldLabel,
} from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { useClinicalProfile } from "../lib/org"
import { fetchOfficialCodes, type OfficialCoding } from "../lib/services"

/** El buscador se muestra solo sin código elegido: su selección siempre empieza vacía. */
const NOTHING_CHOSEN: OfficialCoding | null = null

/**
 * El código de un servicio propio en la lista de servicios del país (ADR 0067,
 * tablero 3 del lienzo del issue 40). Lo que pide sale del perfil del país:
 * obligatorio donde la lista lo es, «(opcional)» donde es de referencia y sin
 * campo donde no hay lista. El buscador es el de la lista oficial, por nombre
 * o por código y sin tildes; el servidor vuelve a validar lo elegido.
 */
export function OfficialCodeField({
  value,
  onChange,
  error = null,
  disabled = false,
}: {
  /** El código elegido, con su texto oficial si se conoce. */
  value: Pick<OfficialCoding, "code"> & Partial<Pick<OfficialCoding, "display">> | null
  onChange: (next: OfficialCoding | null) => void
  error?: string | null
  disabled?: boolean
}) {
  const id = useId()
  const list = useClinicalProfile().services
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])
  const results = useQuery({
    queryKey: ["services", "official-codes", debounced],
    queryFn: () => fetchOfficialCodes({ q: debounced, limit: 20 }),
    enabled: list !== null && !disabled && debounced.length > 0,
    staleTime: 60_000,
  })
  if (!list) return null

  const items = results.data?.data ?? []
  const searching = results.isFetching || query.trim() !== debounced
  const label = list.required ? `Código ${list.label}` : `Código ${list.label} (opcional)`

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {value ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2">
          <span className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{value.code}</span>
            {value.display ? <span className="text-muted-foreground">{` · ${value.display}`}</span> : null}
          </span>
          {!disabled ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
              Cambiar
            </Button>
          ) : null}
        </div>
      ) : (
        <Combobox
          items={items}
          filter={null}
          disabled={disabled}
          open={open && !disabled && query.trim().length > 0}
          onOpenChange={setOpen}
          value={NOTHING_CHOSEN}
          isItemEqualToValue={(a, b) => a.code === b.code}
          itemToStringValue={(item) => item.code}
          inputValue={query}
          onInputValueChange={(next, details) => {
            if (details.reason === "input-change") {
              setQuery(next)
              setOpen(next.trim().length > 0)
              return
            }
            if (details.reason === "item-press" || details.reason === "input-clear" || details.reason === "clear-press") {
              setQuery("")
              setOpen(false)
            }
          }}
          onValueChange={(item) => {
            if (item) onChange(item)
            setQuery("")
            setOpen(false)
          }}
        >
          <ComboboxInput
            id={id}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            placeholder="Buscar por nombre o por código…"
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
                <ComboboxList aria-label={`Códigos ${list.label}`}>
                  {items.map((item) => (
                    <ComboboxItem key={item.code} value={item} className="flex-col items-start gap-0 py-2">
                      <span className="font-medium">{item.code}</span>
                      <span className="text-muted-foreground">{item.display}</span>
                    </ComboboxItem>
                  ))}
                </ComboboxList>
                <ComboboxEmpty>{`Sin resultados en la lista ${list.label}.`}</ComboboxEmpty>
              </>
            )}
          </ComboboxContent>
        </Combobox>
      )}
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        <p className="text-xs text-muted-foreground">
          {list.required
            ? `En tu país cada servicio lleva su código ${list.label}. Busca por nombre o por código.`
            : `Solo si lo necesitas para reportar o cobrar con la lista ${list.label}.`}
        </p>
      )}
    </Field>
  )
}

/** Si al servicio propio le falta el código que su país exige: la frase del campo. */
export function missingOfficialCode(
  list: { label: string; required: boolean } | null,
  value: { code: string } | null,
): string | null {
  return list?.required && !value ? `Elige el código ${list.label}` : null
}

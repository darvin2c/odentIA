import {
  Button,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { useClinicalProfile } from "../lib/org"
import { fetchOfficialCodes, type OfficialCoding } from "../lib/services"

/** El buscador se muestra solo sin código elegido: su selección siempre empieza vacía. */
const NOTHING_CHOSEN: OfficialCoding | null = null

/**
 * El código de un servicio propio en la lista de servicios del país (ADR 0069,
 * tablero 3 del lienzo del issue 40). Lo que pide sale del perfil del país:
 * obligatorio donde la lista lo es, «(opcional)» donde es de referencia y sin
 * campo donde no hay lista. El buscador es el de la lista oficial, por nombre
 * o por código y sin tildes; el servidor vuelve a validar lo elegido.
 *
 * La etiqueta y la ayuda las pinta la pantalla con `officialCodeText`; el
 * control no aparece donde no hay lista. `id` va al buscador o, con un código
 * elegido, al código mostrado, así la etiqueta siempre nombra algo.
 */
export function OfficialCodeField({
  id: idProp,
  value,
  onChange,
  invalid = false,
  disabled = false,
  onBlur,
  "aria-describedby": describedBy,
}: {
  id?: string
  /** El código elegido, con su texto oficial si se conoce. */
  value: Pick<OfficialCoding, "code"> & Partial<Pick<OfficialCoding, "display">> | null
  onChange: (next: OfficialCoding | null) => void
  /** El error lo dice la pantalla: el campo solo se marca. */
  invalid?: boolean
  disabled?: boolean
  onBlur?: () => void
  "aria-describedby"?: string
}) {
  const fallbackId = useId()
  const id = idProp ?? fallbackId
  const list = useClinicalProfile().services
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])
  const results = useQuery({
    queryKey: ["services", "official-codes", list?.system ?? null, debounced],
    queryFn: () => fetchOfficialCodes({ q: debounced, limit: 20 }),
    enabled: list !== null && !disabled && debounced.length > 0,
    staleTime: 60_000,
  })
  if (!list) return null

  const items = results.data?.data ?? []
  const searching = results.isFetching || query.trim() !== debounced

  if (value) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: solo escucha cuándo el foco sale de lo que tiene dentro, para dar el campo por visitado.
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) onBlur?.()
        }}
      >
        {/* Lo elegido es lo que nombra la etiqueta: `output` se asocia a ella sin activarse al tocarla. */}
        <output
          id={id}
          tabIndex={-1}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="min-w-0 flex-1 text-sm outline-none"
        >
          <span className="font-medium">{value.code}</span>
          {value.display ? <span className="text-muted-foreground">{` · ${value.display}`}</span> : null}
        </output>
        {!disabled ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
            Cambiar
          </Button>
        ) : null}
      </div>
    )
  }

  return (
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
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onBlur={() => onBlur?.()}
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
            <ComboboxEmpty>{`Sin resultados en ${list.listName}.`}</ComboboxEmpty>
          </>
        )}
      </ComboboxContent>
    </Combobox>
  )
}

/**
 * La etiqueta y la ayuda del código según la lista del país: obligatorio o
 * «(opcional)»; `null` donde no hay lista (sin campo).
 */
export function officialCodeText(
  list: { codeName: string; required: boolean; listName: string } | null,
): { label: string; description: string } | null {
  if (!list) return null
  const named = capitalize(list.codeName)
  return list.required
    ? { label: named, description: `En tu país cada servicio lleva su ${list.codeName}. Busca por nombre o por código.` }
    : { label: `${named} (opcional)`, description: `Solo si lo necesitas para reportar o cobrar con ${list.listName}.` }
}

/** Si al servicio propio le falta el código que su país exige: la frase del campo. */
export function missingOfficialCode(
  list: { codeName: string; required: boolean } | null,
  value: { code: string } | null,
): string | null {
  return list?.required && !value ? `Elige el ${list.codeName}` : null
}

/** La primera letra en mayúscula: «código CPMS» → «Código CPMS». */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

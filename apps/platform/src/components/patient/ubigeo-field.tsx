import { Button, Field, FieldDescription, FieldLabel, Input } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { apiFetch } from "../../lib/api"

export interface UbigeoItem {
  code: string
  department: string
  province: string | null
  district: string | null
  label: string
}

/** Etiqueta del ubigeo guardado («Lima / Lima / Miraflores»). */
export function useUbigeoLabel(code: string | null | undefined): string | null {
  const query = useQuery({
    queryKey: ["ubigeo", code],
    queryFn: () =>
      apiFetch<{ data: UbigeoItem[] }>(`/api/ubigeo?q=${encodeURIComponent(code ?? "")}`),
    enabled: !!code,
    staleTime: Number.POSITIVE_INFINITY,
  })
  if (!code) return null
  return query.data?.data.find((item) => item.code === code)?.label ?? code
}

/**
 * Ubigeo del INEI: se busca por departamento, provincia o distrito y se guarda
 * el código de seis dígitos. Lista accesible con botones, sin arrastre.
 */
export function UbigeoField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: string
  onChange: (code: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const id = useId()
  const current = useUbigeoLabel(value || null)
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(timer)
  }, [q])
  const results = useQuery({
    queryKey: ["ubigeo-search", debounced],
    queryFn: () =>
      apiFetch<{ data: UbigeoItem[] }>(`/api/ubigeo?q=${encodeURIComponent(debounced)}`),
    enabled: !disabled && debounced.length > 0,
    staleTime: 60_000,
  })
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {value ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            {current} <span className="text-muted-foreground">({value})</span>
          </span>
          {!disabled ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange("")}>
              Cambiar
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <Input
            id={id}
            value={q}
            disabled={disabled}
            placeholder="Departamento, provincia o distrito…"
            onChange={(event) => setQ(event.target.value)}
          />
          {debounced ? (
            <ul
              className="flex max-h-48 flex-col overflow-auto rounded-md border"
              aria-label="Ubigeos encontrados"
            >
              {(results.data?.data ?? []).map((item) => (
                <li key={item.code}>
                  <button
                    type="button"
                    className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted"
                    onClick={() => {
                      onChange(item.code)
                      setQ("")
                    }}
                  >
                    {item.label} <span className="text-muted-foreground">({item.code})</span>
                  </button>
                </li>
              ))}
              {results.isSuccess && results.data.data.length === 0 ? (
                <li className="px-3 py-1.5 text-sm text-muted-foreground">Sin resultados.</li>
              ) : null}
            </ul>
          ) : null}
          <FieldDescription>Catálogo de ubigeo del INEI.</FieldDescription>
        </>
      )}
    </Field>
  )
}

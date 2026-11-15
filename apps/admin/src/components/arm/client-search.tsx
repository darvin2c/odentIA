import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import { Input, Label, RadioGroup, RadioGroupItem } from "@odentia/ui"
import { type FieldControl, LoadingState, submitErrorMessage } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { ProductMark } from "../product"

const pickedSchema = z.object({
  items: z.array(
    z.object({ id: z.string(), name: z.string(), product: z.enum(CLINICAL_PRODUCTS) }),
  ),
})

/**
 * Buscar un cliente que ya tenemos, por el nombre de la clínica o de la
 * persona, y elegirlo. Lo usan «¿De qué cliente es este correo?» y «¿De quién
 * es esta conversación?».
 */
export function ClientSearch({
  id,
  initialQuery = "",
  control,
  value,
  onChange,
}: {
  id: string
  initialQuery?: string
  control: FieldControl
  value: string
  onChange: (clientId: string, name: string) => void
}) {
  const [query, setQuery] = useState(initialQuery)
  const [search, setSearch] = useState(query.trim())
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])
  const found = useQuery({
    queryKey: ["admin", "clients", "picker", search],
    enabled: search.length >= 2,
    queryFn: async () =>
      pickedSchema.parse(
        await api<unknown>(`/api/admin/clients?view=todos&limit=8&q=${encodeURIComponent(search)}`),
      ).items,
  })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>Buscar por nombre</Label>
        <Input
          id={id}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="La clínica o la persona"
          autoComplete="off"
        />
      </div>
      {search.length < 2 ? (
        <p className="text-sm text-muted-foreground">Escribe al menos dos letras.</p>
      ) : found.isPending ? (
        <LoadingState message="Buscando clientes…" />
      ) : found.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {submitErrorMessage(found.error)}
        </p>
      ) : found.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ningún cliente se llama así.</p>
      ) : (
        <RadioGroup
          name={control.name}
          aria-label="Cliente"
          aria-invalid={control.invalid || undefined}
          aria-describedby={control.describedBy}
          value={value}
          onValueChange={(next) => {
            const picked = found.data.find((client) => client.id === String(next ?? ""))
            onChange(String(next ?? ""), picked?.name ?? "")
          }}
          className="flex flex-col gap-2"
        >
          {found.data.map((client) => (
            <Label
              key={client.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 font-normal has-data-checked:border-foreground"
            >
              <RadioGroupItem value={client.id} />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{client.name}</span>
              <ProductMark product={client.product} />
            </Label>
          ))}
        </RadioGroup>
      )}
    </div>
  )
}

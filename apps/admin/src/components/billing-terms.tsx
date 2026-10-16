/**
 * Facturación › tarifas de WhatsApp (Meta) y pedidos de negociación que
 * esperan aprobación (ADR 0030, tableros O1 y O2).
 */
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { EmptyState, ErrorState, FormDrawer, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, api } from "../lib/api"

interface WhatsappRate {
  countryCode: string
  category: "marketing" | "utility" | "authentication"
  currency: string
  priceMicros: number
  updatedAt: string
}

const CATEGORY_WORDS: Record<WhatsappRate["category"], string> = {
  marketing: "Marketing",
  utility: "Servicio (utilidad)",
  authentication: "Autenticación",
}

function perMessage(micros: number, currency: string): string {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(micros / 1_000_000)
}

const errorText = (error: unknown) => (error instanceof ApiError ? (error.shape.message ?? "No se pudo guardar") : "No se pudo guardar")

export function WhatsappRatesSection() {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<Partial<WhatsappRate> | null>(null)
  const rates = useQuery({
    queryKey: ["admin", "billing", "whatsapp-rates"],
    queryFn: () => api<WhatsappRate[]>("/api/admin/billing/whatsapp-rates"),
  })
  return (
    <section aria-labelledby="whatsapp-tarifas" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="whatsapp-tarifas" className="text-base font-semibold">
          Tarifas de WhatsApp (Meta)
        </h2>
        <Button size="sm" variant="outline" onClick={() => setEditing({ category: "utility", currency: "USD" })}>
          Cargar tarifa
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Con estas tarifas la clínica ve cuánto le cobraría Meta por las plantillas del mes. Es solo una estimación: Meta le cobra directo y odentIA no
        recibe ese pago. Cópialas de la tabla de precios de Meta para cada país.
      </p>
      {rates.isPending ? (
        <LoadingState message="Cargando tarifas…" />
      ) : rates.isError ? (
        <ErrorState title="No se pudieron cargar las tarifas" onRetry={() => void rates.refetch()} />
      ) : rates.data.length === 0 ? (
        <EmptyState
          title="Sin tarifas"
          description="Sin tarifa para su país, la clínica ve cuántas plantillas envió pero no un importe estimado."
          actionLabel="Cargar tarifa"
          onAction={() => setEditing({ category: "utility", currency: "USD" })}
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {rates.data.map((rate) => (
            <li key={`${rate.countryCode}-${rate.category}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
              <span className="min-w-0 flex-1 basis-40">
                {rate.countryCode} · {CATEGORY_WORDS[rate.category]}
              </span>
              <span className="tabular-nums">{perMessage(rate.priceMicros, rate.currency)} por plantilla</span>
              <Button size="sm" variant="ghost" onClick={() => setEditing(rate)}>
                Cambiar
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <RateDrawer
          rate={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ["admin", "billing", "whatsapp-rates"] })}
        />
      ) : null}
    </section>
  )
}

function RateDrawer({ rate, onClose, onSaved }: { rate: Partial<WhatsappRate>; onClose: () => void; onSaved: () => void }) {
  const [country, setCountry] = useState(rate.countryCode ?? "PE")
  const [category, setCategory] = useState<WhatsappRate["category"]>(rate.category ?? "utility")
  const [currency, setCurrency] = useState(rate.currency ?? "USD")
  const [price, setPrice] = useState(rate.priceMicros === undefined ? "" : String(rate.priceMicros / 1_000_000))
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => {
      const value = Number(price.trim().replace(",", "."))
      if (!Number.isFinite(value) || value < 0) throw new Error("Escribe la tarifa por plantilla, por ejemplo 0.0218")
      return api("/api/admin/billing/whatsapp-rates", {
        method: "PUT",
        body: JSON.stringify({ countryCode: country.trim().toUpperCase(), category, currency: currency.trim().toUpperCase(), priceMicros: Math.round(value * 1_000_000) }),
      })
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e) => setError(e instanceof Error && !(e instanceof ApiError) ? e.message : errorText(e)),
  })
  return (
    <FormDrawer open title="Tarifa de WhatsApp" submitLabel="Guardar" onSubmit={() => save.mutate()} onClose={onClose} isSubmitting={save.isPending} error={error}>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="rate-country">País (ISO, dos letras)</Label>
          <Input id="rate-country" value={country} maxLength={2} onChange={(event) => setCountry(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rate-category">Categoría</Label>
          <Select value={category} onValueChange={(value) => setCategory(value as WhatsappRate["category"])}>
            <SelectTrigger id="rate-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CATEGORY_WORDS) as Array<WhatsappRate["category"]>).map((key) => (
                <SelectItem key={key} value={key}>
                  {CATEGORY_WORDS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rate-currency">Moneda</Label>
          <Input id="rate-currency" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rate-price">Por plantilla</Label>
          <Input id="rate-price" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="0.0218" />
        </div>
      </div>
    </FormDrawer>
  )
}

interface Negotiation {
  id: string
  organizationId: string
  kind: "descuento" | "prueba"
  discountBps: number | null
  trialCreditCents: number | null
  trialDays: number | null
  note: string | null
  requestedByName: string | null
  createdAt: string
}

/** Lo que alguien pidió fuera de lo de siempre: solo la administración lo aprueba. */
export function NegotiationsSection({ organizationNames }: { organizationNames: Record<string, string> }) {
  const queryClient = useQueryClient()
  const pending = useQuery({
    queryKey: ["admin", "billing", "negotiations"],
    queryFn: () => api<Negotiation[]>("/api/admin/billing/negotiations"),
  })
  const decide = useMutation({
    mutationFn: (input: { id: string; approve: boolean }) =>
      api(`/api/admin/billing/negotiations/${input.id}/decide`, { method: "POST", body: JSON.stringify({ approve: input.approve }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin"] }),
  })
  if (pending.isPending || pending.isError || pending.data.length === 0) return null
  return (
    <section aria-labelledby="negociaciones" className="flex flex-col gap-2">
      <h2 id="negociaciones" className="text-base font-semibold">
        Pedidos por aprobar
      </h2>
      <ul className="flex flex-col gap-2">
        {pending.data.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4 text-sm">
            <div className="min-w-0 flex-1 basis-60">
              <p className="font-medium">{organizationNames[item.organizationId] ?? item.organizationId}</p>
              <p className="text-muted-foreground">
                {item.kind === "descuento"
                  ? `Descuento de ${(item.discountBps ?? 0) / 100} % sobre el precio base`
                  : `Prueba con ${(item.trialCreditCents ?? 0) / 100} de saldo y ${item.trialDays} días`}
                {item.requestedByName ? ` · lo pide ${item.requestedByName}` : ""}
                {item.note ? ` · «${item.note}»` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: item.id, approve: true })}>
                Aprobar
              </Button>
              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ id: item.id, approve: false })}>
                Rechazar
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {decide.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(decide.error)}
        </p>
      ) : null}
    </section>
  )
}

import { Button, Input, Textarea } from "@odentia/ui"
import { ConfirmDialog, ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState, type FormEvent, type ReactNode } from "react"
import { apiFetch } from "../../lib/api"

export interface Row { id: string; title?: string }
export type Json<T> = T extends Date ? string : T extends readonly (infer U)[] ? Json<U>[] : T extends object ? { [K in keyof T]: Json<T[K]> } : T
export type Result<T extends (...args: never[]) => unknown> = Json<Awaited<ReturnType<T>>>
export function useClinical<T = Row>(path: string) {
  return useQuery({ queryKey: ["clinical", path], queryFn: () => apiFetch<{ data: T }>(`/api${path}`) })
}
export function useClinicalMutation() {
  const client = useQueryClient()
  return useMutation({ mutationFn: async ({ path, body, method = "POST" }: { path: string; body: unknown; method?: string }) => {
    return apiFetch<{ data: Row }>(`/api${path}`, { method, body: body instanceof FormData ? body : JSON.stringify(body), ...(body instanceof FormData ? { headers: {} } : {}) })
  }, onSuccess: () => client.invalidateQueries({ queryKey: ["clinical"] }) })
}
export function QueryState({ query }: { query: { isPending: boolean; error: Error | null; refetch: () => unknown } }) {
  if (query.isPending) return <LoadingState message="Cargando historia clínica…" />
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  return null
}
export function money(cents: number, currency = "PEN") { return new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(cents / 100) }
export function date(value: string | null | undefined) { return value ? new Date(value).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" }) : "—" }
export function cents(value: string): number {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) throw new Error("Introduce un importe positivo con hasta dos decimales")
  const [whole, fraction = ""] = value.replace(",", ".").split(".")
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("Importe inválido")
  return result
}
export function iso(value: string) { return new Date(value).toISOString() }
export function text(form: FormData, key: string) { return String(form.get(key) ?? "").trim() }
export function optional(form: FormData, key: string) { return text(form, key) || undefined }
export function Field({ label, name, type = "text", required = true, defaultValue, children, min, max }: { label: string; name: string; type?: string; required?: boolean; defaultValue?: string | number; children?: ReactNode; min?: string | number; max?: string | number }) {
  const id = useId()
  return <div className="grid gap-1.5"><label htmlFor={id} className="text-sm font-medium">{label}</label>{children ? <select id={id} name={name} required={required} defaultValue={defaultValue} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Seleccionar</option>{children}</select> : type === "textarea" ? <Textarea id={id} name={name} required={required} defaultValue={defaultValue} /> : <Input id={id} name={name} type={type} required={required} defaultValue={defaultValue} min={min} max={max} />}</div>
}
export function ActionForm({ title, submit = "Guardar", children, onSubmit, open = false }: { title: string; submit?: string; children: ReactNode; onSubmit: (data: FormData) => Promise<unknown>; open?: boolean }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [success, setSuccess] = useState(false)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; setPending(true); setError(null); setSuccess(false)
    try { await onSubmit(new FormData(form)); setSuccess(true); form.reset() } catch (e) { setError(e instanceof Error ? e : new Error("No se pudo guardar")) } finally { setPending(false) }
  }
  return <details open={open || undefined} className="rounded-lg border bg-card p-4"><summary className="cursor-pointer font-medium">{title}</summary><form onSubmit={save} className="mt-4 grid gap-4">{children}{error && <ErrorState error={error} />}{success && <p role="status" className="text-sm">Guardado correctamente.</p>}<Button type="submit" disabled={pending}>{pending ? "Guardando…" : submit}</Button></form></details>
}
export function ConfirmAction({ label, description, action }: { label: string; description: string; action: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false); const [pending, setPending] = useState(false); const [error, setError] = useState<Error | null>(null)
  return <><Button variant="outline" onClick={() => setOpen(true)}>{label}</Button>{error && <ErrorState error={error} />}<ConfirmDialog open={open} title={label} description={description} confirmLabel={label} variant="default" pending={pending} onClose={() => setOpen(false)} onConfirm={() => { setPending(true); void action().then(() => setOpen(false)).catch(e => setError(e)).finally(() => setPending(false)) }} /></>
}
export function Section({ title, children }: { title: string; children: ReactNode }) { return <section className="space-y-4 rounded-xl border bg-card p-5"><h2 className="text-lg font-semibold">{title}</h2>{children}</section> }
export const patientPath = (id: string) => `/patients/${id}`
export function TreatmentLink({ patientId, item }: { patientId: string; item: Row }) { return <a className="font-medium underline underline-offset-4" href={`${patientPath(patientId)}/treatments/${item.id}`}>{item.title}</a> }

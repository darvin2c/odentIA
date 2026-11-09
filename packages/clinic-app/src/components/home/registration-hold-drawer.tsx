import { Button, Checkbox, toast } from "@odentia/ui"
import { DetailDrawer, internationalText, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { activeOrgLocale } from "../../lib/locale"

interface HoldRow {
  key: string
  label: string
  format: "text" | "phone" | "date"
  declared: string | null
  saved: string | null
  state: "same" | "new" | "changed"
  /** Si no se puede guardar desde aquí, por qué (el servidor lo decide). */
  blocked: string | null
  /** Viene marcado: lo decide el servidor. */
  checked: boolean
}

interface HoldView {
  taskId: string
  match: "documento" | "celular"
  ownerId: string
  ownerName: string
  ownerPatientId: string | null
  createdAt: string
  declaredName: string
  rows: HoldRow[]
  health: { allergies: string | null; more: boolean } | null
  revision: string
}

/** Cada dato como se lee en la clínica: el celular con su prefijo y la fecha con su mes. */
function shown(row: HoldRow, value: string | null): string {
  if (!value) return "—"
  if (row.format === "phone") return internationalText(value)
  if (row.format === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T12:00:00`).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", year: "numeric" })
  }
  return value
}

/** «hace 3 min», en palabras, para decir cuándo se registró. */
function since(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return "hace un momento"
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} d`
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** «Iguales: nacimiento, celular y documento». */
function listWords(labels: string[]): string {
  const words = labels.map((label, index) => (index === 0 ? label : label.toLowerCase()))
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} y ${words.at(-1)}` : (words[0] ?? "")
}

/**
 * «¿Es la misma persona?»: lo que escribió en el registro en línea quien se
 * parece a alguien que ya está en la clínica (el mismo documento o el mismo
 * celular, nunca solo el nombre), dato por dato, como quien revisa cambios
 * antes de aceptarlos. Lo que se marca se guarda en su ficha y lo de antes
 * queda en una nota; quién es y por dónde se le escribe vienen sin marcar
 * (lo decide el servidor). Nada se guarda sin que recepción lo diga.
 */
export function RegistrationHoldDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const legendId = useId()
  const hold = useQuery({
    queryKey: ["registration-hold", taskId],
    queryFn: () => apiFetch<{ data: HoldView }>(`/api/tasks/${taskId}/registration`),
    enabled: !!taskId,
    retry: false,
  })
  const data = hold.data?.data
  // Lo marcado nace de lo que dice el servidor y vuelve a nacer si lo que se ve cambió.
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (data) setMarked(new Set(data.rows.filter((row) => row.checked).map((row) => row.key)))
  }, [data?.revision])

  const savable = data?.rows.filter((row) => row.key !== "document" && row.state !== "same" && !row.blocked) ?? []
  const blocked = data?.rows.filter((row) => row.state !== "same" && (row.blocked || row.key === "document")) ?? []
  const same = data?.rows.filter((row) => row.state === "same") ?? []
  const apply = savable.filter((row) => marked.has(row.key))
  const careful = savable.some((row) => !row.checked)

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ["workspace-home"] })
    onClose()
  }
  const openPerson = (personId: string) => ({ label: "Ver su ficha", onClick: () => void navigate({ to: "/people/$personId", params: { personId } }) })
  const decide = useMutation({
    mutationFn: (isSame: boolean) =>
      apiFetch<{ data: { patientId: string; personId: string; applied: number } }>(`/api/tasks/${taskId}/registration`, {
        method: "POST",
        body: JSON.stringify(isSame ? { same: true, apply: apply.map((row) => row.key), revision: data?.revision } : { same: false, revision: data?.revision }),
      }),
    onSuccess: (result, isSame) => {
      const name = data?.ownerName ?? "la persona"
      const count = apply.length
      const replaced = apply.some((row) => row.state === "changed")
      const message = !isSame
        ? "Listo: se registró como una persona nueva."
        : !data?.ownerPatientId
          ? `Listo: ${name} ya es paciente${count ? `, con ${plural(count, "dato nuevo", "datos nuevos")}` : ""}.`
          : count
            ? `Listo: se guardaron ${plural(count, "cambio", "cambios")} en la ficha de ${name}.${replaced ? " Lo de antes quedó en una nota." : ""}`
            : `Listo: la ficha de ${name} queda como estaba.`
      toast.success(message, { action: openPerson(result.data.personId) })
      done()
    },
    onError: (error) => {
      // Algo cambió mientras se revisaba: se vuelve a mostrar lo de ahora.
      if (error instanceof ApiError && error.shape.code === "HOLD_CHANGED") void hold.refetch()
    },
  })
  const discard = useMutation({
    mutationFn: () => apiFetch(`/api/tasks/${taskId}/discard`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => {
      toast.success("Se descartó: no cambió ninguna ficha.")
      done()
    },
  })
  const busy = decide.isPending || discard.isPending
  const problem = decide.error
    ? submitErrorMessage(decide.error)
    : discard.error
      ? submitErrorMessage(discard.error)
      : hold.isError
        ? hold.error instanceof ApiError
          ? (hold.error.shape.message ?? "No se pudo abrir.")
          : "No se pudo abrir. Revisa tu conexión."
        : null
  const why = data?.match === "documento" ? "el mismo documento" : "el mismo celular"
  const toggle = (key: string) =>
    setMarked((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <DetailDrawer
      open={!!taskId}
      onClose={onClose}
      title="¿Es la misma persona?"
      description={
        data
          ? `Se registró en línea ${since(data.createdAt)} como ${data.declaredName} y tiene ${why} que ${data.ownerName}, que ya está en la clínica.`
          : "Se registró en línea y se parece a alguien que ya está en la clínica."
      }
      isLoading={hold.isPending && !!taskId}
      isSubmitting={busy}
      error={problem}
      showClose={false}
      actions={
        data ? (
          <>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => discard.mutate()}>
              Descartar
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => decide.mutate(false)}>
              Es otra persona
            </Button>
            <Button type="button" disabled={busy} onClick={() => decide.mutate(true)}>
              {apply.length ? `Sí, guardar ${plural(apply.length, "cambio", "cambios")}` : "Sí, sin cambios"}
            </Button>
          </>
        ) : null
      }
    >
      {data ? (
        <div className="flex flex-col gap-5">
          {savable.length ? (
            <fieldset aria-labelledby={legendId} className="flex flex-col gap-2">
              <legend id={legendId} className="text-sm font-medium">
                {plural(savable.length, "dato distinto", "datos distintos")}
              </legend>
              {careful ? (
                <p className="text-sm text-muted-foreground">
                  Quién es y por dónde se le escribe vienen sin marcar: márcalos solo si comprobaste que es la misma persona.
                </p>
              ) : null}
              <ul className="divide-y rounded-2xl border bg-card">
                {savable.map((row) => (
                  <li key={row.key}>
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 px-4 py-3 text-sm">
                      <Checkbox
                        className="mt-0.5"
                        checked={marked.has(row.key)}
                        disabled={busy}
                        onCheckedChange={() => toggle(row.key)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-muted-foreground">
                          {row.label}
                          {row.state === "new" ? " · nuevo" : ""}
                        </span>
                        <span className="break-words font-medium">{shown(row, row.declared)}</span>
                        {row.state === "changed" ? (
                          <span className="break-words text-muted-foreground">Antes: {shown(row, row.saved)}</span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : (
            <p className="text-sm">Escribió lo mismo que ya tiene su ficha.</p>
          )}

          {blocked.length ? (
            <ul className="flex flex-col gap-3 text-sm">
              {blocked.map((row) => (
                <li key={row.key} className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className="break-words font-medium">{shown(row, row.declared)}</span>
                  {row.saved ? <span className="break-words text-muted-foreground">Ya tiene: {shown(row, row.saved)}</span> : null}
                  {row.blocked ? <span className="text-muted-foreground">{row.blocked}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {same.length ? (
            <details className="text-sm text-muted-foreground">
              <summary className="min-h-11 cursor-pointer content-center sm:min-h-8">Iguales: {listWords(same.map((row) => row.label))}</summary>
              <ul className="mt-1 flex flex-col gap-1">
                {same.map((row) => (
                  <li key={row.key}>
                    {row.label}: <span className="text-foreground">{shown(row, row.saved)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {data.health ? (
            <p className="text-sm">
              Su salud: declaró{" "}
              {data.health.allergies ? `alergia a ${data.health.allergies}${data.health.more ? " y otros datos" : ""}` : "algunos datos"}. Si es la
              misma persona, va a sus antecedentes para que el profesional lo revise, aunque no guardes ningún cambio.
            </p>
          ) : null}

          <p className="rounded-2xl bg-muted/60 p-4 text-sm">
            «Es otra persona» la registra aparte{data.match === "documento" ? ", sin ese documento" : ""}. «Descartar» borra lo que escribió sin
            cambiar ninguna ficha.
          </p>
        </div>
      ) : null}
    </DetailDrawer>
  )
}

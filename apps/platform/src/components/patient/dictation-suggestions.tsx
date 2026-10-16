import { formatMoney, isValidTooth, surfaceLabel, surfacesForTooth } from "@odentia/clinical"
import { Badge, Button, Field, FieldDescription, FieldLabel, Input, Textarea } from "@odentia/ui"
import { AgentMark, FormDrawer, SubmitButton } from "@odentia/ui-patterns"
import { Check, CircleAlert, X } from "lucide-react"
import { type FormEvent, useState } from "react"
import { activeOrgLocale } from "../../lib/locale"
import type { ServiceCatalogItem } from "../../lib/services"
import {
  DICTATION_KIND_LABEL,
  type DictationKind,
  dictationErrorText,
  type DictationSession,
  type DictationSuggestion,
  suggestionText,
} from "./dictation-session"
import { ServicePicker } from "./service-picker"

/**
 * Tarifa con la moneda del tarifario en el formato de la clínica. Sin moneda
 * o sin formato cargado no se inventa ninguno: no se escribe el importe.
 */
function price(cents: number, currency: string): string {
  const locale = activeOrgLocale()
  return currency && locale ? formatMoney(cents, currency, locale) : "…"
}

interface Candidate {
  id: string
  name: string
  priceCents: number
  currency: string
  scope?: string | null
}

const candidatesOf = (item: DictationSuggestion): Candidate[] =>
  Array.isArray(item.payload["candidates"]) ? (item.payload["candidates"] as Candidate[]) : []

/**
 * Sugerencias del dictado que corresponden a un bloque de la atención. Van
 * dentro del bloque, no en una lista aparte: se revisa cada cosa donde va a
 * quedar. Mientras se dicta solo se pueden quitar o abrir; al terminar se
 * confirman, se editan o se descartan.
 */
export function DictationBlockSuggestions({ session, kind }: { session: DictationSession; kind: DictationKind }) {
  const items = session.suggestions.filter((item) => item.kind === kind)
  if (!session.enabled || items.length === 0) return null
  const acting = (item: DictationSuggestion) => session.act.isPending && session.act.variables?.item.id === item.id
  return (
    <div className="flex basis-full flex-col gap-2">
      <ul aria-label={`Sugerencias del asistente: ${DICTATION_KIND_LABEL[kind]}`} className="flex flex-col gap-2">
        {items.map((item) => {
          const { title, detail } = suggestionText(item)
          const ready = item.status === "lista"
          const busy = acting(item) || session.confirmReady.isPending
          const candidates = candidatesOf(item)
          return (
            <li key={item.id} className="flex flex-col gap-2 rounded-xl border border-agent-border bg-agent-soft p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {ready ? (
                  <AgentMark size="sm" />
                ) : (
                  <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-warning-soft text-warning">
                    <CircleAlert className="size-3.5" />
                  </span>
                )}
                {/* Tocar la sugerencia la abre para editarla: en teléfono es la única vía. */}
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-11 min-w-0 flex-1 basis-40 flex-col items-start justify-center gap-0 whitespace-normal px-2 py-1 text-left"
                  disabled={busy}
                  onClick={() => session.openEdit(item)}
                >
                  <span className="font-medium">{title}</span>
                  <span className="font-normal text-muted-foreground">
                    {[ready ? detail : (item.note ?? detail), item.voice ? `corregido por voz, antes ${item.voice.before}` : ""].filter(Boolean).join(" · ")}
                  </span>
                </Button>
                {!ready ? <Badge>Por revisar</Badge> : session.dictating ? <Badge variant="secondary">Sugerido</Badge> : null}
                {item.voice ? (
                  <Button type="button" variant="link" size="sm" className="min-h-11 px-1 sm:min-h-8" disabled={busy} onClick={() => session.act.mutate({ item, action: "undo-voice" })}>
                    Deshacer
                  </Button>
                ) : null}
                {ready && !session.dictating ? (
                  <>
                    <SubmitButton type="button" size="sm" className="max-sm:hidden" pending={acting(item) && session.act.variables?.action === "confirm"} disabled={busy} onClick={() => session.act.mutate({ item, action: "confirm" })}>
                      Confirmar
                    </SubmitButton>
                    <Button type="button" size="icon" className="size-11 sm:hidden" aria-label={`Confirmar: ${title}`} disabled={busy} onClick={() => session.act.mutate({ item, action: "confirm" })}>
                      <Check className="size-4" aria-hidden />
                    </Button>
                  </>
                ) : null}
                {!session.dictating ? (
                  <Button type="button" variant="outline" size="sm" className="max-sm:hidden" disabled={busy} onClick={() => session.openEdit(item)}>
                    Editar
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={`Descartar: ${title}`} disabled={busy} onClick={() => session.act.mutate({ item, action: "discard" })}>
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
              {!ready && item.kind === "plan" ? (
                <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0" aria-label="Elige la prestación">
                  {candidates.map((candidate) => (
                    <Button
                      key={candidate.id}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-11 whitespace-normal sm:min-h-8"
                      disabled={busy || session.save.isPending}
                      onClick={() => session.save.mutate({ item, patch: { serviceId: candidate.id }, confirm: false })}
                    >
                      {candidate.name} · {price(candidate.priceCents, candidate.currency)}
                    </Button>
                  ))}
                  <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" disabled={busy} onClick={() => session.openEdit(item)}>
                    Buscar otra prestación
                  </Button>
                </fieldset>
              ) : null}
            </li>
          )
        })}
      </ul>
      {session.act.isError && items.some((item) => item.id === session.act.variables?.item.id) ? (
        <p role="alert" className="text-sm text-destructive">
          {dictationErrorText(session.act.error, "No pude guardar esto. Revísalo y vuelve a intentarlo.")}
        </p>
      ) : null}
    </div>
  )
}

/** Campos que el odontólogo corrige a mano en una sugerencia que no es del plan, con su rótulo. */
const EDITABLE: Record<Exclude<DictationKind, "plan">, Array<{ key: string; label: string; long?: boolean; number?: boolean }>> = {
  nota: [
    { key: "reason", label: "Motivo de consulta", long: true },
    { key: "presentIllness", label: "Enfermedad actual", long: true },
    { key: "illnessDuration", label: "Tiempo de enfermedad" },
    { key: "evolution", label: "Evolución", long: true },
    { key: "indications", label: "Indicaciones", long: true },
    { key: "prognosis", label: "Pronóstico" },
  ],
  diagnostico: [
    { key: "cie10Code", label: "Código CIE-10" },
    { key: "toothNumber", label: "Pieza", number: true },
    { key: "note", label: "Nota", long: true },
  ],
  control: [
    { key: "title", label: "Control" },
    { key: "instructions", label: "Indicaciones", long: true },
  ],
}

/**
 * «Sugerencia del asistente»: editar una sugerencia en la superficie lateral
 * (columna si cabe, cajón si no). Guardar la confirma: entra a la historia por
 * la operación de siempre; si aún le falta algo, se queda abierta y lo dice.
 */
export function DictationEditDrawer({ session }: { session: DictationSession }) {
  const item = session.editing
  return item ? <EditForm key={item.id} item={item} session={session} /> : null
}

function EditForm({ item, session }: { item: DictationSuggestion; session: DictationSession }) {
  const payload = item.payload
  const kind = item.kind
  const plan = kind === "plan"
  const fields = kind === "plan" ? [] : EDITABLE[kind].filter((field) => kind !== "nota" || payload[field.key] !== undefined)
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries([...fields.map((field) => field.key), "toothNumber", "detail"].map((key) => [key, payload[key] == null ? "" : String(payload[key])])),
  )
  const [service, setService] = useState<Candidate | null>(() =>
    typeof payload["serviceId"] === "string"
      ? {
          id: payload["serviceId"],
          name: String(payload["serviceName"] ?? ""),
          priceCents: Number(payload["priceCents"] ?? 0),
          // La moneda viene del tarifario (en el payload); si falta, no se asume ninguna.
          currency: typeof payload["currency"] === "string" ? payload["currency"] : "",
          scope: (payload["serviceScope"] as string | null | undefined) ?? null,
        }
      : null,
  )
  const [surfaces, setSurfaces] = useState<string[]>(() => (Array.isArray(payload["surfaces"]) ? (payload["surfaces"] as string[]) : []))
  const [review, setReview] = useState<string | null>(null)
  const { title } = suggestionText(item)

  const tooth = Number(draft["toothNumber"])
  const validTooth = draft["toothNumber"] !== "" && isValidTooth(tooth)
  // Las caras son las de esa pieza, con los nombres del odontograma: una pieza anterior no tiene oclusal.
  const available = validTooth ? surfacesForTooth(tooth) : []
  const scope = service?.scope ?? null
  const bySite = scope === null || scope === "tooth" || scope === "surfaces"
  const withSurfaces = scope === "surfaces" || (scope === null && surfaces.length > 0)
  const candidates = candidatesOf(item)
  const pick = (chosen: Candidate | ServiceCatalogItem) => setService({ id: chosen.id, name: chosen.name, priceCents: chosen.priceCents, currency: chosen.currency, scope: chosen.scope ?? null })

  function submit(event: FormEvent) {
    event.preventDefault()
    setReview(null)
    const patch: Record<string, unknown> = {}
    if (plan) {
      if (service && service.id !== payload["serviceId"]) patch["serviceId"] = service.id
      if (bySite) patch["toothNumber"] = draft["toothNumber"] === "" ? null : tooth
      if (withSurfaces) {
        const kept = surfaces.filter((surface) => (available as string[]).includes(surface))
        patch["surfaces"] = kept.length ? kept : null
      }
      patch["detail"] = (draft["detail"] ?? "").trim() || null
    } else {
      for (const field of fields) {
        const value = (draft[field.key] ?? "").trim()
        patch[field.key] = value === "" ? null : field.number ? Number(value) : value
      }
    }
    session.save.mutate(
      { item, patch, confirm: true },
      {
        onSuccess: (result) => {
          if (result.confirmed) session.closeEdit()
          else setReview(result.item.note ?? "Todavía le falta algo para poder confirmarla.")
        },
      },
    )
  }

  return (
    <FormDrawer
      open
      title={title}
      description="Sugerencia del asistente"
      onClose={session.closeEdit}
      onSubmit={submit}
      isSubmitting={session.save.isPending}
      error={review ?? dictationErrorText(session.save.error, "No pude guardar esto. Revísalo y vuelve a intentarlo.")}
      submitLabel="Guardar y confirmar"
      submitDisabled={plan && !service}
    >
      <div className="flex flex-col gap-4">
        {item.sourceText ? (
          <div className="flex flex-col gap-1 rounded-xl border bg-muted/40 p-3 text-sm">
            <p className="font-semibold">Lo que dijiste</p>
            <p>«{item.sourceText}»</p>
          </div>
        ) : null}
        {item.status === "por_revisar" && item.note && !review ? <p className="text-sm">{item.note}</p> : null}

        {plan ? (
          <>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Prestación</p>
              <p className="text-sm">{service ? service.name : "Sin elegir"}</p>
              <p className="text-xs text-muted-foreground">
                {service ? `Precio del servicio: ${price(service.priceCents, service.currency)}. No se edita aquí.` : "El precio sale de la lista de servicios; no se edita aquí."}
              </p>
              {candidates.length > 0 ? (
                <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0" aria-label="Prestaciones parecidas">
                  {candidates.map((candidate) => (
                    <Button
                      key={candidate.id}
                      type="button"
                      variant={service?.id === candidate.id ? "default" : "outline"}
                      size="sm"
                      className="h-auto min-h-11 whitespace-normal"
                      aria-pressed={service?.id === candidate.id}
                      onClick={() => pick(candidate)}
                    >
                      {candidate.name} · {price(candidate.priceCents, candidate.currency)}
                    </Button>
                  ))}
                </fieldset>
              ) : null}
              <ServicePicker label="Buscar otra prestación" value={service?.id ?? ""} onChange={pick} />
            </div>
            {bySite ? (
              <Field>
                <FieldLabel htmlFor={`dictado-${item.id}-pieza`}>Pieza</FieldLabel>
                <Input
                  id={`dictado-${item.id}-pieza`}
                  className="w-24"
                  inputMode="numeric"
                  maxLength={2}
                  value={draft["toothNumber"] ?? ""}
                  aria-invalid={draft["toothNumber"] !== "" && !validTooth}
                  onChange={(event) => setDraft({ ...draft, toothNumber: event.target.value.replace(/\D/g, "").slice(0, 2) })}
                />
                <FieldDescription>Número FDI, por ejemplo 16.</FieldDescription>
              </Field>
            ) : (
              <p className="text-sm text-muted-foreground">Esta prestación no se indica por pieza.</p>
            )}
            {withSurfaces ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Superficies</span>
                {available.length > 0 ? (
                  <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0" aria-label={`Superficies de la pieza ${tooth}`}>
                    {available.map((surface) => {
                      const pressed = surfaces.includes(surface)
                      return (
                        <Button
                          key={surface}
                          type="button"
                          size="sm"
                          className="min-h-11"
                          variant={pressed ? "default" : "outline"}
                          aria-pressed={pressed}
                          onClick={() => setSurfaces(pressed ? surfaces.filter((entry) => entry !== surface) : [...surfaces, surface])}
                        >
                          {surfaceLabel(surface)}
                        </Button>
                      )
                    })}
                  </fieldset>
                ) : (
                  <p className="text-sm text-muted-foreground">Escribe la pieza para elegir sus superficies.</p>
                )}
              </div>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`dictado-${item.id}-detalle`}>Detalle</FieldLabel>
              <Textarea id={`dictado-${item.id}-detalle`} rows={3} maxLength={2000} placeholder="Opcional" value={draft["detail"] ?? ""} onChange={(event) => setDraft({ ...draft, detail: event.target.value })} />
            </Field>
          </>
        ) : (
          fields.map((field) => (
            <Field key={field.key}>
              <FieldLabel htmlFor={`dictado-${item.id}-${field.key}`}>{field.label}</FieldLabel>
              {field.long ? (
                <Textarea id={`dictado-${item.id}-${field.key}`} rows={3} value={draft[field.key] ?? ""} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} />
              ) : (
                <Input
                  id={`dictado-${item.id}-${field.key}`}
                  inputMode={field.number ? "numeric" : undefined}
                  value={draft[field.key] ?? ""}
                  onChange={(event) => setDraft({ ...draft, [field.key]: field.number ? event.target.value.replace(/\D/g, "").slice(0, 2) : event.target.value })}
                />
              )}
            </Field>
          ))
        )}

        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start text-destructive"
          disabled={session.save.isPending || session.act.isPending}
          onClick={() => session.act.mutate({ item, action: "discard" }, { onSuccess: session.closeEdit })}
        >
          Descartar sugerencia
        </Button>
      </div>
    </FormDrawer>
  )
}

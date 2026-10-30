import { formatMoney, VITAL_SIGNS } from "@odentia/clinical"
import { Badge, Button, Field, FieldLabel, Input, toast } from "@odentia/ui"
import { AgentMark, FormDrawer, SubmitButton, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { Check, CircleAlert, Mic, X } from "lucide-react"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { CLINICAL_NAME } from "../../lib/agent-names"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { openBookingAnywhere, useAppointmentSaved } from "../agenda/schedule-host"
import type { ServiceCatalogItem } from "../../lib/services"
import {
  DICTATION_KIND_LABEL,
  type DictationKind,
  dictationErrorText,
  type DictationSession,
  type DictationSuggestion,
  suggestionText,
} from "./dictation-session"
import { productUi } from "../../product/product-ui"
import { partNames } from "../../product/site-fields"
import { fetchMyProfessionalProfile } from "../../lib/encounters"
import { ProfessionalProfileDrawer } from "../professional-profile-drawer"
import { RecetasPanel } from "./clinical-panels"
import { NewMedicalLeaveDrawer } from "./medical-leave"
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
export function DictationBlockSuggestions({ session, kind, patientName }: { session: DictationSession; kind: DictationKind; patientName?: string }) {
  const items = session.suggestions.filter((item) => item.kind === kind)
  const removed = session.removedByVoice.filter((item) => item.kind === kind)
  const undo = session.undoRequests.filter((item) => item.kind === kind)
  if (!session.enabled || items.length + removed.length + undo.length === 0) return null
  // La receta dictada es una sola receta con sus medicamentos (issue 109, fase 2).
  if (kind === "receta") return <PrescriptionSuggestion session={session} items={items} />
  // El descanso dictado se emite con su formulario, ya lleno (latidIA, issue 229).
  if (kind === "descanso") return <MedicalLeaveSuggestion session={session} items={items} />
  const acting = (item: DictationSuggestion) => session.act.isPending && session.act.variables?.item.id === item.id
  // Lo que el producto agrega a una sugerencia sin terminar (odentIA: lo que la norma pide de un hallazgo).
  const Choices = productUi().dictation?.SuggestionChoices
  return (
    <div className="flex basis-full flex-col gap-2">
      <ul aria-label={`Sugerencias de ${CLINICAL_NAME}: ${DICTATION_KIND_LABEL[kind]}`} className="flex flex-col gap-2">
        {items.map((item) => {
          const { title, detail: summaryDetail } = suggestionText(item)
          const ready = item.status === "lista"
          const busy = acting(item) || session.confirmReady.isPending
          const candidates = candidatesOf(item)
          const choice = optionsOf(item).length > 0
          // Con caminos, las opciones se ven abajo: arriba basta con lo que se dijo.
          const detail = choice ? (item.sourceText ? `Dijiste «${item.sourceText}»` : "") : summaryDetail
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
                  {/* Lista, con algo por definir (la cara, la pieza): avisa sin impedir confirmarla. */}
                  {ready && item.note ? (
                    <span className="flex items-start gap-1.5 font-normal text-warning">
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {item.note}
                    </span>
                  ) : null}
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
                      {confirmWord(item)}
                    </SubmitButton>
                    <Button type="button" size="icon" className="size-11 sm:hidden" aria-label={`${confirmWord(item)}: ${title}`} disabled={busy} onClick={() => session.act.mutate({ item, action: "confirm" })}>
                      <Check className="size-4" aria-hidden />
                    </Button>
                  </>
                ) : null}
                {!session.dictating ? (
                  <Button type="button" variant="outline" size="sm" className="max-sm:hidden" disabled={busy} onClick={() => session.openEdit(item)}>
                    {/* Incompleta, se completa (la nota dice qué falta); lista, se edita. */}
                    {ready ? "Editar" : "Completar"}
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={`Descartar: ${title}`} disabled={busy} onClick={() => session.act.mutate({ item, action: "discard" })}>
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
              {choice ? <PlanChoices session={session} item={item} busy={busy} /> : null}
              {item.kind === "cita" ? <AppointmentChoices session={session} item={item} busy={busy} patientName={patientName} /> : null}
              {item.kind === "presupuesto" ? <BudgetLines item={item} /> : null}
              {item.kind === "alergia" && pendingOf(item).includes("severity") ? (
                // Qué tan fuerte fue: un aviso, no un requisito. Sin elegirla entra como «No se sabe».
                <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0 sm:pl-8" aria-label="Qué tan fuerte fue la reacción">
                  {ALLERGY_SEVERITIES.map((severity) => (
                    <Button
                      key={severity.value}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      disabled={busy || session.save.isPending}
                      onClick={() => session.save.mutate({ item, patch: { severity: severity.value }, confirm: false })}
                    >
                      {severity.label}
                    </Button>
                  ))}
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Mic className="size-3.5" aria-hidden />
                    o dila: «fue severa»
                  </span>
                </fieldset>
              ) : null}
              {(!ready && item.kind === "plan" && !choice) || (item.kind === "procedimiento" && item.payload["source"] === "libre" && candidates.length > 0) ? (
                <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0" aria-label={item.kind === "procedimiento" ? "Elige el servicio, si se cobra" : "Elige la prestación"}>
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
              {Choices ? <Choices session={session} item={item} busy={busy} /> : null}
              <ActError session={session} item={item} />
            </li>
          )
        })}
        {undo.map((item) => {
          const { title } = suggestionText(item)
          const what = UNDO_WORDS[item.kind] ?? "Quitar"
          const acting = session.act.isPending && session.act.variables?.item.id === item.id
          return (
            // «Quita la endodoncia» sobre algo ya confirmado: nunca se quita solo, se decide aquí.
            <li key={item.id} className="flex flex-col gap-2 rounded-xl border border-agent-border bg-background p-3 text-sm">
              <div className="flex flex-col gap-0.5">
                <p className="font-medium">
                  {what}: {title}
                </p>
                <p className="text-muted-foreground">Dijiste «{item.undoRequest?.said}». Ya la habías confirmado hoy.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <SubmitButton
                  type="button"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  pending={acting && session.act.variables?.action === "undo-confirmed"}
                  disabled={session.act.isPending}
                  onClick={() => session.act.mutate({ item, action: "undo-confirmed" }, { onSuccess: () => toast.success(`Se quitó: ${title}`) })}
                >
                  {what}
                </SubmitButton>
                <Button type="button" variant="secondary" size="sm" className="min-h-11 sm:min-h-8" disabled={session.act.isPending} onClick={() => session.act.mutate({ item, action: "keep" })}>
                  Dejarla
                </Button>
              </div>
              <ActError session={session} item={item} />
            </li>
          )
        })}
        {removed.map((item) => {
          const { title } = suggestionText(item)
          return (
            // Quitada por voz (issue 135): a la vista, tachada, hasta firmar; no cuenta como pendiente.
            <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              <Mic className="size-4 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1 basis-40">
                <p className="font-medium line-through">{title}</p>
                <p>Quitada por voz: dijiste «{item.removal?.said}»</p>
              </div>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="min-h-11 px-1 sm:min-h-8"
                disabled={session.act.isPending}
                onClick={() => session.act.mutate({ item, action: "undo-voice" }, { onSuccess: () => toast.success(`Volvió a tus sugerencias: ${title}`) })}
              >
                Deshacer
              </Button>
              <ActError session={session} item={item} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Cómo se dice quitar lo ya confirmado, según lo que es. */
const UNDO_WORDS: Partial<Record<DictationKind, string>> = {
  plan: "Quitar del plan",
  diagnostico: "Quitar el diagnóstico",
  control: "Quitar el control",
  alergia: "Quitar de sus alergias",
  procedimiento: "Anular el procedimiento",
  material: "Quitar el material",
}

/** Lo que hace confirmar, dicho como lo que es: reservar la cita, armar el presupuesto. */
function confirmWord(item: DictationSuggestion): string {
  if (item.kind === "cita") return item.payload["existing"] ? "Usar esa cita" : "Reservar"
  if (item.kind === "presupuesto") return "Armar"
  return "Confirmar"
}

/** Un hueco en la tarjeta: «Jue 12 · 10:00», en la zona de la clínica. */
function slotChip(startsAt: string): string {
  const at = new Date(startsAt)
  const zone = { timeZone: activeOrgTimeZone() }
  const day = at.toLocaleDateString(activeOrgLocale(), { ...zone, weekday: "short", day: "numeric" }).replace(".", "")
  const time = at.toLocaleTimeString(activeOrgLocale(), { ...zone, hour: "2-digit", minute: "2-digit", hour12: false })
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${time}`
}

/**
 * La próxima cita dictada (issue 109, paso 2): los huecos libres de quien
 * atiende cerca del día pedido, para tocar otro; «Otro horario…» abre «Nueva
 * cita» con lo dicho, y si se reserva ahí, la sugerencia ya no hace falta.
 */
export function AppointmentChoices({ session, item, busy, patientName }: { session: DictationSession; item: DictationSuggestion; busy: boolean; patientName?: string }) {
  const options = Array.isArray(item.payload["slots"]) ? (item.payload["slots"] as string[]) : []
  const chosen = typeof item.payload["startsAt"] === "string" ? item.payload["startsAt"] : null
  const disabled = busy || session.save.isPending
  // Reservada desde «Nueva cita» para este paciente: la que propuso Clío se descarta.
  useAppointmentSaved((appointment) => {
    if (appointment.patientId === session.patientId && item.status !== "confirmada") session.act.mutate({ item, action: "discard" })
  })
  if (item.payload["existing"]) return null
  const other = () =>
    openBookingAnywhere({
      ...(patientName ? { patient: { id: session.patientId, name: patientName } } : {}),
      lockedPatient: true,
      ...(typeof item.payload["serviceId"] === "string" ? { serviceId: item.payload["serviceId"] } : {}),
      ...(typeof item.payload["date"] === "string" ? { date: item.payload["date"] } : {}),
    })
  return (
    <div className="flex flex-col gap-2 sm:pl-8">
      {options.length > 1 ? <p className="text-muted-foreground">Tus huecos libres cerca de esa fecha. Toca otro si le queda mejor:</p> : null}
      <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0" aria-label="Otros horarios libres">
        {options.map((startsAt) => (
          <Button
            key={startsAt}
            type="button"
            variant={startsAt === chosen ? "default" : "outline"}
            size="sm"
            aria-pressed={startsAt === chosen}
            className="min-h-11 sm:min-h-8"
            disabled={disabled || startsAt === chosen}
            onClick={() => session.save.mutate({ item, patch: { startsAt }, confirm: false })}
          >
            {slotChip(startsAt)}
          </Button>
        ))}
        <Button type="button" variant="link" size="sm" className="min-h-11 px-1 sm:min-h-8" disabled={disabled} onClick={other}>
          Otro horario…
        </Button>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Mic className="size-3.5" aria-hidden />
          o dilo: «mejor en la tarde»
        </span>
      </fieldset>
      {chosen ? <p className="text-muted-foreground">Al reservar, {patientName ? patientName.split(" ")[0] : "la persona"} recibe el aviso de la cita, como cuando reserva recepción.</p> : null}
    </div>
  )
}

/** Lo que llevaría el presupuesto pedido: lo indicado hoy y lo dictado, que entra al plan al armarlo. */
export function BudgetLines({ item }: { item: DictationSuggestion }) {
  const lines = Array.isArray(item.payload["lines"])
    ? (item.payload["lines"] as Array<{ title: string; site: string; priceCents: number; currency: string; dictated: boolean }>)
    : []
  if (lines.length === 0) return null
  return (
    <div className="flex flex-col gap-2 sm:pl-8">
      <ul aria-label="Lo que lleva el presupuesto" className="flex flex-col gap-1.5">
        {lines.map((line) => (
          <li key={`${line.title}-${line.site}-${line.dictated}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-background px-3 py-2">
            <span className="min-w-0 flex-1">{[line.title, line.site].filter(Boolean).join(" · ")}</span>
            {line.dictated ? <Badge variant="secondary">dictada hoy: entra al plan</Badge> : <span className="text-xs text-muted-foreground">indicada hoy</span>}
            <span className="whitespace-nowrap font-semibold">{price(line.priceCents, line.currency)}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">«Armar» confirma las indicaciones dictadas que lleva y deja el presupuesto en borrador: todavía no le llega a nadie.</p>
    </div>
  )
}

/** Qué tan fuerte fue una alergia: los valores de «Nueva alergia», sin «No se sabe» (es lo que queda sin tocar). */
const ALLERGY_SEVERITIES = [
  { value: "leve", label: "Leve" },
  { value: "moderada", label: "Moderada" },
  { value: "severa", label: "Severa" },
] as const

/** Lo que aún le falta a una sugerencia (la pieza, la cara, qué tan fuerte fue). */
const pendingOf = (item: DictationSuggestion): string[] => (Array.isArray(item.payload["pending"]) ? (item.payload["pending"] as string[]) : [])

/**
 * Lo que no salió al confirmar, descartar o deshacer, dentro de su tarjeta. Si
 * la sugerencia cambió después (se completó o se corrigió), el error ya no
 * vale y no se muestra: nunca contradice lo que la tarjeta dice ahora.
 */
function ActError({ session, item }: { session: DictationSession; item: DictationSuggestion }) {
  const failed = session.act.variables?.item
  if (!session.act.isError || failed?.id !== item.id || failed.summary !== item.summary || failed.status !== item.status) return null
  return (
    <p role="alert" className="basis-full text-sm text-destructive">
      {dictationErrorText(session.act.error, "No pude guardar esto. Revísalo y vuelve a intentarlo.")}
    </p>
  )
}

interface PlanOption extends Partial<Candidate> {
  service?: string
  serviceId?: string
  serviceName?: string
  candidates?: Candidate[]
}

/** Los otros caminos de una indicación («resina, o si no una corona»): solo el plan los tiene. */
const optionsOf = (item: DictationSuggestion): PlanOption[] => (item.kind === "plan" && Array.isArray(item.payload["options"]) ? (item.payload["options"] as PlanOption[]) : [])

const LETTER = ["A", "B", "C"]

/**
 * «Pieza 46 · dos caminos, el paciente elige» (issue 109, fase 2): una fila por
 * camino con su prestación y su precio; tocar una la deja recomendada (la
 * opción A del presupuesto). Uno que no se ubicó en los servicios se elige con
 * un toque. Al confirmar, el presupuesto en borrador queda con estas opciones:
 * lo dice el aviso flotante, no la tarjeta.
 */
function PlanChoices({ session, item, busy }: { session: DictationSession; item: DictationSuggestion; busy: boolean }) {
  const main: PlanOption = {
    service: String(item.payload["service"] ?? ""),
    ...(typeof item.payload["serviceId"] === "string" ? { serviceId: item.payload["serviceId"], serviceName: String(item.payload["serviceName"] ?? ""), priceCents: Number(item.payload["priceCents"] ?? 0), currency: String(item.payload["currency"] ?? "") } : {}),
    candidates: candidatesOf(item),
  }
  const options = [main, ...optionsOf(item)]
  const save = (patch: Record<string, unknown>) => session.save.mutate({ item, patch, confirm: false })
  const disabled = busy || session.save.isPending
  // Otra elección ya ocupa el presupuesto: se ve lo dicho, sin nada que elegir (la nota dice qué hacer).
  const blocked = item.payload["choiceBlocked"] === true
  const resolved = options.every((option) => option.serviceId)
  return (
    <div className="flex flex-col gap-2 sm:pl-8">
      {resolved && !blocked ? <p className="text-muted-foreground">Toca la que recomiendas</p> : null}
      <ul className="flex flex-col gap-2" aria-label="Caminos para elegir">
        {options.map((option, index) => (
          <li key={LETTER[index]}>
            {option.serviceId ? (
              <button
                type="button"
                aria-pressed={index === 0}
                disabled={disabled || blocked || index === 0}
                onClick={() => save({ recommend: index })}
                className={`flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-background px-3 py-2 text-left disabled:cursor-default ${index === 0 ? "border-2 border-primary" : "border hover:border-primary/60"}`}
              >
                <span aria-hidden className={`size-4 shrink-0 rounded-full border-2 ${index === 0 ? "border-primary bg-primary shadow-[inset_0_0_0_3px_var(--background)]" : "border-muted-foreground"}`} />
                <span className="min-w-0 flex-1">{option.serviceName}</span>
                <span className="whitespace-nowrap font-semibold">{price(option.priceCents ?? 0, option.currency ?? "")}</span>
                {index === 0 ? <Badge variant="secondary">Recomendada</Badge> : null}
              </button>
            ) : blocked ? (
              <p className="rounded-lg border bg-background px-3 py-2 text-muted-foreground">Dijiste «{option.service}».</p>
            ) : (
              <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 rounded-lg border bg-background p-2 px-3" aria-label={`Elige la prestación del camino ${LETTER[index]}`}>
                <p className="w-full text-muted-foreground">Dijiste «{option.service}»: elige cuál es.</p>
                {(option.candidates ?? []).map((candidate) => (
                  <Button
                    key={candidate.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-auto min-h-11 max-w-full whitespace-normal text-left sm:min-h-8"
                    disabled={disabled}
                    onClick={() => save(index === 0 ? { serviceId: candidate.id } : { [`option${index}ServiceId`]: candidate.id })}
                  >
                    {candidate.name} · {price(candidate.priceCents, candidate.currency)}
                  </Button>
                ))}
              </fieldset>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Un medicamento dictado como lo pide «Emitir receta»: para abrir el formulario ya lleno. */
function medicationDraftOf(item: DictationSuggestion) {
  const text = (key: string) => (typeof item.payload[key] === "string" ? String(item.payload[key]) : "")
  return {
    genericName: text("genericName"),
    strength: text("strength"),
    dosageForm: text("dosageForm"),
    dose: text("dose"),
    route: text("route") || "oral",
    frequency: text("frequency"),
    duration: text("duration"),
    quantity: typeof item.payload["quantity"] === "number" ? String(item.payload["quantity"]) : "",
    instructions: text("instructions"),
  }
}

/**
 * La receta dictada (issue 109, fase 2): sus medicamentos en una sola
 * sugerencia, en el bloque Documentos. «Emitir receta» la emite con la
 * colegiatura de quien atiende, solo cuando está completa y sin aviso; si falta
 * algo o choca con una alergia, el formulario de siempre se abre ya lleno, con
 * «Cambiar medicamento» y «Recetar igual, con motivo». Nunca se emite con
 * «Confirmar las N listas».
 */
function PrescriptionSuggestion({ session, items }: { session: DictationSession; items: DictationSuggestion[] }) {
  const [form, setForm] = useState<null | { overriding: boolean }>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const queryClient = useQueryClient()
  // Se emite con la colegiatura de quien atiende: sin ella no se ofrece «Emitir receta».
  const profile = useQuery({ queryKey: ["professional-profile", "me"], queryFn: fetchMyProfessionalProfile })
  const licensed = profile.data?.data.complete !== false
  const warnings = items.flatMap((item) => (Array.isArray(item.payload["allergyWarnings"]) ? (item.payload["allergyWarnings"] as string[]) : []))
  const waiting = items.filter((item) => item.status !== "lista" && !(item.payload["allergyWarnings"] as string[] | undefined)?.length)
  const ready = warnings.length === 0 && waiting.length === 0
  const busy = session.issuePrescription.isPending || session.act.isPending || session.dictating
  const count = items.length === 1 ? "1 medicamento" : `${items.length} medicamentos`
  const voiced = items.find((item) => item.voice)
  return (
    <div className="flex basis-full flex-col gap-2">
      <ul aria-label={`Sugerencias de ${CLINICAL_NAME}: Receta`} className="flex flex-col gap-2">
        <li className={`flex flex-col gap-2 rounded-xl border p-3 text-sm ${warnings.length ? "border-destructive/40 bg-destructive/5" : "border-agent-border bg-agent-soft"}`}>
          <div className="flex flex-wrap items-center gap-2">
            {ready ? (
              <AgentMark size="sm" />
            ) : (
              <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-warning-soft text-warning">
                <CircleAlert className="size-3.5" />
              </span>
            )}
            <div className="min-w-0 flex-1 basis-40 px-2">
              <p className="font-medium">Receta · {count}</p>
              <p className="text-muted-foreground">
                {warnings.length
                  ? "Aviso de alergia: resuélvelo antes de emitir."
                  : waiting.length
                    ? (waiting[0]?.note ?? "Falta completarla.")
                    : voiced?.voice
                      ? `${String(voiced.payload["genericName"] ?? "medicamento").replace(/^./, (first) => first.toLocaleUpperCase(activeOrgLocale()))} corregido por voz, antes ${voiced.voice.before}`
                      : licensed
                        ? "Lista para emitir con tu colegiatura."
                        : "Para emitirla falta tu colegiatura."}
              </p>
            </div>
            {warnings.length ? <Badge variant="destructive">Aviso de alergia</Badge> : !ready ? <Badge>Por revisar</Badge> : null}
            {voiced ? (
              <Button type="button" variant="link" size="sm" className="min-h-11 px-1 sm:min-h-8" disabled={busy} onClick={() => session.act.mutate({ item: voiced, action: "undo-voice" })}>
                Deshacer
              </Button>
            ) : null}
            {ready && licensed ? (
              <SubmitButton type="button" size="sm" className="min-h-11 sm:min-h-8" pending={session.issuePrescription.isPending} disabled={busy} onClick={() => session.issuePrescription.mutate()}>
                Emitir receta
              </SubmitButton>
            ) : ready ? (
              <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setProfileOpen(true)}>
                Completar perfil
              </Button>
            ) : null}
            {profileOpen ? (
              <ProfessionalProfileDrawer
                open
                target="me"
                profile={profile.data?.data ?? null}
                onClose={() => setProfileOpen(false)}
                onSaved={() => {
                  void queryClient.invalidateQueries({ queryKey: ["professional-profile", "me"] })
                  void queryClient.invalidateQueries({ queryKey: ["encounter-closing"] })
                }}
              />
            ) : null}
            {!warnings.length ? (
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={busy} onClick={() => setForm({ overriding: false })}>
                {ready ? "Editar" : "Completar"}
              </Button>
            ) : null}
          </div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 sm:pl-8">
            {items.map((item) => {
              const { title, detail } = suggestionText(item)
              return (
                <li key={item.id} className="flex flex-wrap items-start gap-2 rounded-lg border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{title}</p>
                    {detail ? <p className="text-muted-foreground">{detail}</p> : null}
                    {waiting.includes(item) && item.note ? <p className="text-xs text-warning">{item.note}</p> : null}
                    {item.payload["routeImplied"] ? <p className="text-xs text-muted-foreground">Vía oral por ser {String(item.payload["dosageForm"] ?? "").toLowerCase()}.</p> : null}
                    {item.payload["notInList"] ? <p className="text-xs text-muted-foreground">No está en la lista: no se revisan sus alergias.</p> : null}
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={`Quitar de la receta: ${title}`} disabled={busy} onClick={() => session.act.mutate({ item, action: "discard" })}>
                    <X className="size-4" aria-hidden />
                  </Button>
                </li>
              )
            })}
          </ul>
          {warnings.length ? (
            <div role="alert" className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 sm:ml-8">
              <p className="font-medium">Aviso de alergia</p>
              <ul className="list-disc pl-5">
                {warnings.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={busy} onClick={() => setForm({ overriding: false })}>
                  Cambiar medicamento
                </Button>
                <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={busy} onClick={() => setForm({ overriding: true })}>
                  Recetar igual, con motivo
                </Button>
              </div>
              <p className="text-muted-foreground">O dilo: «mejor clindamicina de trescientos cada ocho horas».</p>
            </div>
          ) : null}
        </li>
      </ul>
      {session.issuePrescription.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {dictationErrorText(session.issuePrescription.error, "No pude emitir la receta. Revísala y vuelve a intentarlo.")}
        </p>
      ) : null}
      {form ? (
        <RecetasPanel
          patientId={session.patientId}
          encounterId={session.encounterId}
          encounterOnly
          drawerOnly
          createOpen
          initialMedications={items.map(medicationDraftOf)}
          startOverriding={form.overriding}
          onIssued={(prescriptionId) => session.settlePrescription.mutate(prescriptionId)}
          onCreateOpenChange={(open) => {
            if (!open) setForm(null)
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * El descanso médico dictado (latidIA, issue 229): «Emitir descanso» abre el
 * formulario de siempre ya lleno con los días y desde cuándo, porque emitirlo
 * es firmarlo y ahí la persona decide si su diagnóstico figura. Nunca se emite
 * con «Confirmar las N listas».
 */
function MedicalLeaveSuggestion({ session, items }: { session: DictationSession; items: DictationSuggestion[] }) {
  const [open, setOpen] = useState(false)
  const item = items[0]
  if (!item) return null
  const { title, detail } = suggestionText(item)
  const busy = session.act.isPending || session.settleMedicalLeave.isPending || session.dictating
  const days = typeof item.payload["days"] === "number" ? item.payload["days"] : null
  const startsOn = typeof item.payload["startsOn"] === "string" ? item.payload["startsOn"] : null
  const ready = item.status === "lista"
  return (
    <div className="flex basis-full flex-col gap-2">
      <ul aria-label={`Sugerencias de ${CLINICAL_NAME}: Descanso médico`} className="flex flex-col gap-2">
        <li className="flex flex-col gap-2 rounded-xl border border-agent-border bg-agent-soft p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {ready ? (
              <AgentMark size="sm" />
            ) : (
              <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-warning-soft text-warning">
                <CircleAlert className="size-3.5" />
              </span>
            )}
            <div className="min-w-0 flex-1 basis-40 px-2">
              <p className="font-medium">Descanso médico · {title}</p>
              <p className="text-muted-foreground">{ready ? (detail || "Listo para emitir con tu firma.") : (item.note ?? detail)}</p>
            </div>
            {!ready ? <Badge>Por revisar</Badge> : null}
            <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={busy} onClick={() => setOpen(true)}>
              Emitir descanso
            </Button>
            <Button type="button" variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={`Descartar: Descanso médico · ${title}`} disabled={busy} onClick={() => session.act.mutate({ item, action: "discard" })}>
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        </li>
      </ul>
      {session.settleMedicalLeave.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {dictationErrorText(session.settleMedicalLeave.error, "El descanso se emitió, pero no pude marcar la sugerencia. Descártala.")}
        </p>
      ) : null}
      {open ? (
        <NewMedicalLeaveDrawer
          open
          patientId={session.patientId}
          encounterId={session.encounterId}
          {...(days ? { defaultDays: days } : {})}
          {...(startsOn ? { defaultStartsOn: startsOn } : {})}
          onClose={() => setOpen(false)}
          onCreated={(leave) => {
            setOpen(false)
            session.settleMedicalLeave.mutate(leave.id)
          }}
        />
      ) : null}
    </div>
  )
}

interface EditableField {
  key: string
  label: string
  long?: boolean
  number?: boolean
  /** Una medida con decimales (la temperatura, el peso). */
  decimal?: boolean
  /** Largo máximo del texto: el mismo que el campo de su operación (`OPERATIONS` en services). */
  max?: number
  /** Rango de un número: el mismo que el campo de su operación. */
  min?: number
  top?: number
}

/** Campos que el profesional corrige a mano en una sugerencia que no es del plan, con su rótulo. */
const EDITABLE: Record<Exclude<DictationKind, "plan" | "procedimiento">, EditableField[]> = {
  nota: [
    { key: "reason", label: "Motivo de consulta", long: true, max: 2000 },
    { key: "presentIllness", label: "Enfermedad actual", long: true, max: 4000 },
    { key: "illnessDuration", label: "Tiempo de enfermedad", max: 200 },
    { key: "evolution", label: "Evolución", long: true, max: 10_000 },
    { key: "indications", label: "Indicaciones", long: true, max: 4000 },
    { key: "prognosis", label: "Pronóstico", max: 2000 },
  ],
  diagnostico: [
    { key: "diagnosisCode", label: "Código", max: 10 },
    { key: "toothNumber", label: "Pieza", number: true },
    { key: "note", label: "Nota", long: true, max: 2000 },
  ],
  control: [
    { key: "title", label: "Control", max: 200 },
    { key: "instructions", label: "Indicaciones", long: true, max: 2000 },
  ],
  // El hallazgo, su variante y su estado se eligen en la tarjeta; aquí, la pieza y una nota.
  odontograma: [
    { key: "toothNumber", label: "Pieza", number: true },
    { key: "note", label: "Nota", long: true, max: 2000 },
  ],
  // La receta se completa en el formulario de siempre, «Emitir receta», ya lleno.
  receta: [],
  // Los signos vitales dictados, cada uno con su unidad (latidIA, issue 229).
  signos: VITAL_SIGNS.map((sign) => ({ key: sign.key, label: `${sign.label} (${sign.suffix})`, decimal: true, min: sign.min, top: sign.max })),
  // El sistema se ve en el título; aquí, lo que se encontró. Sin texto queda «Sin alteraciones».
  examen: [{ key: "finding", label: "Hallazgo", long: true, max: 1000 }],
  // El descanso se completa en su formulario, «Emitir descanso», ya lleno.
  descanso: [],
  // El día y la hora pedidos: se vuelve a buscar el hueco libre más cercano. Otro profesional o sede, en «Otro horario…».
  cita: [
    { key: "date", label: "Día (AAAA-MM-DD)", max: 10 },
    { key: "time", label: "Hora (HH:MM, opcional)", max: 5 },
  ],
  // Lleva lo indicado en la atención: no hay nada que escribir, se arma o se descarta.
  presupuesto: [],
  // La sustancia como se dijo, lo que le pasó y qué tan fuerte fue (leve, moderada o severa).
  alergia: [
    { key: "substance", label: "Sustancia", max: 200 },
    { key: "reaction", label: "Qué le pasó", long: true, max: 2000 },
  ],
  // El material se busca otra vez en Inventario por su nombre; la cantidad es el total, no se suma.
  material: [
    { key: "product", label: "Material", max: 200 },
    { key: "quantity", label: "Cuántos en total", number: true, min: 1 },
  ],
}

/** Lo que no pasa el esquema de la operación, dicho en el campo (los mismos límites que `OPERATIONS`). */
function fieldError(field: EditableField, raw: string, validTooth: (value: string) => boolean): string | null {
  const value = raw.trim()
  if (value === "") return null
  if (field.key === "toothNumber") return validTooth(value) ? null : "Escribe una pieza en numeración FDI, del 11 al 85 (por ejemplo, 16)."
  if (field.max !== undefined && value.length > field.max) return `Escribe como mucho ${field.max} caracteres.`
  if (field.key === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Escribe el día como AAAA-MM-DD (por ejemplo, 2026-11-05)."
  if (field.key === "time" && !/^\d{2}:\d{2}$/.test(value)) return "Escribe la hora como HH:MM (por ejemplo, 16:00)."
  if (field.number || field.decimal) {
    const number = Number(value)
    if (!Number.isFinite(number)) return "Escribe un número."
    if (field.min !== undefined && number < field.min) return `Escribe al menos ${field.min}.`
    if (field.top !== undefined && number > field.top) return `Escribe como mucho ${field.top}.`
  }
  return null
}

/** Lo que se corrige de una sugerencia: lo que trae y, de la presión, las dos partes. */
function fieldsOf(item: DictationSuggestion): EditableField[] {
  if (item.kind === "plan" || item.kind === "procedimiento") return []
  // «No tiene alergias» no tiene nada que escribir: se confirma o se descarta.
  if (item.kind === "alergia" && item.payload["none"] === true) return []
  const all = EDITABLE[item.kind]
  if (item.kind === "nota") return all.filter((field) => item.payload[field.key] !== undefined)
  if (item.kind === "signos") {
    const pressure = item.payload["presionSistolica"] !== undefined || item.payload["presionDiastolica"] !== undefined
    return all.filter((field) => item.payload[field.key] !== undefined || (pressure && field.key.startsWith("presion")))
  }
  // Sin «dónde» (latidIA) no hay pieza que corregir.
  return all.filter((field) => field.key !== "toothNumber" || Boolean(productUi().site))
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

interface EditValues {
  draft: Record<string, string>
  service: Candidate | null
  surfaces: string[]
}

/** Cómo se llama en el formulario un dato que el servidor señala por su nombre en el PATCH. */
function editFieldName(serverField: string): string {
  const key = serverField.split(/[.[]/)[0] ?? serverField
  if (key === "serviceId") return "service"
  if (key === "surfaces") return "surfaces"
  return `draft.${key}`
}

const TOOTH_MESSAGE = "Escribe una pieza en numeración FDI, del 11 al 85 (por ejemplo, 16)."

function EditForm({ item, session }: { item: DictationSuggestion; session: DictationSession }) {
  const payload = item.payload
  const kind = item.kind
  // Lo hecho hoy se corrige como una indicación: el servicio, la pieza y las caras.
  const plan = kind === "plan" || kind === "procedimiento"
  const done = kind === "procedimiento"
  const fields = fieldsOf(item)
  const [review, setReview] = useState<string | null>(null)
  const { title } = suggestionText(item)
  const site = productUi().site
  const isTooth = (value: string) => value !== "" && (site?.isPlace(Number(value)) ?? false)
  const layout = (values: EditValues) => {
    const tooth = Number(values.draft["toothNumber"])
    // Las caras son las de esa pieza, con los nombres del odontograma: una pieza anterior no tiene oclusal.
    const available = isTooth(values.draft["toothNumber"] ?? "") ? (site?.partsOf(tooth) ?? []) : []
    const scope = values.service?.scope ?? null
    // Sin «dónde» en el producto (latidIA), una indicación no lleva pieza ni caras.
    const bySite = Boolean(site) && (scope === null || scope === "tooth" || scope === "surfaces")
    const withSurfaces = Boolean(site) && (scope === "surfaces" || (scope === null && values.surfaces.length > 0))
    return { tooth, available, bySite, withSurfaces }
  }

  const defaultValues: EditValues = {
    draft: Object.fromEntries([...fields.map((field) => field.key), "toothNumber", "detail"].map((key) => [key, payload[key] == null ? "" : String(payload[key])])),
    service:
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
    surfaces: Array.isArray(payload["surfaces"]) ? (payload["surfaces"] as string[]) : [],
  }

  const form = useAppForm({
    defaultValues,
    validators: {
      onSubmit: ({ value }) => {
        const errors: Record<string, string> = {}
        if (plan) {
          if (!done && !value.service) errors["service"] = "Elige la prestación."
          const tooth = value.draft["toothNumber"] ?? ""
          if (layout(value).bySite && tooth !== "" && !isTooth(tooth)) errors["draft.toothNumber"] = TOOTH_MESSAGE
          if (!done && (value.draft["detail"] ?? "").trim().length > 2000) errors["draft.detail"] = "Escribe como mucho 2000 caracteres."
        } else {
          for (const field of fields) {
            const message = fieldError(field, value.draft[field.key] ?? "", isTooth)
            if (message) errors[`draft.${field.key}`] = message
          }
        }
        return Object.keys(errors).length > 0 ? { fields: errors } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const { tooth, available, bySite, withSurfaces } = layout(value)
      const { draft, service, surfaces } = value
      const patch: Record<string, unknown> = {}
      if (plan) {
        if (service && service.id !== payload["serviceId"]) patch["serviceId"] = service.id
        if (bySite) patch["toothNumber"] = draft["toothNumber"] === "" ? null : tooth
        if (withSurfaces) {
          const kept = surfaces.filter((surface) => (available as string[]).includes(surface))
          patch["surfaces"] = kept.length ? kept : null
        }
        if (!done) patch["detail"] = (draft["detail"] ?? "").trim() || null
      } else {
        for (const field of fields) {
          const text = (draft[field.key] ?? "").trim()
          patch[field.key] = text === "" ? null : field.number || field.decimal ? Number(text) : text
        }
        // Con un hallazgo escrito, el sistema queda con hallazgos; sin texto, sin alteraciones.
        if (kind === "examen") patch["state"] = patch["finding"] ? "con_hallazgos" : "sin_alteraciones"
      }
      const result = await session.save.mutateAsync({ item, patch, confirm: true })
      if (result.confirmed) session.closeEdit()
      else setReview(result.item.note ?? "Todavía le falta algo para poder confirmarla.")
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: editFieldName,
    formMessage: (error) => dictationErrorText(error, "No pude guardar esto. Revísalo y vuelve a intentarlo."),
  })
  const values = useStore(form.store, (state) => state.values)
  const { tooth, available, bySite, withSurfaces } = layout(values)
  const service = values.service
  const candidates = candidatesOf(item)
  const pick = (chosen: Candidate | ServiceCatalogItem) =>
    form.setFieldValue("service", { id: chosen.id, name: chosen.name, priceCents: chosen.priceCents, currency: chosen.currency, scope: chosen.scope ?? null })

  return (
    <FormDrawer
      {...surface}
      onSubmit={(event) => {
        setReview(null)
        surface.onSubmit(event)
      }}
      open
      title={title}
      description={`Sugerencia de ${CLINICAL_NAME}`}
      onClose={session.closeEdit}
      error={review ?? surface.error}
      submitLabel="Guardar y confirmar"
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
            <form.AppField name="service">
              {(field) => (
                <field.Group
                  id={`dictado-${item.id}-servicio`}
                  legend="Prestación"
                  description={service ? `Precio del servicio: ${price(service.priceCents, service.currency)}. No se edita aquí.` : "El precio sale de la lista de servicios; no se edita aquí."}
                >
                  {(control) => (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm">{service ? service.name : "Sin elegir"}</p>
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
                      <Field data-invalid={control.invalid || undefined}>
                        <FieldLabel htmlFor={control.id}>Buscar otra prestación</FieldLabel>
                        <ServicePicker
                          id={control.id}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                          value={service?.id ?? ""}
                          onChange={pick}
                        />
                      </Field>
                    </div>
                  )}
                </field.Group>
              )}
            </form.AppField>
            {bySite ? (
              <form.AppField name="draft.toothNumber">
                {(field) => (
                  <field.Control id={`dictado-${item.id}-pieza`} label="Pieza" description="Número FDI, por ejemplo 16.">
                    {(control) => (
                      <Input
                        {...control.props}
                        className="w-24"
                        inputMode="numeric"
                        maxLength={2}
                        value={field.state.value ?? ""}
                        onChange={(event) => field.handleChange(event.target.value.replace(/\D/g, "").slice(0, 2))}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
            ) : site ? (
              <p className="text-sm text-muted-foreground">Esta prestación no se indica por pieza.</p>
            ) : null}
            {withSurfaces ? (
              <form.AppField name="surfaces">
                {(field) => (
                  <field.Group legend="Superficies">
                    {(control) =>
                      available.length > 0 ? (
                        <fieldset
                          className="flex min-w-0 flex-wrap gap-1.5"
                          aria-label={`Superficies de la pieza ${tooth}`}
                          aria-invalid={control.props["aria-invalid"]}
                          aria-describedby={control.describedBy}
                        >
                          {available.map((part) => {
                            const pressed = field.state.value.includes(part)
                            return (
                              <Button
                                key={part}
                                type="button"
                                size="sm"
                                className="min-h-11"
                                variant={pressed ? "default" : "outline"}
                                aria-pressed={pressed}
                                onBlur={control.onBlur}
                                onClick={() => field.handleChange(pressed ? field.state.value.filter((entry) => entry !== part) : [...field.state.value, part])}
                              >
                                {partNames([part])}
                              </Button>
                            )
                          })}
                        </fieldset>
                      ) : (
                        <p className="text-sm text-muted-foreground">Escribe la pieza para elegir sus superficies.</p>
                      )
                    }
                  </field.Group>
                )}
              </form.AppField>
            ) : null}
            {done ? null : (
              <form.AppField name="draft.detail">
                {(field) => <field.TextareaField id={`dictado-${item.id}-detalle`} label="Detalle" rows={3} maxLength={2000} placeholder="Opcional" />}
              </form.AppField>
            )}
          </>
        ) : (
          fields.map((editable) => (
            <form.AppField key={editable.key} name={`draft.${editable.key}`}>
              {(field) =>
                editable.long ? (
                  <field.TextareaField id={`dictado-${item.id}-${editable.key}`} label={editable.label} rows={3} maxLength={editable.max} />
                ) : (
                  <field.Control id={`dictado-${item.id}-${editable.key}`} label={editable.label}>
                    {(control) => (
                      <Input
                        {...control.props}
                        inputMode={editable.number ? "numeric" : editable.decimal ? "decimal" : undefined}
                        maxLength={editable.max}
                        value={field.state.value ?? ""}
                        onChange={(event) =>
                          field.handleChange(
                            editable.number
                              ? event.target.value.replace(/\D/g, "").slice(0, 2)
                              : editable.decimal
                                ? event.target.value.replace(",", ".").replace(/[^\d.]/g, "").slice(0, 6)
                                : event.target.value,
                          )
                        }
                      />
                    )}
                  </field.Control>
                )
              }
            </form.AppField>
          ))
        )}

        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start text-destructive"
          disabled={surface.isSubmitting || session.act.isPending}
          onClick={() => session.act.mutate({ item, action: "discard" }, { onSuccess: session.closeEdit })}
        >
          Descartar sugerencia
        </Button>
      </div>
    </FormDrawer>
  )
}

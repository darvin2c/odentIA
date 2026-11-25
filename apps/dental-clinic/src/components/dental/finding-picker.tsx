import { FINDINGS } from "@odentia/dental"
import { Button, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@odentia/ui"
import { common, EmptyState } from "@odentia/ui-patterns"
import { Search, SearchX, X } from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { foundBySaying, searchFindings } from "./finding-search"
import { useOdontogramNotation } from "./odontogram-notation"
import { ToothSVG } from "./tooth-svg"

// Ejemplos exclusivamente visuales: solo el código elegido sale del selector.
const examples = FINDINGS.map((finding) => ({
  finding,
  entries: [
    {
      id: `catalog-${finding.code}`,
      toothNumber: 36,
      condition: finding.code,
      status: "recorded" as const,
      surface: finding.scope === "surface" ? "occlusal" : undefined,
      details: {
        ...(finding.color === "quality" ? { quality: "good" as const } : {}),
        ...(finding.variants?.[0] ? { variant: finding.variants[0].value } : {}),
        ...(finding.requiresDrawing
          ? {
              drawing: [
                [
                  [30, 25],
                  [55, 45],
                  [40, 65],
                ],
              ],
            }
          : {}),
      },
    },
  ],
}))

/**
 * Lo que cuenta el paciente no se dibuja: va en el motivo (reglas clínicas del 18 nov). Aparece
 * mientras se escribe, así que se anuncia (`role="status"`), como el recuadro del diagnóstico o
 * del tratamiento (`FindingElsewhere`).
 */
export function FindingReasonNotice({
  reason,
  onReason,
}: {
  reason: string
  onReason?: () => void
}) {
  return (
    <div role="status" className="flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-sm">{reason} es el motivo de consulta.</p>
      {onReason ? (
        <Button type="button" variant="outline" className="min-h-11 self-start" onClick={onReason}>
          Ir al motivo
        </Button>
      ) : null}
    </div>
  )
}

/**
 * El orden de lo que se ofrece para lo escrito: primero las tarjetas de hallazgo, después lo que
 * responde de otro lado (el tratamiento para el plan o el diagnóstico, `other`) tras «Si falta
 * hacerlo:», y el motivo de consulta al final. Sin tarjetas, como antes: el motivo solo, lo de otro
 * lado solo y, sin nada, «Sin resultados». En la mesa del 23 nov, con el tratamiento primero
 * («perno», «endodoncia»), dos voces casi agregaron al plan lo que la pieza ya tenía hecho.
 */
export function findingPickerBlocks(input: {
  reason: boolean
  cards: boolean
  other: boolean
}): ("reason" | "other" | "cards" | "empty")[] {
  if (!input.cards) return input.reason ? ["reason"] : input.other ? ["other"] : ["empty"]
  return [
    "cards",
    ...(input.other ? (["other"] as const) : []),
    ...(input.reason ? (["reason"] as const) : []),
  ]
}

export function FindingPicker({
  value,
  onChange,
  disabled = false,
  autoFocus = false,
  elsewhere,
  onReason,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** Al aparecer, el foco va al buscador (la pieza abierta al lado de la página). */
  autoFocus?: boolean
  /**
   * Lo escrito que no es un hallazgo: un diagnóstico o un tratamiento, con su botón
   * (`FindingElsewhere`). `diagnoses` dice si ningún hallazgo coincide. Sin él, «Sin resultados».
   */
  elsewhere?: (search: { query: string; diagnoses: boolean }) => ReactNode
  /** «El dolor es el motivo de consulta»: lleva al motivo y lo enfoca. Sin él, solo se dice. */
  onReason?: () => void
}) {
  const id = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al aparecer, no en cada cambio.
  useEffect(() => {
    if (autoFocus) searchRef.current?.focus({ preventScroll: true })
  }, [])
  const official = useOdontogramNotation()
  const [search, setSearch] = useState("")
  // Por su nombre, sus variantes y cómo se dice («resina», «funda», «resto radicular»).
  const found = searchFindings(search)
  const order = new Map(found.findings.map((finding, index) => [finding.code, index]))
  const visible = examples
    .filter(({ finding }) => order.has(finding.code))
    .sort((a, b) => (order.get(a.finding.code) ?? 0) - (order.get(b.finding.code) ?? 0))
  const other =
    found.elsewhere && elsewhere
      ? elsewhere({ query: search, diagnoses: visible.length === 0 })
      : null
  const chosen = value ? FINDINGS.find((finding) => finding.code === value) : undefined
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      <legend className="text-sm font-medium">¿Qué observas?</legend>
      <p className="text-xs text-muted-foreground">
        Registra la situación actual, incluidos tratamientos existentes. Lo que propones hacer se
        indica después en el plan.
      </p>
      <label htmlFor={id} className="sr-only">
        Buscar hallazgo
      </label>
      <InputGroup className="h-11">
        <InputGroupAddon align="inline-start">
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchRef}
          id={id}
          type="search"
          // Un solo «×»: el «Limpiar» propio, no también el del navegador (QA de diseño, H15).
          className="[&::-webkit-search-cancel-button]:appearance-none"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar caries, corona, fractura…"
        />
        <InputGroupAddon align="inline-end">
          {search ? (
            <InputGroupButton
              size="icon-xs"
              aria-label={common.filters.clear}
              onClick={() => setSearch("")}
            >
              <X aria-hidden />
            </InputGroupButton>
          ) : null}
        </InputGroupAddon>
      </InputGroup>
      {/* Elegido por error al volver con «Cambiar hallazgo»: se quita sin elegir otro (H4). */}
      {value && chosen ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 self-start"
          onClick={() => onChange("")}
        >
          Quitar «{chosen.label}»
        </Button>
      ) : null}
      {/* Primero las tarjetas (mesa del 23 nov): con «endodoncia», la del tratamiento de conducto que
          ya tiene y después, tras «Si falta hacerlo:», agregarla al plan; con «caries dolorosa», la
          caries y después el motivo. */}
      {findingPickerBlocks({
        reason: !!found.reason,
        cards: visible.length > 0,
        other: !!other,
      }).map((block) =>
        block === "reason" && found.reason ? (
          <FindingReasonNotice key="reason" reason={found.reason} onReason={onReason} />
        ) : block === "other" ? (
          // Sin tratamiento que ofrecer («girado», «retenida»), el bloque no queda con su rótulo solo.
          <div key="other" className="flex flex-col gap-3 has-[>[data-other]:empty]:hidden">
            {visible.length > 0 ? (
              <p className="text-xs text-muted-foreground">Si falta hacerlo:</p>
            ) : null}
            <div data-other="" className="contents">
              {other}
            </div>
          </div>
        ) : block === "empty" ? (
          <EmptyState
            key="empty"
            icon={SearchX}
            title={common.filters.noResults}
            description="Ningún hallazgo coincide con la búsqueda. Prueba otro nombre."
            className="p-6"
          />
        ) : block === "cards" ? (
          <div key="cards" className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2">
            {visible.map(({ finding, entries }) => (
              <div key={finding.code} className="relative">
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={value === finding.code}
                  onClick={() => onChange(finding.code)}
                  className={`flex min-h-36 w-full flex-col items-center justify-end gap-1 rounded-lg border px-2 pb-3 pt-24 text-center text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50 ${value === finding.code ? "border-primary bg-primary/10 ring-1 ring-primary" : "bg-background hover:bg-muted"}`}
                >
                  {finding.label}
                  {/* «perno» trajo el «Espigo-muñón»: la tarjeta dice que es lo que se buscó. */}
                  {foundBySaying(finding.code, search) ? (
                    <span className="text-muted-foreground">({search.trim()})</span>
                  ) : null}
                  {value === finding.code && <span className="font-semibold">Seleccionado</span>}
                </button>
                <div
                  inert
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-2 flex h-20 justify-center overflow-hidden [&_button]:h-full [&_svg]:h-full [&_svg]:w-auto"
                >
                  <ToothSVG toothNumber={36} entries={entries} size="preview" showRoots disabled />
                </div>
              </div>
            ))}
          </div>
        ) : null,
      )}
      <p className="text-xs text-muted-foreground">
        {official ? `Simbología ${official.shortName}. ` : ""}Imágenes ilustrativas: el estado, el
        detalle y las superficies se eligen a continuación.
      </p>
    </fieldset>
  )
}

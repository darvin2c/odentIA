import { FINDINGS } from "@odentia/dental"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@odentia/ui"
import { common, EmptyState, normalizeSearchText } from "@odentia/ui-patterns"
import { Search, SearchX, X } from "lucide-react"
import { useId, useState } from "react"
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

export function FindingPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const id = useId()
  const official = useOdontogramNotation()
  const [search, setSearch] = useState("")
  const query = normalizeSearchText(search.trim())
  const visible = examples.filter(({ finding }) =>
    normalizeSearchText(finding.label).includes(query),
  )
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
          id={id}
          type="search"
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
      {visible.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={common.filters.noResults}
          description="Ningún hallazgo coincide con la búsqueda. Prueba otro nombre."
          className="p-6"
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2">
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
      )}
      <p className="text-xs text-muted-foreground">
        {official ? `Simbología ${official.shortName}. ` : ""}Imágenes ilustrativas: el estado, el
        detalle y las superficies se eligen a continuación.
      </p>
    </fieldset>
  )
}

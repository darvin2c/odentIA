import { cn } from "@odentia/ui"
import type { AreaNavEntry, PatientSectionId } from "../../lib/patient-areas"

/**
 * Las secciones de una pestaña en un menú lateral, con sus grupos
 * («Sus datos y la ley») y un número cuando algo espera (lienzo del lote 2,
 * ADR 0080). Solo desde tablet: en el celular manda el selector «Sección».
 */
export function SectionSideNav({
  label,
  entries,
  current,
  badges = {},
  onOpen,
}: {
  label: string
  entries: AreaNavEntry[]
  current: PatientSectionId
  badges?: Partial<Record<PatientSectionId, number>>
  onOpen: (section: PatientSectionId) => void
}) {
  const groups: Array<{ title: string | null; items: AreaNavEntry[] }> = []
  for (const entry of entries) {
    const title = entry.group ?? null
    const last = groups[groups.length - 1]
    if (last && last.title === title) last.items.push(entry)
    else groups.push({ title, items: [entry] })
  }
  return (
    <nav aria-label={label} className="hidden shrink-0 flex-col gap-0.5 sm:flex sm:w-44 lg:w-52">
      {groups.map((group) => (
        <div key={group.title ?? "secciones"} className="flex flex-col gap-0.5">
          {group.title ? (
            <p className="mt-3 mb-1 px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{group.title}</p>
          ) : null}
          {group.items.map((item) => {
            const active = item.value === current
            const badge = badges[item.value]
            return (
              <button
                key={item.value}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onOpen(item.value)}
                className={cn(
                  "flex min-h-9 items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                  active ? "bg-secondary font-semibold text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <span>{item.label}</span>
                {badge ? (
                  <span className="rounded-full bg-warning-soft px-2 text-xs font-semibold text-warning">
                    {badge}
                    <span className="sr-only"> pendiente{badge === 1 ? "" : "s"}</span>
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

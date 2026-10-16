import { Link } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"
import type { KnowledgeSources as Sources } from "./knowledge-model"

function plural(total: number, one: string, many: string): string {
  return total === 1 ? `1 ${one}` : `${total} ${many}`
}

/**
 * «Lo que toma de tus datos»: lo que el agente lee del sistema en el momento,
 * con cuánto hay y dónde se edita. La cifra sale de `/api/agent/knowledge/sources`;
 * mientras no llega, la fila se muestra sin ella.
 */
export function KnowledgeSources({ sources }: { sources: Sources | null }) {
  const rows = [
    {
      to: "/services",
      title: "Servicios y precios",
      detail: sources
        ? sources.pricedServices === 0
          ? "Ningún precio que el agente pueda decir todavía"
          : plural(sources.pricedServices, "servicio con precio que dice el agente", "servicios con precio que dice el agente")
        : null,
      action: "Se editan en Servicios",
    },
    {
      to: "/settings/branches",
      title: "Sedes y horarios",
      detail: sources ? (sources.branches === 0 ? "Ninguna sede activa" : plural(sources.branches, "sede", "sedes")) : null,
      action: "Se editan en Sedes",
    },
  ] as const
  return (
    <section aria-labelledby="tus-datos" className="elevated flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="px-4 pt-4 pb-2.5 sm:px-5">
        <h2 id="tus-datos" className="font-heading text-base font-semibold">
          Lo que toma de tus datos
        </h2>
        <p className="text-sm text-muted-foreground">Siempre al día: no se copia, se lee en el momento.</p>
      </div>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li key={row.to} className="border-t">
            <Link
              to={row.to}
              className="flex min-h-13 flex-wrap items-center gap-x-4 gap-y-0.5 px-4 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
            >
              <span className="flex-[1_1_12rem] font-semibold">{row.title}</span>
              {row.detail ? <span className="flex-[1_1_10rem] text-muted-foreground">{row.detail}</span> : null}
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
                {row.action}
                <ArrowRight aria-hidden className="size-3.5" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

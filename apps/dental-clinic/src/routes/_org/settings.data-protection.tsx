import { ScrollArea } from "@odentia/ui"
import { LoadingState, PageHeader } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Download } from "lucide-react"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { API_URL } from "../../lib/auth-client"
import { apiFetch } from "../../lib/api"
import { formatDate } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { legalLinks, orgSlugFromHostname, requestHostname } from "../../lib/host"

export const Route = createFileRoute("/_org/settings/data-protection")({
  component: DataProtectionPage,
})

const TITLE = "Protección de datos"
const SUBTITLE =
  "Qué datos guarda la clínica, para qué y quién más los toca. Es lo que pide la ley de datos personales y lo que te pide la autoridad si lo revisa. Se arma solo, con lo que la clínica usa hoy."

interface Processor {
  id: string
  name: string
  receives: string
  country: string
  detail: string | null
}

/** Lo que entrega `/api/data-protection`: ya viene dicho con palabras. */
interface DataProtectionView {
  responsible: {
    legalName: string | null
    tradeName: string | null
    fiscalDocType: string | null
    fiscalDocNumber: string | null
    address: string | null
    missing: string[]
  }
  agreement: { version: string; acceptedAt: string; acceptedByName: string | null } | null
  activities: Array<{ id: string; purpose: string; data: string; basis: string; keep: string }>
  processors: { inUse: Processor[]; always: Processor[]; notUsed: string[] }
  requests: {
    year: number
    received: number
    onTime: number
    answeredLate: number
    pending: number
    late: number
    locked: number
  }
}

/** El PDF se abre con un enlace: `?org=` porque un enlace no envía la cabecera de la clínica. */
function pdfUrl(): string {
  const slug = orgSlugFromHostname(requestHostname()) ?? ""
  return `${API_URL}/api/data-protection/pdf?org=${encodeURIComponent(slug)}`
}

/** «la dirección fiscal», «el documento fiscal y la dirección fiscal». */
function missingWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} y ${items.at(-1)}`
}

/**
 * Configuración › Protección de datos (ADR 0080, tablero 9): el registro de
 * actividades de tratamiento. Una consulta: nada se escribe aquí y lo que
 * falta se completa donde vive.
 */
function DataProtectionPage() {
  const allowed = usePermission("settings.read")
  const query = useQuery({
    queryKey: ["data-protection"],
    queryFn: () => apiFetch<{ data: DataProtectionView }>("/api/data-protection").then((r) => r.data),
    enabled: allowed,
    retry: 1,
  })
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        primary={
          allowed && query.data
            ? {
                label: "Descargar para la autoridad",
                icon: <Download aria-hidden="true" />,
                // biome-ignore lint/a11y/useAnchorContent: el encabezado le pone el texto y el icono
                render: <a href={pdfUrl()} download />,
              }
            : undefined
        }
      />
      {!allowed ? (
        <SettingsNoAccess />
      ) : query.isPending ? (
        <LoadingState message="Armando el registro…" />
      ) : query.isError && !query.data ? (
        <SettingsLoadError what="la protección de datos" onRetry={() => void query.refetch()} />
      ) : (
        <DataProtectionBody view={query.data} />
      )}
    </div>
  )
}

function DataProtectionBody({ view }: { view: DataProtectionView }) {
  const r = view.responsible
  const fiscal = [r.fiscalDocType, r.fiscalDocNumber].filter(Boolean).join(" ")
  const req = view.requests
  return (
    <>
      <section className="grid gap-4 rounded-2xl border bg-muted/40 p-5 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <h2 className="mb-1 text-base font-semibold">Responsable de los datos</h2>
          <p>{[r.legalName, fiscal].filter(Boolean).join(" · ") || "Sin razón social"}</p>
          {r.address ? <p className="text-muted-foreground">{r.address}</p> : null}
          {r.missing.length ? (
            <p className="text-warning">
              Falta {missingWords(r.missing)} ·{" "}
              <Link to="/settings" className="underline underline-offset-4">
                Completar en Datos de la clínica
              </Link>
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="mb-1 text-base font-semibold">Encargado</h2>
          <p>odentIA guarda y procesa los datos por cuenta de la clínica.</p>
          <p className="text-muted-foreground">
            {view.agreement
              ? `Contrato de encargo aceptado el ${formatDate(view.agreement.acceptedAt)}${view.agreement.acceptedByName ? ` por ${view.agreement.acceptedByName}` : ""}`
              : "El contrato de encargo aún no se aceptó"}{" "}
            ·{" "}
            <a href={legalLinks.agreement} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              Ver contrato
            </a>
          </p>
        </div>
      </section>

      <section aria-labelledby="dp-activities" className="flex flex-col gap-3 rounded-2xl border p-5">
        <h2 id="dp-activities" className="text-base font-semibold">
          Qué datos guarda y para qué
        </h2>
        {/* En el celular, una fila debajo de otra (tablero 9b); desde tablet, la tabla. */}
        <ul className="flex flex-col divide-y text-sm sm:hidden">
          {view.activities.map((a) => (
            <li key={a.id} className="flex flex-col gap-0.5 py-2.5">
              <span className="font-medium">{a.purpose}</span>
              <span>{a.data}</span>
              <span className="text-muted-foreground">
                {a.basis} · {a.keep}
              </span>
            </li>
          ))}
        </ul>
        <ScrollArea horizontal className="hidden sm:block">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="border-b px-2 py-2 font-medium">Para qué</th>
                <th scope="col" className="border-b px-2 py-2 font-medium">Qué datos</th>
                <th scope="col" className="border-b px-2 py-2 font-medium">Con qué permiso</th>
                <th scope="col" className="border-b px-2 py-2 font-medium">Cuánto tiempo</th>
              </tr>
            </thead>
            <tbody>
              {view.activities.map((a) => (
                <tr key={a.id} className="align-top">
                  <th scope="row" className="border-b px-2 py-2.5 text-left font-medium">{a.purpose}</th>
                  <td className="border-b px-2 py-2.5">{a.data}</td>
                  <td className="border-b px-2 py-2.5">{a.basis}</td>
                  <td className="border-b px-2 py-2.5">{a.keep}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      </section>

      <section aria-labelledby="dp-processors" className="flex flex-col gap-4 rounded-2xl border p-5">
        <div>
          <h2 id="dp-processors" className="text-base font-semibold">
            Quién más los toca
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Empresas que procesan los datos por cuenta de la clínica. Las que están fuera del país son una transferencia
            internacional: la autorizaste en el contrato de encargo.
          </p>
        </div>
        {view.processors.inUse.length ? <ProcessorList title="Porque la clínica los usa" items={view.processors.inUse} /> : null}
        <ProcessorList title="Siempre, porque odentIA funciona así" items={view.processors.always} />
        {view.processors.notUsed.length ? (
          <p className="text-sm text-muted-foreground">
            No usa: {missingWords(view.processors.notUsed)}. Si los conecta, aparecen aquí solos.
          </p>
        ) : null}
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-5">
        <div>
          <h2 className="text-base font-semibold">Pedidos sobre sus datos en {req.year}</h2>
          <p className="mt-1 text-sm">
            {req.received === 0
              ? "Ninguno todavía. Se registran en la ficha de cada persona, en Datos › Pedidos sobre sus datos."
              : [
                  `${req.received} ${req.received === 1 ? "recibido" : "recibidos"}`,
                  `${req.onTime} respondidos a tiempo`,
                  req.answeredLate ? `${req.answeredLate} fuera de plazo` : null,
                  req.pending ? `${req.pending} ${req.pending === 1 ? "pendiente" : "pendientes"}` : null,
                  req.late ? `${req.late} ${req.late === 1 ? "vencido" : "vencidos"}` : null,
                  req.locked ? `${req.locked} ${req.locked === 1 ? "historia bloqueada" : "historias bloqueadas"}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </p>
        </div>
        {req.locked ? (
          <Link to="/people/locked" className="text-sm underline underline-offset-4">
            Ver historias bloqueadas
          </Link>
        ) : null}
      </section>
    </>
  )
}

function ProcessorList({ title, items }: { title: string; items: Processor[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</p>
      <ul className="flex flex-col divide-y rounded-xl border">
        {items.map((p) => (
          <li key={p.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[minmax(150px,1fr)_minmax(220px,2fr)_140px] sm:gap-3">
            <span className="font-medium">{p.name}</span>
            <span>
              {p.receives}
              {p.detail ? <span className="text-muted-foreground"> · {p.detail}</span> : null}
            </span>
            <span className="text-muted-foreground">{p.country}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

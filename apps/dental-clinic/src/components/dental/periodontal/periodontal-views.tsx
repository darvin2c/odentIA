/**
 * Piezas de la pantalla del periodontograma que se repiten: las cifras de una
 * visita (con lo que cambió desde la anterior), el detalle de una pieza y la
 * línea del sangrado entre visitas.
 */
import {
  attachmentLoss,
  furcationEntriesFor,
  PERIODONTAL_SITE_WORDS,
  PERIODONTAL_SITES,
  PLAQUE_FACE_WORDS,
  type PeriodontalSummary,
  type PeriodontalToothRecord,
} from "@odentia/dental"
import { Badge, Button, cn } from "@odentia/ui"
import { innerName, PlaqueToothIcon, toothName } from "./anatomy"
import { signed } from "./periodontal-chart"

const siteWords = (site: string) => PERIODONTAL_SITE_WORDS[PERIODONTAL_SITES.indexOf(site as (typeof PERIODONTAL_SITES)[number])] ?? site

function Delta({ now, before, unit }: { now: number | null; before: number | null | undefined; unit: string }) {
  if (before == null || now == null) return null
  const d = now - before
  if (d === 0) return <span className="ml-1.5 rounded-full bg-muted px-1.5 text-xs font-semibold text-muted-foreground">igual</span>
  // Menos es mejor en todas estas cifras; se dice con palabras, no solo con color.
  return (
    <span
      className={cn(
        "ml-1.5 rounded-full px-1.5 text-xs font-semibold",
        d < 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
      )}
    >
      {d < 0 ? "−" : "+"}
      {Math.abs(d)}
      {unit}
      <span className="sr-only">{d < 0 ? " (mejor que antes)" : " (peor que antes)"}</span>
    </span>
  )
}

/** Las cifras de una visita (tableros 4 y 9). Con `previous`, cuánto cambió cada una. */
export function PeriodontalTiles({ summary, previous }: { summary: PeriodontalSummary; previous?: PeriodontalSummary | null }) {
  const worst = summary.worstInterdentalLoss
  const items: Array<{ key: string; value: React.ReactNode; foot: string }> = [
    {
      key: "Sangrado al sondaje",
      value: (
        <>
          {summary.bleedingPercent === null ? "Sin datos" : `${summary.bleedingPercent} %`}
          <Delta now={summary.bleedingPercent} before={previous?.bleedingPercent} unit=" pts" />
        </>
      ),
      foot: `${summary.bleedingSites} de ${summary.sitesMeasured} sitios`,
    },
    {
      key: "Placa (O'Leary)",
      value: (
        <>
          {summary.plaque ? `${summary.plaque.percent} %` : "Sin marcar"}
          <Delta now={summary.plaque?.percent ?? null} before={previous?.plaque?.percent} unit=" pts" />
        </>
      ),
      foot: summary.plaque ? `${summary.plaque.withPlaque} de ${summary.plaque.faces} caras` : "Se marca aparte, si se usa revelador",
    },
    {
      key: "Bolsas de 4 mm o más",
      value: (
        <>
          {summary.sitesFrom4mm}
          <Delta now={summary.sitesFrom4mm} before={previous?.sitesFrom4mm} unit="" />
        </>
      ),
      foot: "sitios",
    },
    {
      key: "Bolsas de 6 mm o más",
      value: (
        <>
          {summary.sitesFrom6mm}
          <Delta now={summary.sitesFrom6mm} before={previous?.sitesFrom6mm} unit="" />
        </>
      ),
      foot: "sitios",
    },
    {
      key: "Mayor pérdida de inserción entre dientes",
      value: (
        <>
          {worst ? `${worst.value} mm` : "Sin datos"}
          <Delta now={worst?.value ?? null} before={previous?.worstInterdentalLoss?.value} unit=" mm" />
        </>
      ),
      foot: worst ? `${worst.toothNumber}, ${siteWords(worst.site)}` : "Falta medir la recesión",
    },
  ]
  // Mide por su contenedor: en la superficie lateral dos o tres por fila; en ancho, las cinco.
  return (
    <div className="@container">
    <dl className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @4xl:grid-cols-5">
      {items.map((item) => (
        <div key={item.key} className="flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card px-3 py-2.5">
          <dt className="text-xs font-medium text-muted-foreground">{item.key}</dt>
          <dd className="flex flex-wrap items-baseline text-xl font-semibold tabular-nums">{item.value}</dd>
          <dd className="text-xs text-muted-foreground">{item.foot}</dd>
        </div>
      ))}
    </dl>
    </div>
  )
}

const HAMP = ["", "I", "II", "III"]
const FURCATION_WORDS: Record<string, string> = {
  buccal: "por fuera",
  lingual: "por dentro",
  mesiopalatal: "mesial por dentro",
  distopalatal: "distal por dentro",
  mesial: "mesial",
  distal: "distal",
}

/**
 * Detalle de una pieza (tablero 4): sus seis sitios con la bolsa, la pérdida
 * de inserción y la recesión, la movilidad, la furca y su placa. Con
 * `before`, el antes de cada sitio (tablero 11).
 */
export function PeriodontalToothDetail({
  toothNumber,
  record,
  implant,
  present,
  before = null,
  beforeLabel = "antes",
  onToothHistory,
}: {
  toothNumber: number
  record: PeriodontalToothRecord | null
  implant: boolean
  present: boolean
  before?: PeriodontalToothRecord | null
  beforeLabel?: string
  onToothHistory?: (tooth: number) => void
}) {
  const head = (
    <div className="flex flex-col gap-0.5">
      <h3 className="text-2xl font-extrabold tracking-tight">Pieza {toothNumber}</h3>
      <p className="text-sm text-muted-foreground">{toothName(toothNumber)}</p>
    </div>
  )
  if (!present || !record) {
    return (
      <div className="perio flex flex-col gap-3" aria-live="polite">
        {head}
        <p className="text-sm text-muted-foreground">Ausente en el odontograma de esa atención. No se sondea.</p>
      </div>
    )
  }
  const furcations = furcationEntriesFor(toothNumber)
    .map((entry) => [entry, record.furcation[entry]] as const)
    .filter(([, grade]) => grade)
  const cell = (site: number) => {
    const pd = record.probingDepth[site] ?? null
    const rec = record.recession[site] ?? null
    const loss = attachmentLoss(pd, rec)
    const was = before?.probingDepth[site] ?? null
    const change = pd !== null && was !== null ? pd - was : null
    return (
      <div key={site} className="relative flex flex-col items-center gap-px rounded-lg border bg-card px-1 py-1.5 text-center">
        <span className="absolute top-1 right-1 flex gap-0.5" aria-hidden="true">
          {record.bleeding[site] && pd !== null ? <i className="block size-[7px] rounded-full bg-[var(--perio-bop)]" /> : null}
          {record.suppuration[site] && pd !== null ? <i className="block size-[7px] rounded-full border-[1.6px] border-[var(--perio-sup)]" /> : null}
        </span>
        <span
          className={cn(
            "font-mono text-lg leading-tight font-extrabold",
            pd !== null && pd >= 6 ? "text-danger" : pd !== null && pd >= 4 ? "text-warning" : "",
          )}
        >
          {pd ?? "·"}
        </span>
        {!implant && loss !== null ? <small className="text-[0.66rem] text-muted-foreground">NIC {loss}</small> : null}
        {rec !== null ? <small className="text-[0.66rem] text-muted-foreground">rec {signed(rec)}</small> : null}
        <span className="sr-only">
          {[
            record.bleeding[site] && pd !== null ? "sangra" : "",
            record.suppuration[site] && pd !== null ? "supura" : "",
          ]
            .filter(Boolean)
            .join(", ")}
        </span>
        {change !== null ? (
          <span
            className={cn(
              "mt-0.5 rounded-full px-1.5 text-[0.66rem] font-bold whitespace-nowrap",
              change <= -2 ? "bg-success-soft text-success" : change >= 2 ? "bg-danger-soft text-danger" : "bg-muted text-muted-foreground",
            )}
          >
            {beforeLabel} {was}
          </span>
        ) : null}
      </div>
    )
  }
  const plaque = record.plaque
  const plaqueOn = plaque ? PLAQUE_FACE_WORDS.filter((_, i) => plaque[i]) : []
  const plaqueBefore = before?.plaque ?? null
  return (
    <div className="perio flex flex-col gap-3" aria-live="polite">
      {head}
      <div className="flex flex-wrap gap-1.5">
        {implant ? <Badge variant="secondary">Implante</Badge> : null}
        {record.skipped ? <Badge variant="outline">Saltada</Badge> : null}
        {!implant ? (
          <Badge variant={record.mobility ? "warning" : "outline"}>
            {record.mobility ? `Movilidad ${record.mobility}` : record.mobility === 0 ? "Sin movilidad" : "Movilidad sin anotar"}
          </Badge>
        ) : null}
        {furcations.map(([entry, grade]) => (
          <Badge key={entry} variant={grade && grade >= 2 ? "destructive" : "outline"}>
            Furca {HAMP[grade ?? 0]} {FURCATION_WORDS[entry]}
          </Badge>
        ))}
        {implant && record.periImplant ? <Badge variant="outline">{record.periImplant === "health" ? "Sano" : record.periImplant === "mucositis" ? "Mucositis" : "Periimplantitis"}</Badge> : null}
      </div>
      <div className="grid grid-cols-[64px_repeat(3,minmax(0,1fr))] items-stretch gap-1.5">
        <span />
        {["Mesial", "Centro", "Distal"].map((label) => (
          <span key={label} className="text-center text-[0.68rem] font-bold tracking-wider text-muted-foreground uppercase">
            {label}
          </span>
        ))}
        <span className="self-center text-xs font-bold text-muted-foreground">Por fuera</span>
        {[0, 1, 2].map(cell)}
        <span className="self-center text-xs leading-tight font-bold text-muted-foreground">
          Por dentro
          <br />
          <span className="font-semibold">{innerName(toothNumber)}</span>
        </span>
        {[3, 4, 5].map(cell)}
      </div>
      {!implant ? (
        <div className="flex items-center gap-3 rounded-xl border p-2.5">
          <PlaqueToothIcon tooth={toothNumber} faces={plaque} />
          <div className="flex flex-col text-sm">
            <b>{plaque ? `Placa: ${plaqueOn.length} de 4 caras` : "Placa sin marcar"}</b>
            {plaque ? <span className="text-muted-foreground">{plaqueOn.length ? `En ${plaqueOn.join(", ")}` : "Sin placa"}</span> : null}
            {plaqueBefore ? (
              <span className="text-muted-foreground">
                {beforeLabel === "antes" ? "Antes" : beforeLabel}: {plaqueBefore.filter(Boolean).length} de 4
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {implant
          ? "En el implante no se calcula la pérdida de inserción: no hay límite del esmalte."
          : "NIC: pérdida de inserción = bolsa + recesión. El punto rojo es sangrado; el anillo, pus."}
      </p>
      {onToothHistory ? (
        <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => onToothHistory(toothNumber)}>
          Historia de la pieza
        </Button>
      ) : null}
    </div>
  )
}

/** Cómo bajó o subió el sangrado entre la primera y la última visita (tablero 2). */
export function BleedingSparkline({ first, last }: { first: number | null; last: number | null }) {
  if (first === null || last === null) return null
  const y = (value: number) => 22 - (Math.min(value, 60) / 60) * 16
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <svg width="96" height="26" viewBox="0 0 96 26" aria-hidden="true">
        <line x1="8" y1="22" x2="88" y2="22" stroke="var(--border)" />
        <polyline points={`8,${y(first)} 88,${y(last)}`} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="8" cy={y(first)} r="3" fill="var(--card)" stroke="var(--primary)" strokeWidth="2" />
        <circle cx="88" cy={y(last)} r="3.5" fill="var(--primary)" />
      </svg>
      <span>
        Sangrado:{" "}
        <b className="text-foreground">
          {first} % → {last} %
        </b>
      </span>
    </div>
  )
}

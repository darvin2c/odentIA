// Varias sedes de Clínica Sonrisa Norte (portada de /varias-sedes): eliges Los Olivos, San Martín o todas,
// y cambian la agenda y la caja de hoy (que son de cada sede) y el alcance de Reportes; la historia de
// Carlos es la misma en las dos, con su visita resaltada en la sede elegida. Sin animación: solo
// responde al toque. Los montos son de una clínica de ejemplo, en soles.
import { useState } from "react"
import "./sites-demo.css"

type SiteKey = "lo" | "sm" | "all"

const SITES: { key: SiteKey; label: string }[] = [
  { key: "lo", label: "Sede Los Olivos" },
  { key: "sm", label: "Sede San Martín" },
  { key: "all", label: "Todas las sedes" },
]

const DATA: Record<SiteKey, { agenda: [string, string, string][]; cash: string; cashNote: string; month: string; monthCmp: string; scope: string }> = {
  lo: {
    agenda: [
      ["09:00", "Rosa Vega", "Limpieza dental (profilaxis) · Unidad dental 1"],
      ["10:00", "Carlos Medina", "Obturación con resina · Unidad dental 2"],
    ],
    cash: "S/ 300,00",
    cashNote: "Efectivo S/ 120 · Tarjeta S/ 180",
    month: "S/ 21.540",
    monthCmp: "↑ 10 % más que en septiembre",
    scope: "LOS OLIVOS",
  },
  sm: {
    agenda: [
      ["08:30", "Lucía Fernández", "Evaluación odontológica · Unidad dental 1"],
      ["11:00", "Miguel Torres", "Control de ortodoncia · Unidad dental 2"],
    ],
    cash: "S/ 250,00",
    cashNote: "Efectivo S/ 90 · Transferencia S/ 160",
    month: "S/ 11.600",
    monthCmp: "↑ 4 % más que en septiembre",
    scope: "SAN MARTÍN",
  },
  all: { agenda: [], cash: "", cashNote: "", month: "S/ 33.140", monthCmp: "↑ 8 % más que en septiembre", scope: "TODAS LAS SEDES" },
}

// Las cuatro visitas de Carlos, en una y otra sede.
const HISTORY: [string, string, string, SiteKey][] = [
  ["12 ene.", "Los Olivos", "Evaluación odontológica", "lo"],
  ["10 abr.", "San Martín", "Limpieza dental", "sm"],
  ["11 jul.", "Los Olivos", "Resina · pieza 36", "lo"],
  ["10 oct.", "San Martín", "Blanqueamiento dental", "sm"],
]

export default function SitesDemo() {
  const [site, setSite] = useState<SiteKey>("lo")
  const data = DATA[site]
  const one = site !== "all"
  // Lo cobrado en el mes, repartido: Los Olivos 65 %, San Martín 35 %.
  const bars: [string, number, boolean][] = [
    ["Los Olivos", 65, site !== "sm"],
    ["San Martín", 35, site !== "lo"],
  ]

  return (
    <div className="dst">
      <fieldset className="dst-pick">
        <legend className="sr-only">Elige una sede</legend>
        {SITES.map((s) => (
          <button key={s.key} type="button" aria-pressed={s.key === site} onClick={() => setSite(s.key)}>
            {s.label}
          </button>
        ))}
      </fieldset>
      {/* En el teléfono las cuatro tarjetas pasan de lado (se asoma la siguiente); la región se recorre también con las flechas del teclado. */}
      {/* biome-ignore lint/a11y/useSemanticElements: es una zona que se desliza dentro de la demo, no una sección de la página. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: una zona que se desliza necesita el foco para recorrerla con el teclado (WCAG 2.1.1). */}
      <div className="dst-grid" role="region" aria-label="Lo que cambia con la sede" tabIndex={0}>
        <div className="dst-card">
          <span className="dst-k">Agenda de hoy · por sede</span>
          {one ? (
            data.agenda.map(([time, who, what]) => (
              <div key={time} className="dst-appt">
                <span>{time}</span>
                <span>
                  <b>{who}</b>
                  <span>{what}</span>
                </span>
              </div>
            ))
          ) : (
            <p className="dst-all">La agenda es de una sede: sus unidades dentales, sus odontólogos y su horario. Elige Los Olivos o San Martín.</p>
          )}
        </div>
        <div className="dst-card">
          <span className="dst-k">Caja de hoy · por sede</span>
          {one ? (
            <>
              <b className="dst-big">{data.cash}</b>
              <span className="dst-sub">{data.cashNote}</span>
              <span className="dst-sub">Con su propio cierre de caja.</span>
            </>
          ) : (
            <p className="dst-all">Cada sede cierra su caja. Todas juntas se ven en Reportes.</p>
          )}
        </div>
        <div className="dst-card">
          <span className="dst-k">Historia · la misma en todas</span>
          <b className="dst-who">Carlos Medina · sus atenciones</b>
          {HISTORY.map(([when, name, what, key]) => (
            <div key={when} className="dst-visit" data-here={key === site || undefined}>
              <span>
                {when} · {name}
              </span>
              <b>{what}</b>
            </div>
          ))}
          <span className="dst-foot">Se atiende en las dos sedes y su historia va con él.</span>
        </div>
        <div className="dst-card">
          <span className="dst-k">Reportes · {data.scope}</span>
          <span className="dst-sub">Cobrado en octubre</span>
          <b className="dst-big">{data.month}</b>
          <span className="dst-up">{data.monthCmp}</span>
          {bars.map(([label, pct, on]) => (
            <div key={label} className="dst-bar">
              <span>{label}</span>
              <span className="dst-track">
                <span className="dst-fill" style={{ width: on ? `${pct}%` : "0%" }} />
              </span>
            </div>
          ))}
        </div>
      </div>
      <span className="dst-note">Demostración con datos de ejemplo: elige una sede y mira qué cambia.</span>
    </div>
  )
}

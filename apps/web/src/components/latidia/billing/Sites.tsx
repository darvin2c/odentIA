// Varias sedes (lienzo de latidIA, tablero «Caja»): eliges San Martín, Los Olivos o todas, y cambian la
// agenda y la caja de hoy (que son de cada sede) y el alcance de Reportes; la historia de Luis es la
// misma en las dos, con su control resaltado en la sede elegida. Sin animación: solo responde al toque.
// Los montos son de un consultorio de ejemplo, en soles.
import { useState } from "react"
import "./sites.css"

type SiteKey = "sm" | "lo" | "all"

const SITES: { key: SiteKey; label: string }[] = [
  { key: "sm", label: "Sede San Martín" },
  { key: "lo", label: "Sede Los Olivos" },
  { key: "all", label: "Todas las sedes" },
]

const DATA: Record<SiteKey, { agenda: [string, string, string][]; cash: string; cashNote: string; month: string; monthCmp: string; scope: string }> = {
  sm: {
    agenda: [
      ["09:00", "Rosa Paredes Luna", "Consulta por dolor de cabeza · Sala 1"],
      ["10:00", "Luis Gómez Salas", "Control de presión arterial · Sala 2"],
    ],
    cash: "S/ 220,00",
    cashNote: "Efectivo S/ 140 · Tarjeta S/ 80",
    month: "S/ 12.380",
    monthCmp: "↑ 10 % más que en septiembre",
    scope: "SAN MARTÍN",
  },
  lo: {
    agenda: [
      ["08:30", "Mateo Ríos", "Nebulización · Sala 1"],
      ["11:00", "Ana Quispe Rojas", "Control niño sano · Sala 1"],
    ],
    cash: "S/ 100,00",
    cashNote: "Efectivo S/ 30 · Transferencia S/ 70",
    month: "S/ 6.260",
    monthCmp: "↑ 4 % más que en septiembre",
    scope: "LOS OLIVOS",
  },
  all: { agenda: [], cash: "", cashNote: "", month: "S/ 18.640", monthCmp: "↑ 8 % más que en septiembre", scope: "TODAS LAS SEDES" },
}

// Los cuatro controles de presión de Luis, en una y otra sede.
const HISTORY: [string, string, string, SiteKey][] = [
  ["12 ene.", "San Martín", "152/96", "sm"],
  ["10 abr.", "Los Olivos", "144/92", "lo"],
  ["11 jul.", "San Martín", "138/88", "sm"],
  ["10 oct.", "Los Olivos", "132/84", "lo"],
]

export default function Sites() {
  const [site, setSite] = useState<SiteKey>("sm")
  const data = DATA[site]
  const one = site !== "all"
  // Lo cobrado en el mes, repartido: San Martín 66 %, Los Olivos 34 %.
  const bars: [string, number, boolean][] = [
    ["San Martín", 66, site !== "lo"],
    ["Los Olivos", 34, site !== "sm"],
  ]

  return (
    <div className="lt-sites">
      <fieldset className="lt-sites-pick">
        <legend className="sr-only">Elige una sede</legend>
        {SITES.map((s) => (
          <button key={s.key} type="button" aria-pressed={s.key === site} onClick={() => setSite(s.key)}>
            {s.label}
          </button>
        ))}
      </fieldset>
      <div className="lt-sites-grid">
        <div className="lt-sites-card">
          <span className="lt-sites-k">Agenda de hoy · por sede</span>
          {one ? (
            data.agenda.map(([time, who, what]) => (
              <div key={time} className="lt-sites-appt">
                <span>{time}</span>
                <span>
                  <b>{who}</b>
                  <span>{what}</span>
                </span>
              </div>
            ))
          ) : (
            <p className="lt-sites-all">La agenda es de una sede: sus salas, sus médicos y su horario. Elige San Martín o Los Olivos.</p>
          )}
        </div>
        <div className="lt-sites-card">
          <span className="lt-sites-k">Caja de hoy · por sede</span>
          {one ? (
            <>
              <b className="lt-sites-big">{data.cash}</b>
              <span className="lt-sites-sub">{data.cashNote}</span>
              <span className="lt-sites-sub">Con su propio cierre y su hoja para firmar.</span>
            </>
          ) : (
            <p className="lt-sites-all">Cada sede cierra su caja. Todas juntas se ven en Reportes.</p>
          )}
        </div>
        <div className="lt-sites-card">
          <span className="lt-sites-k">Historia · la misma en todas</span>
          <b className="lt-sites-who">Luis Gómez Salas · controles de presión</b>
          {HISTORY.map(([when, name, pa, key]) => (
            <div key={when} className="lt-sites-visit" data-here={key === site || undefined}>
              <span>
                {when} · {name}
              </span>
              <b>{pa}</b>
            </div>
          ))}
          <span className="lt-sites-foot">Se atiende en las dos sedes y su historia va con él.</span>
        </div>
        <div className="lt-sites-card">
          <span className="lt-sites-k">Reportes · {data.scope}</span>
          <span className="lt-sites-sub">Cobrado en octubre</span>
          <b className="lt-sites-big">{data.month}</b>
          <span className="lt-sites-up">{data.monthCmp}</span>
          {bars.map(([label, pct, on]) => (
            <div key={label} className="lt-sites-bar">
              <span>{label}</span>
              <span className="lt-sites-track">
                <span className="lt-sites-fill" style={{ width: on ? `${pct}%` : "0%" }} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

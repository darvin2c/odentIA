// 05 · «Lo que te cuesta no tenernos»: lo que se pierde sin agentes frente a lo que se paga,
// con los números que pone la clínica. Es un ejemplo, nunca una promesa de resultados.
import { type ChangeEvent, useState } from "react"
import { usd, type ValuePrices } from "../../lib/pricing"
import { computeValue, DEFAULT_VALUE_INPUT, sizeOf, type ValueInput } from "../../lib/value"
import SizePicker from "../SizePicker"

export default function ValueCalc({ prices }: { prices: ValuePrices }) {
  const [i, setI] = useState<ValueInput>(DEFAULT_VALUE_INPUT)
  const num = (k: keyof ValueInput, max: number) => (e: ChangeEvent<HTMLInputElement>) => {
    const v = Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0)))
    setI({ ...i, [k]: v })
  }
  const r = computeValue(i, prices)
  const top = Math.max(r.withoutUs, r.withUs, 1)
  const sinPct = ((r.withoutUs / top) * 100).toFixed(1) + "%"
  const conPct = Math.max(2, (r.withUs / top) * 100).toFixed(1) + "%"

  const ratio = r.worthIt ? r.ratio.toFixed(1).replace(".", ",") : "—"

  // Escritorio: los campos a la izquierda y, a la derecha, la cuenta y el resultado fijos al bajar.
  // Teléfono y tableta: una columna y, mientras se ven los campos, un resumen pegado abajo.
  return (
    <div className="vcalc">
      <div className="vgrid">
        <div className="vinw">
          <div className="vin">
            <span className="tag tag-d">Tu clínica, en un mes</span>
            <SizePicker current={sizeOf(i)} onPick={setI} />
            <label className="vl">
              <span>Personas que te escriben</span>
              <input
                type="number"
                className="vnum"
                min="0"
                max="5000"
                value={i.writers}
                onChange={num("writers", 5000)}
              />
            </label>
            <input
              type="range"
              className="vrange"
              min="0"
              max="2000"
              step="10"
              value={Math.min(i.writers, 2000)}
              onChange={num("writers", 5000)}
              aria-label="Personas que te escriben al mes"
            />
            <label className="vl">
              <span>Pacientes que faltaron a su cita en el mes</span>
              <input
                type="number"
                className="vnum"
                min="0"
                max="1000"
                value={i.noShows}
                onChange={num("noShows", 1000)}
              />
            </label>
            <input
              type="range"
              className="vrange"
              min="0"
              max="300"
              step="5"
              value={Math.min(i.noShows, 300)}
              onChange={num("noShows", 1000)}
              aria-label="Pacientes que faltaron a su cita en el mes"
            />
            <label className="vl">
              <span>Consultas que dictarías al mes</span>
              <input
                type="number"
                className="vnum"
                min="0"
                max="5000"
                value={i.consultations}
                onChange={num("consultations", 5000)}
              />
            </label>
            <input
              type="range"
              className="vrange"
              min="0"
              max="2000"
              step="10"
              value={Math.min(i.consultations, 2000)}
              onChange={num("consultations", 5000)}
              aria-label="Consultas que dictarías al mes"
            />
            <label className="vl">
              <span>
                Lo que cobra tu clínica por una cita, en promedio, en dólares
                <small>Si no lo sabes: lo facturado en el mes entre las citas atendidas.</small>
              </span>
              <input
                type="number"
                className="vnum"
                min="0"
                max="2000"
                value={i.appointmentValue}
                onChange={num("appointmentValue", 2000)}
              />
            </label>
            <details className="vsup">
              <summary>Ajustar los supuestos</summary>
              <label className="vl">
                <span>De quienes te escriben, % que hoy no recibe respuesta a tiempo</span>
                <input
                  type="number"
                  className="vnum"
                  min="0"
                  max="100"
                  value={i.unansweredPct}
                  onChange={num("unansweredPct", 100)}
                />
              </label>
              <label className="vl">
                <span>De esos, % que se va a otra clínica</span>
                <input
                  type="number"
                  className="vnum"
                  min="0"
                  max="100"
                  value={i.leavePct}
                  onChange={num("leavePct", 100)}
                />
              </label>
              <label className="vl">
                <span>De quienes faltaron, % que vuelve a reservar si alguien le escribe</span>
                <input
                  type="number"
                  className="vnum"
                  min="0"
                  max="100"
                  value={i.returnPct}
                  onChange={num("returnPct", 100)}
                />
              </label>
              <label className="vl">
                <span>Horas de tu equipo al mes en mensajes y notas</span>
                <input
                  type="number"
                  className="vnum"
                  min="0"
                  max="1000"
                  value={i.teamHours}
                  onChange={num("teamHours", 1000)}
                />
              </label>
              <label className="vl">
                <span>Lo que cuesta una hora de tu equipo, en dólares</span>
                <input
                  type="number"
                  className="vnum"
                  min="0"
                  max="200"
                  value={i.hourCost}
                  onChange={num("hourCost", 200)}
                />
              </label>
            </details>
          </div>
          {/* El resumen repite el resultado de abajo, que es el que se anuncia: aquí va oculto a los lectores. */}
          <div className="vdock" aria-hidden="true">
            <span className="vdock-t">
              <span>
                <span className="vdock-nw">Pierdes {usd(r.withoutUs)} ·</span>{" "}
                <span className="vdock-nw">pagas {usd(r.withUs)}</span>
              </span>
              <span>{r.worthIt ? "Recuperas por cada dólar que pagas" : "Con estos números todavía no conviene"}</span>
            </span>
            <strong className="vdock-n">{r.worthIt ? `USD ${ratio}` : "—"}</strong>
          </div>
        </div>
        <div className="vout">
          <div className="vcol">
            <span className="tag vtag-a">Sin odentIA, cada mes</span>
            <div className="vrow">
              <span>{r.lost} pacientes que escribieron y se fueron a otra clínica</span>
              <strong>{usd(r.lostNew)}</strong>
            </div>
            <div className="vrow">
              <span>{r.recovered} pacientes que faltaron y nadie les ofreció otra cita</span>
              <strong>{usd(r.lostNoShows)}</strong>
            </div>
            <div className="vrow">
              <span>{i.teamHours} horas de tu equipo en mensajes y notas</span>
              <strong>{usd(r.lostTime)}</strong>
            </div>
          </div>
          <div className="vcol us">
            <span className="tag tag-d">Con odentIA, cada mes</span>
            <div className="vrow">
              <span>{i.writers} conversaciones atendidas</span>
              <strong>{usd(r.conversations)}</strong>
            </div>
            <div className="vrow">
              <span>{r.recovered} citas recuperadas, solo si asisten</span>
              <strong>{usd(r.recoveredCost)}</strong>
            </div>
            <div className="vrow">
              <span>{i.consultations} consultas dictadas y confirmadas</span>
              <strong>{usd(r.consultations)}</strong>
            </div>
          </div>
          <div className="vres" aria-live="polite">
            <div className="vbar">
              <div className="vbl">
                <span>Sin odentIA pierdes, cada mes</span>
                <strong className="vbig va">{usd(r.withoutUs)}</strong>
              </div>
              <div className="vtrack">
                <span className="vfill" style={{ width: sinPct, background: "#f5c46b" }}></span>
              </div>
            </div>
            <div className="vbar">
              <div className="vbl">
                <span>Con odentIA pagas, cada mes</span>
                <strong className="vbig vs">{usd(r.withUs)}</strong>
              </div>
              <div className="vtrack">
                <span className="vfill" style={{ width: conPct, background: "#4fc3d7" }}></span>
              </div>
            </div>
            <div className="vratio">
              <span className="vrl">
                <span className="vr1">Recuperas</span>
                <span className="vr3">
                  {r.worthIt ? "por cada dólar que pagas" : "con estos números todavía no conviene"}
                </span>
                <span className="vdiff">
                  {r.worthIt ? (
                    <>
                      A tu favor, cada mes: <strong>{usd(r.inFavor)}</strong>
                    </>
                  ) : (
                    "Prueba con los números de tu clínica"
                  )}
                </span>
              </span>
              <strong className="vr2">
                <span className="vrc">{r.worthIt ? "USD" : ""}</span>
                <span className="vrn">{ratio}</span>
              </strong>
            </div>
            <span className="mono vnote">
              Ejemplo con números de prueba: pon los de tu clínica. No es una promesa de resultados.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

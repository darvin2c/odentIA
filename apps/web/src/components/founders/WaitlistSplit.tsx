// «Pide tus USD 100» (Fundadores, issue 165; lienzo, tableros 2 y 3): a la izquierda la marca sobre
// la noche, con las 32 piezas de la portada y la acción de un agente, como entrar y crear cuenta; a la
// derecha la solicitud (`WaitlistForm`, la misma del final de cada guía). Al enviarla, la misma
// pantalla dice qué sigue.
import { AGENTS, CalmChartScene, CalmPulseScene, CalmToothScene, type DayEvent } from "@odentia/brand-scene"
import { useState } from "react"
import { ofProduct, WORDS } from "../../lib/product"
import { loginUrl } from "../../lib/site"
import WaitlistForm, { type WaitlistSent } from "./WaitlistForm"
import "./waitlist.css"

type Props = {
  /** El logotipo claro de la marca (SVG): la página no lleva cabecera y el logo va en el lado oscuro. */
  logo: string
  /** El regalo del plan Fundadores («USD 100»); null si el plan no tiene saldo de prueba. */
  gift: string | null
  discountPercent: number | null
  noFee: boolean
  /** Días hábiles para responder: las condiciones comerciales que rigen. */
  answerDays: number
}

export default function WaitlistSplit({ logo, gift, discountPercent, noFee, answerDays }: Props) {
  const [sent, setSent] = useState<WaitlistSent | null>(null)
  const [work, setWork] = useState<DayEvent | null>(null)

  const agent = work ? AGENTS[work.agent] : null
  return (
    <div className="wl">
      <aside className="wl-aside">
        <div className="wl-aside-copy">
          {/* El logo y, al lado, «Ingresar»: quien ya es cliente y llegó aquí entra en un toque. */}
          <div className="wl-top">
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: el logotipo es un SVG propio del repositorio. */}
            <a className="wl-logo" href="/" aria-label={`${WORDS.name}, inicio`} dangerouslySetInnerHTML={{ __html: logo }} />
            <a className="wl-login" href={loginUrl}>
              Ingresar
            </a>
          </div>
          {sent ? (
            <>
              <span className="mono wl-tag">[ Solicitud recibida ]</span>
              <p className="wl-title">
                Listo, {sent.firstName}.<br />
                <span className="wl-accent">{sent.clinicName} está en la lista.</span>
              </p>
            </>
          ) : (
            <>
              <span className="mono wl-tag">[ Programa Fundadores ]</span>
              <h1 className="wl-title">
                {gift ? (
                  <>
                    Los primeros <span className="gift wl-gift">{gift}</span> los pagamos nosotros.
                  </>
                ) : (
                  `Tu lugar en ${WORDS.name}.`
                )}
                <br />
                <span className="wl-accent">Tus agentes empiezan con tu invitación.</span>
              </h1>
              <ul className="wl-chips">
                {noFee ? <li>Sin cuota mensual</li> : null}
                {discountPercent ? (
                  <li>
                    {/* En el teléfono las ventajas van en una línea: «50 % menos». */}
                    <span className="wl-long">Acciones con </span>
                    {discountPercent} % menos
                  </li>
                ) : null}
                <li>Sin tarjeta</li>
              </ul>
            </>
          )}
        </div>
        {/* La escena del acceso de cada producto: las piezas de odentIA, el pulso de latidIA y la cartilla de vistIA. */}
        {ofProduct({
          dental: <CalmToothScene className="wl-scene" onWork={setWork} />,
          medical: <CalmPulseScene className="wl-scene" />,
          optical: <CalmChartScene className="wl-scene" />,
        })}
        {agent && work ? (
          <div className="wl-work">
            <span className="wl-dot" style={{ background: agent.color }} aria-hidden="true" />
            <strong>{agent.name}</strong>
            <span className="wl-what">{work.text}</span>
            <span className="mono wl-time">{work.time}</span>
          </div>
        ) : null}
      </aside>

      <div className="wl-main">
        <WaitlistForm variant="page" gift={gift} answerDays={answerDays} onSent={setSent} />
      </div>
    </div>
  )
}

import { ListeningIndicator } from "./listening-indicator.js"
import type { Meta, StoryObj } from "@storybook/react"
import { useEffect, useState, type ReactNode } from "react"

/**
 * Que se note que odentIA escucha: el micrófono entre los corchetes de la
 * marca, con barras que siguen el volumen real de la voz. El dictado de la
 * atención y el micrófono del agente y la Bandeja (SpeechInput) usan este
 * mismo indicador. El nivel de estas escenas es simulado; en producción sale
 * del micrófono con `useMicLevel`, nunca de una animación inventada.
 */
const meta = {
  title: "Identidad/Escuchando",
  parameters: { layout: "padded" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function SimulatedLevel({ children }: { children: (level: number) => ReactNode }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    let raf = 0
    const start = Date.now()
    const tick = () => {
      const seconds = (Date.now() - start) / 1000
      setLevel(Math.round((0.45 + 0.4 * Math.abs(Math.sin(seconds * 2.1) * Math.sin(seconds * 0.7))) * 20) / 20)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <>{children(level)}</>
}
function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex items-center gap-4 rounded-xl border bg-card p-4">
      <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-foreground">
        {children}
      </span>
      <div className="min-w-0">
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </section>
  )
}

export const Escuchando: Story = {
  render: () => (
    <SimulatedLevel>
      {(level) => (
        <Row title="Escuchando" hint="Las barras siguen la voz; en silencio quedan quietas. El estado se anuncia, los niveles no.">
          <ListeningIndicator state="listening" level={level} size="sm" />
        </Row>
      )}
    </SimulatedLevel>
  ),
}

export const EnPausa: Story = {
  render: () => (
    <Row title="En pausa" hint="Corchetes quietos y atenuados: se distingue de un vistazo.">
      <ListeningIndicator state="paused" size="sm" />
    </Row>
  ),
}

export const SinVoz: Story = {
  render: () => (
    <Row title="Sin voz" hint="Tras unos segundos sin captar voz aparece el aviso discreto del dictado.">
      <span className="flex flex-col items-center gap-1">
        <ListeningIndicator state="listening" level={0} size="sm" />
        <span role="status" className="text-[11px] text-muted-foreground">
          No te oigo; revisa el micrófono.
        </span>
      </span>
    </Row>
  ),
}

export const Tamanos: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <ListeningIndicator state="listening" level={0.6} size="sm" />
      <ListeningIndicator state="listening" level={0.6} size="md" />
      <ListeningIndicator state="paused" size="md" />
    </div>
  ),
}

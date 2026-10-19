import { ListeningIndicator } from "./listening-indicator.js"
import type { Meta, StoryObj } from "@storybook/react"
import { useEffect, useState, type ReactNode } from "react"

/**
 * Que se note que odentIA escucha (lienzo del dictado, opción A): la onda
 * entre los corchetes de la marca, con barras que siguen el volumen real de la voz. El dictado de la
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
      {children}
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
          <ListeningIndicator state="listening" level={level} size="md" />
        </Row>
      )}
    </SimulatedLevel>
  ),
}

export const EnPausa: Story = {
  render: () => (
    <Row title="En pausa" hint="Corchetes y puntos en gris, quietos: se distingue de un vistazo.">
      <ListeningIndicator state="paused" size="md" />
    </Row>
  ),
}

export const SinVoz: Story = {
  render: () => (
    <Row title="Sin voz" hint="Barras planas. Tras ocho segundos el dictado dice «No te oigo; revisa el micrófono» junto al título.">
      <ListeningIndicator state="listening" level={0} size="md" />
    </Row>
  ),
}

export const Tamanos: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <ListeningIndicator state="listening" level={0.6} size="sm" />
      <ListeningIndicator state="listening" level={0.6} size="md" />
      <ListeningIndicator state="paused" size="md" />
      <span className="inline-flex h-9 items-center rounded-full bg-destructive px-3 text-white">
        <ListeningIndicator state="listening" level={0.6} size="sm" color="inherit" announce={false} />
      </span>
    </div>
  ),
}

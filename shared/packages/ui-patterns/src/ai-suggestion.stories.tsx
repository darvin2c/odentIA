import { Badge, cn, Input, Textarea } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { X } from "lucide-react"
import { useId, useState } from "react"
import {
  AiQuestion,
  AiSuggestion,
  AiSuggestionBar,
  AiSuggestionChips,
  AiSuggestionMark,
  aiSuggestedClass,
} from "./ai-suggestion.js"
import { RadioChips } from "./radio-chips.js"

const meta = {
  title: "Patrones/Propuesta de la IA",
  component: AiSuggestion,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AiSuggestion>
export default meta
type Story = StoryObj<typeof meta>

const TEXTO =
  "Zapatilla de lona blanca, ligera y cómoda para todo el día. En blanca y negra. Calza normal. Si tienes el pie ancho, pide una talla más. De lona."
const PALABRAS = [
  { id: "urbana", label: "zapatilla urbana" },
  { id: "blanca", label: "zapatilla blanca" },
]
const CALCE = ["Normal", "Chico", "Grande"] as const

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 sm:p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  )
}

/** La ficha del producto con todas las formas de proponer: lo que la pantalla guarda lo cuenta abajo. */
function Ficha() {
  const nameId = useId()
  const calceId = useId()
  const plantillaId = useId()
  const textoId = useId()
  const [name, setName] = useState({ value: "Zapatilla de lona", proposed: true })
  const [texto, setTexto] = useState("Zapatilla de lona para el día a día. Suela gruesa.")
  const [prop, setProp] = useState<string | null>(TEXTO)
  const [palabras, setPalabras] = useState(["zapa blanca", "tenis"])
  const [sugeridas, setSugeridas] = useState(PALABRAS)
  const [calce, setCalce] = useState<string | null>(null)
  const [tramo, setTramo] = useState<null | { desde: number; precio: string }>({
    desde: 3,
    precio: "S/ 109",
  })
  const [tramos, setTramos] = useState([{ desde: 2, precio: "S/ 119" }])
  const [log, setLog] = useState("Nada se guardó todavía.")

  const pendientes = (name.proposed ? 1 : 0) + (prop ? 1 : 0) + sugeridas.length + (tramo ? 1 : 0)
  const aplicarTodo = () => {
    setName((n) => ({ ...n, proposed: false }))
    if (prop) setTexto(prop)
    setProp(null)
    setPalabras((p) => [...p, ...sugeridas.map((s) => s.label)])
    setSugeridas([])
    if (tramo) setTramos((t) => [...t, tramo])
    setTramo(null)
    setLog("Usaste todas las propuestas.")
  }

  return (
    <div className="min-h-screen bg-canvas px-4 py-6 sm:px-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <AiSuggestionBar count={pendientes} onAcceptAll={aplicarTodo}>
          La IA propone {pendientes} {pendientes === 1 ? "cambio" : "cambios"} y pregunta lo que no ve.
        </AiSuggestionBar>

        <Card title="Nombre y descripción para vender">
          <div className="flex flex-col gap-1.5">
            <div className="flex min-h-6 items-center gap-2">
              <label htmlFor={nameId} className="text-sm font-medium">
                Nombre
              </label>
              {name.proposed ? (
                <AiSuggestionMark
                  reason="Visto en las fotos: «Zapatilla de lona»."
                  onAccept={() => {
                    setName((n) => ({ ...n, proposed: false }))
                    setLog("Usaste el nombre propuesto.")
                  }}
                  onDiscard={() => {
                    setName({ value: "", proposed: false })
                    setLog("Descartaste el nombre propuesto.")
                  }}
                  fieldId={nameId}
                />
              ) : null}
            </div>
            <Input
              id={nameId}
              value={name.value}
              className={cn(name.proposed && aiSuggestedClass)}
              onChange={(e) => setName({ value: e.target.value, proposed: false })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={textoId} className="text-sm font-medium">
              Descripción para vender
            </label>
            <Textarea
              id={textoId}
              rows={2}
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
            />
            {prop ? (
              <AiSuggestion
                text={prop}
                onAccept={(t) => {
                  setTexto(t ?? "")
                  setProp(null)
                  setLog("Usaste el texto propuesto.")
                }}
                onDiscard={() => {
                  setProp(null)
                  setLog("Descartaste el texto propuesto.")
                }}
                acceptLabel="Usar este texto"
              />
            ) : null}
          </div>
        </Card>

        <Card title="Datos de calzado">
          <div className="flex flex-col gap-2">
            <span id={calceId} className="text-sm font-medium">
              Cómo calza
            </span>
            {calce ? (
              <RadioChips
                aria-labelledby={calceId}
                value={calce}
                options={CALCE.map((o) => ({ value: o, label: o }))}
                onChange={setCalce}
              />
            ) : (
              <AiQuestion
                question="¿Cómo calza?"
                reason="No se ve en las fotos."
                options={CALCE.map((o) => ({ value: o, label: o }))}
                onAnswer={(v) => {
                  setCalce(v)
                  setLog(`Respondiste: calza ${v.toLowerCase()}.`)
                }}
              />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={plantillaId} className="text-sm font-medium">
              Largo de la plantilla
            </label>
            <AiQuestion
              question="¿Cuánto mide la plantilla?"
              reason="No se ve en las fotos ni en la etiqueta."
              missing="el largo de la 38, en cm"
            >
              <Input
                id={plantillaId}
                inputMode="decimal"
                placeholder="24,5"
                className="w-28 bg-card"
                onBlur={(e) =>
                  e.target.value && setLog(`Plantilla de la 38: ${e.target.value} cm.`)
                }
              />
            </AiQuestion>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Cómo la buscan</span>
            <ul className="flex flex-wrap gap-1.5" aria-label="Palabras guardadas">
              {palabras.map((p) => (
                <li key={p}>
                  <Badge variant="secondary" className="h-8 gap-1 pr-1 text-[13px]">
                    {p}
                    <button
                      type="button"
                      aria-label={`Quitar «${p}»`}
                      className="rounded-full p-1 hover:bg-muted"
                      onClick={() => setPalabras((x) => x.filter((y) => y !== p))}
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
            <AiSuggestionChips
              aria-label="Palabras que propone la IA"
              items={sugeridas}
              onAccept={(id) => {
                const s = sugeridas.find((x) => x.id === id)
                if (s) setPalabras((p) => [...p, s.label])
                setSugeridas((x) => x.filter((y) => y.id !== id))
                setLog(`Usaste «${s?.label}».`)
              }}
              onDiscard={(id) => {
                setSugeridas((x) => x.filter((y) => y.id !== id))
                setLog("Descartaste una palabra propuesta.")
              }}
            />
          </div>
        </Card>

        <Card title="Precio por cantidad">
          <div className="flex flex-col gap-2">
            {tramos.map((t) => (
              <div
                key={t.desde}
                className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm"
              >
                <span className="text-muted-foreground">Desde</span>
                <b>{t.desde}</b>
                <span className="text-muted-foreground">a</span>
                <b>{t.precio}</b>
                <span className="ml-auto text-xs text-muted-foreground">c/u</span>
              </div>
            ))}
            {tramo ? (
              <AiSuggestion
                layout="row"
                reason="Quien compra 3 o más suele pedir rebaja. Con S/ 109 cada uno sigues sobre tu mínimo y ganas S/ 41 por par."
                onAccept={() => {
                  setTramos((t) => [...t, tramo])
                  setTramo(null)
                  setLog("Usaste el precio desde 3.")
                }}
                onDiscard={() => {
                  setTramo(null)
                  setLog("Descartaste el precio desde 3.")
                }}
                onChange={() => setLog("La pantalla abre el precio para cambiarlo.")}
              >
                Desde <b>{tramo.desde}</b> a <b>{tramo.precio}</b>
                <span className="text-muted-foreground"> · deja 38 % de margen</span>
              </AiSuggestion>
            ) : null}
          </div>
        </Card>

        <p role="status" className="text-sm text-muted-foreground">
          {log}
        </p>
      </div>
    </div>
  )
}

export const EnLaFicha: Story = {
  name: "En la ficha",
  render: () => <Ficha />,
  args: { onAccept: () => {}, onDiscard: () => {} },
}

export const Pensando: Story = {
  args: {
    pending: "Completando con las fotos y los datos…",
    onAccept: () => {},
    onDiscard: () => {},
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl p-6">
        <Story />
      </div>
    ),
  ],
}

export const TextoLargo: Story = {
  name: "Texto largo",
  args: {
    text: `${TEXTO} Plantilla acolchada que no aprieta el empeine, suela de caucho que no resbala en piso mojado y costuras reforzadas en la punta para que dure más de una temporada.`,
    reason: "Armado con las fotos y los datos de la ficha. Nunca incluye precios.",
    onAccept: () => {},
    onDiscard: () => {},
  },
  decorators: Pensando.decorators,
}

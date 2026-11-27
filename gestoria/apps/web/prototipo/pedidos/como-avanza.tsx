import { Badge, Button } from "@odentia/ui"
import { FlowDiagram, PageHeader, PageShell } from "@odentia/ui-patterns"
import { ArrowLeft, Bot, RotateCcw, UserRound, XCircle } from "lucide-react"
import { ir } from "../ruta"
import { PASO, type Paso } from "./modelo"

const PASOS: { s: Paso; es: string; mueve: string; solo: boolean; avisa?: string }[] = [
  {
    s: "por_pagar",
    es: "Sofi, el catálogo o el equipo armaron el pedido. El producto queda separado 24 horas.",
    mueve:
      "Paga en su link: la pasarela lo confirma sola. Si manda una captura de Yape o Plin, pasa a «Pago por confirmar».",
    solo: true,
  },
  {
    s: "por_confirmar",
    es: "Llegó una captura de Yape o Plin al número de la tienda.",
    mueve: "Una persona la mira en su app de Yape y toca «Confirmar» o «No coincide».",
    solo: false,
  },
  {
    s: "pagado",
    es: "El pago está confirmado, todo o una parte. Ya puede salir.",
    mueve: "Pasa solo a «Preparando» el día de la entrega, a las 8 a. m.",
    solo: true,
    avisa: "«¡Pago recibido!» y le ofrece sumar algo al mismo envío.",
  },
  {
    s: "preparando",
    es: "Sale hoy: hay que empacarlo.",
    mueve: "Una persona lo empaca y se lo da al repartidor, con su franja, en un toque.",
    solo: false,
  },
  {
    s: "por_salir",
    es: "Lo tiene el repartidor.",
    mueve: "El repartidor toca «Salí» en gestorIA Reparto.",
    solo: true,
  },
  {
    s: "en_camino",
    es: "Va a la casa de la clienta, o va por agencia con su número.",
    mueve:
      "El repartidor toca «Entregado», solo con el pago confirmado. Por agencia, se cierra cuando la clienta lo recoge.",
    solo: true,
    avisa: "«Tu pedido salió»: la franja y quién lo lleva.",
  },
  {
    s: "entregado",
    es: "Lo tiene la clienta. Ya no se cambia ni se anula.",
    mueve: "Si escribe «ya me llegó», también lo marca Sofi.",
    solo: true,
    avisa: "«¿Te llegó bien?»",
  },
]

/** La máquina de estados del pedido, clara: qué mueve cada paso solo y qué necesita a una persona. */
export function ComoAvanzaPage() {
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Cómo avanza un pedido"
        secondary={{
          label: "Volver a Pedidos",
          icon: <ArrowLeft aria-hidden />,
          onClick: () => ir("/pedidos"),
        }}
      />
      <p className="max-w-3xl text-sm text-muted-foreground">
        Casi todo avanza solo. Una persona entra en dos pasos (confirmar una captura y empacar) y
        cuando algo sale de lo normal. Una regla que no se salta: sin pago confirmado no se entrega.
      </p>
      <div className="elevated overflow-x-auto rounded-xl border bg-card p-4">
        <FlowDiagram
          label="Cómo avanza un pedido"
          main={[
            { id: "i", kind: "inicio", label: "Se arma el pedido" },
            { id: "d", kind: "decision", label: "¿Pagó con su link?" },
            { id: "p", kind: "paso", label: "Pagado", actor: "agente", actorLabel: "La pasarela" },
            {
              id: "pr",
              kind: "paso",
              label: "Preparando",
              actor: "agente",
              actorLabel: "gestorIA, ese día",
            },
            {
              id: "ps",
              kind: "paso",
              label: "Por salir",
              actor: "persona",
              actorLabel: "Una persona: empaca",
            },
            {
              id: "ec",
              kind: "paso",
              label: "En camino",
              actor: "persona",
              actorLabel: "El repartidor: «Salí»",
            },
            {
              id: "en",
              kind: "paso",
              label: "Entregado",
              actor: "persona",
              actorLabel: "El repartidor, con el pago confirmado",
            },
            { id: "f", kind: "fin", label: "Listo" },
          ]}
          otherwise={[
            {
              id: "c",
              kind: "paso",
              label: "Pago por confirmar",
              actor: "persona",
              actorLabel: "Una persona, con la captura",
            },
            {
              id: "c2",
              kind: "paso",
              label: "O paga al recibir",
              actor: "persona",
              actorLabel: "El repartidor cobra en la puerta",
            },
          ]}
          yesLabel="Sí"
          noLabel="Yape, Plin o al recibir"
        />
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Cada paso, qué lo mueve</h2>
        <ol className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {PASOS.map((x) => (
            <li
              key={x.s}
              className="elevated flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm"
            >
              <span className="flex items-center gap-2">
                <Badge variant={PASO[x.s].tono}>{PASO[x.s].label}</Badge>
                <span
                  className={
                    x.solo
                      ? "ml-auto inline-flex items-center gap-1 text-xs text-success"
                      : "ml-auto inline-flex items-center gap-1 text-xs text-warning"
                  }
                >
                  {x.solo ? (
                    <Bot className="size-3.5" aria-hidden />
                  ) : (
                    <UserRound className="size-3.5" aria-hidden />
                  )}
                  {x.solo ? "Avanza solo" : "Necesita a una persona"}
                </span>
              </span>
              <span>{x.es}</span>
              <span className="text-muted-foreground">
                <b className="font-medium text-foreground">Lo mueve: </b>
                {x.mueve}
              </span>
              {x.avisa ? (
                <span className="text-muted-foreground">Sofi avisa: {x.avisa}</span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Las salidas</h2>
        <ul className="grid gap-2 md:grid-cols-3">
          {[
            [
              RotateCcw,
              "No se entregó",
              "El repartidor toca «No estaba». Vuelve a «Por salir»; Sofi le escribe para otro día. Lo pagado sigue pagado.",
            ],
            [
              XCircle,
              "Anulado",
              "Solo, si pasan 24 horas sin pago: el producto se libera. O una persona, con motivo. Uno entregado no se anula.",
            ],
            [
              RotateCcw,
              "Cambio o devolución",
              "Después de entregar: un pedido nuevo, enlazado. El entregado no se toca; lo que vuelve entra al stock con su motivo.",
            ],
          ].map(([I, t, d]) => {
            const Icon = I as typeof XCircle
            return (
              <li key={t as string} className="flex gap-3 rounded-xl border bg-card p-4 text-sm">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <b>{t as string}</b>
                  <span className="block text-muted-foreground">{d as string}</span>
                </span>
              </li>
            )
          })}
        </ul>
      </section>
      <Button variant="outline" className="self-start" onClick={() => ir("/pedidos")}>
        Ver los pedidos
      </Button>
    </PageShell>
  )
}

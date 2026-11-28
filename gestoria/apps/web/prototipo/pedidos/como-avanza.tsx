import { Badge, Button } from "@odentia/ui"
import { FlowDiagram, PageHeader, PageShell } from "@odentia/ui-patterns"
import { ArrowLeft, Bot, RotateCcw, UserRound, XCircle } from "lucide-react"
import { href, ir } from "../ruta"
import { PASO, type Paso } from "./modelo"

const PASOS: { s: Paso; es: string; mueve: string; solo: boolean; avisa?: string }[] = [
  {
    s: "por_pagar",
    es: "Sofi, el catálogo o el equipo armaron el pedido. El producto queda separado 24 horas.",
    mueve:
      "Paga en su link: la pasarela lo confirma sola. Sofi le recuerda el link una sola vez, 3 horas antes de que venza. Si manda una captura de Yape o Plin, pasa a «Pago por confirmar».",
    solo: true,
  },
  {
    s: "por_confirmar",
    es: "Llegó una captura de Yape o Plin al número de la tienda.",
    mueve:
      "Una persona la mira en su app de Yape y confirma lo que llegó. Si falta algo, Sofi le cobra el resto sola, con su link.",
    solo: false,
  },
  {
    s: "pagado",
    es: "El pago está confirmado, todo o una parte. Ya puede salir.",
    mueve:
      "Pasa solo a «Preparando» el día de la entrega, a las 8 a. m., y gestorIA asigna al repartidor de siempre según la zona y la franja.",
    solo: true,
    avisa: "«¡Pago recibido!» y le ofrece sumar algo al mismo envío.",
  },
  {
    s: "preparando",
    es: "Sale hoy y ya tiene repartidor: hay que empacarlo.",
    mueve: "Una persona toca «Empacar», mira lo que va en el paquete y confirma «Listo: se lo di a Kevin».",
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

const VUELTA: [string, string, boolean, string][] = [
  [
    "Solicitado",
    "Sofi, sola",
    true,
    "La clienta escribe. Sofi pide el motivo (y la foto si vino fallado), revisa el plazo y las reglas, y ofrece lo que dice tu política.",
  ],
  [
    "Aprobado",
    "Una persona: lo confirma en el cajón",
    false,
    "Sofi pasa el caso armado como un tema, con el chat. Dentro de la política: «Aprobar». Fuera: la excepción, con su motivo.",
  ],
  [
    "Por recoger o en camino",
    "gestorIA y el repartidor",
    true,
    "gestorIA asigna el recojo por zona y franja; el repartidor toca «Recoger» con la foto. O lo trae a la tienda, o llega por agencia.",
  ],
  [
    "Recibido y revisado",
    "Una persona",
    false,
    "«Se puede vender» vuelve al stock. «Dañado» o «Garantía» no vuelve, con su motivo en el kardex.",
  ],
  [
    "Cambio, dinero o saldo",
    "Solo, salvo el dinero",
    true,
    "El cambio sale solo; el saldo a favor queda solo. El dinero: con la pasarela, al aprobarlo; con Yape o Plin, la persona toca «Ya lo devolví».",
  ],
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
        Casi todo avanza solo. A una persona solo le queda empacar (lo confirma en el cajón, con lo que va en el paquete a la vista), confirmar capturas de
        Yape o Plin, aprobar los cambios y devoluciones que deja listos Sofi, revisar lo que vuelve
        y los casos raros, como no tener repartidor libre. Una regla que no se salta: sin pago
        confirmado no se entrega.
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
              actorLabel: "gestorIA: ese día, con repartidor",
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
        <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
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
              "Tiene su propio camino de vuelta (abajo). Sofi lo atiende según tu política y lo deja listo para aprobarlo en su cajón.",
            ],
            [
              UserRound,
              "No hay repartidor libre",
              "gestorIA no encuentra a nadie en esa franja: va a «Te toca» para elegir otra franja, otro día o que lo recojan.",
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
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">El camino de vuelta: cambios y devoluciones</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Todo depende de tu política. El pedido entregado no se toca: el cambio o la devolución va
          enlazado, con sus propios pasos. Con la casilla de Configuración › Sofi marcada (viene
          así), Sofi te pasa el caso listo; si la desmarcas, hace sola lo que está dentro de tu
          política.
        </p>
        <ol className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
          {VUELTA.map(([t, quien, solo, d], i) => (
            <li key={t} className="elevated flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
              <span className="flex items-center gap-2">
                <span className="flex size-5 items-center justify-center rounded-full border text-[11px] font-semibold">
                  {i + 1}
                </span>
                <b>{t}</b>
              </span>
              <span
                className={
                  solo
                    ? "inline-flex items-center gap-1 text-xs text-success"
                    : "inline-flex items-center gap-1 text-xs text-warning"
                }
              >
                {solo ? <Bot className="size-3.5" aria-hidden /> : <UserRound className="size-3.5" aria-hidden />}
                {quien}
              </span>
              <span className="text-muted-foreground">{d}</span>
            </li>
          ))}
        </ol>
        <a href={href("/pedidos/politica")} className="self-start text-sm font-medium text-primary hover:underline">
          Ver tu política de cambios y devoluciones
        </a>
      </section>
      <Button variant="outline" className="self-start" onClick={() => ir("/pedidos")}>
        Ver los pedidos
      </Button>
    </PageShell>
  )
}

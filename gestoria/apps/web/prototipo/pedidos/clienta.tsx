import { Badge, Button, cn, useIsMobile } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { PageHeader, PageShell } from "@odentia/ui-patterns"
import {
  ArrowLeft,
  Check,
  Clock,
  CreditCard,
  ExternalLink,
  Lock,
  Plus,
  Smartphone,
  X,
} from "lucide-react"
import { type CSSProperties, useState } from "react"
import { foto, RUBROS } from "../datos"
import { href, ir, useRuta } from "../ruta"
import { Logo, marca, PhoneFrame, SofiMini } from "../vitrina/marcos"
import {
  avisar,
  cuentas,
  money,
  mover,
  nuevoId,
  type Pedido,
  trasPagar,
  usePedidos,
} from "./modelo"

/** Los pasos que ve la clienta en su link: pocos, con su hora. */
function pasosClienta(p: Pedido) {
  const at = (s: string) => [...p.eventos].reverse().find((e) => e.paso === s)?.cuando
  const pagado = cuentas(p).confirmado > 0 || p.cobro === "al_recibir"
  const orden = ["por_pagar", "pagado", "preparando", "en_camino", "entregado"]
  const i = Math.max(
    orden.indexOf(
      p.paso === "por_confirmar" ? "por_pagar" : p.paso === "por_salir" ? "preparando" : p.paso,
    ),
    0,
  )
  return [
    { l: "Confirmado", t: at("por_pagar"), ok: true },
    {
      l: p.cobro === "al_recibir" && !cuentas(p).confirmado ? "Pagas al recibir" : "Pagado",
      t: at("pagado"),
      ok: pagado && i >= 1,
    },
    { l: "Preparando", t: at("preparando"), ok: i >= 2 },
    {
      l: p.entrega.tipo === "agencia" ? `Salió por ${p.entrega.agencia}` : "Salió",
      t: at("en_camino"),
      ok: i >= 3,
    },
    {
      l: p.entrega.tipo === "agencia" ? "Lo recogiste" : "Entregado",
      t: at("entregado"),
      ok: i >= 4,
    },
  ]
}

/** El link de la clienta: el mismo carrito antes y después de pagar. */
function SuLink({ p, rubro }: { p: Pedido; rubro: keyof typeof RUBROS }) {
  const R = RUBROS[rubro]
  const m = marca(R)
  const k = cuentas(p)
  const [pasarela, setPasarela] = useState(false)
  const [medio, setMedio] = useState<"yape" | "tarjeta">("yape")
  const [sumado, setSumado] = useState(false)
  const n = p.clienta.split(" ")[0]
  const extra = R.products()[6] ?? R.products()[1]
  const porPagar = p.paso !== "anulado" && k.falta > 0 && p.cobro !== "al_recibir"
  const pagar = () => {
    mover(
      rubro,
      p.id,
      (x) => {
        x.pagos.push({
          id: nuevoId("pg"),
          medio: "link",
          monto: cuentas(x).falta,
          estado: "confirmado",
          cuando: "Hoy · ahora",
          quien: "la pasarela",
        })
        x.paso = trasPagar(x)
        x.toca = undefined
        avisar(
          x,
          "pagado",
          sumado
            ? `¡Listo, ${n}! Sumamos tu ${extra?.name.toLowerCase()} al mismo envío.`
            : `¡Pago recibido, ${n}! Sale el ${x.entrega.dia?.toLowerCase()} entre ${x.entrega.franja}. Lo sigues en este mismo link.`,
        )
      },
      {
        actor: "pasarela",
        quien: "La pasarela",
        texto: `Confirmó ${money(k.falta)} con ${medio === "yape" ? "Yape" : "tarjeta"} dentro del link. Nadie revisó nada.`,
        paso: "pagado",
      },
    )
    setPasarela(false)
  }
  const sumar = () => {
    if (!extra) return
    const c = extra.colors[0]
    const mm = extra.media.find((x) => x.kind === "foto") ?? extra.media[0]
    mover(
      rubro,
      p.id,
      (x) => {
        x.lineas.push({
          id: nuevoId("l"),
          pid: extra.id,
          nombre: extra.name,
          variante: [c?.name, extra.sizes[2]].filter(Boolean).join(" · "),
          qty: 1,
          precio: extra.list,
          foto: mm ? (mm.kind === "video" ? (mm.poster ?? "") : mm.src) : "",
        })
      },
      {
        actor: "clienta",
        quien: n,
        texto: `Sumó ${extra.name.toLowerCase()} al mismo pedido desde su link, antes de que salga.`,
      },
    )
    setSumado(true)
  }
  const pasos = pasosClienta(p)
  return (
    <div className="vv" style={{ ...m.style, height: "100%", overflowY: "auto" } as CSSProperties}>
      <div className="hd gut" style={{ position: "sticky" }}>
        <Logo R={R} size={34} />
        <div className="grow" style={{ minWidth: 0 }}>
          <p className="hd-name">{R.store.name}</p>
          <p className="hd-sub">
            <Lock className="mr-1 inline size-3" aria-hidden />
            {R.store.slug}.gestoria24.com/carrito/V8R2
          </p>
        </div>
      </div>
      <div className="gut flex flex-col gap-3 py-4">
        <div className="flex items-baseline justify-between">
          <p className="text-[19px] font-bold" style={{ fontFamily: "var(--vv-display)" }}>
            {porPagar ? "Tu carrito" : "Tu pedido"} {p.id}
          </p>
          <span className="text-xs" style={{ color: "var(--vv-ink-2)" }}>
            {n} · {p.entrega.zona}
          </span>
        </div>

        {p.paso === "anulado" ? (
          <div className="box" style={{ background: "var(--vv-brand-soft)" }}>
            <b>Este carrito venció.</b>
            <span className="text-sm">
              Lo tuvimos separado 24 horas. Escríbenos y Sofi te lo cotiza de nuevo, con el precio y
              el stock de hoy.
            </span>
          </div>
        ) : porPagar ? (
          <div
            className="box flex-row items-center gap-2"
            style={{ background: "var(--vv-brand-soft)" }}
          >
            <Clock className="size-4 shrink-0" aria-hidden />
            <span className="text-sm">
              Separado para ti hasta <b>{p.separadoHasta?.split("· ")[1] ?? "mañana"}</b>
            </span>
          </div>
        ) : (
          <ol className="box gap-0" aria-label="Cómo va tu pedido">
            {pasos.map((s, i) => (
              <li key={s.l} className="flex gap-3">
                <span className="flex flex-col items-center">
                  <span
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full border-2 text-[11px]",
                      s.ok ? "border-transparent text-white" : "border-[var(--vv-line)]",
                    )}
                    style={s.ok ? { background: "var(--vv-brand)" } : undefined}
                  >
                    {s.ok ? <Check className="size-3.5" aria-hidden /> : null}
                  </span>
                  {i < pasos.length - 1 ? (
                    <span
                      className="my-0.5 h-5 w-0.5"
                      style={{ background: s.ok ? "var(--vv-brand)" : "var(--vv-line)" }}
                    />
                  ) : null}
                </span>
                <span className="pb-2 text-sm">
                  <b className={s.ok ? "" : "font-medium opacity-60"}>{s.l}</b>
                  {s.ok && s.t ? (
                    <span className="block text-xs" style={{ color: "var(--vv-ink-2)" }}>
                      {s.t}
                    </span>
                  ) : null}
                  {s.l === "Salió" && s.ok && p.paso === "en_camino" ? (
                    <span className="block text-xs">
                      Llega hoy entre {p.entrega.franja}. Te lo lleva <b>{p.entrega.repartidor}</b>,
                      en moto.
                    </span>
                  ) : null}
                  {s.l.startsWith("Salió por") && s.ok ? (
                    <span className="block text-xs">
                      Número de envío {p.entrega.numero} ·{" "}
                      <span style={{ color: "var(--vv-brand)" }}>
                        Ver en {p.entrega.agencia}{" "}
                        <ExternalLink className="inline size-3" aria-hidden />
                      </span>
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}

        <div className="box gap-2">
          {p.lineas.map((l) => (
            <div key={l.id} className="flex items-center gap-3">
              {l.foto ? (
                <img src={foto(l.foto)} alt="" className="size-12 rounded-xl object-cover" />
              ) : null}
              <span className="min-w-0 flex-1 text-sm">
                <b className="block truncate">{l.vuelve ? `Devuelves: ${l.nombre}` : l.nombre}</b>
                <span style={{ color: "var(--vv-ink-2)" }}>{l.variante}</span>
              </span>
              <span className="text-sm tabular-nums">
                {l.vuelve ? `− ${money(l.precio)}` : money(l.precio * l.qty)}
              </span>
            </div>
          ))}
          <div
            className="flex justify-between border-t pt-2 text-sm"
            style={{ borderColor: "var(--vv-line)" }}
          >
            <span>Envío a {p.entrega.zona}</span>
            <span>{p.entrega.envio ? money(p.entrega.envio) : "Gratis"}</span>
          </div>
          <div className="flex justify-between text-[15px] font-bold">
            <span>{k.pagado ? "Pagado" : k.confirmado ? "Te falta pagar" : "Total"}</span>
            <span>
              {k.pagado ? money(k.total) : k.confirmado ? money(k.falta) : money(k.total)}
            </span>
          </div>
        </div>

        {porPagar ? (
          <button type="button" className="btn" onClick={() => setPasarela(true)}>
            Pagar ahora {money(k.falta)}
          </button>
        ) : null}
        {porPagar ? (
          <p className="text-center text-xs" style={{ color: "var(--vv-ink-2)" }}>
            Con Yape o tarjeta, en la página segura de la pasarela.
          </p>
        ) : null}

        {!porPagar &&
        p.paso !== "anulado" &&
        ["pagado", "preparando"].includes(p.paso) &&
        extra &&
        !sumado ? (
          <div className="box gap-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold">
              <SofiMini size={16} />
              ¿Le sumas algo? Va en el mismo envío
            </p>
            <div className="flex items-center gap-3">
              <img
                src={foto(
                  (extra.media.find((x) => x.kind === "foto") ?? extra.media[0])?.src ?? "",
                )}
                alt=""
                className="size-12 rounded-xl object-cover"
              />
              <span className="min-w-0 flex-1 text-sm">
                <b className="block truncate">{extra.name}</b>
                {money(extra.list)}
              </span>
              <button type="button" className="btn line sm" onClick={sumar}>
                <Plus className="size-4" aria-hidden />
                Sumar
              </button>
            </div>
          </div>
        ) : null}
        {p.paso !== "anulado" ? (
          <button type="button" className="btn line sm">
            Escribir a la tienda
          </button>
        ) : null}
        <p className="text-center text-[11px]" style={{ color: "var(--vv-ink-2)" }}>
          Solo se ve tu nombre, tu distrito y lo que llevas. Nunca tu dirección ni tu teléfono.
        </p>
      </div>

      {pasarela ? (
        <div
          className="absolute inset-0 z-20 flex flex-col bg-white text-[#18181b]"
          role="dialog"
          aria-label="Página de la pasarela"
        >
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Lock className="size-4" aria-hidden />
            <span className="flex-1 text-sm font-semibold">Pasarela de pago</span>
            <button type="button" aria-label="Volver al carrito" onClick={() => setPasarela(false)}>
              <X className="size-5" aria-hidden />
            </button>
          </div>
          <div className="flex flex-col gap-4 p-4">
            <p className="text-sm text-[#52525b]">
              {R.store.name} · Pedido {p.id}
              <b className="block text-2xl text-[#18181b]">{money(k.falta)}</b>
            </p>
            {(
              [
                ["yape", "Yape", "Tu celular y el código de aprobación de tu app.", Smartphone],
                [
                  "tarjeta",
                  "Tarjeta de crédito o débito",
                  "Los datos los pide la pasarela, nunca la tienda.",
                  CreditCard,
                ],
              ] as const
            ).map(([v, l, d, I]) => (
              <label
                key={v}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-xl border p-3",
                  medio === v && "border-[#18181b] ring-1 ring-[#18181b]",
                )}
              >
                <input
                  type="radio"
                  name="medio"
                  checked={medio === v}
                  onChange={() => setMedio(v)}
                  className="mt-1"
                />
                <I className="mt-0.5 size-5" aria-hidden />
                <span className="text-sm">
                  <b className="block">{l}</b>
                  <span className="text-[#52525b]">{d}</span>
                </span>
              </label>
            ))}
            <button
              type="button"
              onClick={pagar}
              className="h-12 rounded-xl bg-[#18181b] text-[15px] font-semibold text-white"
            >
              Pagar {money(k.falta)}
            </button>
            <p className="text-center text-xs text-[#52525b]">
              Prototipo: no se cobra nada. Con el diseño y la marca de la pasarela que use la
              tienda.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** El WhatsApp de la clienta: lo que habló con Sofi y los avisos de los momentos clave. */
function SuWhatsApp({ p, rubro }: { p: Pedido; rubro: keyof typeof RUBROS }) {
  const R = RUBROS[rubro]
  const m = marca(R)
  const msgs = [
    ...p.chat.map((c, i) => ({
      who: c.de === "clienta" ? "me" : "so",
      text: c.texto,
      h: c.hora,
      card: i === p.chat.length - 1 && c.de === "sofi" && c.texto.includes("carrito"),
    })),
    // Los avisos que no están ya en la conversación (el carrito, si Sofi ya lo mandó ahí).
    ...p.avisos
      .filter(
        (a) =>
          !(a.clave === "link" && p.chat.some((c) => c.texto.includes("carrito"))) &&
          !p.chat.some((c) => c.texto === a.texto),
      )
      .map((a) => ({
        who: "so",
        text: a.texto,
        h: a.cuando.split("· ")[1] ?? "",
        card: a.clave === "link",
      })),
  ]
  return (
    <div className="vv" style={{ ...m.style, height: "100%" } as CSSProperties}>
      <div className="ch">
        <div className="ch-head gut">
          <ArrowLeft className="size-5 shrink-0" aria-hidden />
          <Logo R={R} size={38} />
          <div className="grow" style={{ minWidth: 0 }}>
            <p style={{ fontWeight: 700, lineHeight: 1.2 }}>{R.store.name}</p>
            <p className="ch-sub">Cuenta de empresa · responde Sofi</p>
          </div>
        </div>
        <p className="ch-strip">Prototipo: no se envía nada.</p>
        <div className="ch-body">
          {msgs.map((mm, i) => (
            <div key={i} className={cn("msg", mm.who)} style={{ animation: "none" }}>
              {mm.who === "so" ? (
                <p className="who">
                  <SofiMini size={16} />
                  Sofi
                </p>
              ) : null}
              <span>{mm.text}</span>
              {"card" in mm && mm.card ? (
                <span className="lp">
                  {p.lineas[0]?.foto ? <img src={foto(p.lineas[0].foto)} alt="" /> : null}
                  <span>
                    <b>Tu carrito en {R.store.name}</b>
                    <span style={{ fontSize: 13, color: "var(--vv-ink-2)" }}>
                      {money(cuentas(p).total)} · Pagar ahora
                    </span>
                    <span>{R.store.slug}.gestoria24.com/carrito/V8R2</span>
                  </span>
                </span>
              ) : null}
              <span className="h">{mm.h}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Lo que ve la clienta: su WhatsApp y su link, el mismo antes y después de pagar. */
export function ClientaPage() {
  const { rubro, q } = useRuta()
  const all = usePedidos(rubro)
  const isMobile = useIsMobile()
  const [tab, setTab] = useState<"link" | "chat">("link")
  const p = all.find((x) => x.id === (q.get("p") ?? "0165")) ?? all[0]!
  const elegibles = all.filter((x) => x.origen.k !== "equipo" || x.avisos.length)
  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader
        title={`Lo que ve ${p.clienta.split(" ")[0]}`}
        secondary={{
          label: "Volver al pedido",
          icon: <ArrowLeft aria-hidden />,
          onClick: () => ir(`/pedidos/${p.id}`),
        }}
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Pedido</span>
        {elegibles.slice(0, 8).map((x) => (
          <a
            key={x.id}
            href={href("/clienta", { extra: `p=${x.id}` })}
            className={cn(
              "rounded-full border px-3 py-1",
              x.id === p.id
                ? "border-primary bg-primary-soft font-semibold text-primary-soft-foreground"
                : "bg-card",
            )}
          >
            {x.id} · {x.clienta.split(" ")[0]}
          </a>
        ))}
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Un solo link por compra: el mismo carrito que le mandó Sofi sirve para pagar y, ya pagado,
        para seguir el pedido. Sofi le escribe solo en los momentos clave. Toca «Pagar ahora» y mira
        cómo cambia el pedido en la tienda.
      </p>
      {isMobile ? (
        <>
          <ToggleGroup
            value={[tab]}
            onValueChange={(v) => v[0] && setTab(v[0] as "link" | "chat")}
            className="w-full rounded-full bg-muted p-1"
            aria-label="Qué ver"
          >
            {(
              [
                ["link", "Su link"],
                ["chat", "Su WhatsApp"],
              ] as const
            ).map(([v, l]) => (
              <ToggleGroupItem
                key={v}
                value={v}
                className="h-8 flex-1 rounded-full text-[13px] font-medium data-pressed:bg-background data-pressed:shadow-xs"
              >
                {l}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="relative h-[700px] overflow-hidden rounded-2xl border">
            {tab === "link" ? (
              <SuLink key={p.id} p={p} rubro={rubro} />
            ) : (
              <SuWhatsApp p={p} rubro={rubro} />
            )}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-6">
          <div className="flex flex-col items-center gap-2">
            <Badge variant="secondary">Su link</Badge>
            <PhoneFrame height={760}>
              <SuLink key={p.id} p={p} rubro={rubro} />
            </PhoneFrame>
          </div>
          <div className="flex flex-col items-center gap-2">
            <Badge variant="secondary">Su WhatsApp</Badge>
            <PhoneFrame height={760}>
              <SuWhatsApp p={p} rubro={rubro} />
            </PhoneFrame>
          </div>
        </div>
      )}
      <Button
        variant="outline"
        className="self-start"
        onClick={() => ir(`/pedidos/${p.id}`)}
      >
        Ver el pedido en la tienda
      </Button>
    </PageShell>
  )
}

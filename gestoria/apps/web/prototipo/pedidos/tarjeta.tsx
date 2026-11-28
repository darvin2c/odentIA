import { Badge, Button, cn } from "@odentia/ui"
import { DetailDrawer } from "@odentia/ui-patterns"
import { Check, UserRound } from "lucide-react"
import { foto } from "../datos"
import { abrirCajon } from "./cajon"
import { queSigue } from "./detalle"
import { cuentas, entregaTexto, money, PASO, type Pedido, teToca, tocaDe } from "./modelo"

/**
 * La tarjeta de un pedido en dos filas, la misma de Despachos. Arriba, el pedido: la foto, la
 * clienta y el número, la etapa y el cobro, lo que lleva y la entrega. Abajo, lo que toca: una
 * frase y, si toca a una persona, su único botón. Tocar cualquier parte abre el cajón «pedido +
 * lo que toca»; nada se hace en un toque.
 */

/** La etapa del pedido y, si algo vuelve, la de su cambio o devolución. Con el nombre de Pedidos. */
export function EtapaBadge({ p }: { p: Pedido }) {
  if (p.rechazo)
    return p.rechazo.enTienda ? (
      <Badge variant="secondary">De vuelta en la tienda</Badge>
    ) : (
      <Badge variant="destructive">Vuelve a la tienda</Badge>
    )
  const v = p.vuelta
  if (!v || v.estado === "cerrado" || v.estado === "rechazado")
    return <Badge variant={PASO[p.paso].tono}>{PASO[p.paso].label}</Badge>
  const t = v.tipo === "cambio" ? "Cambio" : "Devolución"
  const e =
    v.estado === "solicitado"
      ? "por aprobar"
      : v.estado === "recibido"
        ? "por revisar"
        : v.estado === "revisado"
          ? "por devolver"
          : v.como.startsWith("recojo")
            ? "por recoger"
            : "en vuelta"
  return (
    <Badge variant="warning">
      {t} {e}
    </Badge>
  )
}

/** «Pagado», «Falta S/ 27», «Al recibir S/ 139»: aparte de la etapa, y sin repetir «Pagado». */
export function CobroCorto({ p }: { p: Pedido }) {
  const k = cuentas(p)
  if (p.paso === "anulado" || p.vuelta) return null
  if (p.rechazo)
    return k.cargos ? <span className="font-medium text-warning">Viaje {money(k.cargos)} a su saldo</span> : null
  if (k.pagado)
    return p.paso === "pagado" ? null : <span className="font-medium text-success">Pagado</span>
  if (k.alRecibir && !k.confirmado)
    return <span className="font-medium text-warning">Al recibir {money(k.total)}</span>
  return <span className="font-medium text-warning">Falta {money(k.falta || k.porConfirmar)}</span>
}

const lleva = (p: Pedido) => {
  const va = p.lineas.filter((l) => !l.vuelve)
  const l = va[0] ?? p.lineas[0]
  if (!l) return ""
  return `${l.nombre} · ${l.variante}${va.length > 1 ? ` · +${va.length - 1}` : ""}`
}

export function TarjetaPedido({ p, onAbrir }: { p: Pedido; onAbrir: (p: Pedido) => void }) {
  const t = tocaDe(p)
  const sigue = t ? null : queSigue(p).texto
  const nombre = `${p.clienta}, pedido ${p.id}: ${PASO[p.paso].label}`
  return (
    // Toda la tarjeta abre el cajón; con el teclado, la primera fila y el botón son los botones.
    // biome-ignore lint/a11y/useKeyWithClickEvents: el teclado usa los botones de adentro.
    <li
      onClick={() => onAbrir(p)}
      className="flex list-none flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary"
    >
      <button
        type="button"
        aria-label={`Abrir: ${nombre}`}
        className="flex w-full items-start gap-3 p-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {p.lineas[0]?.foto ? (
          <img src={foto(p.lineas[0].foto)} alt="" className="size-12 shrink-0 rounded-lg bg-muted object-cover" />
        ) : (
          <span className="size-12 shrink-0 rounded-lg bg-muted" />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-semibold">{p.clienta}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{p.id}</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
            <EtapaBadge p={p} />
            <CobroCorto p={p} />
          </span>
          <span className="truncate text-[13px]">{lleva(p)}</span>
          {p.paso !== "anulado" ? (
            <span className="truncate text-[13px] text-muted-foreground">{entregaTexto(p.entrega)}</span>
          ) : null}
        </span>
      </button>
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-2.5 py-2",
          t ? "bg-warning-soft/60" : "bg-muted/40",
        )}
      >
        <p className="flex min-w-[11rem] flex-1 items-start gap-1.5 text-[13px] leading-snug">
          {t ? (
            <UserRound aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          ) : (
            <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
          )}
          <span className={t ? "" : "text-muted-foreground"}>{t ? t.texto : `Sigue solo: ${sigue}`}</span>
        </p>
        {t ? (
          <Button type="button" className="ml-auto h-11 shrink-0 px-4 whitespace-nowrap" aria-label={`${t.boton}: ${p.clienta}`}>
            {t.boton}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/** «Te toca»: lo que necesita a una persona, en tarjetas de dos filas. Cada una abre su cajón. */
export function TeTocaLista({
  list,
  className,
  alAbrir,
}: {
  list: Pedido[]
  className?: string
  /** Antes de abrir el cajón (por ejemplo, cerrar el panel) y al volver de él. */
  alAbrir?: { antes: () => void; despues: () => void }
}) {
  const toca = teToca(list)
  if (!toca.length)
    return (
      <p className="flex items-center gap-2 rounded-2xl bg-success-soft px-4 py-3 text-sm text-success">
        <Check aria-hidden className="size-4" />
        Nada te espera. Lo demás avanza solo.
      </p>
    )
  return (
    <ul className={cn("grid gap-3", className)}>
      {toca.map((p) => (
        <TarjetaPedido
          key={p.id}
          p={p}
          onAbrir={(x) => {
            alAbrir?.antes()
            abrirCajon(x.id, undefined, alAbrir ? { alCerrar: alAbrir.despues } : {})
          }}
        />
      ))}
    </ul>
  )
}

/** El panel de «Te toca» que abre el botón del encabezado de Pedidos. */
export function TeTocaPanel({ list, open, setOpen }: { list: Pedido[]; open: boolean; setOpen: (v: boolean) => void }) {
  const n = teToca(list).length
  return (
    <DetailDrawer
      open={open}
      dock={false}
      size="lg"
      onClose={() => setOpen(false)}
      title={`Te toca · ${n}`}
      description="Lo que necesita a una persona. Lo demás avanza solo. Cada tarjeta abre su pedido con lo que toca."
    >
      <TeTocaLista
        list={list}
        className="grid-cols-1"
        alAbrir={{
          antes: () => setOpen(false),
          // Al cerrar el cajón, vuelve aquí: lo que sigue en la lista.
          despues: () => setOpen(true),
        }}
      />
    </DetailDrawer>
  )
}

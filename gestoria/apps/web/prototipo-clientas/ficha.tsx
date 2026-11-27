import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
} from "@odentia/ui"
import {
  DetailField,
  DetailList,
  PageHeader,
  PageNotice,
  PageShell,
  PersonAvatar,
} from "@odentia/ui-patterns"
import { ArrowLeft, History, Lock, MessageCircle, Pencil, Repeat } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import {
  ACC,
  ACCIONES,
  type Clienta,
  encargoDe,
  type Dato,
  type DatoKey,
  fecha,
  foto,
  META,
  nombre,
  perfil,
  plural,
  quienEs,
  RUBROS,
  soles,
} from "./datos"
import { cambiar, corregir, planOf, useDb } from "./estado"
import { CampanaHecha, EncargoCard, enviosDe } from "./campanas"
import { DeArgos, SegBadge, Tarjeta } from "./piezas"
import { ir, useRuta } from "./ruta"

const FUENTE: Record<Dato["fuente"], string> = {
  chat: "del chat",
  pedido: "de sus pedidos",
  respuesta: "de cómo responde",
  equipo: "",
}

/** Un dato de la clienta: lo que es, de dónde lo sacó Argos, «Corregir» y su historial. */
function DatoRow({
  c,
  k,
  label,
  dato,
  vacio,
}: {
  c: Clienta
  k: DatoKey
  label: string
  dato?: Dato
  vacio: string
}) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const quien = ruta.ventas ? R.store.ventas : R.store.owner
  const [edit, setEdit] = useState(false)
  const [v, setV] = useState(dato?.valor ?? "")
  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {dato?.dudas ? <Badge variant="warning">Por confirmar</Badge> : null}
        {dato?.fijo ? (
          <Badge variant="secondary" className="gap-1">
            <Lock className="size-3" aria-hidden />
            Lo puso la tienda
          </Badge>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          {dato && dato.hist.length > 0 ? (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Historial de ${label.toLowerCase()}`}
                  />
                }
              >
                <History aria-hidden />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 gap-2">
                <p className="text-sm font-semibold">{label}: historial</p>
                <ol className="flex flex-col gap-2">
                  {dato.hist.map((h, i) => (
                    <li
                      key={i}
                      className="flex flex-col border-t pt-2 text-sm first:border-t-0 first:pt-0"
                    >
                      <span className="font-medium">{h.valor}</span>
                      <span className="text-xs text-muted-foreground">
                        {h.cuando} · {h.quien} · {h.nota}
                      </span>
                    </li>
                  ))}
                </ol>
              </PopoverContent>
            </Popover>
          ) : null}
          {!edit ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setV(dato?.valor ?? "")
                setEdit(true)
              }}
            >
              <Pencil aria-hidden />
              Corregir
            </Button>
          ) : null}
        </span>
      </div>
      {edit ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!v.trim()) return
            corregir(ruta.rubro, c.id, k, v.trim(), quien)
            setEdit(false)
            toast.success("Guardado. Argos no lo vuelve a cambiar.")
          }}
        >
          <Input
            autoFocus
            value={v}
            onChange={(e) => setV(e.target.value)}
            aria-label={label}
            className="min-w-40 flex-1"
          />
          <Button type="submit" size="sm">
            Guardar
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEdit(false)}>
            Cancelar
          </Button>
        </form>
      ) : dato ? (
        <>
          <span className="font-medium">{dato.valor}</span>
          {dato.fijo ? (
            <span className="text-xs text-muted-foreground">
              {dato.de} el {dato.cuando}. Argos no lo vuelve a pisar.
            </span>
          ) : (
            <DeArgos>
              Argos lo anotó{" "}
              {dato.fuente === "chat"
                ? dato.de.startsWith("el ")
                  ? `del ${dato.de.slice(3)}`
                  : `de ${dato.de}`
                : FUENTE[dato.fuente]}
              {dato.cita ? <>: «{dato.cita}»</> : <> · {dato.cuando}</>}
            </DeArgos>
          )}
          {dato.dudas ? (
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              Usa {dato.valor} mientras tanto. ¿Cuál es?
              {dato.dudas.map((o) => (
                <Button
                  key={o}
                  size="xs"
                  variant="outline"
                  onClick={() => corregir(ruta.rubro, c.id, k, o, quien)}
                >
                  {o}
                </Button>
              ))}
            </span>
          ) : null}
        </>
      ) : (
        <span className="text-sm text-muted-foreground">{vacio}</span>
      )}
    </div>
  )
}

function Mini({
  label,
  children,
  hint,
  wide,
}: {
  label: string
  children: ReactNode
  hint?: ReactNode
  wide?: boolean
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg bg-surface-muted/60 p-3",
        wide && "sm:col-span-2",
      )}
    >
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 font-semibold">{children}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  )
}

/** ¿Es la misma clienta? Argos lo sugiere; unir lo decide una persona. */
function Comparar({ a, b, onClose }: { a: Clienta; b: Clienta; onClose: () => void }) {
  const ruta = useRuta()
  const lado = (c: Clienta) => (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm">
      <span className="flex items-center gap-2 font-semibold">
        <PersonAvatar name={c.name} className="size-8" decorative />
        {c.name}
      </span>
      <span className="text-muted-foreground">
        {c.ch.map((x) => (x === "wa" ? "WhatsApp" : "Instagram")).join(" · ")} {c.phone || c.ig}
      </span>
      {c.buys.slice(0, 2).map((x, i) => (
        <span key={i}>
          {fecha(x.d)} · {x.p.name} {x.p.color} {x.size}
        </span>
      ))}
    </div>
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>¿Es la misma clienta?</DialogTitle>
          <DialogDescription>
            Argos lo sugiere: el mismo nombre, la misma talla y la misma zapatilla. Nunca las une
            solo, ni por el teléfono.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {lado(a)}
          {lado(b)}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              cambiar(ruta.rubro, (d) => {
                d.distinct = true
              })
              onClose()
              toast.success("Anotado: son dos clientas. No se vuelve a preguntar.")
            }}
          >
            No, son distintas
          </Button>
          <Button
            onClick={() => {
              cambiar(ruta.rubro, (d) => {
                d.merged = true
                const x = d.cl.find((c) => c.id === b.id)
                const y = d.cl.find((c) => c.id === a.id)
                if (!x || !y) return
                x.oculta = true
                y.buys.push(...x.buys)
                if (!y.ch.includes("ig")) y.ch.push("ig")
                y.ig = x.ig
                if (x.ig)
                  y.datos.ig = {
                    valor: x.ig,
                    fuente: "chat",
                    de: "la ficha que se unió",
                    cuando: "27 nov",
                    quien: "Argos",
                    hist: [
                      {
                        cuando: "27 nov",
                        quien: "Argos",
                        valor: x.ig,
                        nota: "De la ficha de Instagram que se unió",
                      },
                    ],
                  }
              })
              onClose()
              toast.success("Listo: una sola ficha. Se puede separar desde su historia.")
            }}
          >
            Sí, es la misma
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** La ficha de una clienta: quién es, lo que Argos sabe y calcula, cuándo escribirle y lo que hace con ella. */
export function FichaPage({ id }: { id: string }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb(ruta.rubro)
  const [comparar, setComparar] = useState(false)
  const c = d.cl.find((x) => x.id === id && !x.oculta)
  const unida = d.cl.find((x) => x.id === id)?.parecida
  // Una ficha que se unió a otra abre la que quedó, sin una pantalla de por medio.
  useEffect(() => {
    if (!c) ir(unida ? `/clientes/${unida}` : "/clientes")
  }, [c, unida])
  if (!c) return null
  const k = perfil(c)
  const plan = planOf(ruta.rubro)
  const otra = c.parecida ? d.cl.find((x) => x.id === c.parecida && !x.oculta) : undefined
  const mostrarParecida = otra && !d.merged && !d.distinct
  const respondio = c.hist.filter((h) => h[2] !== "Sin respuesta").length
  const compro = c.hist.filter((h) => h[2] === "Compró").length
  const proximos = ACCIONES.flatMap((a) => {
    const e = plan[a.id].to.find((x) => x.c.id === c.id)
    return e ? [{ a, e }] : []
  })
  const fuera = ACCIONES.flatMap((a) =>
    plan[a.id].out.filter((o) => o.c.id === c.id).map((o) => o.why),
  )[0]
  const ventanaGratis = c.lastH < 24
  const mias = enviosDe(d, R, plan).filter((e) => e.c.id === c.id)
  const chatRes = (): ReactNode => {
    if (c.id === "c5")
      return d.paid ? (
        <Badge variant="success">Compró {soles(R.nuevo.price)}</Badge>
      ) : d.chat.rocio >= 3 ? (
        <Badge variant="warning">Pidió · pago por confirmar</Badge>
      ) : d.chat.rocio > 0 ? (
        <Badge variant="secondary">Respondió</Badge>
      ) : (
        <Badge variant="outline">Sin respuesta aún</Badge>
      )
    if (c.consent.estado === "baja")
      return <Badge variant="destructive">Pidió que no le escriban</Badge>
    return <Badge variant="outline">Sin respuesta aún</Badge>
  }

  return (
    <PageShell className="flex flex-col gap-5">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => ir("/clientes")}>
          <ArrowLeft aria-hidden />
          Clientes
        </Button>
      </div>
      <PageHeader
        title={c.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <SegBadge seg={k.seg} />
            <span className="text-foreground">
              {quienEs(c, k, R).split(" · ").slice(1).join(" · ")}
            </span>
          </span>
        }
        primary={{
          label: "Escribirle",
          icon: <MessageCircle aria-hidden />,
          onClick: () => ir("/conversaciones"),
        }}
        secondary={
          k.n
            ? {
                label: "Repetir pedido",
                icon: <Repeat aria-hidden />,
                onClick: () =>
                  toast("«Repetir pedido» arma uno igual al último, con el precio de hoy."),
              }
            : undefined
        }
      />
      {mostrarParecida ? (
        <PageNotice
          tone="aviso"
          label="Por mirar"
          action={
            <Button size="sm" variant="outline" onClick={() => setComparar(true)}>
              Comparar
            </Button>
          }
        >
          Argos cree que «{otra.name}» de {otra.ch[0] === "ig" ? "Instagram" : "WhatsApp"} es ella.
          Unirlas lo decide una persona.
        </PageNotice>
      ) : null}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_27rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <Tarjeta
            title="Lo que Argos sabe de ella"
            subtitle="Lo anota solo, de sus chats y sus pedidos. Si corriges algo, queda tuyo."
          >
            <div className="grid gap-x-8 md:grid-cols-2">
              <div className="flex flex-col">
                <DatoRow
                  c={c}
                  k="talla"
                  label={R.field}
                  dato={c.datos.talla}
                  vacio="Todavía no lo dijo"
                />
                <DatoRow
                  c={c}
                  k="distrito"
                  label="Distrito"
                  dato={c.datos.distrito}
                  vacio="Sin entregas todavía"
                />
                <DatoRow
                  c={c}
                  k="cumple"
                  label="Cumpleaños"
                  dato={c.datos.cumple}
                  vacio="Solo si ella lo dice"
                />
              </div>
              <div className="flex flex-col border-t pt-3 md:border-t-0 md:pt-0">
                <DatoRow c={c} k="canal" label="Canal preferido" dato={c.datos.canal} vacio="—" />
                <DatoRow
                  c={c}
                  k="ig"
                  label="Instagram"
                  dato={c.datos.ig}
                  vacio="No escribió por Instagram"
                />
                <DatoRow
                  c={c}
                  k="gustos"
                  label="Lo que le gusta"
                  dato={c.datos.gustos}
                  vacio="Argos lo anota cuando lo diga"
                />
              </div>
            </div>
          </Tarjeta>
          <Tarjeta
            title="Lo que Argos calcula"
            subtitle="Con sus pedidos pagados, cada noche. Nadie la mueve a mano."
          >
            {k.n ? (
              <div className="grid gap-2.5 sm:grid-cols-2">
                <Mini label="Su grupo" hint={k.why} wide>
                  <SegBadge seg={k.seg} />
                </Mini>
                <Mini label="Gasto total" hint={plural(k.n, "compra", "compras")}>
                  {soles(k.total)}
                </Mini>
                <Mini
                  label="Ticket promedio"
                  hint={k.ritmo ? `compra cada ${k.ritmo} días` : "una sola compra"}
                >
                  {soles(k.avg)}
                </Mini>
                <Mini label="Lo que compra" wide>
                  <span className="flex flex-wrap gap-1.5 font-normal">
                    {[...k.cats, ...k.colors.slice(0, 2), ...k.sizes.slice(0, 2)].map(([x, n]) => (
                      <Badge key={x} variant="outline">
                        {x} ×{n}
                      </Badge>
                    ))}
                  </span>
                </Mini>
                <Mini label="Precio" hint={k.sens ? k.sensWhy : "sin rebaja en sus compras"}>
                  {k.sens ? k.sens[0]!.toUpperCase() + k.sens.slice(1) : "Paga el precio normal"}
                </Mini>
                <Mini
                  label="Cómo responde a Sofi"
                  hint={
                    c.hist.length
                      ? compro
                        ? `compró ${compro} ${compro === 1 ? "vez" : "veces"}`
                        : "todavía no compró por una campaña"
                      : "sin campañas todavía"
                  }
                >
                  {c.hist.length
                    ? `Respondió ${respondio} de ${c.hist.length}`
                    : "Aún no le escribió"}
                </Mini>
                {c.asked.length || c.cart ? (
                  <Mini label="Lo que quiso y no compró" wide>
                    <span className="flex flex-col gap-0.5 font-normal">
                      {c.asked.map((a) => (
                        <span key={a.text}>
                          {a.text} · {a.why} · {fecha(a.d)}
                        </span>
                      ))}
                      {c.cart ? (
                        <span>
                          Carrito sin pagar: {R.P[c.cart.slot]!.name.toLowerCase()}{" "}
                          {R.P[c.cart.slot]!.color} · {soles(R.P[c.cart.slot]!.price)} · hace{" "}
                          {c.cart.h} h
                        </span>
                      ) : null}
                    </span>
                  </Mini>
                ) : null}
              </div>
            ) : (
              <div className="grid gap-2.5 sm:grid-cols-2">
                <Mini label="Su grupo" hint={k.why} wide>
                  <SegBadge seg="sin" />
                </Mini>
                <Mini label="Lo que quiso y no compró" wide>
                  <span className="font-normal">
                    {c.asked.map((a) => `${a.text} · ${fecha(a.d)}`).join(" · ")}
                  </span>
                </Mini>
              </div>
            )}
          </Tarjeta>
          {k.n ? (
            <Tarjeta title="Compras">
              <ul className="flex flex-col divide-y">
                {[...c.buys]
                  .sort((a, b) => a.d - b.d)
                  .map((b, i) => (
                    <li key={i} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                      {b.p.photo ? (
                        <img
                          src={foto(b.p.photo)}
                          alt=""
                          className="size-11 rounded-lg bg-muted object-cover"
                        />
                      ) : (
                        <span className="size-11 rounded-lg bg-muted" aria-hidden />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col text-sm">
                        <span className="truncate font-medium">
                          {b.p.name} {b.p.color} · {b.size}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {fecha(b.d)}
                          {b.reb ? " · con rebaja" : b.liq ? " · en liquidación" : ""}
                        </span>
                        {b.argos ? (
                          <span className="text-xs text-primary">
                            {b.pedido ? `Pedido ${b.pedido} · ` : ""}Venta de la campaña «
                            {ACC[b.argos].t(R)}»{b.motivo ? ` · porque ${b.motivo}` : ""}
                          </span>
                        ) : null}
                      </span>
                      <span className="font-medium tabular-nums">{soles(b.price)}</span>
                    </li>
                  ))}
              </ul>
            </Tarjeta>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <Tarjeta
            title="Sus campañas"
            subtitle="Argos decide la campaña y se la encarga a Sofi. Sofi le escribe, conversa y vende."
          >
            {mias
              .filter((e) => e.cuandoTipo === "hara")
              .map((e) => (
                <EncargoCard
                  key={e.a}
                  e={encargoDe(e.a, c, R)}
                  estado={
                    <Badge variant={e.resTexto.startsWith("Sofi") ? "soft" : "warning"}>
                      {ruta.ventas && e.resTexto.startsWith("Espera el sí")
                        ? `Sofi le escribe ${ACC[e.a].when}`
                        : e.resTexto}
                    </Badge>
                  }
                />
              ))}
            {!mias.some((e) => e.cuandoTipo === "hara") && fuera && !c.sentWeek ? (
              <p className="text-sm text-muted-foreground">
                Esta semana no le toca ninguna: {fuera[0]?.toLowerCase()}
                {fuera.slice(1)}.
              </p>
            ) : null}
            {mias.filter((e) => e.cuandoTipo !== "hara").length ? (
              <ol className="flex flex-col divide-y">
                {mias
                  .filter((e) => e.cuandoTipo !== "hara")
                  .map((e) => (
                    <li key={`${e.a}-${e.cuando}`} className="py-3 first:pt-0 last:pb-0">
                      <CampanaHecha
                        e={e}
                        R={R}
                        accion={
                          e.chat ? (
                            <span>
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() => ir(`/conversaciones/${e.chat}`)}
                              >
                                Ver la conversación
                              </Button>
                            </span>
                          ) : null
                        }
                      />
                    </li>
                  ))}
              </ol>
            ) : null}
          </Tarjeta>
          <Tarjeta title="Cuándo se le puede escribir">
            <DetailList columns={1}>
              <DetailField label="Promociones">
                <span className="flex flex-col gap-1">
                  {c.consent.estado === "si" ? (
                    <Badge variant="success">Acepta</Badge>
                  ) : c.consent.estado === "baja" ? (
                    <Badge variant="destructive">Pidió que no le escriban</Badge>
                  ) : (
                    <Badge variant="outline">Sin permiso todavía</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">{c.consent.nota}</span>
                </span>
              </DetailField>
              <DetailField label="Por dónde">
                {c.ch.includes("wa")
                  ? "WhatsApp"
                  : "Solo Instagram: ahí no se le puede escribir primero"}
              </DetailField>
              <DetailField label="Esta semana">
                {c.sentWeek ? `1 de ${d.tope}` : `0 de ${d.tope}`}{" "}
                {d.tope === 1 ? "mensaje" : "mensajes"} (el tope de la tienda)
              </DetailField>
              {ruta.ventas ? null : (
                <DetailField label="Si le escribe hoy, Meta cobra">
                  {c.consent.estado !== "si" || !c.ch.includes("wa")
                    ? "No se le escribe"
                    : ventanaGratis
                      ? `Nada: escribió hace ${c.lastH} h`
                      : `${soles(META)}, con plantilla`}
                </DetailField>
              )}
            </DetailList>
          </Tarjeta>
        </div>
      </div>
      {comparar && otra ? <Comparar a={c} b={otra} onClose={() => setComparar(false)} /> : null}
    </PageShell>
  )
}

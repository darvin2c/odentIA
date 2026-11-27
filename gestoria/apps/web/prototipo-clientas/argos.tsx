import { Badge, Button, Checkbox, cn, Input, Label, toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import {
  DataTable,
  DetailDrawer,
  KpiCard,
  PageHeader,
  PageNotice,
  PageShell,
  PersonAvatar,
  RadioChips,
  UsageMeter,
  ViewTabs,
} from "@odentia/ui-patterns"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Lock, Minus, Pause, Play, Plus } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import {
  CampanaHecha,
  type Cifras,
  cifrasDe,
  EncargoCard,
  type EnvioC,
  enviosDe,
  ResBadge,
  retorno,
} from "./campanas"
import {
  ACC,
  ACCIONES,
  type AccionId,
  costo,
  encargoDe,
  mensaje,
  nombre,
  type PlanAccion,
  perfil,
  plural,
  RUBROS,
  SEG,
  SEG_IDS,
  soles,
} from "./datos"
import { cambiar, type Db, planOf, useDb } from "./estado"
import { Burbuja, DeArgos, ICONOS, SegBadge, Tarjeta } from "./piezas"
import { href, ir, useRuta } from "./ruta"

type Tab = "hizo" | "hara" | "campanas" | "reglas"

export function totales(plan: Record<AccionId, PlanAccion>, d: Db) {
  let msgs = 0
  let cost = 0
  let est = 0
  let espera = 0
  let esperaCost = 0
  const ppl = new Set<string>()
  for (const a of ACCIONES) {
    if (d.pausa[a.id]) continue
    for (const e of plan[a.id].to) {
      if (e.estado === "presupuesto") {
        espera++
        esperaCost += e.cost
        continue
      }
      if (e.estado === "permiso") continue
      msgs++
      cost += e.cost
      est += e.k.avg * plan[a.id].rate
      ppl.add(e.c.id)
    }
  }
  return { msgs, cost, est, ppl: ppl.size, espera, esperaCost }
}

/** Lo único que espera a una persona aquí: el gasto que pasa el presupuesto de Meta. */
function EsperaTuSi({ d, t }: { d: Db; t: ReturnType<typeof totales> }) {
  const ruta = useRuta()
  if (!t.espera) return null
  const pasa = d.used + t.cost + t.esperaCost - d.budget
  return (
    <PageNotice
      tone="alarma"
      label="Espera tu sí"
      action={
        <span className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              cambiar(ruta.rubro, (x) => {
                x.budgetOk = true
              })
              toast.success(
                `Listo: Sofi les escribe hoy a ${plural(t.espera, "una clienta más", `${t.espera} clientas más`)}, dentro del horario.`,
              )
            }}
          >
            Dejar que salgan
          </Button>
          <Button size="sm" variant="outline" onClick={() => ir("/argos/reglas")}>
            Cambiar el presupuesto
          </Button>
        </span>
      }
    >
      {plural(t.espera, "encargo pasa", "encargos pasan")} el presupuesto de Meta de noviembre (
      {soles(d.budget)}) por {soles(Math.max(0.01, pasa))}. Argos no gasta de más sin tu sí; lo
      demás sale solo.
    </PageNotice>
  )
}

/* ------------------------------------------------------------------ lo que hizo */

function LoQueHizo({ d }: { d: Db }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const envios = enviosDe(d, R, planOf(ruta.rubro))
  const semana = envios.filter((e) => e.cuandoTipo === "semana")
  const todas = ACCIONES.map((a) => cifrasDe(a.id, d))
  const tot = todas.reduce(
    (s, x) => ({
      rec: s.rec + x.recibieron,
      resp: s.resp + x.respondieron,
      comp: s.comp + x.compraron,
      vend: s.vend + x.vendido,
    }),
    { rec: 0, resp: 0, comp: 0, vend: 0 },
  )
  const anotados = d.cl.reduce(
    (n, c) => n + Object.values(c.datos).filter((x) => x?.quien === "Argos").length,
    0,
  )
  const mariela = d.cl.find((c) => c.id === "c1")
  const jimena = d.cl.find((c) => c.id === "c10")
  const fio = d.cl.find((c) => c.id === "c8")
  const rocio = d.cl.find((c) => c.id === "c5")
  type Ev = { when: string; text: ReactNode; badge?: ReactNode; to?: string }
  const evs: Ev[] = [
    ...(d.paid && rocio
      ? [
          {
            when: "Hoy · 10:21",
            text: (
              <>
                Pasó a <b>{rocio.name}</b> de Dormida a {SEG[perfil(rocio).seg].label}: pagó el
                pedido 0161 de la campaña «{ACC.despertar.t(R)}».
              </>
            ),
            to: "/clientes/c5",
          },
        ]
      : []),
    ...(fio?.consent.estado === "baja"
      ? [
          {
            when: "Hoy · 09:48",
            text: (
              <>
                Anotó que <b>{fio.name}</b> no quiere promociones: se lo dijo a Sofi en el chat.
              </>
            ),
            badge: <Badge variant="destructive">Baja</Badge>,
            to: "/clientes/c8",
          },
        ]
      : []),
    {
      when: "Hoy · 06:00",
      text: (
        <>
          Revisó los grupos de {plural(d.cl.filter((c) => !c.oculta).length, "clienta", "clientas")}
          : <b>Andrea Castillo</b> pasó a En riesgo.
        </>
      ),
      to: "/clientes/c3",
    },
    ...semana
      .slice()
      .sort((a, b) => (a.cuando < b.cuando ? 1 : -1))
      .map((e) => ({
        when: e.cuando,
        text: (
          <>
            Le encargó a Sofi la campaña «{ACC[e.a].t(R)}» para <b>{e.c.name}</b>: {e.motivo}.
          </>
        ),
        badge: <ResBadge e={e} />,
        to: e.chat ? `/conversaciones/${e.chat}` : `/clientes/${e.c.id}`,
      })),
    ...(jimena?.datos.talla
      ? [
          {
            when: "Mar 25",
            text: (
              <>
                Anotó la {R.field.toLowerCase()} de <b>{jimena.name}</b>: {jimena.datos.talla.valor}
                , del chat («{jimena.datos.talla.cita}»).
              </>
            ),
            to: "/clientes/c10",
          },
        ]
      : []),
    ...(mariela
      ? [
          {
            when: "Vie 20",
            text: (
              <>
                Anotó de <b>{mariela.name}</b> su {R.field.toLowerCase()} y su cumpleaños, del chat.
                La talla quedó por confirmar: «{R.cita(R.sizes[3] ?? "", R.sizes[4] ?? "")}».
              </>
            ),
            badge: mariela.datos.talla?.dudas ? (
              <Badge variant="warning">Por confirmar</Badge>
            ) : (
              <Badge variant="secondary">Confirmada</Badge>
            ),
            to: "/clientes/c1",
          },
        ]
      : []),
  ]
  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Las cifras de Argos" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard
          title="Vendió con sus campañas"
          value={soles(tot.vend)}
          description={`${plural(tot.comp, "pedido pagado", "pedidos pagados")} en 4 semanas`}
        />
        <KpiCard
          title="Encargos a Sofi"
          value={tot.rec}
          description={`le respondieron ${Math.round((tot.resp / tot.rec) * 100)} %`}
        />
        <KpiCard
          title="Datos que anotó"
          value={anotados}
          description="de chats, pedidos y respuestas"
        />
        <KpiCard
          title="Gastó en Meta"
          value={soles(d.used)}
          description={`de ${soles(d.budget)} este mes`}
          meter={{
            value: d.used,
            total: d.budget,
            tone: d.used / d.budget > 0.9 ? "danger" : "primary",
          }}
        />
      </section>
      <Tarjeta
        title={`Esta semana, Sofi escribió a ${plural(semana.length, "clienta", "clientas")} por encargo de Argos`}
        subtitle="Lo que hizo Argos solo, lo más nuevo arriba."
        action={
          <Button variant="outline" size="sm" onClick={() => ir("/argos/campanas")}>
            Ver las campañas
          </Button>
        }
      >
        <ol className="flex flex-col divide-y">
          {evs.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: la lista es fija en cada dibujo
            <li key={i} className="entra flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
              <span className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">{e.when}</span>
                <span className="ml-auto">{e.badge}</span>
              </span>
              <span className="text-sm leading-relaxed">
                {e.text}{" "}
                {e.to ? (
                  <a href={href(e.to)} className="text-primary underline-offset-4 hover:underline">
                    Ver
                  </a>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </Tarjeta>
    </div>
  )
}

/* ------------------------------------------------------------------ lo que hará */

function Encargos({ a, onClose }: { a: AccionId; onClose: () => void }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  useDb(ruta.rubro)
  const pl = planOf(ruta.rubro)[a]
  const quitadas = pl.out.filter((o) => o.why === "La quitaste tú")
  const otras = pl.out.filter((o) => o.why !== "La quitaste tú")
  const fila = (cId: string, on: boolean, estado?: string) => {
    const c = [...pl.to.map((e) => e.c), ...quitadas.map((o) => o.c)].find((x) => x.id === cId)!
    const cost = costo(c)
    return (
      <li
        key={c.id}
        className={cn(
          "flex flex-col gap-2 border-t py-4 first:border-t-0 first:pt-0",
          !on && "opacity-55",
        )}
      >
        <span className="flex flex-wrap items-center gap-2">
          <PersonAvatar name={c.name} className="size-8" decorative />
          <span className="font-medium">{c.name}</span>
          <SegBadge seg={perfil(c).seg} />
          <span className="ml-auto flex items-center gap-2 text-sm font-medium">
            <Checkbox
              aria-label={`Encargárselo a Sofi para ${c.name}`}
              checked={on}
              onCheckedChange={(v) =>
                cambiar(ruta.rubro, (x) => {
                  const s = x.skip[a] ?? []
                  x.skip[a] = v ? s.filter((id) => id !== c.id) : [...s, c.id]
                })
              }
            />
            Encargar
          </span>
        </span>
        <EncargoCard
          e={encargoDe(a, c, R)}
          estado={
            estado === "presupuesto" ? (
              <Badge variant="warning">Espera tu sí</Badge>
            ) : (
              <Badge variant="soft">{cost ? `Meta ${soles(cost)}` : "Sin costo en Meta"}</Badge>
            )
          }
        />
        <span className="text-xs font-medium text-muted-foreground">
          Lo primero que le escribe Sofi
        </span>
        <Burbuja plantilla={cost ? ACC[a].tpl : null}>{mensaje(a, c, R)}</Burbuja>
      </li>
    )
  }
  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={ACC[a].t(R)}
      description={`${plural(pl.to.length, "encargo", "encargos")} a Sofi · Meta ${pl.cost ? soles(pl.cost) : "sin costo"} · ${ACC[a].when}`}
      closeLabel="Listo"
    >
      <ul className="flex flex-col">
        {pl.to.map((e) => fila(e.c.id, true, e.estado))}
        {quitadas.map((o) => fila(o.c.id, false))}
      </ul>
      {otras.length ? (
        <div className="mt-4 flex flex-col gap-2 rounded-lg bg-surface-muted/60 p-3 text-sm">
          <span className="font-semibold">No entran esta vez</span>
          {otras.map((o) => (
            <span key={o.c.id} className="flex flex-col">
              <span className="font-medium">{o.c.name}</span>
              <span className="text-xs text-muted-foreground">{o.why}</span>
            </span>
          ))}
        </div>
      ) : null}
    </DetailDrawer>
  )
}

function Tarea({
  a,
  pl,
  d,
  onVer,
}: {
  a: (typeof ACCIONES)[number]
  pl: PlanAccion
  d: Db
  onVer: () => void
}) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const I = ICONOS[a.id]
  const n = pl.to.length
  const ex = pl.to[0]
  const pausa = !!d.pausa[a.id]
  const espera = pl.to.filter((e) => e.estado === "presupuesto").length
  const permiso = pl.to.some((e) => e.estado === "permiso")
  if (!ex) return null
  return (
    <article
      className={cn(
        "entra elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5",
        pausa && "bg-surface-muted/40",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground">
          <I className="size-[18px]" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="font-semibold">{a.t(R)}</h3>
          <p className="text-xs text-muted-foreground">{a.who(R)}</p>
        </div>
        {pausa ? (
          <Badge variant="secondary">En pausa</Badge>
        ) : permiso ? (
          <Badge variant="warning">Te pide permiso</Badge>
        ) : (
          <Badge variant="success">Sale sola</Badge>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="A quiénes">
        {pl.to.slice(0, 5).map((e) => (
          <Badge key={e.c.id} variant="outline">
            {nombre(e.c)}
          </Badge>
        ))}
        {n > 5 ? <Badge variant="outline">y {n - 5} más</Badge> : null}
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">Por qué {nombre(ex.c)}: </span>
        {encargoDe(a.id, ex.c, R).porque}.
      </p>
      <Burbuja
        plantilla={ex.cost ? a.tpl : null}
        pie={`Sofi le escribe a ${nombre(ex.c)}`}
        botones={
          ["recuperar", "despertar", "nuevo"].includes(a.id)
            ? ["Sí, mándame", "Ahora no"]
            : undefined
        }
        className={cn(pausa && "opacity-55")}
      >
        {ex.text}
      </Burbuja>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>
          A <b className="text-foreground">{plural(n, "clienta", "clientas")}</b>
        </span>
        <span>
          Meta <b className="text-foreground">{pl.cost ? soles(pl.cost) : "sin costo"}</b>
        </span>
        <span>
          Venta estimada <b className="text-foreground">≈ {soles(Math.round(pl.est))}</b>
        </span>
      </p>
      <p className="text-sm">
        {pausa
          ? "En pausa: Argos no se la encarga a Sofi hasta que la reanudes."
          : permiso
            ? d.ok[a.id]
              ? `Aprobada · Sofi les escribe ${a.when}.`
              : "Pediste que te consulte antes: espera tu permiso."
            : espera
              ? `Sofi les escribe ${a.when}. ${plural(espera, "encargo espera", "encargos esperan")} tu sí: pasan el presupuesto.`
              : `Sofi les escribe ${a.when}.`}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            cambiar(ruta.rubro, (x) => {
              x.pausa[a.id] = !pausa
            })
          }
        >
          {pausa ? <Play aria-hidden /> : <Pause aria-hidden />}
          {pausa ? "Reanudar" : "Pausar"}
        </Button>
        {permiso && !d.ok[a.id] ? (
          <Button
            size="sm"
            onClick={() =>
              cambiar(ruta.rubro, (x) => {
                x.ok[a.id] = true
              })
            }
          >
            Aprobar
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onVer}>
          {n === 1 ? "Ver el encargo" : `Ver los ${n} encargos`}
        </Button>
      </div>
    </article>
  )
}

function LoQueHara({ d }: { d: Db }) {
  const ruta = useRuta()
  const plan = planOf(ruta.rubro)
  const t = totales(plan, d)
  const [ver, setVer] = useState<AccionId | null>(null)
  return (
    <div className="flex flex-col gap-5">
      <section aria-label="La semana de Argos" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard
          title="Encargos a Sofi"
          value={t.msgs}
          description={`a ${plural(t.ppl, "clienta", "clientas")} · tope ${d.tope} por clienta`}
        />
        <KpiCard
          title="Costo en Meta"
          value={soles(t.cost)}
          description={`quedan ${soles(Math.max(0, d.budget - d.used))} de ${soles(d.budget)} este mes`}
        />
        <KpiCard
          title="Venta estimada"
          value={`≈ ${soles(Math.round(t.est))}`}
          description="con lo que vendió cada campaña antes"
        />
        <KpiCard
          title="Esperan tu sí"
          value={t.espera}
          description={t.espera ? "pasan el presupuesto de Meta" : "nada: todo sale solo"}
        />
      </section>
      <div className="grid items-start gap-4 md:grid-cols-2">
        {ACCIONES.map((a) => (
          <Tarea key={a.id} a={a} pl={plan[a.id]} d={d} onVer={() => setVer(a.id)} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Datos de ejemplo. Meta cobra S/ 0,2339 por mensaje de promoción en Perú (desde el 1 de
        octubre de 2026). Si ella escribió en las últimas 24 h, Sofi le responde sin plantilla: Meta
        no cobra las primeras 1 000 del mes.
      </p>
      {ver ? <Encargos a={ver} onClose={() => setVer(null)} /> : null}
    </div>
  )
}

/* ---------------------------------------------------------------------- campañas */

interface FilaC {
  id: AccionId
  t: string
  x: Cifras
}

function Campana({ a, onClose }: { a: AccionId; onClose: () => void }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb(ruta.rubro)
  const x = cifrasDe(a, d)
  const env = enviosDe(d, R, planOf(ruta.rubro)).filter((e) => e.a === a)
  const grupo = (titulo: string, lista: EnvioC[], hara?: boolean) =>
    lista.length ? (
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{titulo}</h3>
        <ol className="flex flex-col divide-y">
          {lista.map((e) => (
            <li key={`${e.c.id}-${e.cuando}`} className="flex flex-col gap-2 py-3 first:pt-0">
              <span className="flex items-center gap-2">
                <PersonAvatar name={e.c.name} className="size-8" decorative />
                <a href={href(`/clientes/${e.c.id}`)} className="font-medium hover:underline">
                  {e.c.name}
                </a>
                <span className="ml-auto">
                  {hara ? <Badge variant="soft">{e.resTexto}</Badge> : null}
                </span>
              </span>
              {hara ? (
                <span className="text-sm">
                  <span className="text-muted-foreground">Por qué: </span>
                  {e.motivo}.
                </span>
              ) : (
                <>
                  <Burbuja pie={`Sofi · ${e.cuando}`}>{e.texto}</Burbuja>
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
                            Ver la conversación con Sofi
                          </Button>
                        </span>
                      ) : null
                    }
                  />
                </>
              )}
            </li>
          ))}
        </ol>
      </section>
    ) : null
  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={`Campaña «${ACC[a].t(R)}»`}
      description={`Sale por: ${ACC[a].who(R).toLowerCase()}. Argos se la encarga a Sofi, que escribe y vende.`}
      closeLabel="Listo"
    >
      <div className="flex flex-col gap-5">
        <dl className="grid grid-cols-3 gap-2 text-center text-sm">
          {(
            [
              ["Recibieron", x.recibieron],
              ["Conversaron con Sofi", x.conversaron],
              ["Compraron", x.compraron],
              ["Vendió", soles(x.vendido)],
              ["Meta", x.costo ? soles(x.costo) : "Sin costo"],
              ["Retorno", retorno(x)],
            ] as const
          ).map(([l, v]) => (
            <div key={l} className="flex flex-col gap-0.5 rounded-lg bg-surface-muted/60 p-2.5">
              <dt className="text-xs text-muted-foreground">{l}</dt>
              <dd className="font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {grupo(
          "Esta semana",
          env.filter((e) => e.cuandoTipo === "semana"),
        )}
        {grupo(
          "Sofi les escribe ahora",
          env.filter((e) => e.cuandoTipo === "hara"),
          true,
        )}
        {grupo(
          "Antes",
          env.filter((e) => e.cuandoTipo === "antes"),
        )}
        <p className="text-xs text-muted-foreground">
          Datos de ejemplo: las cifras son de las últimas 4 semanas; el detalle muestra algunas
          clientas.
        </p>
      </div>
    </DetailDrawer>
  )
}

function Campanas({ d }: { d: Db }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const [ver, setVer] = useState<AccionId | null>(null)
  const clave = JSON.stringify(d.extra)
  const rows: FilaC[] = useMemo(
    () => ACCIONES.map((a) => ({ id: a.id, t: a.t(R), x: cifrasDe(a.id, d) })),
    // biome-ignore lint/correctness/useExhaustiveDependencies: `clave` resume lo que cambió en los chats
    [R, clave, d],
  )
  const tot = rows.reduce(
    (s, r) => ({
      rec: s.rec + r.x.recibieron,
      conv: s.conv + r.x.conversaron,
      comp: s.comp + r.x.compraron,
      vend: s.vend + r.x.vendido,
      cost: s.cost + r.x.costo,
    }),
    { rec: 0, conv: 0, comp: 0, vend: 0, cost: 0 },
  )
  const mx = Math.max(...rows.map((r) => r.x.vendido))
  const columns = useMemo<ColumnDef<FilaC>[]>(
    () => [
      {
        id: "campana",
        header: "Campaña",
        meta: { view: { role: "title" } },
        cell: ({ row }) => {
          const I = ICONOS[row.original.id]
          return (
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground">
                <I className="size-4" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{row.original.t}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {ACC[row.original.id].who(R)}
                </span>
              </span>
            </span>
          )
        },
      },
      {
        id: "rec",
        header: "Recibieron",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => <span className="tabular-nums">{row.original.x.recibieron}</span>,
      },
      {
        id: "conv",
        header: "Conversaron con Sofi",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => <span className="tabular-nums">{row.original.x.conversaron}</span>,
      },
      {
        id: "comp",
        header: "Compraron",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.x.compraron} de {row.original.x.recibieron}
          </span>
        ),
      },
      {
        id: "vend",
        header: "Vendió",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="flex items-center gap-3">
            <span className="w-16 font-semibold tabular-nums">{soles(row.original.x.vendido)}</span>
            <span
              className="hidden h-2 w-20 overflow-hidden rounded-full bg-muted xl:block"
              aria-hidden
            >
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${(row.original.x.vendido / mx) * 100}%` }}
              />
            </span>
          </span>
        ),
      },
      {
        id: "meta",
        header: "Meta",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.x.costo ? soles(row.original.x.costo) : "Sin costo"}
          </span>
        ),
      },
      {
        id: "ret",
        header: "Retorno",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => <span className="tabular-nums">{retorno(row.original.x)}</span>,
      },
      {
        id: "bajas",
        header: "Bajas",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => <span className="tabular-nums">{row.original.x.bajas || "—"}</span>,
      },
    ],
    [R, mx],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return (
    <div className="flex flex-col gap-5">
      <section
        aria-label="Las campañas en 4 semanas"
        className="grid grid-cols-2 gap-3 xl:grid-cols-4"
      >
        <KpiCard
          title="Recibieron"
          value={tot.rec}
          description="encargos de Argos que Sofi escribió"
        />
        <KpiCard
          title="Conversaron con Sofi"
          value={tot.conv}
          description={`${Math.round((tot.conv / tot.rec) * 100)} % de las que recibieron`}
        />
        <KpiCard
          title="Compraron"
          value={tot.comp}
          description={`${soles(tot.vend)} en pedidos pagados`}
        />
        <KpiCard
          title="Retorno"
          value={`${Math.round(tot.vend / tot.cost)} a 1`}
          description={`por cada sol en Meta (${soles(tot.cost)})`}
        />
      </section>
      <DataTable table={table} onRowClick={(r) => setVer(r.id)} />
      <p className="text-xs text-muted-foreground">
        Datos de ejemplo de las últimas 4 semanas. Una venta cuenta si la clienta pagó en los 7 días
        después del mensaje de Sofi; lo pedido y sin pagar no suma. Cada pedido dice de qué campaña
        salió, y cuenta para el 1 % del plan.
      </p>
      {ver ? <Campana a={ver} onClose={() => setVer(null)} /> : null}
    </div>
  )
}

/* ---------------------------------------------------------------------- reglas */

function Reglas({ d }: { d: Db }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const plan = planOf(ruta.rubro)
  const t = totales(plan, d)
  const set = (f: (x: Db) => void) => cambiar(ruta.rubro, f)
  const stepper = (
    label: string,
    v: number,
    min: number,
    max: number,
    f: (x: Db, n: number) => void,
  ) => (
    <span className="inline-flex items-center rounded-full border">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${label}: menos`}
        disabled={v <= min}
        onClick={() => set((x) => f(x, v - 1))}
      >
        <Minus aria-hidden />
      </Button>
      <span className="min-w-8 text-center font-semibold tabular-nums" aria-live="polite">
        {v}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${label}: más`}
        disabled={v >= max}
        onClick={() => set((x) => f(x, v + 1))}
      >
        <Plus aria-hidden />
      </Button>
    </span>
  )
  const todas = d.cl.filter((c) => !c.oculta).map((c) => perfil(c))
  const DIAS = ["L", "M", "X", "J", "V", "S", "D"]
  const NOMBRES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-5">
        <Tarjeta
          title="Presupuesto de Meta"
          subtitle="Meta lo cobra a tu tarjeta por cada mensaje de Sofi; gestorIA no cobra estos mensajes."
        >
          <UsageMeter
            label="Noviembre"
            value={d.used}
            total={d.budget}
            valueText={`${soles(d.used)} de ${soles(d.budget)}`}
            description={`Esta semana suma ${soles(t.cost)}. Al llegar al tope, lo que cobra Meta espera tu sí y lo que no cuesta sigue saliendo.`}
            warnAt={0.8}
            alarmAt={0.95}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Label htmlFor="presupuesto">Al mes, en soles</Label>
            <Input
              id="presupuesto"
              type="number"
              min={0}
              step={5}
              className="w-28"
              value={d.budget}
              onChange={(e) =>
                set((x) => {
                  x.budget = Math.max(0, Number(e.target.value) || 0)
                })
              }
            />
          </div>
        </Tarjeta>
        <Tarjeta
          title="Cuántos mensajes por clienta"
          subtitle="En todas las campañas. Si entra en dos, va la primera de la lista. Los avisos de sus pedidos no cuentan."
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <span className="text-sm font-medium">Por semana</span>
            {stepper("Por semana", d.tope, 1, 3, (x, n) => {
              x.tope = n
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <span className="text-sm font-medium">Por mes, como mucho</span>
            {stepper("Por mes", d.mes, 1, 8, (x, n) => {
              x.mes = n
            })}
          </div>
        </Tarjeta>
        <Tarjeta
          title="Horario"
          subtitle="Hora de Lima. Lo que toca fuera de hora espera al día siguiente; nunca de noche."
        >
          <ToggleGroup
            multiple
            value={DIAS.filter((_, i) => d.days[i])}
            onValueChange={(v) =>
              set((x) => {
                x.days = DIAS.map((dd) => v.includes(dd))
              })
            }
            aria-label="Días"
            className="flex-wrap gap-1"
          >
            {DIAS.map((dd, i) => (
              <ToggleGroupItem
                key={dd}
                value={dd}
                aria-label={NOMBRES[i]}
                className="size-9 rounded-full data-pressed:bg-primary data-pressed:text-primary-foreground"
              >
                {dd}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex flex-col gap-2">
            <span id="desde" className="text-sm font-medium">
              Desde
            </span>
            <RadioChips
              aria-labelledby="desde"
              value={d.from}
              options={["09:00", "10:00", "11:00"].map((h) => ({ value: h, label: h }))}
              onChange={(v) =>
                set((x) => {
                  x.from = v
                })
              }
            />
            <span id="hasta" className="text-sm font-medium">
              Hasta
            </span>
            <RadioChips
              aria-labelledby="hasta"
              value={d.to}
              options={["18:00", "19:00", "20:00"].map((h) => ({ value: h, label: h }))}
              onChange={(v) =>
                set((x) => {
                  x.to = v
                })
              }
            />
          </div>
        </Tarjeta>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <Tarjeta
          title="Pedirme permiso antes de…"
          subtitle="Lo normal es que Argos le encargue todo a Sofi solo, dentro del tope y del presupuesto. Marca solo lo que quieras ver antes."
        >
          <ul className="flex flex-col">
            {ACCIONES.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-3 border-t py-2.5 first:border-t-0 first:pt-0"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{a.t(R)}</span>
                  <span className="text-xs text-muted-foreground">
                    {d.permiso[a.id] ? "Te pide permiso" : "Sale sola"} · esta semana{" "}
                    {plural(plan[a.id].to.length, "clienta", "clientas")}
                  </span>
                </span>
                <Switch
                  checked={!!d.permiso[a.id]}
                  aria-label={`Pedirme permiso antes de «${a.t(R)}»`}
                  onCheckedChange={(v) =>
                    set((x) => {
                      x.permiso[a.id] = v
                      x.ok[a.id] = false
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </Tarjeta>
        <Tarjeta
          title="Lo que Argos nunca hace solo"
          subtitle="Reglas fijas de gestorIA: no se cambian."
        >
          <ul className="flex flex-col gap-3 text-sm">
            {[
              [
                "Unir dos fichas",
                "Si parecen la misma clienta, lo sugiere en «Te toca». Lo decide una persona, y nunca por el teléfono.",
              ],
              [
                "Encargar promociones a quien no aceptó o pidió que no",
                "Sofi pregunta en la primera compra: «¿Te aviso cuando llegue algo en tu talla?». La baja la anota Argos solo.",
              ],
              ["Gastar más del presupuesto de Meta", "Lo que pasa del mes espera tu sí."],
              [
                "Encargar ofertas fuera del margen",
                "Ningún encargo baja del mínimo que dejaste en el catálogo, y Sofi tampoco.",
              ],
            ].map(([t1, t2]) => (
              <li key={t1} className="flex gap-3">
                <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex flex-col">
                  <span className="font-medium">{t1}</span>
                  <span className="text-muted-foreground">{t2}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2 border-t pt-3">
            {(
              [
                ["noRecl", "Esperar si tiene un reclamo abierto"],
                ["noRuta", "Esperar si tiene un pedido en camino"],
              ] as const
            ).map(([key, label]) => (
              <span key={key} className="flex items-center gap-3 text-sm">
                <Switch
                  aria-label={label}
                  checked={d[key]}
                  onCheckedChange={(v) =>
                    set((x) => {
                      x[key] = v
                    })
                  }
                />
                {label}
              </span>
            ))}
          </div>
        </Tarjeta>
        <Tarjeta
          title="Cómo arma los grupos"
          subtitle="Cuentas fijas con los pedidos pagados, cada noche."
        >
          <ul className="flex flex-col">
            {SEG_IDS.map((g) => (
              <li
                key={g}
                className="flex items-center gap-3 border-t py-2 text-sm first:border-t-0 first:pt-0"
              >
                <SegBadge seg={g} className="w-24 justify-center" />
                <span className="min-w-0 flex-1">{SEG[g].regla}</span>
                <span className="text-xs text-muted-foreground">
                  {todas.filter((k) => k.seg === g).length}
                </span>
              </li>
            ))}
          </ul>
        </Tarjeta>
      </div>
    </div>
  )
}

/** Argos: lo que hizo solo, lo que hará, sus campañas y las pocas reglas que pone la tienda. */
export function ArgosPage({ tab }: { tab: Tab }) {
  const ruta = useRuta()
  const d = useDb(ruta.rubro)
  const t = totales(planOf(ruta.rubro), d)
  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader
        title="Argos"
        subtitle={
          <DeArgos className="text-sm">
            Perfila a tus clientas, decide cada campaña y se la encarga a Sofi, que escribe y vende.
          </DeArgos>
        }
      />
      <EsperaTuSi d={d} t={t} />
      <ViewTabs
        label="Qué ver de Argos"
        value={tab}
        onValueChange={(v) => ir(v === "hizo" ? "/argos" : `/argos/${v}`)}
        options={[
          { value: "hizo", label: "Lo que hizo" },
          { value: "hara", label: "Lo que hará", count: t.msgs },
          { value: "campanas", label: "Campañas" },
          { value: "reglas", label: "Reglas" },
        ]}
      />
      {tab === "hizo" ? (
        <LoQueHizo d={d} />
      ) : tab === "hara" ? (
        <LoQueHara d={d} />
      ) : tab === "campanas" ? (
        <Campanas d={d} />
      ) : (
        <Reglas d={d} />
      )}
    </PageShell>
  )
}

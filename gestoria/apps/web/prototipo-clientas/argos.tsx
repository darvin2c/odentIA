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
import { useMemo, useState } from "react"
import {
  ACC,
  ACCIONES,
  type AccionId,
  type Clienta,
  costo,
  HIST,
  META,
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
import { ir, useRuta } from "./ruta"

type Tab = "hizo" | "hara" | "reglas"

function totales(plan: Record<AccionId, PlanAccion>, d: Db) {
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

/** Lo único que espera a una persona: el gasto que pasa el presupuesto de Meta. */
function EsperaTuSi({
  d,
  espera,
  esperaCost,
  cost,
}: {
  d: Db
  espera: number
  esperaCost: number
  cost: number
}) {
  const ruta = useRuta()
  if (!espera || ruta.ventas) return null
  const pasa = d.used + cost + esperaCost - d.budget
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
                `Listo: ${plural(espera, "mensaje sale", "mensajes salen")} hoy, dentro del horario.`,
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
      {plural(espera, "mensaje pasa", "mensajes pasan")} el presupuesto de Meta de noviembre (
      {soles(d.budget)}) por {soles(Math.max(0.01, pasa))}. Argos no gasta de más sin tu sí; lo
      demás sale solo.
    </PageNotice>
  )
}

/* ------------------------------------------------------------------ lo que hizo */

interface Fila {
  id: AccionId
  t: string
  env: number
  resp: number
  comp: number
  vend: number
  cost: number
  bajas: number
}

function LoQueHizo({ d }: { d: Db }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const extra = JSON.stringify(d.extra)
  // La misma lista mientras no cambie: la tabla no se vuelve a medir sin parar.
  const rows: Fila[] = useMemo(
    () =>
      ACCIONES.map((a) => {
        const h = HIST[a.id]
        const e = d.extra[a.id] ?? { c: 0, v: 0, b: 0, r: 0 }
        return {
          id: a.id,
          t: a.t(R),
          env: h[0],
          resp: h[2] + e.r,
          comp: h[3] + e.c,
          vend: h[4] + e.v,
          cost: h[1] * META,
          bajas: h[5] + e.b,
        }
      }),
    // biome-ignore lint/correctness/useExhaustiveDependencies: `extra` resume lo que vendió en el prototipo
    [R, extra, d],
  )
  const tot = rows.reduce(
    (s, x) => ({
      env: s.env + x.env,
      resp: s.resp + x.resp,
      comp: s.comp + x.comp,
      vend: s.vend + x.vend,
      cost: s.cost + x.cost,
      bajas: s.bajas + x.bajas,
    }),
    { env: 0, resp: 0, comp: 0, vend: 0, cost: 0, bajas: 0 },
  )
  const mx = Math.max(...rows.map((r) => r.vend))
  const columns = useMemo<ColumnDef<Fila>[]>(
    () => [
      {
        id: "accion",
        header: "Trabajo",
        meta: { view: { role: "title" } },
        cell: ({ row }) => {
          const I = ICONOS[row.original.id]
          return (
            <span className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground">
                <I className="size-4" aria-hidden />
              </span>
              <span className="font-medium">{row.original.t}</span>
            </span>
          )
        },
      },
      {
        id: "vend",
        header: "Vendió",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="flex items-center gap-3">
            <span className="w-16 font-semibold tabular-nums">{soles(row.original.vend)}</span>
            <span
              className="hidden h-2 w-28 overflow-hidden rounded-full bg-muted md:block"
              aria-hidden
            >
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${(row.original.vend / mx) * 100}%` }}
              />
            </span>
          </span>
        ),
      },
      {
        id: "comp",
        header: "Compraron",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.comp} de {row.original.env}
          </span>
        ),
      },
      {
        id: "resp",
        header: "Respondieron",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => <span className="tabular-nums">{row.original.resp}</span>,
      },
      {
        id: "cost",
        header: "Meta",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.cost ? soles(row.original.cost) : "Gratis"}
          </span>
        ),
      },
      {
        id: "bajas",
        header: "Bajas",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => <span className="tabular-nums">{row.original.bajas || "—"}</span>,
      },
    ],
    [mx],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  const anotados = d.cl.reduce(
    (n, c) => n + Object.values(c.datos).filter((x) => x?.quien === "Argos").length,
    0,
  )
  const rocio = d.cl.find((c) => c.id === "c5")!
  const fio = d.cl.find((c) => c.id === "c8")!
  const mariela = d.cl.find((c) => c.id === "c1")!
  const jimena = d.cl.find((c) => c.id === "c10")!
  type Ev = { when: string; text: React.ReactNode; badge?: React.ReactNode; to?: string }
  const evs: Ev[] = [
    ...(d.paid
      ? [
          {
            when: "Hoy · 10:21",
            text: (
              <>
                Pasó a <b>{rocio.name}</b> de Dormida a {SEG[perfil(rocio).seg].label}: pagó el
                pedido 0161.
              </>
            ),
            badge: <Badge variant="success">Vendió {soles(R.nuevo.price)}</Badge>,
            to: "/clientes/c5",
          },
        ]
      : []),
    ...(fio.consent.estado === "baja"
      ? [
          {
            when: "Hoy · 09:48",
            text: (
              <>
                Anotó que <b>{fio.name}</b> no quiere promociones: «ya no me mandes estas cosas
                porfa».
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
          : <b>Diana Flores</b> pasó a En riesgo.
        </>
      ),
      to: "/clientes/c4",
    },
    {
      when: "Mar 25",
      text: (
        <>
          Anotó la {R.field.toLowerCase()} de <b>{jimena.name}</b>: {jimena.datos.talla?.valor}, del
          chat («{jimena.datos.talla?.cita}»).
        </>
      ),
      to: "/clientes/c10",
    },
    {
      when: "Lun 23 · 16:00",
      text: (
        <>
          Le escribió a <b>{rocio.name}</b> para recuperarla, con algo {R.fitT}.
        </>
      ),
      badge: d.paid ? (
        <Badge variant="success">Compró</Badge>
      ) : d.chat.rocio > 0 ? (
        <Badge variant="secondary">Respondió</Badge>
      ) : (
        <Badge variant="outline">Sin respuesta</Badge>
      ),
      to: "/conversaciones",
    },
    {
      when: "Lun 23 · 16:00",
      text: (
        <>
          Le avisó a <b>{fio.name}</b> lo nuevo {R.fitT}.
        </>
      ),
      badge:
        fio.consent.estado === "baja" ? (
          <Badge variant="destructive">Se dio de baja</Badge>
        ) : (
          <Badge variant="outline">Sin respuesta</Badge>
        ),
    },
    {
      when: "Vie 20",
      text: (
        <>
          Anotó de <b>{mariela.name}</b> su {R.field.toLowerCase()} y su cumpleaños, del chat. La
          talla quedó por confirmar: «{mariela.datos.talla?.cita}».
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
  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Las cifras de Argos" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard
          title="Vendió"
          value={soles(tot.vend)}
          description={`${plural(tot.comp, "pedido pagado", "pedidos pagados")} en 4 semanas`}
        />
        <KpiCard
          title="Mensajes"
          value={tot.env}
          description={`respondieron ${Math.round((tot.resp / tot.env) * 100)} %`}
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
      <div className="flex flex-col gap-5">
        <Tarjeta title="Esta semana" subtitle="Lo que hizo solo, lo más nuevo arriba.">
          <ol className="flex flex-col divide-y">
            {evs.map((e, i) => (
              <li key={i} className="entra flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <span className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">{e.when}</span>
                  <span className="ml-auto">{e.badge}</span>
                </span>
                <span className="text-sm leading-relaxed">
                  {e.text}{" "}
                  {e.to ? (
                    <a
                      href={`#/${ruta.rubro}${e.to}${ruta.ventas ? "?ventas=1" : ""}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      Ver
                    </a>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </Tarjeta>
        <Tarjeta
          title="Lo que vendió cada trabajo"
          subtitle="Pedidos pagados en los 7 días después del mensaje. Lo pedido y sin pagar no suma."
        >
          <DataTable table={table} inCard />
          <p className="text-xs text-muted-foreground">
            Datos de ejemplo de las últimas 4 semanas. Estos pedidos los arma Sofi: cuentan para el
            1 % del plan.
          </p>
        </Tarjeta>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ lo que hará */

function Mensajes({ a, onClose }: { a: AccionId; onClose: () => void }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  useDb(ruta.rubro)
  const pl = planOf(ruta.rubro)[a]
  const quitadas = pl.out.filter((o) => o.why === "La quitaste tú")
  const otras = pl.out.filter((o) => o.why !== "La quitaste tú")
  const fila = (c: Clienta, text: string, cost: number, on: boolean, estado?: string) => (
    <li
      key={c.id}
      className={cn("flex gap-3 border-t py-3 first:border-t-0 first:pt-0", !on && "opacity-55")}
    >
      <PersonAvatar name={c.name} className="size-9" decorative />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{c.name}</span>
          <SegBadge seg={perfil(c).seg} />
          {estado === "presupuesto" ? <Badge variant="warning">Espera tu sí</Badge> : null}
        </span>
        <span className="text-xs text-muted-foreground">{perfil(c).why}</span>
        <Burbuja>{text}</Burbuja>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {cost ? `Meta ${soles(cost)} · plantilla` : `Gratis: escribió hace ${c.lastH} h`}
          <span className="ml-auto flex items-center gap-2 text-sm font-medium text-foreground">
            <Checkbox
              aria-label={`Enviarle a ${c.name}`}
              checked={on}
              disabled={ruta.ventas}
              onCheckedChange={(v) =>
                cambiar(ruta.rubro, (x) => {
                  const s = x.skip[a] ?? []
                  x.skip[a] = v ? s.filter((id) => id !== c.id) : [...s, c.id]
                })
              }
            />
            Enviarle
          </span>
        </span>
      </div>
    </li>
  )
  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={ACC[a].t(R)}
      description={`${plural(pl.to.length, "mensaje", "mensajes")} · Meta ${pl.cost ? soles(pl.cost) : "gratis"} · sale ${ACC[a].when}`}
      closeLabel="Listo"
    >
      <ul className="flex flex-col">
        {pl.to.map((e) => fila(e.c, e.text, e.cost, true, e.estado))}
        {quitadas.map((o) => fila(o.c, mensaje(a, o.c, R), costo(o.c), false))}
      </ul>
      {otras.length ? (
        <div className="mt-4 flex flex-col gap-2 rounded-lg bg-surface-muted/60 p-3 text-sm">
          <span className="font-semibold">No le escribe a</span>
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
  const vacia = !n
  return (
    <article
      className={cn(
        "entra elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5",
        (pausa || vacia) && "bg-surface-muted/40",
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
        {vacia ? (
          <Badge variant="outline">Nadie esta semana</Badge>
        ) : pausa ? (
          <Badge variant="secondary">En pausa</Badge>
        ) : permiso ? (
          <Badge variant="warning">Te pide permiso</Badge>
        ) : (
          <Badge variant="success">Sale sola</Badge>
        )}
      </div>
      {n && ex ? (
        <>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="A quiénes">
            {pl.to.slice(0, 5).map((e) => (
              <Badge key={e.c.id} variant="outline">
                {nombre(e.c)}
              </Badge>
            ))}
            {n > 5 ? <Badge variant="outline">y {n - 5} más</Badge> : null}
          </div>
          <Burbuja
            plantilla={ex.cost ? a.tpl : null}
            pie={`ejemplo: ${nombre(ex.c)}`}
            botones={
              a.id === "recuperar" || a.id === "nuevo" ? ["Sí, mándame", "Ahora no"] : undefined
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
              Meta <b className="text-foreground">{pl.cost ? soles(pl.cost) : "gratis"}</b>
            </span>
            <span>
              Venta estimada <b className="text-foreground">≈ {soles(Math.round(pl.est))}</b>
            </span>
          </p>
          <p className="text-sm">
            {pausa
              ? "En pausa: no sale hasta que la reanudes."
              : permiso
                ? d.ok[a.id]
                  ? `Aprobado · sale ${a.when}.`
                  : "Pediste que te consulte antes: espera tu permiso."
                : espera
                  ? `Sale sola ${a.when}. ${plural(espera, "mensaje espera", "mensajes esperan")} tu sí: pasan el presupuesto.`
                  : `Sale sola ${a.when}.`}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {a.id === "recompra" && !R.P.some((p) => p.dura)
            ? "Ningún producto dice cuánto dura. Ponlo en el catálogo: «Dura unos … días»."
            : "Esta semana no hay a quién. Argos lo revisa cada mañana."}
        </p>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-3">
        {!ruta.ventas && n ? (
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
        ) : null}
        {permiso && !d.ok[a.id] && !ruta.ventas ? (
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
        {n || pl.out.length ? (
          <Button variant="ghost" size="sm" onClick={onVer}>
            {n
              ? n === 1
                ? "Ver el mensaje"
                : `Ver los ${n} mensajes`
              : "Ver quiénes quedan fuera"}
          </Button>
        ) : null}
        {pl.sentWeek.length ? (
          <span className="ml-auto text-xs text-muted-foreground">
            Ya salió el lunes: {pl.sentWeek.map((c) => nombre(c)).join(", ")}
          </span>
        ) : null}
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
          title="Salen solos"
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
          description="con lo que vendió cada trabajo antes"
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
        Datos de ejemplo. Meta cobra {soles(META).replace("0,23", "0,2339")} por mensaje de
        promoción en Perú (desde el 1 de octubre de 2026). Si ella escribió en las últimas 24 h,
        sale como respuesta normal: Meta no cobra las primeras 1 000 del mes.
      </p>
      {ver ? <Mensajes a={ver} onClose={() => setVer(null)} /> : null}
    </div>
  )
}

/* ---------------------------------------------------------------------- reglas */

function Reglas({ d }: { d: Db }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const plan = planOf(ruta.rubro)
  const t = totales(plan, d)
  const dis = ruta.ventas
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
        disabled={dis || v <= min}
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
        disabled={dis || v >= max}
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
          subtitle="Meta lo cobra a tu tarjeta; gestorIA no cobra estos mensajes."
        >
          <UsageMeter
            label="Noviembre"
            value={d.used}
            total={d.budget}
            valueText={`${soles(d.used)} de ${soles(d.budget)}`}
            description={`Esta semana suma ${soles(t.cost)}. Al llegar al tope, lo que cobra Meta espera tu sí y lo gratis sigue saliendo.`}
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
              disabled={dis}
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
          subtitle="En todo Argos. Si entra en dos trabajos, sale el primero de la lista. Los avisos de sus pedidos no cuentan."
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
            disabled={dis}
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
              disabled={dis}
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
              disabled={dis}
            />
          </div>
        </Tarjeta>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <Tarjeta
          title="Pedirme permiso antes de…"
          subtitle="Lo normal es que todo salga solo, dentro del tope y del presupuesto. Marca solo lo que quieras ver antes."
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
                  disabled={dis}
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
                "Escribir a quien no aceptó o pidió que no",
                "Sofi pregunta en la primera compra: «¿Te aviso cuando llegue algo en tu talla?». La baja la anota Argos solo.",
              ],
              ["Gastar más del presupuesto de Meta", "Lo que pasa del mes espera tu sí."],
              [
                "Ofrecer fuera del margen",
                "Ningún precio baja del mínimo que dejaste en el catálogo.",
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
                  disabled={dis}
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

/** Argos: lo que hizo solo, lo que hará y las pocas reglas que pone la tienda. */
export function ArgosPage({ tab }: { tab: Tab }) {
  const ruta = useRuta()
  const d = useDb(ruta.rubro)
  const plan = planOf(ruta.rubro)
  const t = totales(plan, d)
  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader
        title="Argos"
        subtitle={
          <DeArgos className="text-sm">
            Perfila a tus clientas y les escribe solo. Tú decides solo lo que cuesta de más.
          </DeArgos>
        }
      />
      <EsperaTuSi d={d} espera={t.espera} esperaCost={t.esperaCost} cost={t.cost} />
      <ViewTabs
        label="Qué ver de Argos"
        value={tab}
        onValueChange={(v) => ir(v === "hizo" ? "/argos" : `/argos/${v}`)}
        options={[
          { value: "hizo", label: "Lo que hizo" },
          { value: "hara", label: "Lo que hará", count: t.msgs },
          { value: "reglas", label: "Reglas" },
        ]}
      />
      {tab === "hizo" ? (
        <LoQueHizo d={d} />
      ) : tab === "hara" ? (
        <LoQueHara d={d} />
      ) : (
        <Reglas d={d} />
      )}
    </PageShell>
  )
}

export { totales }

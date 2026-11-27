import { Badge, Button, cn, useIsMobile } from "@odentia/ui"
import {
  DataTable,
  FilterBar,
  type FilterDef,
  KpiCard,
  ListSearchScope,
  PageHeader,
  PageShell,
  useListSearch,
  useScopedListSearch,
  ViewTabs,
} from "@odentia/ui-patterns"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import {
  CalendarDays,
  Megaphone,
  Plus,
  Route,
  Sparkles,
  Store,
  UserRound,
  Workflow,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { foto } from "../datos"
import { ir, useRuta } from "../ruta"
import { useTienda } from "../tienda"
import { AccionDrawer, Anotar, empacar } from "./acciones"
import {
  type Accion,
  CANAL,
  cuentas,
  entregaTexto,
  money,
  ORIGEN_LABEL,
  PASO,
  type Paso,
  type Pedido,
  teToca,
  tocaDe,
  usePedidos,
} from "./modelo"
import { ConRouter } from "./router"

type Vista =
  | "abiertos"
  | "por_cobrar"
  | "por_preparar"
  | "en_camino"
  | "entregados"
  | "anulados"
  | "todos"
const VISTAS: Record<Vista, { label: string; pasos: Paso[] | null }> = {
  abiertos: {
    label: "Abiertos",
    pasos: ["por_pagar", "por_confirmar", "pagado", "preparando", "por_salir", "en_camino"],
  },
  por_cobrar: { label: "Por cobrar", pasos: ["por_pagar", "por_confirmar"] },
  por_preparar: { label: "Por preparar", pasos: ["pagado", "preparando", "por_salir"] },
  en_camino: { label: "En camino", pasos: ["en_camino"] },
  entregados: { label: "Entregados", pasos: ["entregado"] },
  anulados: { label: "Anulados", pasos: ["anulado"] },
  todos: { label: "Todos", pasos: null },
}

const diaDe = (p: Pedido) =>
  p.entrega.dia === "Hoy"
    ? "hoy"
    : p.entrega.dia === "Vie 28"
      ? "manana"
      : p.entrega.dia
        ? "antes"
        : "sin"

/** «Te toca» de pedidos: lo que necesita a una persona, cada uno con su único botón. */
export function TeTocaPedidos({
  list,
  onAbrir,
  onAccion,
  max,
}: {
  list: Pedido[]
  onAbrir: (id: string) => void
  onAccion: (p: Pedido, a: Accion) => void
  max?: number
}) {
  const toca = teToca(list).slice(0, max)
  const t = (p: Pedido) => tocaDe(p)!
  if (!toca.length) return null
  return (
    <section aria-labelledby="toca-h" className="flex flex-col gap-3">
      <h2 id="toca-h" className="flex items-center gap-2 text-sm font-semibold">
        Te toca
        <Badge variant="warning">{toca.length}</Badge>
        <span className="font-normal text-muted-foreground">Lo demás avanza solo.</span>
      </h2>
      <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {toca.map((p) => (
          <li key={p.id} className="elevated flex flex-col gap-3 rounded-xl border bg-card p-3.5">
            <button
              type="button"
              className="flex items-start gap-3 text-left"
              onClick={() => onAbrir(p.id)}
            >
              {p.lineas[0]?.foto ? (
                <img
                  src={foto(p.lineas[0].foto)}
                  alt=""
                  className="size-10 shrink-0 rounded-lg bg-muted object-cover"
                />
              ) : null}
              <span className="flex min-w-0 flex-col gap-0.5 text-sm">
                <span className="text-xs text-muted-foreground">
                  {p.id} · {p.clienta}
                </span>
                <span className="font-medium leading-snug">{t(p).texto}</span>
              </span>
            </button>
            <Button size="sm" className="self-start" onClick={() => onAccion(p, t(p).accion)}>
              {t(p).boton}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Foto({ p }: { p: Pedido }) {
  return p.lineas[0]?.foto ? (
    <img
      src={foto(p.lineas[0].foto)}
      alt=""
      className="size-12 shrink-0 rounded-lg bg-muted object-cover"
    />
  ) : (
    <span className="size-12 shrink-0 rounded-lg bg-muted" />
  )
}

function Cobro({ p }: { p: Pedido }) {
  const k = cuentas(p)
  if (p.paso === "anulado") return <span className="text-muted-foreground">—</span>
  if (k.alRecibir && !k.confirmado)
    return (
      <span className="tabular-nums">
        {money(k.total)} <span className="text-muted-foreground">· al recibir</span>
      </span>
    )
  return k.pagado ? (
    <span className="tabular-nums">
      {money(k.total)} <span className="text-success">· pagado</span>
    </span>
  ) : (
    <span className="tabular-nums">
      {money(k.total)}{" "}
      <span className="text-warning">· falta {money(k.falta || k.porConfirmar)}</span>
    </span>
  )
}

function OrigenIcon({ p }: { p: Pedido }) {
  const I =
    p.origen.k === "campana"
      ? Megaphone
      : p.origen.k === "equipo"
        ? UserRound
        : p.origen.k === "catalogo"
          ? Store
          : Sparkles
  return (
    <I
      className={cn("size-3.5 shrink-0", p.unoPorCiento ? "text-primary" : "text-muted-foreground")}
      aria-hidden
    />
  )
}

function Lista() {
  const { rubro } = useRuta()
  const all = usePedidos(rubro)
  const owner = useTienda((s) => s.rol === "dueno")
  const isMobile = useIsMobile()
  const { get } = useListSearch()
  const [vista, setVistaS] = useState<Vista>(memo.vista)
  const setVista = (v: Vista) => {
    memo.vista = v
    setVistaS(v)
  }
  const [anotar, setAnotar] = useState(false)
  const [accion, setAccion] = useState<{ p: Pedido; a: Accion } | null>(null)
  const abrir = (id: string) => ir(`/pedidos/${id}`)
  const hacer = (p: Pedido, a: Accion) => (a === "empacar" ? empacar(rubro, p) : setAccion({ p, a }))

  const busca = (get("q") ?? "").toLowerCase()
  const fDia = get("dia")
  const fCanal = get("canal")
  const fOrigen = get("origen")
  const sort = get("sort")
  const filtrados = all.filter(
    (p) =>
      (!busca ||
        `${p.id} ${p.clienta} ${p.telefono} ${p.lineas.map((l) => l.nombre).join(" ")}`
          .toLowerCase()
          .includes(busca)) &&
      (!fDia || diaDe(p) === fDia) &&
      (!fCanal || p.canal === fCanal) &&
      (!fOrigen || p.origen.k === fOrigen),
  )
  const enVista = (v: Vista) =>
    filtrados.filter((p) => !VISTAS[v].pasos || VISTAS[v].pasos!.includes(p.paso))
  // La tabla recibe la misma lista mientras no cambie nada: una lista nueva en cada render la
  // vuelve a medir sin fin.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depende de lo que filtra
  const filas = useMemo(
    () =>
      [...enVista(vista)].sort((a, b) =>
        sort?.endsWith("falta")
          ? cuentas(b).falta - cuentas(a).falta
          : sort?.endsWith("sale")
            ? diaDe(a).localeCompare(diaDe(b)) * -1
            : Number(b.id) - Number(a.id),
      ),
    [all, vista, busca, fDia, fCanal, fOrigen, sort],
  )

  const filters: FilterDef[] = [
    {
      key: "dia",
      label: "Día",
      icon: CalendarDays,
      type: "select",
      options: [
        { value: "hoy", label: "Sale hoy" },
        { value: "manana", label: "Sale mañana" },
        { value: "antes", label: "Días pasados" },
      ],
    },
    {
      key: "canal",
      label: "Canal",
      type: "select",
      options: Object.entries(CANAL).map(([value, label]) => ({
        value,
        label,
        count: all.filter((p) => p.canal === value).length,
      })),
    },
    {
      key: "origen",
      label: "Origen",
      type: "select",
      options: Object.entries(ORIGEN_LABEL).map(([value, label]) => ({
        value,
        label,
        count: all.filter((p) => p.origen.k === value).length,
      })),
    },
  ]

  const columns = useMemo<ColumnDef<Pedido>[]>(
    () => [
      {
        id: "foto",
        header: "Foto",
        meta: { view: isMobile ? { tableOnly: true } : { role: "media" } },
        cell: ({ row }) => <Foto p={row.original} />,
      },
      {
        id: "pedido",
        header: "Pedido",
        meta: { view: { role: "title" } },
        cell: ({ row }) => {
          const p = row.original
          const lleva = p.lineas
            .filter((l) => !l.vuelve)
            .map((l) => `${l.nombre} ${l.variante}`)
            .join(" + ")
          // En el celular, la tarjeta entera va en el título: foto a la izquierda y
          // estado, cobro y entrega debajo, sin separadores que queden colgando.
          if (isMobile)
            return (
              <span className="flex min-w-0 items-start gap-3">
                <Foto p={p} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate font-semibold">
                    {p.id} · {p.clienta}
                  </span>
                  <span className="truncate text-xs font-normal text-muted-foreground">{lleva}</span>
                  <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Badge variant={PASO[p.paso].tono}>{PASO[p.paso].corto}</Badge>
                    {tocaDe(p) ? <Badge variant="warning">Te toca</Badge> : null}
                    <span className="text-sm font-normal">
                      <Cobro p={p} />
                    </span>
                  </span>
                  {p.paso !== "anulado" ? (
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {entregaTexto(p.entrega)}
                    </span>
                  ) : null}
                </span>
              </span>
            )
          return (
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-semibold">
                {p.id} · {p.clienta}
              </span>
              <span className="truncate text-xs text-muted-foreground">{lleva}</span>
            </span>
          )
        },
      },
      {
        id: "estado",
        header: "Estado",
        meta: { view: isMobile ? { tableOnly: true } : { primary: true } },
        cell: ({ row }) => {
          const p = row.original
          return (
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant={PASO[p.paso].tono}>{PASO[p.paso].corto}</Badge>
              {tocaDe(p) ? <Badge variant="warning">Te toca</Badge> : null}
            </span>
          )
        },
      },
      {
        id: "cobro",
        header: "Cobro",
        meta: { view: isMobile ? { tableOnly: true } : { primary: true } },
        cell: ({ row }) => <Cobro p={row.original} />,
      },
      {
        id: "entrega",
        header: "Entrega",
        meta: { view: isMobile ? { tableOnly: true } : { primary: true } },
        cell: ({ row }) => (
          <span className="truncate text-sm">
            {row.original.paso === "anulado" ? "—" : entregaTexto(row.original.entrega)}
          </span>
        ),
      },
      {
        id: "origen",
        header: "Origen",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          const p = row.original
          return (
            <span className="flex min-w-0 items-center gap-1.5 text-sm">
              <OrigenIcon p={p} />
              <span className="truncate">
                {p.origen.k === "campana"
                  ? "Campaña de Argos"
                  : p.origen.k === "sofi"
                    ? `Sofi · ${CANAL[p.canal]}`
                    : p.origen.k === "equipo"
                      ? `Anotó ${p.origen.quien}`
                      : "Catálogo"}
              </span>
            </span>
          )
        },
      },
    ],
    [isMobile],
  )
  const table = useReactTable({ data: filas, columns, getCoreRowModel: getCoreRowModel() })

  const abiertos = all.filter((p) => VISTAS.abiertos.pasos!.includes(p.paso))
  const porCobrar = abiertos.reduce((a, p) => a + cuentas(p).falta, 0)
  const salenHoy = all.filter(
    (p) => p.entrega.dia === "Hoy" && ["preparando", "por_salir", "en_camino"].includes(p.paso),
  ).length
  const vivos = all.filter((p) => p.paso !== "anulado")
  const solos = vivos.filter((p) => p.unoPorCiento).length

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Pedidos"
        subtitle={`${abiertos.length} abiertos · ${salenHoy} salen hoy`}
        primary={{
          label: "Anotar pedido",
          icon: <Plus aria-hidden />,
          onClick: () => setAnotar(true),
        }}
        secondary={{
          label: "Cómo avanza",
          icon: <Workflow aria-hidden />,
          onClick: () => ir("/pedidos/como-avanza"),
        }}
        menu={[
          {
            label: "Ver lo que ve la clienta",
            icon: <Route aria-hidden />,
            onSelect: () => ir("/clienta", { extra: "p=0165" }),
          },
          {
            label: "Ver la app del repartidor",
            icon: <Route aria-hidden />,
            onSelect: () => ir("/reparto"),
          },
        ]}
      />
      <TeTocaPedidos list={all} onAbrir={abrir} onAccion={hacer} />
      {!isMobile ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard
            title="Por confirmar"
            value={all.filter((p) => p.paso === "por_confirmar").length}
            description="Capturas de Yape o Plin"
          />
          <KpiCard
            title="Salen hoy"
            value={salenHoy}
            description="Preparando, por salir y en camino"
          />
          <KpiCard
            title="Falta cobrar"
            value={money(porCobrar)}
            description="En los pedidos abiertos"
          />
          {owner ? (
            <KpiCard
              title="Los vendió gestorIA"
              value={`${solos} de ${vivos.length}`}
              description="Sofi, catálogo y campañas: cuentan para el 1 %"
              meter={{ value: solos, total: vivos.length }}
            />
          ) : (
            <KpiCard
              title="Entregados"
              value={all.filter((p) => p.paso === "entregado").length}
              description="Esta semana"
            />
          )}
        </div>
      ) : null}
      <div className="flex flex-col gap-3">
        <ViewTabs
          label="Qué pedidos ver"
          value={vista}
          onValueChange={setVista}
          options={(Object.keys(VISTAS) as Vista[]).map((v) => ({
            value: v,
            label: VISTAS[v].label,
            count: enVista(v).length,
          }))}
        />
        <FilterBar
          filters={filters}
          sortOptions={[
            { value: "reciente", label: "Más recientes" },
            { value: "sale", label: "Sale primero" },
            { value: "falta", label: "Más por cobrar" },
          ]}
          searchLabel="Buscar en pedidos"
          searchPlaceholder="Nombre, número o teléfono"
        />
        <DataTable table={table} onRowClick={(p) => abrir(p.id)} />
        {!filas.length ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No hay pedidos con estos filtros.
          </p>
        ) : null}
      </div>
      {anotar ? <Anotar onClose={() => setAnotar(false)} /> : null}
      {accion ? (
        <AccionDrawer
          p={all.find((x) => x.id === accion.p.id) ?? accion.p}
          accion={accion.a}
          onClose={() => setAccion(null)}
        />
      ) : null}
    </PageShell>
  )
}

/** Los filtros y la vista de la lista, para volver a ella tal como estaba. */
const memo: { filtros: Record<string, string | undefined>; vista: Vista } = {
  filtros: {},
  vista: "abiertos",
}

/** Pedidos: lo que necesita a una persona arriba, y la lista por estado, con filtros. */
export function PedidosPage() {
  const scope = useScopedListSearch(memo.filtros)
  // «Volver a Pedidos» regresa a la lista con sus filtros: se guardan al salir.
  useEffect(() => {
    memo.filtros = scope.search as typeof memo.filtros
  }, [scope.search])
  return (
    <ConRouter>
      <ListSearchScope value={scope}>
        <Lista />
      </ListSearchScope>
    </ConRouter>
  )
}

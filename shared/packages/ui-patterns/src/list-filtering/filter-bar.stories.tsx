import type { Meta, StoryObj } from "@storybook/react"
import { Banknote, MapPin, Truck } from "lucide-react"
import { PageShell } from "../page-shell.js"
import { StoryRouter } from "../story-fixtures.js"
import { FilterBar } from "./filter-bar.js"
import type { FilterDef } from "./filter-def.js"
import { FilterStrip } from "./filter-strip.js"
import { useListSearch } from "./list-search.js"

/**
 * La barra de filtros de una lista. En el teléfono cada filtro va en una fila que se desliza,
 * con su nombre y lo elegido; con el dedo (pantalla táctil o teléfono) el buscador, cada filtro,
 * su «×», las opciones, «Ordenar» y «Limpiar» miden 44 px; con el mouse, como siempre.
 *
 * La tira (`type: "strip"`) es un filtro más: una ficha por opción con su punto, su nombre y
 * cuántas hay; «Limpiar» la quita como a los demás.
 */
const meta = {
  title: "Patrones/Filtros",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const REPARTIDOR: FilterDef = {
  key: "rep",
  label: "Repartidor",
  icon: Truck,
  type: "select",
  options: [
    { value: "kevin", label: "Kevin", count: 8 },
    { value: "jhon", label: "Jhon", count: 7 },
    { value: "agencia", label: "Por agencia", count: 1 },
    { value: "sin", label: "Sin repartidor", count: 3 },
  ],
}
const COBRO: FilterDef = {
  key: "cobro",
  label: "Cobro",
  icon: Banknote,
  type: "select",
  options: [
    { value: "al_recibir", label: "Al recibir", count: 5 },
    { value: "pagado", label: "Pagado", count: 12 },
    { value: "falta", label: "Falta cobrar", count: 2 },
  ],
}
const ZONA: FilterDef = {
  key: "zona",
  label: "Zona",
  icon: MapPin,
  type: "multi",
  placement: "overflow",
  options: ["Callao", "Comas", "Independencia", "La Victoria", "Los Olivos", "Miraflores"].map((zona, index) => ({
    value: zona,
    label: zona,
    count: index + 1,
  })),
}

const ETAPAS = [
  { value: "por_confirmar", label: "Pago por confirmar", count: 1, tone: "warning" },
  { value: "preparando", label: "Preparando", count: 6, tone: "soft" },
  { value: "por_salir", label: "Por salir", count: 3, tone: "soft" },
  { value: "en_camino", label: "En camino", count: 3, tone: "soft" },
  { value: "entregado", label: "Entregado", count: 3, tone: "success" },
  { value: "no_entregado", label: "No se entregó", count: 1, tone: "destructive" },
  { value: "vuelve", label: "Vuelve a la tienda", count: 1, tone: "destructive" },
  { value: "anulado", label: "Anulado", count: 0, tone: "outline" },
] as const

const ETAPA = (placement: "below" | "apart"): FilterDef => ({
  key: "etapa",
  label: "Etapa",
  type: "strip",
  placement,
  options: ETAPAS.map((etapa) => ({ ...etapa })),
})

/** Lo que la lista filtra, a la vista: la story no tiene datos que esconder. */
function Elegido() {
  const { search } = useListSearch()
  const pares = Object.entries(search).filter(([, value]) => value)
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {pares.length ? `Filtra por ${pares.map(([key, value]) => `${key}=${value}`).join(", ")}` : "Sin filtros."}
    </p>
  )
}

/** La tira bajo la barra, como hace el `FilterBar` solo. */
export const ConTira: Story = {
  render: () => (
    <StoryRouter>
      <PageShell className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Pedidos</h1>
        <FilterBar
          filters={[REPARTIDOR, COBRO, ZONA, ETAPA("below")]}
          sortOptions={[
            { value: "reciente", label: "Más recientes" },
            { value: "sale", label: "Sale primero" },
          ]}
          searchLabel="Buscar en pedidos"
          searchPlaceholder="Nombre, número o teléfono"
        />
        <Elegido />
      </PageShell>
    </StoryRouter>
  ),
}

/**
 * La tira donde la pone la página (bajo el día que se mira, en Despachos): `placement: "apart"`
 * y `FilterStrip`. El `FilterBar` la sigue contando en «Limpiar».
 */
export const TiraAparte: Story = {
  render: () => (
    <StoryRouter>
      <PageShell className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Despachos</h1>
        <FilterBar
          filters={[REPARTIDOR, COBRO, ZONA, ETAPA("apart")]}
          sortOptions={[]}
          searchLabel="Buscar en despachos"
          searchPlaceholder="Nombre o número"
        />
        <div className="flex flex-col">
          <h2 className="text-lg font-semibold">Jueves 27 de noviembre · hoy</h2>
          <p className="text-sm text-muted-foreground">19 entregas · 7 te tocan</p>
        </div>
        <FilterStrip filter={ETAPA("apart") as Extract<FilterDef, { type: "strip" }>} />
        <Elegido />
      </PageShell>
    </StoryRouter>
  ),
}

/** Un día sin nada: la tira no se pinta y la barra queda sola. */
export const TiraVacia: Story = {
  render: () => (
    <StoryRouter>
      <PageShell className="flex flex-col gap-4">
        <FilterBar
          filters={[
            REPARTIDOR,
            { ...ETAPA("below"), options: ETAPAS.map((etapa) => ({ ...etapa, count: 0 })) } as FilterDef,
          ]}
          sortOptions={[]}
          searchLabel="Buscar en despachos"
        />
        <Elegido />
      </PageShell>
    </StoryRouter>
  ),
}

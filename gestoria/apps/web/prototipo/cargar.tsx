import { Badge, Button, Checkbox, cn, Input } from "@odentia/ui"
import { EmptyState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { ArrowLeft, FileSpreadsheet, Images, MessageCircle, Sparkles, Upload } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { foto, RUBROS } from "./datos"
import { Swatch } from "./ficha/piezas"
import { MoneyInput } from "./ficha/precio-card"
import { crearProducto, type Propuesta, proponer } from "./ia"
import { href, ir, useRuta } from "./ruta"
import { agregarProducto, useDb } from "./tienda"

interface Grupo {
  fotos: string[]
  pr: Propuesta
  name: string
  precio: number | null
  tallas: string
  stock: string
  sel: boolean
  existe?: string
  accion: "crear" | "sumar"
}

/**
 * «Cargar muchos»: se sueltan todas las fotos como salen del celular, la IA las junta por
 * producto y propone cada uno; se revisa en una lista, se pone el precio (a varios a la vez) y se crean.
 */
export function BulkPage() {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb()
  const [step, setStep] = useState<"soltar" | "juntando" | "revisar">("soltar")
  const [fotos, setFotos] = useState<string[]>([])
  const [grupos, setGrupos] = useState<Grupo[]>([])
  const [bulk, setBulk] = useState<number | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (step !== "juntando") return
    const t = setTimeout(() => {
      const byKind = new Map<string, string[]>()
      for (const f of fotos) {
        const k = R.ph[f]?.[0] ?? "otro"
        byKind.set(k, [...(byKind.get(k) ?? []), f])
      }
      setGrupos(
        [...byKind.values()].map((fs) => {
          const pr = proponer(fs, R, ruta.rubro)
          const existe = d.products.find((p) => p.name === pr.name)?.id
          return {
            fotos: fs,
            pr,
            name: pr.name,
            precio: null,
            tallas: pr.cols,
            stock: "",
            sel: false,
            existe,
            accion: existe ? "sumar" : "crear",
          }
        }),
      )
      setStep("revisar")
    }, 1800)
    return () => clearTimeout(t)
  }, [step])

  const nuevos = grupos.filter((g) => g.accion === "crear")
  const listos = nuevos.filter((g) => (g.precio ?? 0) > 0)
  const elegidos = grupos.filter((g) => g.sel)
  const set = (i: number, patch: Partial<Grupo>) =>
    setGrupos((gs) => gs.map((g, j) => (j === i ? { ...g, ...patch } : g)))
  const mosaic = useMemo(() => fotos.map((f, i) => ({ f, i })), [fotos])

  return (
    <PageShell className="flex flex-col gap-5">
      <a
        href={href("/catalogo")}
        className="inline-flex items-center gap-1 self-start text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Catálogo
      </a>
      <PageHeader
        title="Cargar muchos"
        subtitle={
          step === "revisar"
            ? `${fotos.length} fotos en ${grupos.length} productos · ${nuevos.length} nuevos`
            : "Todas tus fotos de una vez: la IA las junta en productos y tú revisas."
        }
        primary={
          step === "revisar"
            ? {
                label:
                  `Crear ${listos.length || ""} ${listos.length === 1 ? "producto" : "productos"}`.replace(
                    "  ",
                    " ",
                  ),
                icon: <Sparkles aria-hidden />,
                onClick: () => {
                  if (!listos.length) return setErr(true)
                  for (const g of listos) {
                    const p = crearProducto(
                      g.pr,
                      {
                        name: g.name,
                        cat: g.pr.cat,
                        precio: g.precio!,
                        tallas: g.tallas,
                        stock: Number(g.stock) || 0,
                        texto: g.pr.texto,
                        datos: {},
                        aceptado: new Set(),
                      },
                      R,
                    )
                    agregarProducto(p)
                  }
                  ir("/catalogo")
                },
              }
            : undefined
        }
      />

      {step === "soltar" ? (
        <>
          <label
            className="flex min-h-64 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-input-border bg-card p-6 text-center transition-colors hover:border-primary/50 hover:bg-primary-soft/20"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const fs = [...e.dataTransfer.files].map((x) => URL.createObjectURL(x))
              if (fs.length) {
                setFotos(fs)
                setStep("juntando")
              }
            }}
          >
            <span className="flex size-12 items-center justify-center rounded-2xl bg-muted">
              <Upload className="size-6 text-muted-foreground" aria-hidden />
            </span>
            <span className="text-lg font-semibold">Suelta aquí todas tus fotos</span>
            <span className="max-w-sm text-sm text-muted-foreground">
              Como salen del celular, sin ordenarlas. También con Ctrl+V.
            </span>
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const fs = [...(e.target.files ?? [])].map((x) => URL.createObjectURL(x))
                if (fs.length) {
                  setFotos(fs)
                  setStep("juntando")
                }
              }}
            />
          </label>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              onClick={() => {
                setFotos(R.pool)
                setStep("juntando")
              }}
            >
              <Images aria-hidden />
              Usar {R.pool.length} fotos de ejemplo de {R.label.toLowerCase()}
            </Button>
            <Button variant="outline">
              <FileSpreadsheet aria-hidden />
              Una hoja de Excel
            </Button>
            <Button variant="outline">
              <MessageCircle aria-hidden />
              El catálogo de WhatsApp
            </Button>
          </div>
        </>
      ) : step === "juntando" ? (
        <div className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5" role="status">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="pulso size-4 text-primary" aria-hidden />
            La IA está juntando las fotos en productos…
            <span className="ml-auto text-muted-foreground">Puedes salir: sigue sola</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <span className="block h-full w-2/3 animate-pulse rounded-full bg-primary" />
          </div>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
            {mosaic.map(({ f, i }) => (
              <img
                key={`${f}${i}`}
                src={foto(f)}
                alt=""
                style={{ animationDelay: `${i * 60}ms` }}
                className="entra aspect-square w-full rounded-lg object-cover"
              />
            ))}
          </div>
        </div>
      ) : grupos.length === 0 ? (
        <EmptyState
          icon={Images}
          title="No se encontraron productos"
          description="Prueba con otras fotos."
          actionLabel="Volver a empezar"
          onAction={() => setStep("soltar")}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-primary-soft/50 px-4 py-2.5 text-sm">
            <Sparkles className="size-4 text-primary" aria-hidden />
            <span className="flex-1">
              Nombres, categorías y colores los propone la IA (punteado). El precio lo pones tú.
            </span>
            {elegidos.length ? (
              <span className="entra flex items-center gap-2">
                <b>{elegidos.length} elegidos</b>
                <MoneyInput
                  className="w-32"
                  value={bulk}
                  onChange={setBulk}
                  label="Precio para los elegidos"
                  placeholder="Precio"
                />
                <Button
                  size="sm"
                  onClick={() =>
                    setGrupos((gs) =>
                      gs.map((g) => (g.sel ? { ...g, precio: bulk, sel: false } : g)),
                    )
                  }
                >
                  Poner a los {elegidos.length}
                </Button>
              </span>
            ) : null}
          </div>
          {err && !listos.length ? (
            <p className="text-sm text-destructive">
              Pon el precio de al menos un producto para crearlo.
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {grupos.map((g, i) => (
              <div
                key={g.pr.kind}
                className={cn(
                  "entra elevated flex flex-col gap-3 rounded-xl border bg-card p-4",
                  g.sel && "ring-2 ring-primary",
                )}
                style={{ animationDelay: `${i * 70}ms` }}
              >
                <div className="flex items-start gap-3">
                  <div className="flex -space-x-6">
                    {g.fotos.slice(0, 3).map((f, j) => (
                      <img
                        key={`${f}${j}`}
                        src={foto(f)}
                        alt=""
                        className="size-16 rounded-xl object-cover ring-2 ring-card"
                        style={{ transform: `rotate(${(j - 1) * 4}deg)` }}
                      />
                    ))}
                  </div>
                  <span className="ml-auto flex items-center gap-2">
                    {g.accion === "crear" ? (
                      <Checkbox
                        checked={g.sel}
                        onCheckedChange={(v) => set(i, { sel: !!v })}
                        aria-label={`Elegir ${g.name}`}
                      />
                    ) : null}
                  </span>
                </div>
                <Input
                  aria-label="Nombre"
                  value={g.name}
                  className="propuesta font-medium"
                  onChange={(e) => set(i, { name: e.target.value })}
                />
                <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                  {g.pr.colors.map((c) => (
                    <span key={c.id} className="inline-flex items-center gap-1">
                      <Swatch color={c} />
                      {c.name}
                    </span>
                  ))}
                  · {g.pr.cat} · {g.fotos.length} {g.fotos.length === 1 ? "foto" : "fotos"}
                </span>
                {g.existe ? (
                  <div className="flex flex-col gap-2 rounded-xl bg-surface-muted p-3 text-sm">
                    <span className="font-medium">Ya está en tu catálogo.</span>
                    <span className="flex gap-1.5">
                      {(["sumar", "crear"] as const).map((a) => (
                        <Button
                          key={a}
                          size="xs"
                          variant={g.accion === a ? "default" : "outline"}
                          onClick={() => set(i, { accion: a })}
                        >
                          {a === "sumar" ? "Sumar las fotos" : "Crear aparte"}
                        </Button>
                      ))}
                    </span>
                  </div>
                ) : (
                  <Badge variant="soft" className="w-fit">
                    <Sparkles aria-hidden />
                    Producto nuevo
                  </Badge>
                )}
                {g.accion === "crear" ? (
                  <div className="grid grid-cols-3 gap-2">
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Precio
                      <MoneyInput
                        value={g.precio}
                        onChange={(v) => set(i, { precio: v })}
                        label={`Precio de ${g.name}`}
                      />
                    </label>
                    {R.col ? (
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {R.col}s
                        <Input
                          value={g.tallas}
                          onChange={(e) => set(i, { tallas: e.target.value })}
                        />
                      </label>
                    ) : null}
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Stock c/u
                      <Input
                        inputMode="numeric"
                        value={g.stock}
                        placeholder="0"
                        onChange={(e) => set(i, { stock: e.target.value.replace(/\D/g, "") })}
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}
    </PageShell>
  )
}

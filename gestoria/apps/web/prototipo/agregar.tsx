import { Button, cn, Input, Textarea } from "@odentia/ui"
import { FormDrawer, RadioChips } from "@odentia/ui-patterns"
import { Check, ImagePlus, Sparkles } from "lucide-react"
import { useEffect, useId, useMemo, useState } from "react"
import { foto, RUBROS } from "./datos"
import { Swatch } from "./ficha/piezas"
import { MoneyInput } from "./ficha/precio-card"
import { crearProducto, type Propuesta, proponer } from "./ia"
import { ir, useRuta } from "./ruta"
import { VistaPrevia } from "./ficha/vista-previa"
import { agregarProducto, useDb } from "./tienda"

/** Una marca de lo propuesto, con «Aceptar» a un toque. */
function Marca({ ok, onAccept }: { ok: boolean; onAccept: () => void }) {
  return ok ? (
    <span className="entra inline-flex h-5 items-center gap-1 rounded-full bg-success-soft px-1.5 text-[11px] font-semibold text-success">
      <Check className="size-3" aria-hidden />
      Aceptado
    </span>
  ) : (
    <button
      type="button"
      onClick={onAccept}
      className="inline-flex h-5 items-center gap-1 rounded-full bg-primary-soft px-1.5 text-[11px] font-semibold text-primary-soft-foreground hover:bg-[color-mix(in_oklab,var(--primary-soft),var(--primary)_14%)]"
    >
      <Sparkles className="size-3" aria-hidden />
      IA · Aceptar
    </button>
  )
}

/**
 * «Agregar desde fotos»: se eligen fotos, la IA mira y propone (punteado) nombre, categoría,
 * colores, datos y texto; pregunta lo que no ve y nunca propone el precio. Nada se guarda solo.
 */
export function AddFromPhotos({ onClose }: { onClose: () => void }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const [step, setStep] = useState<"elegir" | "mirando" | "propuesta">("elegir")
  const [picked, setPicked] = useState<string[]>([])
  const [propia, setPropia] = useState<string[]>([])
  const [pr, setPr] = useState<Propuesta | null>(null)
  const [f, setF] = useState({
    name: "",
    cat: "",
    tallas: "",
    precio: null as number | null,
    texto: "",
  })
  const [ok, setOk] = useState<Set<string>>(new Set())
  const [resp, setResp] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)
  const [ver, setVer] = useState(false)
  // Lo que quedaría si se guarda ahora: el mismo producto que crea «Guardar y abrir la ficha».
  const previa = useMemo(
    () => (pr ? crearProducto(pr, { name: f.name.trim() || pr.name, cat: f.cat, precio: f.precio ?? 0, tallas: f.tallas, texto: f.texto, datos: { ...resp }, aceptado: ok, extraFotos: propia }, R) : null),
    [pr, f, resp, ok, propia, R],
  )
  const d = useDb()
  const nameId = useId()
  const priceId = useId()

  useEffect(() => {
    if (step !== "mirando") return
    const t = setTimeout(() => {
      const p = proponer(picked, R, ruta.rubro)
      setPr(p)
      setF((x) => ({ ...x, name: p.name, cat: p.cat, tallas: x.tallas || p.cols, texto: p.texto }))
      setStep("propuesta")
    }, 1500)
    return () => clearTimeout(t)
  }, [step])

  const asks = R.datos.filter((d) => d.ask && d.type === "chips")
  const accept = (k: string) => setOk((s) => new Set(s).add(k))
  const all = ["name", "cat", "colores", "texto", "kw"]
  const pending = all.filter((k) => !ok.has(k)).length

  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Agregar desde fotos"
      description={
        step === "propuesta"
          ? "Lo punteado lo propone la IA. Nada se guarda hasta que lo guardes."
          : "Empieza por las fotos: la IA propone el resto."
      }
      isDirty={picked.length > 0}
      submitLabel={
        step === "elegir"
          ? `Mirar ${picked.length || ""} ${picked.length === 1 ? "foto" : "fotos"}`.replace(
              "  ",
              " ",
            )
          : "Guardar y abrir la ficha"
      }
      isSubmitting={step === "mirando"}
      error={err}
      secondaryAction={step === "propuesta" ? { label: "Ver cómo queda", onClick: () => setVer(true) } : undefined}
      onSubmit={(e) => {
        e.preventDefault()
        if (step === "elegir") {
          if (!picked.length) return setErr("Elige al menos una foto.")
          setErr(null)
          setStep("mirando")
          return
        }
        if (step !== "propuesta" || !pr) return
        if (!f.name.trim()) return setErr("Escribe o acepta el nombre.")
        if (!f.precio) return setErr("Pon el precio: lo pones tú, la IA no propone precios.")
        const datos = Object.fromEntries(Object.entries(resp))
        const p = crearProducto(
          pr,
          {
            name: f.name.trim(),
            cat: f.cat,
            precio: f.precio,
            tallas: f.tallas,
            texto: f.texto,
            datos,
            aceptado: ok,
            extraFotos: propia,
          },
          R,
        )
        agregarProducto(p)
        onClose()
        ir(`/catalogo/${p.id}`)
      }}
    >
      {step === "elegir" ? (
        <div className="flex flex-col gap-5">
          <label className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-input-border p-4 text-center text-sm transition-colors hover:border-primary/50 hover:bg-primary-soft/30">
            <ImagePlus className="size-6 text-muted-foreground" aria-hidden />
            <span className="font-medium">Suelta o elige tus fotos</span>
            <span className="text-muted-foreground">
              De distintos lados, hasta 8. También con Ctrl+V.
            </span>
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const urls = [...(e.target.files ?? [])].map((x) => URL.createObjectURL(x))
                setPropia((p) => [...p, ...urls])
                setPicked((p) => [...p, ...urls])
              }}
            />
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Tus fotos recientes</span>
            <div className="grid grid-cols-4 gap-2">
              {[...propia, ...R.gallery].map((k) => {
                const i = picked.indexOf(k)
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={i >= 0}
                    aria-label={`Foto ${k}`}
                    onClick={() =>
                      setPicked((p) => (i >= 0 ? p.filter((x) => x !== k) : [...p, k]))
                    }
                    className={cn(
                      "relative aspect-square overflow-hidden rounded-xl outline-none ring-offset-2 ring-offset-card transition-all focus-visible:ring-3 focus-visible:ring-ring/50",
                      i >= 0 ? "ring-2 ring-primary" : "hover:opacity-90",
                    )}
                  >
                    <img
                      src={foto(k)}
                      alt=""
                      className={cn(
                        "size-full object-cover transition-transform duration-200",
                        i >= 0 && "scale-95 rounded-lg",
                      )}
                    />
                    {i >= 0 ? (
                      <span className="entra absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                        {i + 1}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      ) : step === "mirando" ? (
        <div
          className="flex flex-col gap-5"
          role="status"
          aria-label="La IA está mirando las fotos"
        >
          <div className="flex gap-2">
            {picked.map((k) => (
              <img key={k} src={foto(k)} alt="" className="size-16 rounded-xl object-cover" />
            ))}
          </div>
          <span className="flex items-center gap-2 text-sm font-medium text-primary">
            <Sparkles className="pulso size-4" aria-hidden />
            Mirando las fotos…
          </span>
          {["Nombre", "Categoría", R.row, "Descripción"].map((l, i) => (
            <div key={l} className="flex flex-col gap-2">
              <span className="text-sm font-medium">{l}</span>
              <span
                className="brillo h-9 rounded-3xl"
                style={{ width: `${[85, 50, 65, 100][i]}%` }}
              />
            </div>
          ))}
        </div>
      ) : pr ? (
        <div className="flex flex-col gap-5">
          <div className="flex gap-2">
            {picked.map((k) => (
              <img key={k} src={foto(k)} alt="" className="size-16 rounded-xl object-cover" />
            ))}
          </div>
          {pr.mixed ? (
            <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning">
              Algunas fotos parecen de otro producto. Propongo con las de «{pr.name}»; las demás
              quedan fuera.
            </p>
          ) : null}
          {pending ? (
            <div className="entra flex items-center gap-3 rounded-2xl bg-primary-soft/60 px-3 py-2 text-sm">
              <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
              <span className="flex-1">La IA propone {pending} cosas y pregunta lo que no ve.</span>
              <Button type="button" size="sm" onClick={() => setOk(new Set(all))}>
                Aceptar todo
              </Button>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <label htmlFor={nameId} className="text-sm font-medium">
                Nombre
              </label>
              <Marca ok={ok.has("name")} onAccept={() => accept("name")} />
            </div>
            <Input
              id={nameId}
              value={f.name}
              className={cn(!ok.has("name") && "propuesta")}
              onChange={(e) => {
                setF({ ...f, name: e.target.value })
                accept("name")
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Categoría</span>
                <Marca ok={ok.has("cat")} onAccept={() => accept("cat")} />
              </div>
              <Input
                aria-label="Categoría"
                value={f.cat}
                className={cn(!ok.has("cat") && "propuesta")}
                onChange={(e) => {
                  setF({ ...f, cat: e.target.value })
                  accept("cat")
                }}
              />
            </div>
            {R.col ? (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {R.col}s
                <Input
                  value={f.tallas}
                  placeholder={pr.cols}
                  onChange={(e) => setF({ ...f, tallas: e.target.value })}
                />
              </label>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                {R.row}
                {pr.colors.length > 1 ? "es" : ""}, sacados de las fotos
              </span>
              <Marca ok={ok.has("colores")} onAccept={() => accept("colores")} />
            </div>
            <div
              className={cn(
                "flex flex-wrap gap-2 rounded-2xl p-1",
                !ok.has("colores") && "propuesta border",
              )}
            >
              {pr.colors.map((c) => (
                <span
                  key={c.id}
                  className="entra inline-flex h-9 items-center gap-2 rounded-full border bg-card pr-3.5 pl-2 text-sm font-medium"
                >
                  <Swatch color={c} className="size-5" />
                  {c.name}
                  <span className="text-xs text-muted-foreground">
                    {c.fotos.length} {c.fotos.length === 1 ? "foto" : "fotos"}
                  </span>
                </span>
              ))}
            </div>
          </div>
          {asks.map((d) => {
            const seen = pr.datos[d.id]
            return (
              <div key={d.id} className="flex flex-col gap-2">
                <span className="flex items-center gap-2 text-sm font-medium" id={`ask-${d.id}`}>
                  {seen ? d.label : d.ask}
                  {seen ? (
                    <Marca
                      ok={resp[d.id] === seen}
                      onAccept={() => setResp({ ...resp, [d.id]: seen })}
                    />
                  ) : null}
                </span>
                <div
                  className={cn(
                    "w-fit rounded-full",
                    seen && !resp[d.id] && "propuesta border p-0.5",
                  )}
                >
                  <RadioChips
                    aria-labelledby={`ask-${d.id}`}
                    value={resp[d.id] ?? seen ?? null}
                    options={(d.opts ?? []).map((o) => ({ value: o, label: o }))}
                    onChange={(v) => setResp({ ...resp, [d.id]: v })}
                  />
                </div>
              </div>
            )
          })}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={priceId} className="text-sm font-medium">
              Precio
            </label>
            <MoneyInput
              id={priceId}
              value={f.precio}
              onChange={(v) => setF({ ...f, precio: v })}
              className="w-40"
            />
            <span className="text-xs text-muted-foreground">
              Lo pones tú. La IA nunca propone precios.
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Descripción para vender</span>
              <Marca ok={ok.has("texto")} onAccept={() => accept("texto")} />
            </div>
            <Textarea
              aria-label="Descripción para vender"
              rows={3}
              value={f.texto}
              className={cn(!ok.has("texto") && "propuesta")}
              onChange={(e) => {
                setF({ ...f, texto: e.target.value })
                accept("texto")
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Cómo la buscan</span>
              <Marca ok={ok.has("kw")} onAccept={() => accept("kw")} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {pr.kw.map((k) => (
                <span
                  key={k}
                  className={cn(
                    "inline-flex h-7 items-center rounded-full px-2.5 text-[13px] font-medium",
                    ok.has("kw") ? "bg-secondary" : "propuesta border",
                  )}
                >
                  {k}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {ver && pr ? (
        <VistaPrevia
          open
          title="Así quedaría en tu vitrina"
          onClose={() => setVer(false)}
          R={R}
          tpl={d.tpl}
          all={d.products}
          p={previa!}
        />
      ) : null}
    </FormDrawer>
  )
}

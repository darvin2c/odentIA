import { Button, cn } from "@odentia/ui"
import { Check, ImagePlus, Sparkles, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { foto, RUBROS } from "./datos"
import { Swatch } from "./ficha/piezas"
import { crearProducto, proponer } from "./ia"
import { ir, useRuta } from "./ruta"
import { agregarProducto } from "./tienda"

/**
 * La cámara primero (celular): se toman fotos seguidas y el producto se arma mientras tanto. La
 * cámara del prototipo «ve» fotos de ejemplo; «Usar la cámara del celular» toma fotos de verdad.
 */
export function CameraPage() {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const [shots, setShots] = useState<string[]>([])
  const [flash, setFlash] = useState(0)
  const [mirando, setMirando] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const next = R.camara[Math.min(shots.length, R.camara.length - 1)]!
  const pr = shots.length
    ? proponer(
        shots.filter((s) => !s.startsWith("blob:")).length
          ? shots.filter((s) => !s.startsWith("blob:"))
          : R.camara.slice(0, 1),
        R,
        ruta.rubro,
      )
    : null
  // Lo que ya se sabe crece con cada toma: nombre, luego colores, luego lo que se lee.
  const sabe = Math.min(3, shots.length)

  useEffect(() => {
    if (!shots.length) return
    setMirando(true)
    const t = setTimeout(() => setMirando(false), 700)
    return () => clearTimeout(t)
  }, [shots.length])

  const shoot = () => {
    setFlash((f) => f + 1)
    setShots((s) => [...s, next])
  }
  const done = () => {
    if (!pr) return
    const p = crearProducto(
      pr,
      {
        name: pr.name,
        cat: pr.cat,
        precio: 0,
        tallas: pr.cols,
        texto: pr.texto,
        datos: {},
        aceptado: new Set(),
        extraFotos: shots.filter((s) => s.startsWith("blob:")),
      },
      R,
    )
    agregarProducto(p)
    ir(`/catalogo/${p.id}`)
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0b0b0c] text-white md:static md:z-auto md:mx-auto md:my-6 md:h-[calc(100svh-var(--notice-strip-h)-3rem)] md:max-w-sm md:overflow-hidden md:rounded-[2rem]">
      <div className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cerrar la cámara"
          className="text-white hover:bg-white/10 hover:text-white"
          onClick={() => ir("/catalogo")}
        >
          <X aria-hidden />
        </Button>
        <span className="flex-1 text-center text-sm font-semibold">Tomar fotos</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Elegir de la galería"
          className="text-white hover:bg-white/10 hover:text-white"
          onClick={() => input.current?.click()}
        >
          <ImagePlus aria-hidden />
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          hidden
          onChange={(e) =>
            setShots((s) => [
              ...s,
              ...[...(e.target.files ?? [])].map((f) => URL.createObjectURL(f)),
            ])
          }
        />
      </div>

      {/* Lo que se va armando, arriba del visor. */}
      <div className="px-3">
        <div
          className={cn(
            "flex min-h-[4.5rem] items-center gap-3 rounded-2xl bg-white/10 p-3 backdrop-blur transition-opacity",
            !shots.length && "opacity-80",
          )}
          aria-live="polite"
        >
          {!pr ? (
            <span className="text-sm text-white/80">
              Toma la primera foto: la IA arma el producto mientras sigues.
            </span>
          ) : (
            <>
              <Sparkles
                className={cn("size-5 shrink-0 text-white", mirando && "pulso")}
                aria-hidden
              />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                {sabe >= 1 ? (
                  <span className="entra truncate text-sm font-semibold">{pr.name}</span>
                ) : null}
                {sabe >= 2 ? (
                  <span className="entra flex items-center gap-1.5 text-xs text-white/80">
                    {pr.colors.map((c) => (
                      <span key={c.id} className="inline-flex items-center gap-1">
                        <Swatch color={c} className="size-3" />
                        {c.name}
                      </span>
                    ))}
                    <span>· {pr.cat}</span>
                  </span>
                ) : (
                  <span className="brillo h-3 w-32 rounded-full opacity-40" />
                )}
                {sabe >= 3 ? (
                  <span className="entra text-xs text-white/80">
                    {Object.entries(pr.datos)
                      .map(
                        ([k, v]) =>
                          `${R.datos.find((d) => d.id === k)?.label ?? k}: ${v.toLowerCase()}`,
                      )
                      .join(" · ") || pr.texto}
                  </span>
                ) : shots.length ? (
                  <span className="text-xs text-white/60">Otra toma y sigo…</span>
                ) : null}
              </span>
            </>
          )}
        </div>
      </div>

      {/* El visor. */}
      <div className="relative mx-3 mt-3 min-h-0 flex-1 overflow-hidden rounded-3xl bg-black">
        <img
          key={`${next}${shots.length}`}
          src={foto(next)}
          alt="Lo que ve la cámara"
          className="absolute inset-0 size-full scale-110 object-cover opacity-90 blur-[0.3px] transition-transform duration-[2000ms]"
        />
        {(
          [
            "top-4 left-4 border-t-2 border-l-2 rounded-tl-xl",
            "top-4 right-4 border-t-2 border-r-2 rounded-tr-xl",
            "bottom-4 left-4 border-b-2 border-l-2 rounded-bl-xl",
            "bottom-4 right-4 border-b-2 border-r-2 rounded-br-xl",
          ] as const
        ).map((c) => (
          <span key={c} aria-hidden className={cn("absolute size-8 border-white/85", c)} />
        ))}
        <span className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-3 py-1 text-xs font-medium backdrop-blur">
          {shots.length === 0
            ? "De frente"
            : shots.length === 1
              ? "Ahora de lado"
              : "Un detalle o la etiqueta"}
        </span>
        {flash ? (
          <span key={flash} aria-hidden className="disparo absolute inset-0 bg-white" />
        ) : null}
      </div>

      <div className="flex items-center gap-3 px-4 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {shots.map((s, i) => (
            <img
              key={`${s}${i}`}
              src={foto(s)}
              alt={`Foto ${i + 1}`}
              className="entra size-11 shrink-0 rounded-lg object-cover ring-1 ring-white/30"
            />
          ))}
        </div>
        <button
          type="button"
          onClick={shoot}
          aria-label="Tomar foto"
          className="flex size-[4.5rem] shrink-0 items-center justify-center rounded-full border-4 border-white/90 outline-none transition-transform active:scale-90 focus-visible:ring-4 focus-visible:ring-white/50"
        >
          <span className="size-14 rounded-full bg-white" />
        </button>
        <div className="flex flex-1 justify-end">
          <Button disabled={!shots.length} onClick={done} className="h-11 rounded-full px-4">
            <Check aria-hidden />
            Listo{shots.length ? ` (${shots.length})` : ""}
          </Button>
        </div>
      </div>
    </div>
  )
}

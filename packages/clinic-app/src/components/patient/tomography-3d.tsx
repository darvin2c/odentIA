import { Button, Slider } from "@odentia/ui"
import { LoadingState } from "@odentia/ui-patterns"
import { useEffect, useId, useRef, useState } from "react"
import { cbctNifti } from "../../lib/cbct-nifti"
import type { CbctVolume, WindowLevel } from "../../lib/cbct-volume"
import { sliderValue } from "../../lib/view-transform"
import { isChunkLoadError, markNewVersion, NEW_VERSION_TEXT } from "../../lib/new-version"

/**
 * La tomografía en 3D, solo para mostrar (ADR 0147): se gira con el dedo o el
 * ratón y «Cortar» le quita una parte para ver adentro. No mide ni se guarda en
 * la atención: el umbral del 3D puede borrar el hueso fino, y lo que vale está
 * en los cortes. La dibuja NiiVue con la tarjeta gráfica (WebGL2), sobre una
 * copia reducida del volumen ya cargado; sin WebGL2 se dice y los cortes siguen.
 */

type NiivueInstance = {
  attachToCanvas(canvas: HTMLCanvasElement): Promise<unknown>
  loadFromArrayBuffer(buffer: ArrayBuffer, name: string): Promise<void>
  setSliceType(type: number): unknown
  setClipPlane(depthAzimuthElevation: number[]): void
  setRenderAzimuthElevation(azimuth: number, elevation: number): void
  setVolumeRenderIllumination(gradient?: number): Promise<void>
  updateGLVolume(): void
  volumes: { cal_min: number; cal_max: number }[]
  gl?: WebGL2RenderingContext | null
  cleanup?: () => void
}

/** Lado mínimo de las texturas 3D que pide la copia reducida. */
const SIDE = 256

let render3d: boolean | undefined

/**
 * ¿Este equipo puede dibujar el 3D? WebGL2 con texturas 3D de al menos 256 de
 * lado. Es del equipo, no de la tomografía: se prueba una sola vez.
 */
function canRender3d(): boolean {
  if (typeof document === "undefined") return false
  render3d ??= probeWebgl2()
  return render3d
}

function probeWebgl2(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2")
    if (!gl) return false
    const ok = (gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number) >= SIDE
    gl.getExtension("WEBGL_lose_context")?.loseContext()
    return ok
  } catch {
    return false
  }
}

/** El umbral del 3D sale del brillo elegido: lo más oscuro de la ventana queda transparente. */
function calibration(window: WindowLevel) {
  return { min: window.center - window.width * 0.25, max: window.center + window.width / 2 }
}

export function Tomography3D({
  volume,
  window,
  className,
  onExpand,
  focusOnOpen = false,
}: {
  volume: CbctVolume
  window: WindowLevel
  className?: string
  /** En el cuadro chico de «Cortes»: lleva a la pestaña «3D», grande, para mostrárselo al paciente. */
  onExpand?: () => void
  /** Recibe el foco al abrirse (al llegar con «Ver grande», que desaparece). */
  focusOnOpen?: boolean
}) {
  const id = useId()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nvRef = useRef<NiivueInstance | null>(null)
  const [state, setState] = useState<"cargando" | "listo" | "sin-3d" | "error" | "sin-cargar">(() =>
    canRender3d() ? "cargando" : "sin-3d",
  )
  const [cut, setCut] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let alive = true
    setState("cargando")
    ;(async () => {
      // Se descarga solo al abrir el 3D: quien no lo usa no carga nada.
      const mod = (await import("@niivue/niivue")) as unknown as {
        Niivue: new (options: Record<string, unknown>) => NiivueInstance
        SLICE_TYPE: { RENDER: number }
      }
      if (!alive) return
      const nv = new mod.Niivue({
        backColor: [0.02, 0.03, 0.05, 1],
        show3Dcrosshair: false,
        isOrientCube: false,
        isColorbar: false,
        dragAndDropEnabled: false,
        loadingText: "",
        logLevel: "silent",
      })
      nvRef.current = nv
      await nv.attachToCanvas(canvas)
      await nv.loadFromArrayBuffer(cbctNifti(volume, SIDE).buffer, "tomografia.nii")
      if (!alive) return
      nv.setSliceType(mod.SLICE_TYPE.RENDER)
      // De frente, apenas desde arriba. El brillo lo pone el efecto de abajo al quedar listo.
      nv.setRenderAzimuthElevation(180, 10)
      await nv.setVolumeRenderIllumination(0.4).catch(() => {})
      if (alive) setState("listo")
    })().catch((error: unknown) => {
      // El 3D baja al abrirse: si no bajó (versión nueva o sin conexión), se dice con la salida ahí mismo,
      // porque el aviso general queda detrás del visor.
      const chunk = isChunkLoadError(error)
      if (chunk) markNewVersion()
      if (alive) setState(chunk ? "sin-cargar" : "error")
    })
    return () => {
      alive = false
      const nv = nvRef.current
      nvRef.current = null
      try {
        nv?.cleanup?.()
        nv?.gl?.getExtension("WEBGL_lose_context")?.loseContext()
      } catch {
        // Cerrar el 3D nunca rompe el visor.
      }
    }
  }, [volume])

  useEffect(() => {
    const nv = nvRef.current
    const image = nv?.volumes[0]
    if (state !== "listo" || !nv || !image) return
    const cal = calibration(window)
    image.cal_min = cal.min
    image.cal_max = cal.max
    nv.updateGLVolume()
  }, [window, state])

  useEffect(() => {
    if (focusOnOpen) canvasRef.current?.focus()
  }, [focusOnOpen])

  useEffect(() => {
    const nv = nvRef.current
    if (state !== "listo" || !nv) return
    // Sin cortar, el plano queda fuera del volumen; al cortar entra desde adelante hasta el centro.
    nv.setClipPlane(cut === 0 ? [2, 180, 0] : [0.87 * (1 - cut / 100), 180, 0])
  }, [cut, state])

  return (
    <div className={`relative flex min-h-0 min-w-0 flex-col bg-black ${className ?? ""}`}>
      <span className="absolute top-2 left-2 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[0.7rem] font-semibold tracking-wide text-slate-300 uppercase">
        3D · para mostrar
      </span>
      {onExpand && state !== "sin-3d" && (
        <Button type="button" size="sm" variant="outline" className="absolute top-2 right-2 z-10" onClick={onExpand}>
          Ver grande
        </Button>
      )}
      {state === "sin-3d" ? (
        <p role="status" className="m-auto max-w-xs p-6 text-center text-sm text-slate-300">
          Este equipo no puede mostrar el 3D; los cortes siguen igual.
        </p>
      ) : state === "error" ? (
        <p role="status" className="m-auto max-w-xs p-6 text-center text-sm text-slate-300">
          No se pudo armar el 3D; los cortes siguen igual.
        </p>
      ) : state === "sin-cargar" ? (
        <div role="status" className="m-auto flex max-w-xs flex-col items-center gap-3 p-6 text-center text-sm text-slate-300">
          {NEW_VERSION_TEXT}
          <Button type="button" size="sm" variant="outline" onClick={() => globalThis.location.reload()}>
            Recargar
          </Button>
        </div>
      ) : (
        <>
          <div className="relative min-h-48 flex-1 touch-none">
            <canvas
              ref={canvasRef}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: el 3D recibe el foco al llegar con «Ver grande».
              tabIndex={focusOnOpen ? -1 : undefined}
              aria-label="Tomografía en 3D: arrastra para girarla"
              className="absolute inset-0 h-full w-full outline-none"
            />
            {state === "cargando" && (
              <div className="absolute inset-0 flex items-center justify-center">
                <LoadingState message="Armando el 3D…" />
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-xs text-slate-400">
            <p className="basis-full text-slate-300">
              Arrastra con el dedo o el ratón para girarla.
            </p>
            <span id={`${id}-cut`}>Ver por dentro</span>
            <Slider
              aria-labelledby={`${id}-cut`}
              className="min-w-32 flex-1"
              value={[cut]}
              min={0}
              max={100}
              step={1}
              disabled={state !== "listo"}
              onValueChange={(v) => setCut(sliderValue(v))}
            />
            <p className="basis-full">
              Mueve a la derecha para abrirla desde adelante; a la izquierda vuelve a verse entera.
            </p>
            <p className="basis-full text-amber-200">
              El hueso fino puede no verse en 3D. Para medir y decidir, usa los cortes.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

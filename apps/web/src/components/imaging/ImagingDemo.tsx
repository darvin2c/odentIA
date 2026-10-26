// La demo de imágenes de las dos webs: se ve como el visor de la clínica (oscuro, con sus pestañas y
// sus botones) y se usa como él, con una tomografía real de ejemplo. En odentIA: «Panorámica y cortes»
// (la panorámica con el corte de cada pieza y su medida), «Tres cortes» (desde arriba, de frente y de
// lado, cada uno con su barra) y «Radiografía» (brillo, contraste, invertir y acercar). En latidIA:
// la radiografía de frente y la tomografía de senos por cortes. Sin movimiento (prefers-reduced-motion)
// no pasa sola de pieza en pieza.
import { useEffect, useRef, useState } from "react"
import { CROSS_SIZE, CROSSES, FRAMES, IMG, PANO_COLUMNS } from "./imaging-data"
import "./imaging-demo.css"

type Tab = "pano" | "cuts" | "xray"
type Variant = "dental" | "medical"

const TABS: Record<Variant, [Tab, string][]> = {
  dental: [
    ["pano", "Panorámica y cortes"],
    ["cuts", "Tres cortes"],
    ["xray", "Radiografía"],
  ],
  medical: [
    ["xray", "Radiografía"],
    ["cuts", "Tomografía"],
  ],
}

const PLANES = [
  { id: "axial", label: "Desde arriba" },
  { id: "coronal", label: "De frente" },
  { id: "sagittal", label: "De lado" },
] as const

/** El cuadro de cada plano con el que abre: los dientes desde arriba y los senos de frente. */
const START: Record<(typeof PLANES)[number]["id"], number> = { axial: 6, coronal: 4, sagittal: 12 }

const mm = (value: number) => `${value.toLocaleString("es", { maximumFractionDigits: 1 })} mm`

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <label className="iv-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

export default function ImagingDemo({ variant = "dental" }: { variant?: Variant }) {
  const tabs = TABS[variant]
  const [tab, setTab] = useState<Tab>(tabs[0][0])
  const [tooth, setTooth] = useState(CROSSES.length - 1)
  const [frame, setFrame] = useState(START)
  // En el teléfono se ve un plano a la vez.
  const [plane, setPlane] = useState<(typeof PLANES)[number]["id"]>("axial")
  const [light, setLight] = useState(100)
  const [contrast, setContrast] = useState(100)
  const [invert, setInvert] = useState(false)
  const [zoom, setZoom] = useState(false)
  const touched = useRef(false)

  // Pasa sola de pieza en pieza hasta que quien mira toca algo.
  useEffect(() => {
    if (variant !== "dental" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      return
    setTooth(0)
    const timer = window.setInterval(() => {
      if (touched.current) return window.clearInterval(timer)
      setTooth((t) => (t + 1) % CROSSES.length)
    }, 1800)
    return () => window.clearInterval(timer)
  }, [variant])

  const touch = () => {
    touched.current = true
  }
  const filter = `brightness(${light}%) contrast(${contrast}%)${invert ? " invert(1)" : ""}`
  const cross = CROSSES[tooth]
  const xray =
    variant === "dental"
      ? {
          src: `${IMG}/cefalometrica.jpg`,
          alt: "Radiografía lateral de cráneo (cefalométrica) de la tomografía de ejemplo: los dientes con sus brackets, la mandíbula y las vértebras del cuello.",
        }
      : {
          src: `${IMG}/senos.jpg`,
          alt: "Radiografía de cráneo de frente de la tomografía de ejemplo: las órbitas, los senos maxilares y los dientes.",
        }

  return (
    <div className="iv" data-variant={variant}>
      <div className="iv-top">
        <span className="iv-title">
          <b>
            {variant === "dental"
              ? "Tomografía (CBCT) · Lucía Ramos Soto"
              : "Imágenes · Rosa Paredes Luna"}
          </b>
          <span>
            {variant === "dental"
              ? "330 cortes de 0,5 mm · Centro de Imágenes San Borja"
              : "Las trajo a la consulta · se abren en su historia"}
          </span>
        </span>
        <fieldset className="iv-tabs" aria-label="Vista">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => {
                touch()
                setTab(id)
              }}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="iv-tools">
        <Slider
          label="Brillo"
          value={light}
          min={60}
          max={160}
          onChange={(v) => {
            touch()
            setLight(v)
          }}
        />
        <Slider
          label="Contraste"
          value={contrast}
          min={60}
          max={200}
          onChange={(v) => {
            touch()
            setContrast(v)
          }}
        />
        {tab === "xray" && (
          <>
            <button
              type="button"
              className="iv-tool"
              aria-pressed={invert}
              onClick={() => setInvert(!invert)}
            >
              Invertir
            </button>
            <button
              type="button"
              className="iv-tool"
              aria-pressed={zoom}
              onClick={() => setZoom(!zoom)}
            >
              Acercar
            </button>
          </>
        )}
        <button
          type="button"
          className="iv-tool ghost"
          onClick={() => {
            setLight(100)
            setContrast(100)
            setInvert(false)
            setZoom(false)
          }}
        >
          Restablecer
        </button>
      </div>

      {tab === "pano" && (
        <div className="iv-pano">
          <div className="iv-panel">
            <span className="iv-label">Panorámica · reconstruida del arco</span>
            <div className="iv-pano-img">
              <img
                src={`${IMG}/pano-hueso.jpg`}
                alt="Panorámica reconstruida de la tomografía de ejemplo: los dos maxilares con todas las piezas y sus brackets."
                width={576}
                height={513}
                style={{ filter }}
              />
              {/* La línea de la pieza elegida, como «Ir a la pieza» del visor. */}
              <span
                className="iv-mark"
                style={{ left: `${(cross.column / PANO_COLUMNS) * 100}%` }}
                aria-hidden="true"
              >
                <b>{cross.fdi}</b>
              </span>
            </div>
            <fieldset className="iv-teeth" aria-label="Ir a la pieza">
              {CROSSES.map((item, i) => (
                <button
                  key={item.fdi}
                  type="button"
                  aria-pressed={i === tooth}
                  onClick={() => {
                    touch()
                    setTooth(i)
                  }}
                >
                  {item.fdi}
                </button>
              ))}
            </fieldset>
          </div>
          <div className="iv-panel">
            <span className="iv-label">Corte de la {cross.fdi}</span>
            <div
              className="iv-cross"
              role="img"
              aria-label={`Corte transversal de la pieza ${cross.fdi}, con el ancho del hueso medido: ${mm(cross.mm)}.`}
              style={{
                backgroundImage: `url(${IMG}/cross.jpg)`,
                backgroundPosition: `${(tooth / (CROSSES.length - 1)) * 100}% 0`,
                filter,
              }}
            >
              <span
                className="iv-measure"
                style={{
                  left: `${(cross.x0 / CROSS_SIZE.width) * 100}%`,
                  width: `${((cross.x1 - cross.x0 + 1) / CROSS_SIZE.width) * 100}%`,
                  top: `${(CROSS_SIZE.row / CROSS_SIZE.height) * 100}%`,
                }}
                aria-hidden="true"
              >
                <b>{mm(cross.mm)}</b>
              </span>
            </div>
            <p className="iv-read">
              Ancho del hueso: <b>{mm(cross.mm)}</b>
            </p>
          </div>
        </div>
      )}

      {tab === "cuts" && variant === "dental" && (
        <fieldset className="iv-planes" aria-label="Plano">
          {PLANES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={plane === item.id}
              onClick={() => setPlane(item.id)}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
      )}
      {tab === "cuts" && (
        <div className="iv-cuts" data-planes={variant === "medical" ? 1 : 3}>
          {PLANES.filter((item) => variant === "dental" || item.id === "coronal").map((item) => {
            const k = frame[item.id]
            return (
              <div
                key={item.id}
                className="iv-panel"
                data-off={variant === "dental" && item.id !== plane ? "" : undefined}
              >
                <span className="iv-label">
                  {variant === "medical" ? "Tomografía de senos · de frente" : item.label}
                </span>
                <div
                  className="iv-frame"
                  role="img"
                  aria-label={`Corte ${k + 1} de ${FRAMES}, ${item.label.toLowerCase()}.`}
                  style={{
                    backgroundImage: `url(${IMG}/${item.id}.jpg)`,
                    backgroundPosition: `0 ${(k / (FRAMES - 1)) * 100}%`,
                    filter,
                  }}
                />
                <label className="iv-step">
                  <span className="sr-only">Cambiar de corte, {item.label.toLowerCase()}</span>
                  <input
                    type="range"
                    min={0}
                    max={FRAMES - 1}
                    value={k}
                    onChange={(event) => {
                      touch()
                      setFrame({ ...frame, [item.id]: Number(event.target.value) })
                    }}
                  />
                  <span aria-hidden="true">
                    {k + 1} de {FRAMES}
                  </span>
                </label>
              </div>
            )
          })}
        </div>
      )}

      {tab === "xray" && (
        <div className="iv-panel iv-xray">
          <span className="iv-label">
            {variant === "dental"
              ? "Radiografía lateral (cefalométrica)"
              : "Radiografía de cráneo y senos · de frente"}
          </span>
          <button
            type="button"
            className="iv-xray-img"
            data-zoom={zoom || undefined}
            onClick={() => setZoom(!zoom)}
            aria-label={zoom ? "Alejar" : "Acercar"}
          >
            <img src={xray.src} alt={xray.alt} width={720} height={660} style={{ filter }} />
          </button>
        </div>
      )}

      <p className="iv-foot">
        Tomografía real de ejemplo (3D Slicer), con las vistas que arma{" "}
        {variant === "dental" ? "odentIA" : "latidIA"}. Las medidas son orientativas.
      </p>
    </div>
  )
}

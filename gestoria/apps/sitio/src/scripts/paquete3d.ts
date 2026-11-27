/**
 * El paquete de la venta en 3D (web v4, three.js): la caja de cartón que recibe la zapatilla, se
 * cierra cuando el pago está confirmado, se sella con la cinta naranja de gestorIA y sale. Es el
 * objeto que viaja por la historia del Inicio: su estado sale de un solo número (`setProgress`, de
 * 0 a 1, el avance de la venta), así el scroll lo puede llevar adelante y atrás sin saltos.
 *
 * Barato a propósito: unas pocas cajas con MeshStandardMaterial, una sombra pintada en vez de
 * sombras reales, el pixel ratio tope 1.5 (1.25 en pantallas táctiles), y el dibujo se detiene
 * cuando el lienzo sale de la pantalla o la pestaña se oculta. Con «reducir movimiento» dibuja un
 * solo cuadro por cambio, sin flotar ni seguir el puntero.
 */
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from "three"

export type Modo = "venta" | "cierre"

export type Paquete = {
  setProgress(p: number): void
  setPointer(x: number, y: number): void
  dispose(): void
}

const CARTON = "#c48a55"
const CARTON_OSCURO = "#9c6a3c"
const MARCA = "#cc4604"

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))
/** El avance local de un tramo [a, b] del progreso, con salida suave. */
const tramo = (p: number, a: number, b: number) => {
  const t = clamp((p - a) / (b - a))
  return 1 - (1 - t) ** 3
}

/** La etiqueta del paquete: el pedido de la tienda de ejemplo y, ya confirmado, «Pagado». */
function etiqueta(pagado: boolean): CanvasTexture {
  const c = document.createElement("canvas")
  c.width = 512
  c.height = 288
  const g = c.getContext("2d") as CanvasRenderingContext2D
  g.fillStyle = "#fffdf9"
  g.beginPath()
  g.roundRect(0, 0, 512, 288, 28)
  g.fill()
  g.fillStyle = "#1d1512"
  g.font = "600 34px Figtree Variable, Figtree, system-ui, sans-serif"
  g.fillText("gestorIA", 36, 64)
  g.fillStyle = MARCA
  g.fillText("[24]", 36 + g.measureText("gestorIA").width, 64)
  g.fillStyle = "#1d1512"
  g.font = "500 40px Figtree Variable, Figtree, system-ui, sans-serif"
  g.fillText("Pedido 0018", 36, 136)
  g.fillStyle = "#6b5d55"
  g.font = "400 30px Figtree Variable, Figtree, system-ui, sans-serif"
  g.fillText("Reparto · Surco", 36, 182)
  const sello = pagado ? "Pagado" : "Pago por confirmar"
  g.font = "600 30px Figtree Variable, Figtree, system-ui, sans-serif"
  const w = g.measureText(sello).width + 40
  g.fillStyle = pagado ? "#dff3e4" : "#fbefd6"
  g.beginPath()
  g.roundRect(36, 210, w, 50, 25)
  g.fill()
  g.fillStyle = pagado ? "#1f7a4d" : "#8a5a00"
  g.fillText(sello, 56, 246)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 4
  return t
}

/** La sombra del paquete en el suelo: un degradado pintado, sin sombras en tiempo real. */
function sombra(): CanvasTexture {
  const c = document.createElement("canvas")
  c.width = c.height = 256
  const g = c.getContext("2d") as CanvasRenderingContext2D
  const r = g.createRadialGradient(128, 128, 10, 128, 128, 128)
  r.addColorStop(0, "rgba(40,20,8,.55)")
  r.addColorStop(1, "rgba(40,20,8,0)")
  g.fillStyle = r
  g.fillRect(0, 0, 256, 256)
  return new CanvasTexture(c)
}

export function crearPaquete(canvas: HTMLCanvasElement, modo: Modo, reducido: boolean): Paquete {
  const tactil = matchMedia("(pointer: coarse)").matches
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  })
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, tactil ? 1.25 : 1.5))
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05

  const scene = new Scene()
  const camera = new PerspectiveCamera(30, 1, 0.1, 100)
  if (modo === "cierre") camera.position.set(3.4, 2.6, 4.4)
  else camera.position.set(5.2, 4.4, 6.6)
  camera.lookAt(0, 0.55, 0)

  scene.add(new HemisphereLight(new Color("#fff4ea"), new Color("#3b2416"), 1.25))
  const sol = new DirectionalLight("#ffffff", 1.7)
  sol.position.set(4, 8, 5)
  scene.add(sol)
  const borde = new DirectionalLight(MARCA, modo === "cierre" ? 1.4 : 0.7)
  borde.position.set(-5, 3, -4)
  scene.add(borde)

  const carton = new MeshStandardMaterial({ color: CARTON, roughness: 0.88, metalness: 0 })
  const cartonDentro = new MeshStandardMaterial({ color: CARTON_OSCURO, roughness: 0.95 })
  const W = 2.2
  const D = 1.6
  const H = 1.25
  const t = 0.05

  const paquete = new Group()
  scene.add(paquete)

  const pared = (w: number, h: number, d: number, x: number, y: number, z: number, m = carton) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d), m)
    mesh.position.set(x, y, z)
    paquete.add(mesh)
    return mesh
  }
  pared(W, t, D, 0, t / 2, 0, cartonDentro)
  pared(W, H, t, 0, H / 2, D / 2)
  pared(W, H, t, 0, H / 2, -D / 2)
  pared(t, H, D, W / 2, H / 2, 0)
  pared(t, H, D, -W / 2, H / 2, 0)

  // Las solapas giran sobre su bisagra: un grupo en el borde de arriba y la tapa corrida hacia dentro.
  const solapa = (largo: number, ancho: number, eje: "x" | "z", lado: 1 | -1, y: number) => {
    const bisagra = new Group()
    const geo =
      eje === "x" ? new BoxGeometry(largo, t * 0.8, ancho) : new BoxGeometry(ancho, t * 0.8, largo)
    const mesh = new Mesh(geo, carton)
    if (eje === "x") {
      bisagra.position.set(0, y, (lado * D) / 2)
      mesh.position.z = (-lado * ancho) / 2
    } else {
      bisagra.position.set((lado * W) / 2, y, 0)
      mesh.position.x = (-lado * ancho) / 2
    }
    bisagra.add(mesh)
    paquete.add(bisagra)
    return bisagra
  }
  const frente = solapa(W, D / 2, "x", 1, H + 0.03)
  const fondo = solapa(W, D / 2, "x", -1, H + 0.03)
  const izq = solapa(D, W * 0.42, "z", -1, H)
  const der = solapa(D, W * 0.42, "z", 1, H)

  // La cinta naranja de gestorIA: crece de un lado al otro al sellar.
  const cintaGeo = new BoxGeometry(W + 0.12, 0.012, 0.34)
  cintaGeo.translate((W + 0.12) / 2, 0, 0)
  const cinta = new Mesh(cintaGeo, new MeshStandardMaterial({ color: MARCA, roughness: 0.45 }))
  cinta.position.set(-(W + 0.12) / 2, H + 0.075, 0)
  paquete.add(cinta)

  // La etiqueta del pedido, al frente.
  const texPendiente = etiqueta(false)
  const texPagado = etiqueta(true)
  const etiquetaMat = new MeshBasicMaterial({ map: texPendiente, transparent: true })
  const rotulo = new Mesh(new PlaneGeometry(1.2, 0.675), etiquetaMat)
  rotulo.position.set(-0.25, H * 0.48, D / 2 + t / 2 + 0.004)
  paquete.add(rotulo)

  // La zapatilla, en su caja: blanca con la tapa naranja. Cae dentro del paquete al armar el pedido.
  const zapatilla = new Group()
  const cajaZ = new Mesh(
    new BoxGeometry(1.25, 0.46, 0.78),
    new MeshStandardMaterial({ color: "#f6f1ea", roughness: 0.6 }),
  )
  const tapaZ = new Mesh(
    new BoxGeometry(1.29, 0.1, 0.82),
    new MeshStandardMaterial({ color: MARCA, roughness: 0.5 }),
  )
  tapaZ.position.y = 0.26
  zapatilla.add(cajaZ, tapaZ)
  paquete.add(zapatilla)

  const piso = new Mesh(
    new PlaneGeometry(5.4, 4.2),
    new MeshBasicMaterial({ map: sombra(), transparent: true, depthWrite: false }),
  )
  piso.rotation.x = -Math.PI / 2
  piso.position.y = 0.002
  scene.add(piso)

  let progreso = modo === "cierre" ? 1 : 0
  let px = 0
  let py = 0
  let rx = 0
  let ry = 0

  /** Todo el estado sale del progreso: el scroll puede ir y volver. */
  const aplicar = (p: number, tiempo: number) => {
    const aparece = modo === "cierre" ? 1 : tramo(p, 0, 0.12)
    const cae = tramo(p, 0.5, 0.6)
    const cierraLados = modo === "cierre" ? 1 : tramo(p, 0.68, 0.74)
    const cierraLargo = modo === "cierre" ? 1 : tramo(p, 0.72, 0.79)
    const sella = modo === "cierre" ? 1 : tramo(p, 0.78, 0.84)
    const sale = modo === "cierre" ? 0 : tramo(p, 0.88, 1)
    const flota = reducido ? 0 : Math.sin(tiempo * 1.4) * 0.05

    paquete.scale.setScalar(0.62 + 0.38 * aparece)
    izq.rotation.z = -2.15 * (1 - cierraLados)
    der.rotation.z = 2.15 * (1 - cierraLados)
    frente.rotation.x = 2.3 * (1 - cierraLargo)
    fondo.rotation.x = -2.3 * (1 - cierraLargo)
    cinta.scale.x = Math.max(0.0001, sella)
    cinta.visible = sella > 0.001
    etiquetaMat.map = p >= 0.76 || modo === "cierre" ? texPagado : texPendiente

    const visibleZ = modo === "cierre" ? false : p > 0.46 && cierraLargo < 0.999
    zapatilla.visible = visibleZ
    zapatilla.position.set(0, 3.2 - 2.92 * cae, 0)
    zapatilla.rotation.set(0.35 * (1 - cae), 0.5 * (1 - cae), -0.25 * (1 - cae))

    // El paquete sale por la derecha: se levanta un poco, gira y se va.
    paquete.position.set(
      7.5 * sale ** 1.6,
      0.04 + flota + Math.sin(sale * Math.PI) * 0.5,
      -1.2 * sale,
    )
    const base = modo === "cierre" ? -0.55 + tiempo * (reducido ? 0 : 0.25) : -0.42 + 0.3 * aparece
    paquete.rotation.set(rx * 0.35, base + ry * 0.6 + sale * 0.5, -0.06 * sale)
    piso.position.x = paquete.position.x
    piso.material.opacity = (1 - sale) * (0.55 + 0.45 * aparece)
  }

  const medir = () => {
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    // En un lienzo angosto, la cámara se aleja para que el paquete entre entero.
    camera.fov = w / h < 0.9 ? 40 : 30
    camera.updateProjectionMatrix()
  }

  let visible = false
  let corriendo = false
  let raf = 0
  const reloj = performance.now()
  const cuadro = () => {
    const tiempo = (performance.now() - reloj) / 1000
    rx += (py - rx) * 0.08
    ry += (px - ry) * 0.08
    aplicar(progreso, tiempo)
    renderer.render(scene, camera)
  }
  const bucle = () => {
    cuadro()
    raf = requestAnimationFrame(bucle)
  }
  const actualizar = () => {
    const debe = visible && !document.hidden && !reducido
    if (debe && !corriendo) {
      corriendo = true
      raf = requestAnimationFrame(bucle)
    } else if (!debe && corriendo) {
      corriendo = false
      cancelAnimationFrame(raf)
    }
    if (reducido && visible) cuadro()
  }
  const io = new IntersectionObserver((e) => {
    visible = e.some((x) => x.isIntersecting)
    actualizar()
  })
  io.observe(canvas)
  const ro = new ResizeObserver(() => {
    medir()
    cuadro()
  })
  ro.observe(canvas)
  document.addEventListener("visibilitychange", actualizar)
  medir()
  cuadro()

  return {
    setProgress(p) {
      progreso = clamp(p)
      if (!corriendo) cuadro()
    },
    setPointer(x, y) {
      if (reducido) return
      px = clamp(x, -1, 1)
      py = clamp(y, -1, 1)
    },
    dispose() {
      cancelAnimationFrame(raf)
      io.disconnect()
      ro.disconnect()
      document.removeEventListener("visibilitychange", actualizar)
      renderer.dispose()
    },
  }
}

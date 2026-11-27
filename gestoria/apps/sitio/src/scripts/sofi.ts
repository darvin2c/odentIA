// Sofi, el objeto vivo de la web (v5): un globo de chat de vidrio naranja con dos ojos, dibujado con
// un shader propio en three.js. Un solo lienzo fijo la dibuja sobre la página y ella viaja entre
// los lugares marcados con `data-sofi` (el héroe, cómo vende, la negociación, el pago, el cierre):
// va al que está más cerca del centro de la pantalla, con un resorte que la estira al volar.
//
// - La forma: una esfera que el shader de vértices aplana como un globo, le saca la colita, la
//   ondula y la aplasta (resorte) al tocarla o al llegar.
// - El vidrio: refracción y reflejo de un estudio de luz inventado en el shader, película fina que
//   cambia de color con el ángulo, brillos de ventana y un centro translúcido que deja ver la página.
// - Los ojos: dos píldoras dibujadas en el shader de fragmentos que parpadean, miran el puntero o lo
//   que importa y cambian con el humor (atenta, decidida, feliz).
//
// Cuida el celular: densidad de píxeles limitada, nada se dibuja cuando Sofi no está a la vista y
// la calidad baja sola si los cuadros se atrasan. Con «reducir movimiento» queda quieta: se dibuja
// solo cuando cambia el scroll, sin ondas, parpadeos ni vuelos.
import {
  AdditiveBlending,
  Color,
  IcosahedronGeometry,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three"

export type Humor = "atenta" | "decidida" | "feliz" | "curiosa"

type Lugar = {
  el: HTMLElement
  /** El tamaño de Sofi: el radio es esta fracción del lado menor del lugar. */
  escala: number
  humor: Humor
  /** Si se puede jugar con ella ahí (el cierre). */
  juego: boolean
}

const vertex = /* glsl */ `
uniform float uTiempo;
uniform float uOnda;
uniform vec2 uAplasta;   // x: ancho, y: alto (el resorte)
uniform vec3 uEstira;    // dirección y cuánto se estira al volar (z)
varying vec3 vObj;
varying vec3 vNormal;
varying vec3 vVista;

const vec3 COLA = vec3(-0.62, -0.78, 0.0);

vec3 forma(vec3 p) {
  vec3 q = p;
  // El cuerpo del globo: más ancho que alto y aplanado de frente, como una almohada.
  q *= vec3(1.16, 0.93, 0.74);
  // La colita: crece donde la normal apunta abajo a la izquierda.
  vec3 c = normalize(COLA);
  float d = dot(p, c);
  float k = smoothstep(0.76, 1.0, d);
  q += c * k * k * k * 0.62;
  // Se afina hacia la punta: lo que no es la dirección de la cola se encoge.
  q -= (p - c * d) * k * k * 0.55;
  // Una onda suave y lenta: respira.
  float n = sin(p.x * 3.1 + uTiempo * 1.3) * sin(p.y * 2.7 + uTiempo * 1.05) * sin(p.z * 2.2 + uTiempo * 0.8);
  q += p * n * 0.04 * uOnda;
  q.y += sin(uTiempo * 1.6) * 0.012 * uOnda;
  // El resorte y el estirón del vuelo.
  q.x *= uAplasta.x;
  q.y *= uAplasta.y;
  q.z *= (uAplasta.x + uAplasta.y) * 0.5;
  vec2 e = uEstira.xy;
  float s = uEstira.z;
  float largo = dot(q.xy, e);
  q.xy += e * largo * s;
  q.xy -= (q.xy - e * largo) * s * 0.35;
  return q;
}

void main() {
  vec3 p = normalize(position);
  vObj = p;
  vec3 P = forma(p);
  // La normal sale de dos vecinos sobre la esfera.
  vec3 a = normalize(cross(p, abs(p.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(p, a);
  float eps = 0.012;
  vec3 Pa = forma(normalize(p + a * eps));
  vec3 Pb = forma(normalize(p + b * eps));
  vec3 n = normalize(cross(Pa - P, Pb - P));
  if (dot(n, P) < 0.0) n = -n;
  vNormal = normalize(normalMatrix * n);
  vec4 mv = modelViewMatrix * vec4(P, 1.0);
  vVista = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`

const fragment = /* glsl */ `
precision highp float;
uniform float uTiempo;
uniform vec2 uMira;      // hacia dónde miran los ojos (-1..1)
uniform float uParpadeo; // 1 abierto, 0 cerrado
uniform float uFeliz;    // ojos en arco
uniform float uDecidida; // ojos con el párpado de arriba plano
uniform float uBrillo;   // un destello al celebrar
uniform vec3 uCuerpo;
uniform vec3 uHondo;
uniform vec3 uClaro;
varying vec3 vObj;
varying vec3 vNormal;
varying vec3 vVista;

// El estudio de luz que el vidrio refleja y refracta: un cielo cálido, dos ventanas y el piso.
vec3 estudio(vec3 d) {
  float y = d.y;
  vec3 c = mix(vec3(0.38, 0.17, 0.08), vec3(1.0, 0.94, 0.88), smoothstep(-0.45, 0.9, y));
  // Ventana grande arriba a la izquierda.
  float v1 = smoothstep(0.08, 0.0, abs(d.x + 0.42) - 0.26) * smoothstep(0.06, 0.0, abs(d.y - 0.62) - 0.2);
  // Ventana alta y angosta a la derecha.
  float v2 = smoothstep(0.05, 0.0, abs(d.x - 0.72) - 0.06) * smoothstep(0.08, 0.0, abs(d.y - 0.25) - 0.4);
  // El rebote naranja del piso.
  float piso = smoothstep(-0.2, -0.85, y);
  c += vec3(1.0) * v1 * 2.4 + vec3(1.0, 0.96, 0.9) * v2 * 1.6;
  c += vec3(1.0, 0.42, 0.1) * piso * 0.9;
  return c;
}

// Paleta de película fina, solo en tonos cálidos: oro, rosa y durazno.
vec3 pelicula(float t) {
  return vec3(0.78, 0.55, 0.45) + vec3(0.25, 0.32, 0.3) * cos(6.28318 * (vec3(1.0, 1.0, 1.0) * t + vec3(0.0, 0.18, 0.36)));
}

float pildora(vec2 p, vec2 c, vec2 r) {
  vec2 q = (p - c) / r;
  return (length(q) - 1.0) * min(r.x, r.y);
}

float arco(vec2 p, vec2 c, float r, float g) {
  vec2 q = p - c;
  float d = abs(length(q) - r) - g;
  // Solo la mitad de arriba: ojos felices ^ ^.
  return q.y < 0.0 ? length(vec2(abs(q.x) - r, q.y)) - g : d;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vVista);
  float nv = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(1.0 - nv, 2.6);

  vec3 R = reflect(-V, N);
  vec3 T = refract(-V, N, 1.0 / 1.45);
  vec3 refl = estudio(R);
  vec3 refr = estudio(T * vec3(1.0, 1.0, 1.0) + N * 0.25);

  // El cuerpo: luminoso al centro (la luz lo atraviesa) y más hondo solo en el borde.
  float grosor = mix(0.2, 1.0, pow(1.0 - nv, 1.4));
  vec3 cuerpo = mix(uClaro, uCuerpo, smoothstep(0.05, 0.75, grosor));
  cuerpo = mix(cuerpo, uHondo, smoothstep(0.78, 1.0, grosor) * 0.85);
  vec3 color = cuerpo * (0.72 + 0.5 * refr);
  // El brillo interno que junta la luz abajo, del lado contrario a la ventana.
  float caustica = pow(max(dot(N, normalize(vec3(0.35, -0.65, 0.65))), 0.0), 5.0);
  color += vec3(1.0, 0.78, 0.45) * caustica * 0.75;
  // Una luz de borde, como el contraluz de un vidrio.
  float borde = smoothstep(0.55, 1.0, 1.0 - nv);
  // Película fina en el borde: oro, rosa y durazno.
  vec3 iris = pelicula(fres * 1.6 + N.y * 0.35 + N.x * 0.2 + uTiempo * 0.05);
  color = mix(color, iris * 1.15, fres * 0.7);
  color += vec3(1.0, 0.62, 0.42) * borde * 0.25;
  // Reflejos de las ventanas del estudio.
  color += refl * fres * 1.1;
  vec3 L = normalize(vec3(-0.45, 0.65, 0.6));
  float spec = pow(max(dot(R, L), 0.0), 110.0);
  float spec2 = pow(max(dot(R, normalize(vec3(0.6, 0.2, 0.75))), 0.0), 40.0);
  color += vec3(1.0) * spec * 1.8 + vec3(1.0, 0.9, 0.8) * spec2 * 0.35;
  color += vec3(1.0, 0.85, 0.7) * uBrillo * (0.25 + fres);

  // Los ojos, de frente.
  vec2 o = vObj.xy;
  float frente = smoothstep(0.25, 0.55, vObj.z);
  vec2 mira = uMira * vec2(0.09, 0.07);
  vec2 cI = vec2(-0.27, 0.1) + mira;
  vec2 cD = vec2(0.27, 0.1) + mira;
  float alto = mix(0.03, 0.155, uParpadeo);
  float dI = pildora(o, cI, vec2(0.083, alto));
  float dD = pildora(o, cD, vec2(0.083, alto));
  // Decidida: el párpado de arriba corta la píldora en recto.
  float tapa = (o.y - (cI.y + alto * 0.35));
  dI = mix(dI, max(dI, tapa), uDecidida);
  dD = mix(dD, max(dD, tapa), uDecidida);
  // Feliz: arcos.
  float aI = arco(o, cI - vec2(0.0, 0.03), 0.085, 0.028);
  float aD = arco(o, cD - vec2(0.0, 0.03), 0.085, 0.028);
  dI = mix(dI, aI, uFeliz);
  dD = mix(dD, aD, uFeliz);
  float d = min(dI, dD);
  float aa = fwidth(d) * 1.2;
  float ojo = (1.0 - smoothstep(-aa, aa, d)) * frente;
  vec3 tinta = vec3(0.13, 0.04, 0.01);
  // Un puntito de luz en cada ojo.
  float luzI = 1.0 - smoothstep(0.0, 0.022, length(o - cI - vec2(-0.025, alto * 0.45)));
  float luzD = 1.0 - smoothstep(0.0, 0.022, length(o - cD - vec2(-0.025, alto * 0.45)));
  float luz = max(luzI, luzD) * (1.0 - uFeliz) * step(0.06, alto);
  color = mix(color, tinta, ojo * 0.94);
  color += vec3(1.0) * luz * ojo * 0.9;

  // El centro deja ver un poco la página: es vidrio.
  float alfa = mix(0.74, 1.0, smoothstep(0.1, 0.7, grosor));
  alfa = max(alfa, ojo);
  gl_FragColor = vec4(color * alfa, alfa);
}
`

const auraFrag = /* glsl */ `
precision highp float;
uniform float uFuerza;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, d);
  a = a * a * uFuerza;
  gl_FragColor = vec4(vec3(1.0, 0.42, 0.1) * a, a);
}
`
const auraVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`

const HUMOR: Record<Humor, { feliz: number; decidida: number }> = {
  atenta: { feliz: 0, decidida: 0 },
  curiosa: { feliz: 0, decidida: 0 },
  decidida: { feliz: 0, decidida: 1 },
  feliz: { feliz: 1, decidida: 0 },
}

export type Sofi = {
  /** Fija el humor de un lugar (las escenas lo cambian mientras avanzan). */
  humor(el: HTMLElement, humor: Humor): void
  /** Que mire a un punto de la pantalla (px), o al puntero con `null`. */
  mirar(punto: { x: number; y: number } | null): void
  /** Un saltito con destello: festeja. */
  festejar(): void
  /** Un toque: se aplasta y rebota. */
  tocar(): void
}

function hayWebGL(): boolean {
  try {
    const c = document.createElement("canvas")
    return !!(c.getContext("webgl2") || c.getContext("webgl"))
  } catch {
    return false
  }
}

export function crearSofi(quieta: boolean): Sofi | null {
  const elementos = [...document.querySelectorAll<HTMLElement>("[data-sofi]")]
  if (!elementos.length || !hayWebGL()) {
    document.documentElement.classList.add("sin-sofi")
    return null
  }
  const lugares: Lugar[] = elementos.map((el) => ({
    el,
    escala: Number(el.dataset.sofiEscala ?? "0.5"),
    humor: (el.dataset.sofi as Humor) || "atenta",
    juego: el.hasAttribute("data-sofi-juego"),
  }))

  const lienzo = document.createElement("canvas")
  lienzo.className = "sofi-lienzo"
  lienzo.setAttribute("aria-hidden", "true")
  document.body.appendChild(lienzo)

  const celular = matchMedia("(max-width: 767px)").matches
  let dprTope = celular ? 1.5 : 1.75
  const renderer = new WebGLRenderer({
    canvas: lienzo,
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    powerPreference: "high-performance",
  })
  renderer.setClearColor(0x000000, 0)

  const escena = new Scene()
  const camara = new OrthographicCamera(-1, 1, 1, -1, -2000, 2000)
  camara.position.z = 1000

  const uniforms = {
    uTiempo: { value: 0 },
    uOnda: { value: quieta ? 0 : 1 },
    uAplasta: { value: new Vector2(1, 1) },
    uEstira: { value: new Vector3(1, 0, 0) },
    uMira: { value: new Vector2(0, 0) },
    uParpadeo: { value: 1 },
    uFeliz: { value: 0 },
    uDecidida: { value: 0 },
    uBrillo: { value: 0 },
    uCuerpo: { value: new Color("#f05a12") },
    uHondo: { value: new Color("#9c3206") },
    uClaro: { value: new Color("#ffc59a") },
  }
  const material = new ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms,
    transparent: true,
    depthWrite: true,
  })
  const detalle = celular ? 28 : 40
  const malla = new Mesh(new IcosahedronGeometry(1, detalle), material)
  escena.add(malla)

  const auraU = { uFuerza: { value: 0.5 } }
  const aura = new Mesh(
    new PlaneGeometry(1, 1),
    new ShaderMaterial({
      vertexShader: auraVert,
      fragmentShader: auraFrag,
      uniforms: auraU,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  )
  aura.position.z = -400
  escena.add(aura)

  // ---------------------------------------------------------------- tamaño
  let ancho = 0
  let alto = 0
  let dpr = 1
  const medir = () => {
    ancho = window.innerWidth
    alto = window.innerHeight
    dpr = Math.min(window.devicePixelRatio || 1, dprTope)
    renderer.setPixelRatio(dpr)
    renderer.setSize(ancho, alto, false)
    camara.left = -ancho / 2
    camara.right = ancho / 2
    camara.top = alto / 2
    camara.bottom = -alto / 2
    camara.updateProjectionMatrix()
    sucio = true
  }
  let sucio = true
  let dibujada = false
  medir()
  window.addEventListener("resize", medir)

  // ---------------------------------------------------------------- estado
  const pos = { x: ancho * 0.7, y: alto * 0.3, vx: 0, vy: 0 }
  let radio = 0
  let radioV = 0
  let radioMeta = 0
  let lugar: Lugar | null = null
  let primera = true
  const aplasta = { s: 1, v: 0 }
  const humorDe = new Map<HTMLElement, Humor>()
  const animo = { feliz: 0, decidida: 0, brillo: 0 }
  const mira = { x: 0, y: 0, tx: 0, ty: 0 }
  let puntero: { x: number; y: number } | null = null
  let foco: { x: number; y: number } | null = null
  const rot = { x: 0, y: 0 }
  let proximoParpadeo = 1.5
  let parpadeo = 0

  if (!quieta) {
    window.addEventListener(
      "pointermove",
      (e) => {
        puntero = { x: e.clientX, y: e.clientY }
      },
      { passive: true },
    )
  }
  document.addEventListener("pointerdown", (e) => {
    if (quieta || !lugar?.juego || radio < 4) return
    const dx = e.clientX - pos.x
    const dy = e.clientY - pos.y
    if (Math.hypot(dx, dy) < radio * 1.3) sofi.tocar()
  })

  // ---------------------------------------------------------------- lugar activo
  // El lugar más cerca del centro de la pantalla, entre los que se ven.
  const elegir = (): { l: Lugar; r: DOMRect } | null => {
    let mejor: { l: Lugar; r: DOMRect } | null = null
    let dist = Number.POSITIVE_INFINITY
    const centro = alto * 0.5
    for (const l of lugares) {
      const r = l.el.getBoundingClientRect()
      if (r.width === 0 || r.bottom < alto * 0.06 || r.top > alto * 0.94) continue
      if (getComputedStyle(l.el).visibility === "hidden") continue
      const cy = r.top + r.height / 2
      // Un poco de preferencia por el que ya está activo: no salta de uno a otro.
      const d = Math.abs(cy - centro) - (l === lugar ? alto * 0.12 : 0)
      if (d < dist) {
        dist = d
        mejor = { l, r }
      }
    }
    return mejor
  }

  // ---------------------------------------------------------------- bucle
  let ultimo = performance.now()
  let lentos = 0
  let visible = true
  document.addEventListener("visibilitychange", () => {
    visible = document.visibilityState === "visible"
    ultimo = performance.now()
  })
  let scrolleo = true
  window.addEventListener("scroll", () => (scrolleo = true), { passive: true })

  const cuadro = (ahora: number) => {
    requestAnimationFrame(cuadro)
    if (!visible) return
    let dt = Math.min((ahora - ultimo) / 1000, 1 / 20)
    // La calidad baja sola si los cuadros se atrasan seguido.
    if (ahora - ultimo > 24 && radio > 2) lentos++
    else lentos = Math.max(0, lentos - 0.25)
    if (lentos > 40 && dprTope > 1) {
      dprTope = Math.max(1, dprTope - 0.25)
      lentos = 0
      medir()
    }
    ultimo = ahora
    if (quieta && !scrolleo && !sucio) return
    if (quieta) dt = 1
    scrolleo = false

    const activo = elegir()
    const cambio = activo?.l !== lugar
    lugar = activo?.l ?? null
    if (activo) {
      const r = activo.r
      const tx = r.left + r.width / 2
      const ty = r.top + r.height / 2
      radioMeta = (Math.min(r.width, r.height) / 2) * activo.l.escala * 2
      if (primera || quieta) {
        pos.x = tx
        pos.y = ty
        pos.vx = pos.vy = 0
        primera = false
      } else {
        // Resorte: sigue al lugar de cerca; al cambiar de lugar, vuela.
        const k = cambio ? 70 : 160
        const c = 2 * Math.sqrt(k) * 0.82
        pos.vx += (k * (tx - pos.x) - c * pos.vx) * dt
        pos.vy += (k * (ty - pos.y) - c * pos.vy) * dt
        pos.x += pos.vx * dt
        pos.y += pos.vy * dt
      }
      if (cambio && !quieta) aplasta.v -= 2.2
    } else {
      radioMeta = 0
    }

    // El tamaño, también con resorte (aparece con un pop).
    if (quieta) {
      radio = radioMeta
    } else {
      const k = 110
      radioV += (k * (radioMeta - radio) - 2 * Math.sqrt(k) * 0.6 * radioV) * dt
      radio = Math.max(0, radio + radioV * dt)
    }

    if (radio < 0.6 && radioMeta === 0) {
      if (dibujada) {
        renderer.clear()
        dibujada = false
      }
      sucio = false
      radio = 0
      radioV = 0
      return
    }
    sucio = false
    dibujada = true

    // Ánimo: el humor del lugar, o el que fijó la escena.
    const h = lugar ? HUMOR[humorDe.get(lugar.el) ?? lugar.humor] : HUMOR.atenta
    const suav = quieta ? 1 : 1 - Math.exp(-dt * 7)
    animo.feliz += (h.feliz - animo.feliz) * suav
    animo.decidida += (h.decidida - animo.decidida) * suav
    animo.brillo *= quieta ? 0 : Math.exp(-dt * 3)

    // Aplastarse: resorte.
    if (!quieta) {
      const k = 260
      aplasta.v += (-k * (aplasta.s - 1) - 2 * Math.sqrt(k) * 0.25 * aplasta.v) * dt
      aplasta.s += aplasta.v * dt
    }
    const s = Math.min(Math.max(aplasta.s, 0.6), 1.45)
    uniforms.uAplasta.value.set(1 / Math.sqrt(s), s)

    // Estirarse con la velocidad del vuelo.
    const vel = Math.hypot(pos.vx, pos.vy)
    const est = quieta ? 0 : Math.min(vel / 4000, 0.28)
    if (vel > 1) uniforms.uEstira.value.set(pos.vx / vel, -pos.vy / vel, est)
    else uniforms.uEstira.value.z = 0

    // Mirar: al foco de la escena, al puntero o un poco al frente.
    const objetivo = foco ?? puntero
    if (objetivo && !quieta) {
      const dx = (objetivo.x - pos.x) / Math.max(radio * 4, 200)
      const dy = (objetivo.y - pos.y) / Math.max(radio * 4, 200)
      mira.tx = Math.max(-1, Math.min(1, dx))
      mira.ty = Math.max(-1, Math.min(1, -dy))
    } else if (!quieta) {
      mira.tx = Math.sin(ahora / 2100) * 0.35
      mira.ty = Math.sin(ahora / 2900) * 0.2
    } else {
      mira.tx = 0.15
      mira.ty = 0.05
    }
    const sm = quieta ? 1 : 1 - Math.exp(-dt * 6)
    mira.x += (mira.tx - mira.x) * sm
    mira.y += (mira.ty - mira.y) * sm
    uniforms.uMira.value.set(mira.x, mira.y)
    rot.x += (-mira.y * 0.2 - rot.x) * sm
    rot.y += (mira.x * 0.26 - rot.y) * sm

    // Parpadeo.
    if (!quieta) {
      proximoParpadeo -= dt
      if (proximoParpadeo <= 0) {
        parpadeo = 1
        proximoParpadeo = 2.2 + Math.random() * 3.2
        if (Math.random() < 0.2) proximoParpadeo = 0.22 // a veces dos seguidos
      }
      parpadeo = Math.max(0, parpadeo - dt * 7.5)
      uniforms.uParpadeo.value = 1 - Math.sin(parpadeo * Math.PI)
    }

    uniforms.uTiempo.value = quieta ? 1.2 : ahora / 1000
    uniforms.uFeliz.value = animo.feliz
    uniforms.uDecidida.value = animo.decidida
    uniforms.uBrillo.value = animo.brillo

    malla.position.set(pos.x - ancho / 2, alto / 2 - pos.y, 0)
    malla.scale.setScalar(radio)
    malla.rotation.set(rot.x, rot.y, quieta ? 0 : Math.sin(ahora / 1700) * 0.05)
    aura.position.set(malla.position.x, malla.position.y - radio * 0.1, -400)
    aura.scale.setScalar(radio * 4.2)
    auraU.uFuerza.value = 0.28 + animo.brillo * 0.5 + animo.feliz * 0.08

    renderer.render(escena, camara)
  }
  requestAnimationFrame(cuadro)

  const sofi: Sofi = {
    humor(el, humor) {
      humorDe.set(el, humor)
      scrolleo = true
    },
    mirar(punto) {
      foco = punto
    },
    festejar() {
      if (quieta) return
      animo.brillo = 1
      aplasta.v += 3.4
    },
    tocar() {
      if (quieta) return
      aplasta.v -= 4.5
      animo.brillo = Math.max(animo.brillo, 0.6)
      parpadeo = 1
    },
  }
  return sofi
}

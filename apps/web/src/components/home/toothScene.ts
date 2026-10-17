// Escena WebGL de la portada: las 32 piezas dentales en dos arcadas. Cada trabajo del jueves
// de ejemplo enciende una pieza con el color del agente que lo hizo; el mensaje viaja del canal
// a la pieza (o de la pieza al canal si escribe el Administrador) y una línea la une con el registro.
// Geometría y shaders portados tal cual del tablero aprobado (portada «D3»).
import { AGENTS, DAY } from "./heroData"

export interface SceneHost {
  /** Estado actual: trabajos hechos, pieza señalada y si la escena está quieta (pausa o menos movimiento). */
  state(): { step: number; hover: number; still: boolean }
  /** Punto del canal (en píxeles del lienzo) desde donde sale o adonde llega el mensaje. */
  anchor(ch: number): [number, number]
  /** Punto del registro al que se une la pieza. */
  panelPt(): [number, number]
  cap: HTMLElement | null
  lineIn: SVGLineElement | null
  lineOut: SVGLineElement | null
  dot: SVGCircleElement | null
}

type Geo = { pb: WebGLBuffer; nb: WebGLBuffer; ib: WebGLBuffer; cnt: number }
type Tooth = {
  p: number[]
  out: number[]
  yaw: number
  kind: string
  sc: number[]
  ph: number
  lit: number
  lift: number
}

/** Piezas con forma de diente: cúspides, raíz más angosta y normales recalculadas. */
function toothGeo(kind: string) {
  const LAT = 30,
    LON = 36,
    E = 3.0,
    P: number[] = [],
    I: number[] = []
  const sm = (a: number, b: number, x: number) => {
    const u = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return u * u * (3 - 2 * u)
  }
  for (let i = 0; i <= LAT; i++) {
    const th = (i / LAT) * Math.PI
    for (let j = 0; j <= LON; j++) {
      const ph = (j / LON) * Math.PI * 2
      const dx = Math.sin(th) * Math.cos(ph),
        dy = Math.cos(th),
        dz = Math.sin(th) * Math.sin(ph)
      const r = (Math.abs(dx) ** E + Math.abs(dy) ** E + Math.abs(dz) ** E) ** (-1 / E)
      let x = dx * r,
        y = dy * r,
        z = dz * r
      const root = sm(-0.1, 1, y),
        occ = sm(-0.45, -1, y)
      const tp = (1 - 0.32 * root ** 1.3) * (1 + 0.06 * Math.exp(-(((y + 0.35) / 0.35) ** 2)))
      x *= tp
      z *= tp
      if (kind === "inc") z *= 1 - 0.3 * occ
      if (kind === "can") y -= 0.24 * occ * Math.exp(-(x * x + z * z) / 0.18)
      if (kind === "pre") y += 0.13 * occ * Math.exp(-(z * z) / 0.05)
      if (kind === "mol") y += 0.17 * occ * Math.exp(-(x * x + z * z) / 0.14)
      P.push(x, y, z)
    }
  }
  for (let i = 0; i < LAT; i++)
    for (let j = 0; j < LON; j++) {
      const a = i * (LON + 1) + j,
        b = a + LON + 1
      I.push(a, b, a + 1, b, b + 1, a + 1)
    }
  const N: number[] = new Array(P.length).fill(0)
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3,
      b = I[t + 1] * 3,
      c = I[t + 2] * 3
    const ux = P[b] - P[a],
      uy = P[b + 1] - P[a + 1],
      uz = P[b + 2] - P[a + 2],
      vx = P[c] - P[a],
      vy = P[c + 1] - P[a + 1],
      vz = P[c + 2] - P[a + 2]
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx
    ;[a, b, c].forEach((k) => {
      N[k] += nx
      N[k + 1] += ny
      N[k + 2] += nz
    })
  }
  let dot = 0
  for (let k = 0; k < N.length; k += 3) {
    const l = Math.hypot(N[k], N[k + 1], N[k + 2]) || 1
    N[k] /= l
    N[k + 1] /= l
    N[k + 2] /= l
    dot += N[k] * P[k] + N[k + 1] * P[k + 1] + N[k + 2] * P[k + 2]
  }
  if (dot < 0) for (let k = 0; k < N.length; k++) N[k] = -N[k]
  return { P, N, I }
}

const VS =
  "attribute vec3 aP;attribute vec3 aN;uniform mat4 uPV;uniform mat3 uR;uniform vec3 uS;uniform vec3 uT;varying vec3 vN;varying vec3 vW;varying float vY;void main(){vec3 p=uR*(aP*uS)+uT;vN=normalize(uR*(aN/uS));vW=p;vY=aP.y;gl_Position=uPV*vec4(p,1.0);}"
const FS =
  "precision mediump float;varying vec3 vN;varying vec3 vW;varying float vY;uniform vec3 uC;uniform vec3 uTint;uniform float uLit;uniform float uGlow;uniform float uHov;void main(){vec3 n=normalize(vN);vec3 v=normalize(uC-vW);vec3 l1=normalize(vec3(0.3,0.9,0.6));vec3 l2=normalize(vec3(-0.8,-0.2,-0.4));float w1=dot(n,l1)*0.5+0.5;float d1=max(dot(n,l1),0.0);float d2=max(dot(n,l2),0.0);float fr=pow(1.0-max(dot(n,v),0.0),3.0);vec3 h=normalize(l1+v);float sp=pow(max(dot(n,h),0.0),40.0);vec3 base=vec3(0.94,0.93,0.89);float ao=mix(1.0,0.7,smoothstep(0.15,1.0,vY));vec3 col=base*(0.16+0.46*w1+0.3*d1)*ao+vec3(0.31,0.76,0.84)*d2*0.14+vec3(0.85,0.95,1.0)*fr*0.26+vec3(1.0)*sp*0.24;col=mix(col,col*0.3+uTint*0.78,uLit*0.6);col=mix(col,uTint*1.2+vec3(0.12),uGlow);col+=vec3(1.0)*uHov*0.14;gl_FragColor=vec4(col,1.0);}"

export class ToothScene {
  /** Posición en pantalla de cada pieza (para señalarlas con el cursor o el dedo). */
  scr: [number, number][] = []
  /** Inclinación que pide el cursor, de -1 a 1. */
  tmx = 0
  tmy = 0
  /** Momento en que empezó el último trabajo. */
  stepAt = performance.now()
  private host: SceneHost
  private cv: HTMLCanvasElement | null = null
  private gl: WebGLRenderingContext | null = null
  private locP = 0
  private locN = 0
  private G: Record<string, Geo> = {}
  private U: Record<string, WebGLUniformLocation | null> = {}
  private T: Tooth[] = []
  private mx = 0
  private my = 0
  private t0 = performance.now()
  private t = 0
  private vis = true
  private raf: number | null = null
  private io: IntersectionObserver | null = null
  private dead = false

  constructor(host: SceneHost) {
    this.host = host
  }

  start(cv: HTMLCanvasElement): boolean {
    let gl: WebGLRenderingContext | null = null
    try {
      gl = cv.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true })
    } catch {
      gl = null
    }
    if (!gl) return false
    this.cv = cv
    this.gl = gl
    const sh = (t: number, src: string) => {
      const o = gl.createShader(t)!
      gl.shaderSource(o, src)
      gl.compileShader(o)
      return o
    }
    const pr = gl.createProgram()!
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS))
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(pr)
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return false
    // biome-ignore lint/correctness/useHookAtTopLevel: es el método useProgram de WebGL, no un hook de React.
    gl.useProgram(pr)
    this.locP = gl.getAttribLocation(pr, "aP")
    this.locN = gl.getAttribLocation(pr, "aN")
    gl.enableVertexAttribArray(this.locP)
    gl.enableVertexAttribArray(this.locN)
    ;["inc", "can", "pre", "mol"].forEach((kind) => {
      const g = toothGeo(kind)
      const pb = gl.createBuffer()!
      gl.bindBuffer(gl.ARRAY_BUFFER, pb)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.P), gl.STATIC_DRAW)
      const nb = gl.createBuffer()!
      gl.bindBuffer(gl.ARRAY_BUFFER, nb)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.N), gl.STATIC_DRAW)
      const ib = gl.createBuffer()!
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(g.I), gl.STATIC_DRAW)
      this.G[kind] = { pb, nb, ib, cnt: g.I.length }
    })
    ;["uPV", "uR", "uS", "uT", "uC", "uTint", "uLit", "uGlow", "uHov"].forEach((u) => {
      this.U[u] = gl.getUniformLocation(pr, u)
    })
    gl.enable(gl.DEPTH_TEST)
    const types: [number, number, number, string][] = [
      [0.46, 0.94, 0.32, "inc"],
      [0.38, 0.88, 0.3, "inc"],
      [0.42, 1.0, 0.44, "can"],
      [0.46, 0.82, 0.54, "pre"],
      [0.46, 0.8, 0.54, "pre"],
      [0.68, 0.72, 0.68, "mol"],
      [0.64, 0.68, 0.64, "mol"],
      [0.58, 0.64, 0.58, "mol"],
    ]
    this.T = []
    for (let arch = 0; arch < 2; arch++) {
      const A = arch ? 2.25 : 2.42,
        B = arch ? 2.7 : 2.9,
        y = arch ? -0.6 : 0.6,
        f = arch ? 0.93 : 1
      for (const side of [1, -1]) {
        let phi = 0,
          acc = 0
        for (let k = 0; k < 8; k++) {
          const w = types[k][0] * 0.92 * f
          let target = acc + w / 2
          while (acc < target) {
            acc += Math.hypot(A * Math.cos(phi), B * Math.sin(phi)) * 0.004
            phi += 0.004
          }
          const x = side * A * Math.sin(phi),
            z = B * Math.cos(phi) - B * 0.55,
            tx = side * A * Math.cos(phi),
            tz = -B * Math.sin(phi)
          const ol = Math.hypot(x, z + B * 0.2) || 1
          this.T.push({
            p: [x, y, z],
            out: [x / ol, 0, (z + B * 0.2) / ol],
            yaw: Math.atan2(-tz, tx),
            kind: types[k][3],
            sc: [
              types[k][0] * 0.5 * f,
              types[k][1] * 0.5 * f * (arch ? -1 : 1),
              types[k][2] * 0.5 * f,
            ],
            ph: arch * 8 + k + (side > 0 ? 0 : 16),
            lit: 0,
            lift: 0,
          })
          target = acc + w / 2 + 0.07
          while (acc < target) {
            acc += Math.hypot(A * Math.cos(phi), B * Math.sin(phi)) * 0.004
            phi += 0.004
          }
        }
      }
    }
    this.scr = this.T.map(() => [0, 0])
    this.mx = 0
    this.my = 0
    this.tmx = 0
    this.tmy = 0
    this.t0 = performance.now()
    this.vis = true
    this.t = 0
    this.stepAt = performance.now()
    // Sin dibujar mientras la escena no está en pantalla.
    if (window.IntersectionObserver) {
      this.io = new IntersectionObserver((es) => {
        this.vis = es[0].isIntersecting
        if (this.vis && !this.raf) this.loop()
      })
      this.io.observe(cv)
    }
    this.loop()
    return true
  }

  stop() {
    this.dead = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = null
    this.io?.disconnect()
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext()
    this.gl = null
  }

  private loop() {
    this.raf = null
    if (this.dead || !this.gl) return
    if (this.vis) {
      this.draw()
      this.raf = requestAnimationFrame(() => this.loop())
    }
  }

  private draw() {
    const gl = this.gl!,
      cv = this.cv!,
      h = this.host,
      st = h.state(),
      still = st.still,
      D = DAY,
      AG = AGENTS
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75),
      cw = cv.clientWidth,
      ch = cv.clientHeight
    const W = Math.max(1, Math.round(cw * dpr)),
      H = Math.max(1, Math.round(ch * dpr))
    if (cv.width !== W || cv.height !== H) {
      cv.width = W
      cv.height = H
    }
    gl.viewport(0, 0, W, H)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    const now = performance.now()
    if (!still) this.t = (now - this.t0) / 1000
    const t = this.t,
      step = still ? 32 : st.step
    this.mx += ((still ? 0 : this.tmx) - this.mx) * 0.04
    this.my += ((still ? 0 : this.tmy) - this.my) * 0.04
    const aspect = W / H,
      f = 1 / Math.tan((15 * Math.PI) / 180),
      n = 0.1,
      fa = 60,
      camZ = Math.max(10.4, 3.5 / (Math.tan((15 * Math.PI) / 180) * aspect)) + 0.8
    const Pm = [
      f / aspect,
      0,
      0,
      0,
      0,
      f,
      0,
      0,
      0,
      0,
      (fa + n) / (n - fa),
      -1,
      0,
      0,
      (2 * fa * n) / (n - fa),
      0,
    ]
    const V = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.55, -camZ, 1]
    const m4 = (a: number[], b: number[]) => {
      const o: number[] = []
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
          let x = 0
          for (let k = 0; k < 4; k++) x += a[k * 4 + r] * b[c * 4 + k]
          o[c * 4 + r] = x
        }
      return o
    }
    const m3 = (a: number[], b: number[]) => {
      const o: number[] = []
      for (let c = 0; c < 3; c++)
        for (let r = 0; r < 3; r++) {
          let x = 0
          for (let k = 0; k < 3; k++) x += a[k * 3 + r] * b[c * 3 + k]
          o[c * 3 + r] = x
        }
      return o
    }
    const ap = (m: number[], v: number[]) => [
      m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
      m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
      m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
    ]
    const rX = (a: number) => {
      const c = Math.cos(a),
        s = Math.sin(a)
      return [1, 0, 0, 0, c, s, 0, -s, c]
    }
    const rY = (a: number) => {
      const c = Math.cos(a),
        s = Math.sin(a)
      return [c, 0, -s, 0, 1, 0, s, 0, c]
    }
    const PV = m4(Pm, V)
    gl.uniformMatrix4fv(this.U.uPV, false, new Float32Array(PV))
    gl.uniform3f(this.U.uC, 0, -0.55, camZ)
    const G = m3(
      rX(0.5 - this.my * 0.12),
      rY(-0.3 + this.mx * 0.28 + (still ? 0 : Math.sin(t * 0.11) * 0.32)),
    )
    const newest = step > 0 ? D.order[step - 1] : -1,
      hov = st.hover
    const nEv = step > 0 ? D.ev[step - 1] : null,
      inb = !!nEv && nEv.agent !== 2
    const since = now - (this.stepAt || 0),
      fp = still ? 1 : Math.min(1, since / 900)
    const flash = still ? 0 : Math.max(0, 1 - Math.max(0, since - (inb ? 900 : 0)) / 1300)
    this.T.forEach((p, i) => {
      const slot = D.slotOf[i],
        ev = D.ev[slot],
        on = slot < step && !(slot === step - 1 && ev.agent !== 2 && fp < 1),
        tint = AG[ev.agent].rgb
      p.lit += ((on ? 1 : 0) - p.lit) * (still ? 1 : on ? 0.08 : 0.12)
      const up = i === newest || i === hov ? 1 : 0
      p.lift += (up - p.lift) * (still ? 1 : 0.1)
      const o = 0.16 * p.lift,
        fl = still ? 0 : Math.sin(t * 0.9 + p.ph) * 0.012
      const w = ap(G, [p.p[0] + p.out[0] * o, p.p[1] + fl, p.p[2] + p.out[2] * o])
      const cx = PV[0] * w[0] + PV[4] * w[1] + PV[8] * w[2] + PV[12],
        cy = PV[1] * w[0] + PV[5] * w[1] + PV[9] * w[2] + PV[13],
        cwv = PV[3] * w[0] + PV[7] * w[1] + PV[11] * w[2] + PV[15]
      this.scr[i] = [((cx / cwv) * 0.5 + 0.5) * cw, (1 - ((cy / cwv) * 0.5 + 0.5)) * ch]
      const g = this.G[p.kind]
      gl.bindBuffer(gl.ARRAY_BUFFER, g.pb)
      gl.vertexAttribPointer(this.locP, 3, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, g.nb)
      gl.vertexAttribPointer(this.locN, 3, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ib)
      gl.uniformMatrix3fv(this.U.uR, false, new Float32Array(m3(G, rY(p.yaw))))
      gl.uniform3f(this.U.uS, p.sc[0], p.sc[1], p.sc[2])
      gl.uniform3f(this.U.uT, w[0], w[1], w[2])
      gl.uniform3f(this.U.uTint, tint[0], tint[1], tint[2])
      gl.uniform1f(this.U.uLit, p.lit)
      gl.uniform1f(this.U.uGlow, i === newest && on ? 0.28 + 0.5 * flash : 0)
      gl.uniform1f(this.U.uHov, i === hov ? 1 : 0)
      gl.drawElements(gl.TRIANGLES, g.cnt, gl.UNSIGNED_SHORT, 0)
    })

    // El mensaje viaja del canal a la pieza (o, si escribe el Administrador, de la pieza al canal)
    let pr = 1,
      cx2 = 0,
      cy2 = 0
    if (h.cap) {
      let op = 0
      if (!still && hov < 0 && newest >= 0 && nEv) {
        const c = h.anchor(nEv.ch),
          [tx, ty] = this.scr[newest]
        pr = inb ? fp : Math.min(1, Math.max(0, (since - 350) / 900))
        const e = pr < 0.5 ? 2 * pr * pr : 1 - (-2 * pr + 2) ** 2 / 2
        cx2 = inb ? c[0] + (tx - c[0]) * e : tx + (c[0] - tx) * e
        cy2 = inb ? c[1] + (ty - c[1]) * e : ty + (c[1] - ty) * e
        op = pr <= 0 || pr >= 1 ? 0 : Math.min(1, pr * 8, (1 - pr) * 6)
        h.cap.style.transform =
          "translate(" + cx2.toFixed(1) + "px," + cy2.toFixed(1) + "px) translate(-50%, -50%)"
      }
      h.cap.style.opacity = op.toFixed(2)
    }
    // La línea une el canal con la pieza, y la pieza con el registro
    const focus = hov >= 0 ? hov : newest
    if (h.lineIn && h.lineOut && h.dot) {
      const L: Element[] = [h.lineIn, h.lineOut, h.dot]
      if (focus >= 0 && !(still && hov < 0)) {
        const [sx, sy] = this.scr[focus],
          e = D.ev[D.slotOf[focus]],
          color = AG[e.agent].color,
          c = h.anchor(e.ch),
          pp = h.panelPt()
        const set = (el: Element, o: Record<string, string>) => {
          for (const k in o) el.setAttribute(k, o[k])
        }
        const live = hov < 0 && focus === newest,
          flying = live && pr > 0 && pr < 1,
          waiting = live && !inb && pr <= 0
        const p1 = flying && !inb ? [sx, sy] : c,
          p2 = flying ? [cx2, cy2] : [sx, sy]
        set(h.lineIn, {
          x1: p1[0].toFixed(1),
          y1: p1[1].toFixed(1),
          x2: p2[0].toFixed(1),
          y2: p2[1].toFixed(1),
          stroke: color,
          opacity: waiting ? "0" : "0.9",
        })
        const arrived = !(live && inb && pr < 1)
        set(h.lineOut, {
          x1: sx.toFixed(1),
          y1: sy.toFixed(1),
          x2: pp[0].toFixed(1),
          y2: pp[1].toFixed(1),
          opacity: arrived ? "0.45" : "0",
        })
        set(h.dot, { cx: sx.toFixed(1), cy: sy.toFixed(1), opacity: arrived ? "1" : "0" })
      } else
        L.forEach((el) => {
          el.setAttribute("opacity", "0")
        })
    }
  }
}

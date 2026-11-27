// El mar de puntos de la sección de rubros (web v5): una malla de puntos en perspectiva que ondula
// despacio, en WebGL puro (sin three.js: son pocas líneas). Solo se dibuja mientras la sección se
// ve; con «reducir movimiento» se dibuja una vez y queda quieta. Sin WebGL, la sección queda con su
// fondo gris y nada más.

const vertice = `
attribute vec2 aPos;
uniform float uTiempo;
uniform float uAspecto;
varying float vLuz;
void main() {
  // aPos va de 0 a 1 en x (a lo ancho) y en y (de cerca a lejos).
  float x = (aPos.x - 0.5) * 2.4;
  float z = aPos.y;
  float onda = sin(x * 3.2 + uTiempo * 0.7) * 0.06 + sin(z * 9.0 - uTiempo * 0.9 + x * 1.7) * 0.05;
  float y = -0.5 + onda + z * 0.75;
  // Perspectiva: lo lejano se junta hacia el centro y se achica.
  float p = 1.0 / (0.55 + z * 1.6);
  gl_Position = vec4(x * p / uAspecto * 0.9, y * p * 0.9 + 0.05, 0.0, 1.0);
  gl_PointSize = (2.6 + onda * 18.0) * p * 1.5;
  vLuz = clamp(1.0 - z, 0.0, 1.0) * (0.55 + onda * 4.0);
}
`
const fragmento = `
precision mediump float;
varying float vLuz;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.2, d) * clamp(vLuz, 0.0, 1.0);
  // Gris tinta, con un toque del naranja en las crestas.
  vec3 color = mix(vec3(0.07, 0.07, 0.08), vec3(0.996, 0.31, 0.008), clamp(vLuz - 0.45, 0.0, 1.0) * 1.4);
  gl_FragColor = vec4(color * a * 0.7, a * 0.7);
}
`

export function marDePuntos(lienzo: HTMLCanvasElement, quieta: boolean) {
  const gl = lienzo.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: true })
  if (!gl) return
  const compilar = (tipo: number, src: string) => {
    const s = gl.createShader(tipo)
    if (!s) return null
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
  }
  const vs = compilar(gl.VERTEX_SHADER, vertice)
  const fs = compilar(gl.FRAGMENT_SHADER, fragmento)
  const prog = gl.createProgram()
  if (!vs || !fs || !prog) return
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return
  // biome-ignore lint/correctness/useHookAtTopLevel: es WebGL, no un hook de React.
  gl.useProgram(prog)

  const celular = window.innerWidth < 768
  const columnas = celular ? 70 : 140
  const filas = celular ? 34 : 56
  const datos = new Float32Array(columnas * filas * 2)
  let k = 0
  for (let f = 0; f < filas; f++)
    for (let c = 0; c < columnas; c++) {
      datos[k++] = c / (columnas - 1)
      datos[k++] = f / (filas - 1)
    }
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, datos, gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(prog, "aPos")
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
  const uTiempo = gl.getUniformLocation(prog, "uTiempo")
  const uAspecto = gl.getUniformLocation(prog, "uAspecto")
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0, 0, 0, 0)

  const medir = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    lienzo.width = Math.round(lienzo.clientWidth * dpr)
    lienzo.height = Math.round(lienzo.clientHeight * dpr)
    gl.viewport(0, 0, lienzo.width, lienzo.height)
    gl.uniform1f(uAspecto, lienzo.width / Math.max(1, lienzo.height))
  }
  const dibujar = (t: number) => {
    gl.uniform1f(uTiempo, t / 1000)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.POINTS, 0, columnas * filas)
  }
  medir()
  window.addEventListener("resize", () => {
    medir()
    if (quieta) dibujar(4000)
  })
  if (quieta) {
    dibujar(4000)
    return
  }
  let visible = false
  let pedido = 0
  const bucle = (t: number) => {
    if (!visible) return
    dibujar(t)
    pedido = requestAnimationFrame(bucle)
  }
  new IntersectionObserver(([e]) => {
    visible = !!e?.isIntersecting
    cancelAnimationFrame(pedido)
    if (visible) pedido = requestAnimationFrame(bucle)
  }).observe(lienzo)
}

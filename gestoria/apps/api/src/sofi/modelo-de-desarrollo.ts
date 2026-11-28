import type { ChatMessage, ChatModel, ModelReply, ToolCall } from "./modelo.js"

/**
 * El modelo de desarrollo (`GESTORIA_LLM_MODEL=fake`): sin red ni costo, responde por reglas
 * fijas con las herramientas de verdad de Sofi. Sirve para ver «Probar como clienta» en local y en
 * los recorridos e2e: busca, manda la foto del color o el video, cotiza y ofrece el envío gratis
 * una vez, anota el pedido cuando la clienta confirma, deja a la tienda lo que la ficha no dice y
 * dice lo que avisó la tienda. No es Sofi: no cuenta como medición y nunca corre en producción.
 */

const NONE = { input: 0, cached: 0, output: 0 }
let next = 0

function call(name: string, args: Record<string, unknown>): Partial<ModelReply> {
  next += 1
  const toolCall: ToolCall = {
    id: `dev_${next}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }
  return { content: null, toolCalls: [toolCall] }
}

const say = (content: string): Partial<ModelReply> => ({ content, toolCalls: [] })

const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

interface Found {
  producto_id: string
  nombre: string
  precio: string
  estado?: string
  datos?: { dato: string; valor: string }[]
  la_ficha_no_dice?: string[]
  preguntas_respondidas?: { pregunta: string; respuesta: string }[]
  colores?: { color: string; foto: boolean }[]
  video?: string
  puede_ofrecer?: string[]
  combina?: { producto_id: string; nombre: string; precio: string }[]
  variantes: {
    variante_id: string
    opciones: string
    precio: string
    stock: number
    agotada?: true
  }[]
}

/** Qué dato del rubro pregunta una clienta, por sus palabras. */
const ASKS: [RegExp, string][] = [
  [/\b(calza|horma|me queda|me sirve)\b/, "Cómo calza"],
  [/\bancho\b/, "Si tienes el pie ancho"],
  [/\b(material|de que es|cuero|sintetic)/, "Material"],
  [/\b(plantilla|mide|cm|centimetros)\b/, "Largo de la plantilla"],
  [/\b(lava|lavar|lavarla|limpia|limpiar|destine|destin|mancha)/, "Cómo se limpia"],
  [/\b(tela|algodon)\b/, "Tela"],
]

function dev(messages: ChatMessage[]): Partial<ModelReply> {
  const facts = messages.find((m, i) => i > 0 && m.role === "system")?.content ?? ""
  // Lo que pide respuesta: el último mensaje de la clienta o el aviso de la tienda.
  const at = messages.findLastIndex(
    (m) => m.role === "user" || (m.role === "system" && m.content.startsWith("AVISO DE LA TIENDA")),
  )
  const trigger = messages[at]
  const text = trigger && "content" in trigger && trigger.content ? trigger.content : ""
  const t = plain(text)
  const after = messages.slice(at + 1)
  const results = new Map<string, Record<string, unknown>>()
  for (const [i, m] of after.entries())
    if (m.role === "assistant" && m.tool_calls)
      for (const c of m.tool_calls) {
        const answer = after.slice(i + 1).find((r) => r.role === "tool" && r.tool_call_id === c.id)
        if (answer?.role === "tool")
          results.set(c.function.name, JSON.parse(answer.content) as Record<string, unknown>)
      }
  const before = messages
    .slice(0, at)
    .filter((m) => m.role === "assistant" && typeof m.content === "string")
    .map((m) => plain(String(m.content)))
  const greeting = before.length === 0 ? "¡Hola! Soy Sofi. " : ""

  const notice = trigger?.role === "system"
  if (notice && /respondio lo que pregunto/.test(t)) {
    const quoted = [...text.matchAll(/«([^»]+)»/g)].map((m) => m[1])
    return say(`Te cuento lo que me preguntaste: ${quoted[1] ?? quoted[0] ?? ""}`.trim())
  }

  const from = /LLEGÓ DESDE EL LINK DE: «([^»]+)»/.exec(facts)?.[1]
  // Dice que sí a lo que Sofi le ofreció sumar después del pago: es ese otro producto.
  const lastSaid = messages
    .slice(0, at)
    .filter((m) => m.role === "assistant" && typeof m.content === "string")
    .at(-1)
  const upsell = /¿Te sumo también ([^?]+)\?/.exec(String(lastSaid?.content ?? ""))?.[1]
  const takesUpsell = Boolean(upsell) && /\b(si|dale|sumalo|sumala|quiero)\b/.test(t)
  const search = results.get("buscar_productos")
  if (!search) {
    const words = takesUpsell
      ? upsell!
      : notice
        ? text.split(":").slice(2).join(" ") || text
        : `${from ?? ""} ${text}`
    return call("buscar_productos", { texto: words.slice(0, 190) || "producto" })
  }
  const found = (search.productos as Found[] | undefined) ?? []
  const p = takesUpsell ? found[0] : (from && found.find((f) => f.nombre === from)) || found[0]
  if (!p) return say(`${greeting}No encontré eso en el catálogo. ¿Me cuentas qué buscas?`)
  // La forma de entrega: la primera con un costo que se sabe (no la que se acuerda ni la gratis),
  // con su primera zona si es por zona.
  const deliveries = [...facts.matchAll(/^- ([0-9a-f-]{36}) · .*$/gm)]
  const chosen =
    deliveries.find(
      (d) => !d[0].includes("se acuerda en el chat") && !d[0].includes(" · gratis"),
    ) ?? deliveries[0]
  const delivery = chosen?.[1]
  const zone = chosen ? /por zona: ([^;·]+?) S\//.exec(chosen[0])?.[1]?.trim() : undefined
  const where = { entrega_id: delivery, ...(zone ? { zona: zone } : {}) }

  if (notice) {
    const order = /pedido (\d+)/.exec(text)?.[1] ?? ""
    const other = p.combina?.[0]
    if (other && !results.has("mandar_foto"))
      return call("mandar_foto", { producto_id: other.producto_id })
    return say(
      `¡Pago recibido! Tu pedido ${order} queda pagado y te aviso por aquí cuando salga.${other ? ` ¿Te sumo también ${other.nombre}? Iría como un pedido aparte, a ${other.precio}.` : ""}`,
    )
  }

  // El color y la talla de lo que escribe ahora o, si no los dice, de lo último que dijo.
  const said = [
    t,
    ...messages
      .slice(0, at)
      .filter((m) => m.role === "user")
      .map((m) => plain(String(m.content)))
      .reverse(),
  ]
  const pick = <T>(find: (text: string) => T | undefined) =>
    said.map(find).find((found) => found !== undefined)
  const color = takesUpsell
    ? undefined
    : pick((x) => p.colores?.find((c) => x.includes(plain(c.color)))?.color)
  const size = takesUpsell ? undefined : pick((x) => /\b(\d{2})\b/.exec(x)?.[1])
  const fits = p.variantes.filter(
    (v) =>
      (!color || plain(v.opciones).includes(plain(color))) &&
      (!size || v.opciones.split(" · ").includes(size)),
  )
  const variant = fits.find((v) => !v.agotada) ?? fits[0]
  const left = (v: Found["variantes"][number]) =>
    v.stock > 0 && v.stock <= 5 ? ` y me quedan ${v.stock}` : ""

  // Pide verla puesta: el video.
  if (/video|puesta|puesto|como se ve/.test(t)) {
    if (!results.has("mandar_foto"))
      return call("mandar_foto", { producto_id: p.producto_id, color, video: true })
    const sent = results.get("mandar_foto")!
    return say(
      sent.ok
        ? `${greeting}${variant && color ? `En ${color}${size ? ` ${size}` : ""} está a ${variant.precio}${left(variant)}. ` : ""}Te mando el video.`
        : `${greeting}De ${p.nombre} no tengo video. ¿Te mando la foto?`,
    )
  }

  // Lo quiere, o confirma lo acordado: cotizar y anotar el pedido.
  const offeredFree = before.some((b) => b.includes("envio gratis"))
  if (
    takesUpsell ||
    /\b(quiero|compro|llevo|confirmo|dale|envio gratis|si,? |si$|lo acepto)/.test(t)
  ) {
    if (!variant || (!takesUpsell && !size && p.variantes.length > 1 && !color))
      return say(
        `${greeting}¿En qué talla la quieres? Tengo ${p.variantes
          .filter((v) => !v.agotada)
          .map((v) => v.opciones)
          .slice(0, 6)
          .join(", ")}.`,
      )
    if (!delivery) return say("Te paso con una persona del equipo para coordinar la entrega.")
    const lines = [{ variante_id: variant.variante_id, cantidad: 1 }]
    const free = offeredFree && /envio gratis|si|dale|confirmo|quiero/.test(t)
    if (!results.has("cotizar"))
      return call("cotizar", { lineas: lines, ...where, ...(free ? { envio_cobrado: 0 } : {}) })
    const quote = results.get("cotizar")!
    if (!quote.ok) return say(`${greeting}Está a ${variant.precio}. ¿Te lo anoto así?`)
    if (!results.has("armar_pedido"))
      return call("armar_pedido", {
        lineas: lines,
        ...where,
        ...(free ? { envio_cobrado: 0 } : {}),
        nombre: "Clienta",
      })
    const made = results.get("armar_pedido")!
    if (made.ok)
      return say(
        `¡Listo! Tu pedido ${String(made.pedido).padStart(4, "0")} quedó anotado: ${made.total}${free ? ", con el envío gratis" : ""}. Aquí lo pagas: toca «Ver y pagar».`,
      )
    return say(`${greeting}Te queda en ${quote.total}, con envío ${quote.envio}. ¿Lo confirmo?`)
  }

  // Pide rebaja o lo va a pensar: primero el valor; la oferta, una vez y con plazo.
  if (/precio|rebaja|descuento|menos|barat|pensar|caro|dejas/.test(t)) {
    const target = variant ?? p.variantes.find((v) => !v.agotada)
    if (!target || !delivery) return say(`${greeting}Está a ${p.precio}.`)
    const canFree = !offeredFree && (p.puede_ofrecer ?? []).some((o) => o.startsWith("envío"))
    if (canFree && !results.has("cotizar"))
      return call("cotizar", {
        lineas: [{ variante_id: target.variante_id, cantidad: 1 }],
        ...where,
        envio_cobrado: 0,
      })
    const quote = results.get("cotizar")
    const value = p.datos?.[0] ? ` ${p.datos[0].dato}: ${p.datos[0].valor.toLowerCase()}.` : ""
    if (quote?.ok && typeof quote.plazo === "string") {
      const until = /hasta (.+?)\.\s*Dilo/.exec(quote.plazo)?.[1] ?? ""
      return say(
        `${greeting}Te entiendo. Está a ${target.precio}.${value} Mira: si lo pagas hasta ${until}, te consigo el envío gratis: quedas en ${quote.total} con todo.`,
      )
    }
    return say(`${greeting}Está a ${target.precio}: es su mejor precio.${value}`)
  }

  // Una pregunta del producto: lo que dice la ficha, o se la deja a la tienda.
  const asked = ASKS.find(([re]) => re.test(t))?.[1]
  const datum = asked ? p.datos?.find((d) => d.dato === asked) : undefined
  if (datum) return say(`${greeting}${datum.dato}: ${datum.valor.toLowerCase()}.`)
  const words = t.split(/[^a-z0-9]+/).filter((w) => w.length > 3)
  const known = p.preguntas_respondidas?.find(
    (q) => words.filter((w) => plain(q.pregunta).includes(w)).length >= 2,
  )
  if (known) return say(`${greeting}${known.respuesta}`)
  if (asked || (text.includes("?") && !color && !size && !/tienes|hay|queda/.test(t))) {
    if (!results.has("anotar_pregunta"))
      return call("anotar_pregunta", { producto_id: p.producto_id, pregunta: text.slice(0, 280) })
    return say(
      `${greeting}No lo tengo confirmado. Le pregunto a la tienda y te escribo. Mientras, ¿en qué talla la buscas?`,
    )
  }

  // Un color o una talla: su precio, lo que queda y su foto.
  if (color && !results.has("mandar_foto"))
    return call("mandar_foto", { producto_id: p.producto_id, color })
  const status = p.estado ? /«([^»]+)»/.exec(p.estado)?.[1] : undefined
  if (status) return say(`${greeting}${status}`)
  if (variant && (color || size))
    return variant.agotada
      ? say(`${greeting}De esa no me queda. ¿Te aviso cuando vuelva?`)
      : say(
          `${greeting}Sí: ${p.nombre}${color ? ` ${color}` : ""}${size ? ` ${size}` : ""} está a ${variant.precio}${left(variant)}. ¿Te la envío o la recoges?`,
        )
  return say(`${greeting}Tenemos ${p.nombre}: ${p.precio}. ¿Qué color y talla buscas?`)
}

export function devModel(): ChatModel {
  return {
    name: "fake",
    async complete(request) {
      const reply = dev(request.messages)
      return { content: reply.content ?? null, toolCalls: reply.toolCalls ?? [], usage: NONE }
    },
  }
}

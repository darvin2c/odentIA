import { can, ROLE_NAMES, type StorePermission, type StoreSeat } from "./permisos.js"

/**
 * La guía de la Ayuda de gestorIA (entrega 7 del lienzo «gestorIA como odentIA», tablero 19): una
 * pregunta por tarea, con su respuesta y quién puede hacerla. Es la misma idea de la guía de las
 * clínicas (`packages/services/src/help-guide.ts`), sin sus pantallas: las de una tienda son otras.
 * Más adelante, el asistente que contesta solo responde desde aquí (decisión 6).
 *
 * - Dice solo lo que gestorIA hace hoy. Lo que todavía no existe no se promete: se suma cuando
 *   llega su pantalla, en el mismo cambio.
 * - Quién puede hacerlo sale de `permisos.ts` (`needs`), nunca del texto: las respuestas no nombran
 *   roles (lo prueba `ayuda.test.ts`).
 * - Cada pregunta lleva a su pantalla, si el rol de quien lee puede abrirla.
 */

/** Las pantallas de la tienda a las que lleva una respuesta: su ruta y lo que hace falta para abrirla. */
export const HELP_SCREENS = {
  pedidos: { label: "Pedidos", path: "/pedidos", opens: "ventas.atender" },
  catalogo: { label: "Catálogo", path: "/catalogo", opens: "catalogo.ver" },
  reportes: { label: "Reportes", path: "/reportes", opens: "reportes.ver" },
  // Configuración, al pie del menú: cada apartado lo abre quien puede cambiarlo.
  datos: { label: "Datos de la tienda", path: "/configuracion", opens: "configuracion" },
  marca: { label: "Tu marca", path: "/configuracion/marca", opens: "configuracion" },
  equipo: { label: "Equipo", path: "/configuracion/equipo", opens: "equipo.gestionar" },
  sofi: { label: "Sofi", path: "/configuracion/sofi", opens: "configuracion" },
  pagos: { label: "Medios de pago", path: "/configuracion/medios-de-pago", opens: "configuracion" },
  entregas: {
    label: "Formas de entrega y zonas",
    path: "/configuracion/entregas",
    opens: "configuracion",
  },
  plan: { label: "Plan y pagos", path: "/configuracion/plan", opens: "plan" },
} as const satisfies Record<string, { label: string; path: `/${string}`; opens: StorePermission }>
export type HelpScreen = keyof typeof HELP_SCREENS

export interface HelpFaq {
  /** Su nombre fijo: no cambia aunque se reescriba la pregunta (`?pregunta=` de la Ayuda). */
  id: string
  q: string
  /** La respuesta, en párrafos cortos. */
  a: readonly string[]
  /** El permiso para hacer lo que explica: de ahí sale quién puede. */
  needs: StorePermission
  screen: HelpScreen
}

export interface HelpGroup {
  id: string
  title: string
  faqs: readonly HelpFaq[]
}

export const HELP_GUIDE: readonly HelpGroup[] = [
  {
    id: "vender",
    title: "Vender",
    faqs: [
      {
        id: "sofi-que-hace",
        q: "¿Quién es Sofi y qué hace sola?",
        a: [
          "Sofi es la vendedora de tu tienda. Responde con tu catálogo y tus precios, recomienda, negocia sin bajar del precio mínimo que pusiste y arma el pedido con lo que el cliente ya vio. Le dice cómo pagar y, si paga por link, el pedido queda pagado solo.",
          "Lo que no está en tu catálogo ni en lo que debe saber, no lo inventa: pasa la conversación a una persona. Por ahora la pruebas en Configuración, en Sofi, con «Probar a Sofi», escribiendo como si fueras un cliente. Esos pedidos son de prueba: no mueven el stock ni cuentan en Reportes.",
          "Probarla sirve al ajustarla: por eso la prueba quien cambia la configuración de la tienda.",
        ],
        needs: "configuracion",
        screen: "sofi",
      },
      {
        id: "sofi-confirma-pagos",
        q: "¿Sofi confirma pagos?",
        a: [
          "No. Si el cliente paga con el link de pago, el pedido pasa a pagado solo. Si manda una captura, Sofi le agradece y le dice que una persona revisa el pago.",
          "El pedido queda en «Pago por confirmar» y lo confirma alguien del equipo que pueda confirmar pagos, después de mirar la cuenta de la tienda.",
        ],
        needs: "pagos.confirmar",
        screen: "pedidos",
      },
      {
        id: "sofi-lo-que-sabe",
        q: "¿Cómo le enseño a Sofi lo que debe saber?",
        a: [
          "En Configuración, en Sofi, «Cómo vende»: cómo se presenta, lo que debe saber (tu horario, los cambios de talla, cómo se cuida el producto) y si está encendida. Ahí también eliges los seguimientos que Argos le encarga, como recordar el pago a quien no pagó.",
          "Lo cuenta tal cual. Tus productos, precios, medios de pago y formas de entrega los toma del catálogo y de Configuración: no hace falta repetirlos.",
        ],
        needs: "configuracion",
        screen: "sofi",
      },
      {
        id: "anotar-pedido",
        q: "¿Cómo anoto una venta que me llegó por otro lado?",
        a: [
          "En Pedidos, «Anotar un pedido»: el cliente, los productos, cómo se entrega y cómo paga. Se arma con los mismos precios y límites que usa Sofi, y ves el total antes de guardarlo.",
        ],
        needs: "ventas.atender",
        screen: "pedidos",
      },
    ],
  },
  {
    id: "cobrar",
    title: "Cobrar",
    faqs: [
      {
        id: "pago-por-confirmar",
        q: "¿Por qué un pedido dice «Pago por confirmar»?",
        a: [
          "Porque llegó la captura de un pago y falta que alguien la revise. Ábrelo desde el filtro «Pago por confirmar», mira la captura y revisa la cuenta de la tienda.",
          "Si el pago está, «Confirmar pago». Si no, «No coincide» con su motivo: el pedido vuelve a «Por pagar» y el motivo queda escrito en el pedido.",
        ],
        needs: "pagos.confirmar",
        screen: "pedidos",
      },
      {
        id: "anotar-captura",
        q: "El cliente me mandó la captura, ¿dónde la anoto?",
        a: [
          "En el pedido, «Anotar captura del pago»: el monto que se ve, el número de operación y la imagen, si la tienes. Queda por confirmar hasta que alguien revise la cuenta de la tienda.",
        ],
        needs: "ventas.atender",
        screen: "pedidos",
      },
      {
        id: "link-de-pago",
        q: "¿Cómo le mando un link de pago?",
        a: [
          "En el pedido por pagar, «Crear link de pago» y después «Copiar el link», para pegarlo en la conversación. Cuando paga, el pedido pasa a pagado solo.",
          "Si no aparece el botón, falta conectar Mercado Pago en Configuración, en Medios de pago, o venció el precio acordado.",
        ],
        needs: "ventas.atender",
        screen: "pedidos",
      },
      {
        id: "cobrar-al-recibir",
        q: "¿Cómo anoto lo que cobré al entregar?",
        a: [
          "Si el pedido se paga al recibir, al llegar usa «Entregado y cobrado» y escribe cuánto cobraste. Queda con tu nombre y, si no es el total, queda anotado para revisarlo.",
        ],
        needs: "entregas",
        screen: "pedidos",
      },
      {
        id: "deshacer-pago",
        q: "Confirmé un pago por error, ¿cómo lo deshago?",
        a: [
          "En el pedido, en ese pago, «Deshacer» con su motivo. El pago vuelve a «Por confirmar» y el motivo queda escrito en el pedido. Si era lo único que había pagado y el pedido todavía no sale, el pedido vuelve a esperar su pago y lo que salió del stock vuelve.",
          "Se deshace la confirmación de una captura. Lo que llegó por el link o se cobró en la puerta no se deshace, ni el pago de un pedido entregado.",
        ],
        needs: "pagos.confirmar",
        screen: "pedidos",
      },
    ],
  },
  {
    id: "corregir",
    title: "Corregir",
    faqs: [
      {
        id: "corregir-pedido",
        q: "¿Cómo corrijo un pedido que ya anoté?",
        a: [
          "En el pedido, «Cambiar»: la talla, el color, la cantidad, otro producto, la entrega, la dirección o el día, y «Guardar cambios». Es el mismo pedido, con su número y sus pagos: antes de guardar ves el total nuevo y lo que falta cobrar, y lo que cambió queda en su historia. Lo que ya salió del stock se mueve solo.",
          "Se cambia mientras no sale. Si la talla nueva no tiene stock, se guarda igual y no sale hasta que entre. Si sobra de lo que pagó, queda anotado para ver si se devuelve.",
          "Si ya no va, «Anular pedido» con su motivo. Un pedido pagado lo anula solo quien puede confirmar pagos, y la devolución del dinero se hace fuera de gestorIA. Un pedido entregado ya no se anula: si la clienta quiere otra talla o devolverlo, usa «Cambio o devolución».",
        ],
        needs: "ventas.atender",
        screen: "pedidos",
      },
      {
        id: "cambio-devolucion",
        q: "¿Cómo hago un cambio o una devolución de un pedido entregado?",
        a: [
          "En el pedido entregado, «Cambio o devolución»: marca lo que vuelve y por qué, elige lo que se lleva (otra talla u otro producto) o «Nada: es una devolución», y la entrega del cambio, con quién paga el envío. «Crear el cambio» arma un pedido nuevo, enlazado al entregado; el entregado no cambia su total ni su pago.",
          "Lo que vuelve entra a tu stock con su motivo al marcar «Entregado» el cambio, cuando llega a la tienda. Si lo nuevo cuesta más, falta cobrar la diferencia, como en cualquier pedido; si cuesta menos, el cambio dice cuánto falta devolver.",
          "Puedes abrir el WhatsApp de tu celular con el aviso del cambio ya escrito, para enviarlo tú.",
        ],
        needs: "ventas.atender",
        screen: "pedidos",
      },
      {
        id: "anotar-devolucion",
        q: "Le devolví dinero a una clienta, ¿cómo lo anoto?",
        a: [
          "Si un cambio cuesta menos, es una devolución o pagó de más, el pedido dice cuánto falta devolver. Devuélvelo desde tu app y, en el pedido, «Anotar la devolución» con cuánto y con qué medio: queda con tu nombre. gestorIA no mueve el dinero.",
          "Lo devuelto deja de contar como vendido en Reportes, y un pedido con dinero devuelto ya no se anula.",
        ],
        needs: "pagos.confirmar",
        screen: "pedidos",
      },
      {
        id: "precio-vencido",
        q: "Dice que el precio acordado venció, ¿qué hago?",
        a: [
          "Un precio negociado vale 24 horas. Si el cliente sigue de acuerdo, en el pedido, «Cambiar» con el precio que acuerden y «Guardar cambios»: vale otras 24 horas.",
        ],
        needs: "ventas.atender",
        screen: "pedidos",
      },
    ],
  },
  {
    id: "entregar",
    title: "Entregar",
    faqs: [
      {
        id: "salio-entregado",
        q: "¿Cómo marco que un pedido salió o llegó?",
        a: [
          "En Pedidos, en «Para entregar hoy» o «Para entregar». En el pedido, «Salió» lo pasa a «En camino» (si va por agencia, pega su número de envío) y «Entregado» lo cierra cuando llega. Si lo recogen en la tienda, va directo a «Entregado».",
          "Si nadie marcó «Salió», «Entregado» deja las dos, con la misma hora.",
        ],
        needs: "entregas",
        screen: "pedidos",
      },
      {
        id: "no-se-entrego",
        q: "¿Qué hago si un pedido volvió sin entregar?",
        a: [
          "En el pedido en camino, «No se entregó»: elige qué pasó (no contestó, dirección errada, no lo quiso u otro motivo) y cuándo va. Vuelve a «Por salir» ese día, sin anular nada, y el stock no se mueve.",
        ],
        needs: "entregas",
        screen: "pedidos",
      },
      {
        id: "pasar-a",
        q: "¿Cómo paso un pedido a otro día?",
        a: [
          "En el pedido, «Pasar a…» y elige el día: hoy, mañana u otro. Se puede mientras no sale, y no se anula nada.",
        ],
        needs: "entregas",
        screen: "pedidos",
      },
      {
        id: "pagado-sin-stock",
        q: "Está pagado, pero dice que no alcanzaba el stock",
        a: [
          "El pago se confirma igual, pero el pedido no sale hasta que entre lo que falta. Anota la entrada en el Catálogo: en el producto, «Kardex» de esa variante y «Entrada», con lo que llegó.",
        ],
        needs: "configuracion",
        screen: "catalogo",
      },
    ],
  },
  {
    id: "catalogo",
    title: "Catálogo",
    faqs: [
      {
        id: "agregar-producto",
        q: "¿Cómo subo un producto con tallas y stock?",
        a: [
          "En Catálogo, «Agregar producto»: el nombre, el precio de lista y hasta tres opciones, como talla y color. Cada combinación es una variante con su código y su stock.",
          "Después, en el producto, le sumas hasta 8 fotos y la primera entrada de stock de cada variante, en su «Kardex».",
        ],
        needs: "configuracion",
        screen: "catalogo",
      },
      {
        id: "subir-hoja",
        q: "¿Puedo subir todo mi catálogo de una vez?",
        a: [
          "Sí, con «Subir una hoja»: una fila por variante, con el producto, sus opciones, el precio y el stock. Empieza con «Descargar la hoja de ejemplo» y guárdala como CSV. Antes de crear nada, ves lo que se leyó bien.",
        ],
        needs: "configuracion",
        screen: "catalogo",
      },
      {
        id: "cambiar-stock",
        q: "¿Cómo cambio el stock?",
        a: [
          "El stock solo cambia con un movimiento. En el producto, «Kardex» de la variante: «Entrada» cuando llega mercadería (con su costo, si quieres) o «Ajuste» cuando contaste y no cuadra, con su motivo escrito.",
          "Las ventas lo bajan solas cuando se confirma el pago, o cuando el pedido sale si se paga al recibir, y vuelve si se anula.",
        ],
        needs: "configuracion",
        screen: "catalogo",
      },
      {
        id: "precio-minimo",
        q: "¿Cómo dejo que Sofi negocie el precio?",
        a: [
          "En el producto, «Precio y negociación»: pon el precio mínimo de venta. Sofi nunca baja de ahí y lo que cede queda escrito en el pedido. Sin mínimo, ese producto no se negocia.",
          "Sofi primero cuenta lo bueno del producto y ofrece algo solo cuando ve que puede perder la venta: una sola vez, sin mejorarlo si el cliente insiste, y siempre a cambio de pagar dentro de 24 horas, con la hora exacta. Con pago al recibir no hay rebaja.",
          "Ahí también van los precios por cantidad y las promociones con sus fechas.",
        ],
        needs: "configuracion",
        screen: "catalogo",
      },
    ],
  },
  {
    id: "tienda",
    title: "La tienda",
    faqs: [
      {
        id: "configuracion",
        q: "¿Dónde se ajusta la tienda y por qué hay quien no ve Configuración?",
        a: [
          "En Configuración, al pie del menú: los datos de la tienda y su hora, Tu marca, el equipo, Sofi con «Probar a Sofi», los medios de pago, las formas de entrega y el plan. Se ajusta una vez y lo usan las demás pantallas.",
          "Cada apartado lo ve quien puede cambiarlo. Quien atiende sin cambiar la configuración no ve Configuración, ni el equipo ni «Probar a Sofi», y sigue vendiendo con lo que ahí se puso.",
        ],
        needs: "configuracion",
        screen: "datos",
      },
      {
        id: "hora-de-la-tienda",
        q: "¿Cómo cambio el nombre o la hora de la tienda?",
        a: [
          "En Configuración, en Datos de la tienda: el nombre, el país y la «Hora de la tienda», con la que se cuentan «hoy», «mañana», los reportes y las promociones para todo el equipo. La moneda queda fija desde que se creó la tienda.",
        ],
        needs: "configuracion",
        screen: "datos",
      },
      {
        id: "tu-marca",
        q: "¿Cómo pongo mi logo y el color de mi marca?",
        a: [
          "En Configuración, en Tu marca: el logo, el nombre que ve el cliente, la foto de portada, el nombre del link de tu tienda y el color. Te sugerimos colores de tu logo y de una foto de tu letrero; cualquier color vale, y los tonos para que se lea bien se calculan solos.",
          "El color se ve en gestorIA para todo tu equipo. El nombre del link va sin tildes ni espacios, y algunos nombres están reservados.",
        ],
        needs: "configuracion",
        screen: "marca",
      },
      {
        id: "medios-de-pago",
        q: "¿Cómo agrego Yape, Plin o una cuenta para transferencias?",
        a: [
          "En Configuración, en Medios de pago, «Agregar medio»: el nombre como lo dirá Sofi y los datos que envía tal cual (el número, la cuenta, a nombre de quién). Si lo apagas, Sofi deja de ofrecerlo.",
        ],
        needs: "configuracion",
        screen: "pagos",
      },
      {
        id: "formas-de-entrega",
        q: "¿Cómo pongo el costo del envío por zona?",
        a: [
          "En Configuración, en Formas de entrega y zonas, «Agregar forma»: tu reparto, el recojo en tienda o la agencia, con su precio por zona y cuándo llega. También dices hasta cuánto puede rebajarlo Sofi y desde qué compra es gratis.",
        ],
        needs: "configuracion",
        screen: "entregas",
      },
      {
        id: "mercado-pago",
        q: "¿Cómo conecto Mercado Pago?",
        a: [
          "En Configuración, en Medios de pago, «Conectar Mercado Pago», con la cuenta de la tienda: el dinero de cada link llega directo a ella. Desde entonces, cada pedido por pagar puede llevar su link de pago.",
        ],
        needs: "configuracion",
        screen: "pagos",
      },
      {
        id: "invitar",
        q: "¿Cómo invito a alguien a mi equipo?",
        a: [
          "En Configuración, en Equipo, «Invitar»: su correo y su rol; al elegirlo, cada rol dice lo que puede hacer. Comparte el enlace: entra con la cuenta de ese correo, y la invitación vence en 7 días.",
        ],
        needs: "equipo.gestionar",
        screen: "equipo",
      },
      {
        id: "soporte-mira",
        q: "¿Qué ve soporte cuando lo dejo entrar y cómo sé si entró?",
        a: [
          "Soporte de gestorIA entra solo si lo dejan entrar, y por los minutos que pidió, que empiezan cuando lo dejan entrar. Ve tu tienda, tu catálogo sin costos y tu equipo (nombres, correos y roles). No ve tus pedidos ni tus conversaciones, y no cambia nada. Solo el equipo de gestorIA puede pedirlo.",
          "En Configuración, en Equipo, ves quién miró, desde qué hora, quién lo dejó entrar y cómo terminó. Mientras mira, «Sacar ahora» lo saca al momento.",
        ],
        needs: "equipo.gestionar",
        screen: "equipo",
      },
      {
        id: "reportes",
        q: "¿Dónde veo cuánto vendí?",
        a: [
          "En Reportes: lo vendido y cobrado, lo que falta cobrar, quiénes volvieron a comprar, lo más vendido y lo que se acaba, y lo que hizo Sofi. En «Te toca», Argos dice lo que queda pendiente.",
        ],
        needs: "reportes.ver",
        screen: "reportes",
      },
      {
        id: "plan",
        q: "¿Dónde veo mi plan y lo que se me cobró?",
        a: [
          "En Configuración, en «Plan y pagos» (también se abre desde el nombre de la tienda, arriba en el menú): tu plan, lo que se te cobró, tus pagos y sus avisos. Ahí también subes el comprobante de un pago.",
        ],
        needs: "plan",
        screen: "plan",
      },
    ],
  },
]

/** Los roles del equipo, en el orden en que se nombran. Soporte no es del equipo: no se nombra. */
const TEAM_ROLES = ["owner", "admin", "sales"] as const

/** «Dueño, Administrador y Ventas»: los roles del equipo que tienen ese permiso. */
export function whoCan(permission: StorePermission): string {
  const names = TEAM_ROLES.filter((role) => can(role, permission)).map((role) => ROLE_NAMES[role])
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`
}

/** Una respuesta como la ve quien lee: quién puede, si puede quien lee y su pantalla, si la abre. */
export interface HelpFaqView {
  id: string
  q: string
  a: readonly string[]
  /** «Dueño, Administrador y Ventas». */
  who: string
  /** Cuántos roles pueden: para decir «Lo puede hacer» o «Lo pueden hacer». */
  whoCount: number
  /** Si el rol de quien lee puede hacerlo. */
  you: boolean
  /** Su pantalla, solo si quien lee puede abrirla. */
  screen: { label: string; path: string } | null
}

/** La guía para un rol: todas las preguntas (cada una dice quién puede), con lo suyo marcado. */
export function helpGuideFor(
  seat: StoreSeat,
): { id: string; title: string; faqs: HelpFaqView[] }[] {
  return HELP_GUIDE.map((group) => ({
    id: group.id,
    title: group.title,
    faqs: group.faqs.map((faq) => {
      const screen = HELP_SCREENS[faq.screen]
      return {
        id: faq.id,
        q: faq.q,
        a: faq.a,
        who: whoCan(faq.needs),
        whoCount: TEAM_ROLES.filter((role) => can(role, faq.needs)).length,
        you: can(seat, faq.needs),
        screen: can(seat, screen.opens) ? { label: screen.label, path: screen.path } : null,
      }
    }),
  }))
}

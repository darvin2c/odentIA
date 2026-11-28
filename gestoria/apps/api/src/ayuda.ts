import type { HelpAskAnswer, HelpGuideTopic } from "@odentia/contract"
import { can, ROLE_NAMES, type StorePermission, type StoreSeat } from "./permisos.js"

/**
 * La guía de la Ayuda de gestorIA (entrega 7 del lienzo «gestorIA como odentIA», tablero 19; ADR
 * 0227): una pregunta por tarea, con su respuesta y quién puede hacerla. Es la misma idea de la
 * guía de las clínicas (`packages/services/src/help-guide.ts`), sin sus pantallas: las de una
 * tienda son otras. Ariadna, la de todas las apps, responde solo desde aquí: viaja entera en cada
 * pregunta (`helpTopics`) y vuelve en ids de esta guía, que aquí se hacen texto (`helpReplyOf`).
 *
 * - Dice solo lo que gestorIA hace hoy. Lo que todavía no existe no se promete: se suma cuando
 *   llega su pantalla, en el mismo cambio.
 * - Quién puede hacerlo sale de `permisos.ts` (`needs`), nunca del texto: las respuestas no nombran
 *   roles (lo prueba `ayuda.test.ts`).
 * - Cada respuesta lleva a su pantalla, si el rol de quien lee puede abrirla.
 */

/**
 * Las pantallas de la tienda a las que lleva una respuesta: su ruta, lo que hace falta para
 * abrirla y, para Ariadna, para qué sirve y con qué palabras la busca la gente.
 */
export const HELP_SCREENS = {
  inicio: {
    label: "Inicio",
    path: "/",
    opens: "ventas.atender",
    purpose:
      "Lo que toca hacer hoy en la tienda, con las cifras del día, y los primeros pasos de una tienda que empieza.",
    terms: [
      "inicio",
      "hoy",
      "pendientes",
      "qué hago",
      "primeros pasos",
      "empezar",
      "cifras del día",
    ],
  },
  despachos: {
    label: "Despachos",
    path: "/despachos",
    opens: "entregas",
    purpose:
      "Lo que sale cada día y quién lo lleva: marcar que salió o se entregó, el repartidor, la agencia, avisar a la clienta y lo que no se entregó.",
    terms: [
      "despachos",
      "entregas",
      "reparto",
      "repartidor",
      "delivery",
      "agencia",
      "número de envío",
      "salió",
      "no se entregó",
      "otro día",
    ],
  },
  pedidos: {
    label: "Pedidos",
    path: "/pedidos",
    opens: "ventas.atender",
    purpose:
      "Los pedidos de la tienda: anotarlos, cobrarlos, confirmar sus pagos, corregirlos, anularlos y hacer cambios o devoluciones.",
    terms: [
      "pedidos",
      "pedido",
      "venta",
      "cobrar",
      "pago",
      "captura",
      "link de pago",
      "anular",
      "cambio",
      "devolución",
    ],
  },
  clientes: {
    label: "Clientes",
    path: "/clientes",
    opens: "ventas.atender",
    purpose:
      "Cada clienta con sus compras y lo que Argos sabe de ella (talla, distrito, cumpleaños, canal), con su fuente, para corregirlo, y si acepta promociones.",
    terms: [
      "clientes",
      "clientas",
      "ficha",
      "talla",
      "distrito",
      "cumpleaños",
      "corregir",
      "promociones",
      "baja",
      "Argos",
    ],
  },
  catalogo: {
    label: "Catálogo",
    path: "/catalogo",
    opens: "catalogo.ver",
    purpose:
      "Los productos de la tienda y la ficha de cada uno, que se guarda sola: fotos, colores y tallas con su stock en una cuadrícula, precio, mínimo, margen, promociones, estado, datos del rubro y lo que Sofi no supo.",
    terms: [
      "catálogo",
      "productos",
      "ficha",
      "stock",
      "inventario",
      "kardex",
      "tallas",
      "colores",
      "fotos",
      "precio",
      "margen",
      "promoción",
      "por encargo",
      "preventa",
      "código de barras",
    ],
  },
  // La ficha de un producto: su propia pantalla en la Ayuda, con sus preguntas. Su ruta lleva el
  // producto (`$productId`); el enlace de la Ayuda va al Catálogo, donde se elige.
  producto: {
    label: "Ficha del producto",
    path: "/catalogo/$productId",
    opens: "catalogo.ver",
    purpose:
      "La ficha de un producto, que se guarda sola: fotos, colores y tallas con su stock en una cuadrícula (también pegando desde Excel), precio, mínimo, margen, lo que Sofi puede ofrecer, promociones, estado, datos del rubro, lo que Sofi no supo y quién cambió qué.",
    terms: [
      "ficha",
      "producto",
      "cuadrícula",
      "pegar",
      "excel",
      "deshacer",
      "stock",
      "tallas",
      "colores",
      "precio",
      "mínimo",
      "margen",
      "cuánto gano",
      "simulador",
      "cuánto cobraría",
      "estado",
      "rubro",
      "otra pestaña",
    ],
  },
  caja: {
    label: "Caja",
    path: "/caja",
    opens: "caja",
    purpose:
      "El efectivo por recibir de cada repartidor y de la tienda, lo cobrado del día por medio de pago y lo que falta cobrar en las entregas del día.",
    terms: ["caja", "efectivo", "recibir", "cuadrar", "repartidor", "cobrado hoy", "arqueo"],
  },
  reportes: {
    label: "Reportes",
    path: "/reportes",
    opens: "reportes.ver",
    purpose:
      "Lo vendido y cobrado, lo que falta cobrar, lo más vendido, lo que se acaba y lo que hicieron Sofi y Argos.",
    terms: ["reportes", "cuánto vendí", "ventas del mes", "cifras", "estadísticas", "Argos"],
  },
  // Configuración, al pie del menú: abre en «Lo que falta» y cada apartado lo abre quien puede
  // cambiarlo.
  configuracion: {
    label: "Lo que falta",
    path: "/configuracion",
    opens: "configuracion",
    purpose:
      "La entrada de Configuración: lo que falta para vender, cada cosa con su botón, cómo está cada parte y el buscador de Configuración.",
    terms: ["configuración", "lo que falta", "qué me falta", "ajustes", "buscar en configuración"],
  },
  datos: {
    label: "Datos de la tienda",
    path: "/configuracion/datos",
    opens: "configuracion",
    purpose: "El nombre de la tienda, su país y su hora.",
    terms: ["datos de la tienda", "nombre", "hora", "zona horaria", "país", "moneda"],
  },
  marca: {
    label: "Tu marca",
    path: "/configuracion/marca",
    opens: "configuracion",
    purpose: "El logo, el color, la foto de portada y el nombre del link de la tienda.",
    terms: ["marca", "logo", "color", "portada", "link de la tienda"],
  },
  equipo: {
    label: "Equipo y repartidores",
    path: "/configuracion/equipo",
    opens: "equipo.gestionar",
    purpose:
      "Quiénes trabajan en la tienda y con qué rol, sus invitaciones, los repartidores, y si soporte pide mirar la tienda o quién la miró.",
    terms: ["equipo", "invitar", "roles", "usuarios", "permisos", "soporte", "repartidores"],
  },
  sofi: {
    label: "Sofi",
    path: "/configuracion/sofi",
    opens: "configuracion",
    purpose:
      "Cómo vende Sofi, la vendedora de la tienda: lo que debe saber, sus seguimientos y la prueba escribiéndole como cliente.",
    terms: ["Sofi", "vendedora", "asistente", "bot", "probar", "seguimientos", "horario"],
  },
  pagos: {
    label: "Cobros",
    path: "/configuracion/medios-de-pago",
    opens: "configuracion",
    purpose:
      "Los medios de pago que ofrece Sofi (Yape, Plin, transferencias) y la conexión con Mercado Pago para los links de pago.",
    terms: [
      "cobros",
      "medios de pago",
      "Yape",
      "Plin",
      "transferencia",
      "cuenta bancaria",
      "Mercado Pago",
    ],
  },
  entregas: {
    label: "Entregas",
    path: "/configuracion/entregas",
    opens: "configuracion",
    purpose:
      "Las formas de entrega (reparto, recojo en tienda o agencia), su precio por zona, cuándo llega y desde qué compra es gratis.",
    terms: ["entregas", "envío", "delivery", "zonas", "agencia", "recojo", "costo de envío"],
  },
  avisos: {
    label: "Avisos al celular",
    path: "/configuracion/avisos",
    opens: "avisos.recibir",
    purpose:
      "Recibir en el celular los avisos de lo que tu rol puede resolver (pagos por confirmar, chats, entregas), aunque gestorIA esté cerrada, y elegir cuáles.",
    terms: ["avisos", "notificaciones", "celular", "push", "instalar", "alertas"],
  },
  plan: {
    label: "Plan y pagos",
    path: "/configuracion/plan",
    opens: "plan",
    purpose: "El plan de la tienda, lo que se le cobró, sus pagos y los comprobantes.",
    terms: ["plan", "cobro", "pagar el plan", "comprobante", "suscripción", "factura"],
  },
} as const satisfies Record<
  string,
  {
    label: string
    path: `/${string}`
    opens: StorePermission
    purpose: string
    terms: readonly string[]
  }
>
export type HelpScreen = keyof typeof HELP_SCREENS

export interface HelpFaq {
  /** Su nombre fijo, único en la guía: es el que vuelve de Ariadna (`faq:<id>`). */
  id: string
  q: string
  /** La respuesta, en párrafos cortos. */
  a: readonly string[]
  /** El permiso para hacer lo que explica: de ahí sale quién puede. */
  needs: StorePermission
  screen: HelpScreen
  /**
   * Se sugiere solo a quien NO tiene `needs`: la pregunta es por qué no puede (como Ventas en
   * Configuración). Su respuesta lleva a quién pedírselo (`restrictionFor`).
   */
  forWhoCannot?: true
}

export interface HelpGroup {
  id: string
  title: string
  faqs: readonly HelpFaq[]
}

export const HELP_GUIDE: readonly HelpGroup[] = [
  {
    id: "inicio",
    title: "Inicio",
    faqs: [
      {
        id: "te-toca",
        q: "¿Qué me toca hacer hoy?",
        a: [
          "En Inicio, «Te toca»: lo que hay que hacer ahora, hoy y sin apuro, cada línea con su botón. Un pago por confirmar se abre con «Ver y confirmar», que muestra la captura junto al pedido; un pedido que no se entregó se mueve con «Pasar a…»; dos fichas que quizá son la misma clienta se miran con «Comparar»; un pedido pagado al que le falta stock, con «Ver pedido», y el efectivo cobrado en la puerta que nadie recibió todavía, con «Ir a Caja» (lo ve quien ve Caja).",
          "Arriba van las cifras del día, con la hora de la tienda: «Cobrado hoy», «Por confirmar», «Falta cobrar» y «Sale hoy», que abre Despachos. Lo que está por confirmar no se suma a lo que falta cobrar. Los montos del día los ve quien puede ver Reportes; quien atiende ve lo que le toca, sin los totales.",
        ],
        needs: "ventas.atender",
        screen: "inicio",
      },
      {
        id: "primeros-pasos",
        q: "Acabo de crear mi tienda, ¿qué me falta para vender?",
        a: [
          "En Inicio, «Tu tienda está casi lista»: los pasos para empezar, cada uno con cómo va. Cada paso abre su apartado y, con «Volver a Inicio», regresas a la lista. Se marcan solos cuando lo guardas: nadie los marca a mano.",
          "Puedes vender sin terminarlos. Si trabajas sola o no vas a usar a Sofi, ese paso se salta con «No lo necesito». Conectar los chats dice «Muy pronto»: todavía no se puede y no cuenta. Cuando todos están hechos o saltados, la lista se va de Inicio y no vuelve.",
        ],
        needs: "configuracion",
        screen: "inicio",
      },
    ],
  },
  {
    id: "vender",
    title: "Vender",
    faqs: [
      {
        id: "sofi-que-hace",
        q: "¿Quién es Sofi y qué hace sola?",
        a: [
          "Sofi es la vendedora de tu tienda. Responde con tu catálogo y tus precios, recomienda, negocia sin bajar del precio mínimo que pusiste y arma el pedido con lo que el cliente ya vio. Le dice cómo pagar y, si paga por link, el pedido queda pagado solo.",
          "Lo que no está en tu catálogo ni en «Lo que sabe», no lo inventa: pasa la conversación a una persona y la pregunta aparece en «Lo que aprendió». Por ahora la pruebas en Configuración, en Sofi, con «Probar a Sofi», escribiendo como si fueras un cliente: debajo de cada respuesta, «Por qué» dice qué usó. En una pantalla ancha la prueba está al lado, también mientras cambias algo; en el celular queda abajo, y el botón «Probar a Sofi» de arriba te lleva a ella. Esos pedidos son de prueba: no mueven el stock ni cuentan en Reportes.",
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
          "En Configuración, en Sofi, «Lo que sabe»: con «Agregar» escribes una pregunta como la haría una clienta («¿Hacen cambios?») y su respuesta. Sofi la lee cuando le preguntan eso y la cuenta así.",
          "En «Lo que aprendió» ves lo que clientas preguntaron en tus chats y Sofi no supo: con «Responder» lo guardas en «Lo que sabe». En el celular, si hay preguntas por responder, una línea debajo de las pestañas dice cuántas y te lleva ahí. Nada se agrega solo. Tus productos, precios, medios de pago y formas de entrega los toma del catálogo y de Configuración: no hace falta repetirlos.",
        ],
        needs: "configuracion",
        screen: "sofi",
      },
      {
        id: "sofi-como-habla",
        q: "¿Cómo elijo cómo habla Sofi y qué puede ofrecer?",
        a: [
          "En Configuración, en Sofi, cada parte tiene su «Cambiar». En «Cómo habla» eliges su tono viendo un ejemplo de cada uno (cercana, amable y formal o directa), si trata de tú o de usted, los emojis y cómo se presenta. En «Qué ofrece» marcas lo que puede ofrecer para cerrar: envío gratis, un descuento, un regalo o una rebaja si lleva dos.",
          "En «Cuándo te pasa el chat» eliges si te lo pasa cuando la clienta está molesta o cuando el pedido pasa de un monto, y el horario de tu equipo: fuera de él, Sofi dice cuándo le responden y tú decides si sigue vendiendo. Con «Pausar» deja de atender y tus chats esperan a una persona; en pausa, ese botón dice «Encender» y la vuelve a poner a atender. Guardar un cambio no la enciende ni la pausa. Si otra persona cambió a Sofi mientras tenías un «Cambiar» abierto, al guardar te lo dice: ciérralo y vuelve a abrirlo para ver lo nuevo.",
          "Lo que no se elige: ofrece una sola vez, a cambio de pagar en 24 horas, nunca baja del mínimo de cada producto y con pago al recibir no hay oferta.",
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
          "Porque llegó la captura de un pago y falta que alguien la revise. Ábrelo desde Inicio con «Ver y confirmar», o desde el filtro «Pago por confirmar» de Pedidos, mira la captura y revisa la cuenta de la tienda.",
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
          "Si no aparece el botón, falta conectar Mercado Pago en Configuración, en Cobros, o venció el precio acordado.",
        ],
        needs: "ventas.atender",
        screen: "pedidos",
      },
      {
        id: "cobrar-al-recibir",
        q: "¿Cómo anoto lo que cobré al entregar?",
        a: [
          "En Despachos, «Cobrar y entregar» (en el pedido, «Entregado y cobrado»): con qué te pagaron (efectivo o el POS de la tienda, con la foto del voucher si la tienes) y cuánto. Si pagó una parte con cada medio, «Agregar otro medio».",
          "Sin pago confirmado no se entrega: lo cobrado tiene que ser todo lo que falta, sin el vuelto. Si pagó con Yape o Plin al número de la tienda, anota su captura en el pedido; si ya la mandó, al entregar ves la captura y «Ya me pagó: confirmar» en el mismo paso. Lo cobrado queda a nombre de quien llevó el pedido y, el efectivo, por recibir en Caja.",
        ],
        needs: "entregas",
        screen: "despachos",
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
        id: "despachos",
        q: "¿Dónde veo qué sale hoy y quién lo lleva?",
        a: [
          "En Despachos: arriba, los días con cuántas entregas hay en cada uno; abajo, primero lo que no se entregó, con su motivo y lo que hay que cobrar, y después cada franja y «Sin franja». Filtra por repartidor; la forma de entrega va en cada fila.",
          "Hoy trae también lo atrasado y lo que no tiene día. «Cobrar» es lo que falta cobrar del pedido: lo mismo que dicen el pedido y Caja.",
        ],
        needs: "entregas",
        screen: "despachos",
      },
      {
        id: "salio-entregado",
        q: "¿Cómo marco que un pedido salió o llegó?",
        a: [
          "En Despachos, en su fila, o en el pedido: «Salió» lo pasa a «En camino» y «Entregado» lo cierra cuando llega. Si lo recogen en la tienda, va directo a «Entregado». Lo demás está en «Más».",
          "Si nadie marcó «Salió», «Entregado» deja las dos, con la misma hora.",
        ],
        needs: "entregas",
        screen: "despachos",
      },
      {
        id: "repartidor",
        q: "¿Cómo digo quién lleva un pedido?",
        a: [
          "En Despachos, en «Más», «Cambiar repartidor»: una persona del equipo o, con «Otro: escribe el nombre», alguien de fuera, que queda para la próxima vez. También se elige al pasarlo a otro día. Un pedido sin repartidor sale igual.",
          "Lo que se cobre en la puerta queda a nombre de quien lo lleva.",
        ],
        needs: "entregas",
        screen: "despachos",
      },
      {
        id: "agencia",
        q: "¿Cómo anoto un envío por agencia?",
        a: [
          "Al marcar «Salió», elige la agencia (Shalom, Olva Courier, Marvisur u «Otra: escribe cuál») y, si ya lo tienes, su número de envío. El número lo puedes anotar después, en «Más», «Agencia y n.º de envío».",
          "Se cierra como entregado cuando lo recoge. Con el número, cualquiera lo sigue en la página de la agencia.",
        ],
        needs: "entregas",
        screen: "despachos",
      },
      {
        id: "avisar",
        q: "¿Cómo le aviso a la clienta que su pedido sale?",
        a: [
          "En Despachos, «Avisar»: ves el mensaje escrito, con cuándo sale, quién lo lleva y lo que paga al recibir, y lo puedes cambiar. «Abrir WhatsApp con el aviso» abre el WhatsApp de tu celular con ese texto: lo envías tú.",
          "En la historia del pedido queda «enviado por usted»: gestorIA no sabe si le llegó.",
        ],
        needs: "entregas",
        screen: "despachos",
      },
      {
        id: "no-se-entrego",
        q: "¿Qué hago si un pedido volvió sin entregar?",
        a: [
          "En Despachos, en «Más», o en el pedido en camino, «No se entregó»: elige qué pasó (no contestó, dirección errada, no lo quiso u otro motivo), cuándo va, en qué franja y quién lo lleva. Arriba te recuerda la regla de la tienda si la clienta no está y si es la primera vez que ese pedido no se entrega. Vuelve a «Por salir» ese día, sin anular nada, y el stock no se mueve.",
          "Hasta que vuelva a salir, aparece primero en Despachos, en «No se entregó», con su motivo y lo que hay que cobrar.",
        ],
        needs: "entregas",
        screen: "despachos",
      },
      {
        id: "pasar-a",
        q: "¿Cómo paso un pedido a otro día?",
        a: [
          "En Despachos o en el pedido, «Pasar a…»: el día (hoy, mañana u otro), la franja y quién lo lleva. Se puede mientras no sale, y no se anula nada. Es la forma de mover una entrega, también con el teclado y en el celular.",
        ],
        needs: "entregas",
        screen: "despachos",
      },
      {
        id: "pagado-sin-stock",
        q: "Está pagado, pero dice que no alcanzaba el stock",
        a: [
          "El pago se confirma igual, pero el pedido no sale hasta que entre lo que falta. Anota la entrada en el Catálogo: en el producto, «Ver el kardex», elige esa variante y «Entrada», con lo que llegó.",
        ],
        needs: "configuracion",
        screen: "catalogo",
      },
    ],
  },
  {
    id: "clientas",
    title: "Clientas",
    faqs: [
      {
        id: "lo-que-sabe-argos",
        q: "¿De dónde saca Argos lo que sabe de una clienta?",
        a: [
          "En la ficha de cada clienta, «Lo que Argos sabe de ella»: su talla (o como se llame la medida en tu catálogo), su distrito, su cumpleaños, por dónde prefiere escribir, su Instagram y lo que le gusta. Nadie tiene que llenarlo: Argos lo anota solo, de sus compras y de lo que ella escribió en el chat.",
          "Cada dato dice de dónde salió y cuándo: sus compras, la dirección de una entrega o lo que ella dijo, con sus palabras tal cual. Lo que ella no dijo, Argos no lo supone. Lo que no tiene claro, como dos tallas que compra por igual, lo usa igual y lo marca «Por confirmar»: no frena ninguna venta.",
          "Lee cada conversación cuando ella deja de escribir un rato, nunca a media conversación, y no lee las de prueba. Tampoco junta fichas por el teléfono: si dos fichas son la misma clienta, lo decide una persona.",
        ],
        needs: "ventas.atender",
        screen: "clientes",
      },
      {
        id: "corregir-dato",
        q: "¿Cómo corrijo un dato de una clienta?",
        a: [
          "En su ficha, en «Lo que Argos sabe de ella», «Corregir» junto al dato. Lo que pones queda «Lo puso la tienda», con tu nombre, y Argos ya no lo cambia aunque ella diga otra cosa después.",
          "Nada se borra: cada dato guarda su historial, con lo que anotó Argos antes y lo que corrigió la tienda. Si un dato está «Por confirmar», al corregirlo eliges el que es.",
        ],
        needs: "ventas.atender",
        screen: "clientes",
      },
      {
        id: "no-quiere-promociones",
        q: "¿Qué pasa si una clienta dice que no quiere promociones?",
        a: [
          "En su ficha, «Cuándo se le puede escribir» dice lo último que ella contestó sobre las «Promociones»: «Acepta», «Pidió que no le escriban» o «Sin permiso todavía». Sofi se lo pregunta en su primera compra y anota lo que ella responde, con sus palabras.",
          "Si en el chat pide que no le escriban más, Sofi lo anota en ese momento y desde entonces no se le escriben promociones. Lo de sus pedidos, como el pago y la entrega, sigue igual.",
          "Nadie del equipo puede decir por ella que sí: solo cambia si ella lo vuelve a escribir.",
        ],
        needs: "ventas.atender",
        screen: "clientes",
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
          "En Catálogo, «Agregar producto»: el nombre, el precio de lista y hasta tres opciones, como talla y color. Al guardarlo se abre su ficha.",
          "En la ficha, en «Variantes», cada color es un chip y las tallas se escriben como se dicen («35 a 42»). Debajo, la cuadrícula: una celda por color y talla con su «Stock». Subir el stock ahí es una entrada del kardex.",
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
        id: "ficha-se-guarda-sola",
        q: "¿Cómo guardo los cambios de un producto?",
        a: [
          "La ficha se guarda sola: arriba dice «Guardando…» y luego «Guardado». Si algo no se pudo guardar, lo dice ahí y en su campo; lo demás sí se guarda. Sin internet, lo escrito se queda y se guarda al volver.",
          "Con «Deshacer» y «Rehacer» (o Ctrl+Z y Ctrl+Mayús+Z) vuelves atrás un cambio, también uno ya guardado: el stock vuelve a lo que había, y si al deshacer baja, pide el motivo. Dentro de un campo, Ctrl+Z deshace lo que escribes en ese campo, y lo escrito se guarda al salir de él o con Enter. En el menú ⋯, «Volver a lo guardado» deja la ficha como estaba y «Quién cambió qué» muestra cada cambio con quién y cuándo.",
          "Si la misma ficha está abierta en otra pestaña o la cambia otra persona, lo de ella no se pisa: lo que cambió en otra cosa ya lo ves, y si cambiaron lo mismo, la ficha dice «Alguien cambió esta ficha» y eliges «Guardar lo mío» o «Quedarme con lo otro». Lo tuyo no se pierde.",
        ],
        needs: "configuracion",
        screen: "producto",
      },
      {
        id: "cuadricula",
        q: "¿Cómo lleno el stock de muchas tallas y colores de una vez?",
        a: [
          "En la cuadrícula de «Variantes»: con las flechas te mueves y con Mayúscula y las flechas eliges varias celdas. Escribe un número y Enter: se llena todo lo elegido. Abajo, «Poner» hace lo mismo con un valor para todas.",
          "También pegas desde Excel o Google Sheets: copia la tabla allá, con su fila de colores y su columna de tallas o sin ellas, toca la primera celda y pega con Ctrl+V. Con sus títulos, cada número va a su talla y su color por el nombre, aunque estén en otro orden; sin títulos, se pega desde la celda que elegiste. Lo que no entra se dice («No entró»), y lo pegado queda marcado, con «Deshacer».",
          "Las pestañas «Precio» y «Código de barras» se llenan igual; una celda de precio vacía usa el precio del producto.",
        ],
        needs: "configuracion",
        screen: "producto",
      },
      {
        id: "cambiar-stock",
        q: "¿Cómo cambio el stock?",
        a: [
          "El stock solo cambia con un movimiento. Subirlo en la cuadrícula es una entrada; bajarlo pide el motivo (contaste, se dañó…) y queda en el kardex con tu nombre.",
          "En «Ver el kardex» eliges la variante y ves cada movimiento. Ahí también anotas una «Entrada» con su costo, o un «Ajuste» cuando contaste y no cuadra.",
          "Las ventas lo bajan solas cuando se confirma el pago, o cuando el pedido sale si se paga al recibir, y vuelve si se anula.",
        ],
        needs: "configuracion",
        screen: "producto",
      },
      {
        id: "color-y-foto",
        q: "¿Cómo pongo el color de cada variante y la foto que manda Sofi?",
        a: [
          "En «Variantes», toca el chip del color: su nombre, el color sacado de sus fotos o escrito como código, con «Cuentagotas» sobre la foto, y si «Es de dos colores». Abajo eliges su foto: es la que manda Sofi cuando piden ese color.",
          "También desde «Fotos»: en el menú de cada foto, de qué color es.",
        ],
        needs: "configuracion",
        screen: "producto",
      },
      {
        id: "precio-minimo",
        q: "¿Cómo dejo que Sofi negocie el precio?",
        a: [
          "En la ficha, «Precio y ofertas de Sofi»: pon el «Mínimo». Sofi nunca baja de ahí y lo que cede queda escrito en el pedido. Sin mínimo, ese producto no se negocia.",
          "En «Lo que Sofi puede ofrecer» eliges qué puede dar de este producto: envío gratis, unos soles, precio en la 2.ª unidad o un regalo. Sofi primero dice el precio completo y lo bueno del producto, y ofrece algo solo si después el cliente duda: dice que está caro, que lo va a pensar, que en otra tienda está más barato o pide rebaja. A quien solo pregunta el precio no le rebaja ni le regala el envío. Ofrece una sola vez, con como mucho la mitad de lo que hay entre tu precio y tu mínimo, sin mejorarlo si el cliente insiste, y siempre a cambio de pagar dentro de 24 horas, con la hora exacta. Con pago al recibir no hay rebaja.",
          "En «Precio por cantidad y promociones» van el precio por cantidad, el de revendedora («Por mayor») y las promociones con fecha, de todo el producto, de un color o de una talla. No se suman: a cada variante le toca la mejor.",
        ],
        needs: "configuracion",
        screen: "producto",
      },
      {
        id: "margen",
        q: "¿Cuánto gano con cada producto?",
        a: [
          "En «Precio y ofertas de Sofi», con el costo (de lo último que entró de cada variante, el más alto), la barra dice cuánto ganas al precio de hoy, cuánto puede ceder Sofi (del precio al mínimo) y cuánto ganas en el mínimo, sin contar el envío. La cuenta la hace gestorIA con lo guardado: se pone al día al guardarse el precio o el mínimo.",
          "Lo que ganas en el peor caso, con el envío que pone la tienda, lo dice «Probar cuánto cobraría Sofi».",
        ],
        needs: "costos.ver",
        screen: "producto",
      },
      {
        id: "simulador",
        q: "¿Cuánto cobraría Sofi por un producto?",
        a: [
          "En la ficha, «Probar cuánto cobraría Sofi»: eliges cuántos, la entrega y la variante, y dice lo menos que cobraría, con la misma cuenta de los pedidos. No guarda nada.",
          "Lo que se gana en cada caso lo ve solo quien ve los costos.",
        ],
        needs: "catalogo.ver",
        screen: "producto",
      },
      {
        id: "estado-producto",
        q: "¿Cómo pongo un producto por encargo, en preventa o que ya no se vende?",
        a: [
          "En la ficha, en «Estado»: disponible y agotado salen solos del stock. Por encargo (con los días), con cupo por día, preventa (con el día que llega), liquidación o ya no se vende los pones tú. Debajo dice cómo lo cuenta Sofi.",
          "Por encargo, con cupo o en preventa se vende sin stock. En liquidación el precio es el final y no se negocia. Lo que ya no se vende no entra a un pedido nuevo.",
        ],
        needs: "configuracion",
        screen: "producto",
      },
      {
        id: "datos-rubro",
        q: "¿Qué datos pide cada producto para que Sofi responda?",
        a: [
          "En la ficha, elige su rubro (calzado, ropa…) y responde lo que preguntan sus clientas, como cómo calza o la tela. Lo que dice «Sofi lo necesita» le falta para venderlo sola; si no corresponde, «No aplica». Nada de esto frena una venta.",
          "Arriba, la línea de Sofi dice si lo vende sola y qué le falta: «Ver» lo muestra y «Completar» te lleva a ese dato.",
          "Con «Plantilla» ajustas qué pide cada producto de ese rubro en tu tienda: «Sofi lo necesita», «Suma» o «Quitar», y agregar un dato tuyo.",
        ],
        needs: "configuracion",
        screen: "producto",
      },
      {
        id: "sofi-no-supo",
        q: "Sofi no supo responder algo de un producto, ¿cómo se lo enseño?",
        a: [
          "En la ficha, en «Lo que Sofi no supo», escribe la respuesta. Desde ahí Sofi la usa la próxima vez y queda en «Preguntas respondidas».",
          "Quien atiende y no cambia la ficha la propone con «Proponer la respuesta»; quien cambia la ficha la deja con «Guardar en la ficha».",
        ],
        needs: "ventas.atender",
        screen: "producto",
      },
      {
        id: "web-paquete-cruzada",
        q: "¿Dónde pongo el link del producto, el paquete para la agencia y lo que combina?",
        a: [
          "Al costado de la ficha: en «Catálogo web», si se muestra y «Su nombre en el link»; en «Paquete para la agencia», el peso y las medidas, solo si envías por agencia; y en «Venta cruzada», lo que Sofi ofrece junto («Combina con», con su porcentaje si lo lleva junto) o como «Algo más barato».",
          "El código del producto va en «Organización» y el código de barras de cada variante, en la cuadrícula, en «Código de barras».",
        ],
        needs: "configuracion",
        screen: "producto",
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
          "En Configuración, al pie del menú, por tareas: «Tu tienda» (los datos de la tienda y Tu marca), «Vender» (Sofi, Cobros y Entregas), «Tu equipo» (Equipo y repartidores), «Para ti» (tus avisos al celular) y «Tu cuenta gestorIA» (el plan). Se ajusta una vez y lo usan las demás pantallas.",
          "Cada apartado lo ve quien puede cambiarlo. Quien atiende sin cambiar la configuración, al abrir Configuración llega directo a sus avisos al celular: no ve el equipo ni «Probar a Sofi», y sigue vendiendo con lo que ahí se puso.",
          "En el celular, Configuración es una lista: cada parte se abre en su pantalla y «Configuración», arriba, vuelve a la lista.",
        ],
        needs: "configuracion",
        screen: "configuracion",
      },
      {
        id: "lo-que-falta",
        q: "¿Qué me falta para vender y cómo está cada parte?",
        a: [
          "Configuración abre en «Lo que falta»: arriba, lo que falta para vender, cada cosa con su botón para hacerla (como «Probar a Sofi»); lo que ya está lleva su ✓. Es la misma cuenta que «Tu tienda está casi lista» de Inicio. Se marca solo con lo que guardas en cada parte: nadie lo marca a mano.",
          "Debajo, en «Para vender más», lo que ayuda pero no frena la venta, como tu logo o «Conectar pasarela» para cobrar por link: no se cuenta como falta. Cuando no falta nada, lo dice en una línea.",
          "Debajo, en «Cómo está cada parte», cada parte dice en una línea cómo está, y la que tiene algo pendiente lleva un punto y lo dice, como «Sin probar» o «Por pagar». Toca la línea para abrirla.",
        ],
        needs: "configuracion",
        screen: "configuracion",
      },
      {
        id: "configuracion-sin-permiso",
        q: "¿Por qué en Configuración solo veo mis avisos?",
        a: [
          "En Configuración cada quien ve lo que puede cambiar. Tus avisos al celular son tuyos: eliges tú qué te llega.",
          "Los datos de la tienda, Tu marca, Sofi, Cobros, Entregas y el equipo los cambia quien configura la tienda. Tú sigues atendiendo y vendiendo con lo que ahí se puso; si algo hay que cambiar, pídeselo.",
        ],
        needs: "configuracion",
        screen: "avisos",
        forWhoCannot: true,
      },
      {
        id: "buscar-en-configuracion",
        q: "No encuentro dónde se cambia algo, ¿cómo lo busco?",
        a: [
          "Arriba de la lista de Configuración, en «Buscar en Configuración», escribe con tus palabras: «yape», «shalom», «envío gratis», «horario» o el nombre de alguien de tu equipo. Cada resultado dice en qué parte está; con las flechas eliges y con Enter lo abres.",
        ],
        needs: "configuracion",
        screen: "configuracion",
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
          "En Configuración, en Tu marca: suelta tu logo en el recuadro o pégalo con Ctrl + V; si aún no tienes logo, también lo eliges con «Elegir imagen», y si ya tienes uno, lo cambias con «Cambiar». Con «Ajustar» lo recortas. Salen los colores de tu logo: toca uno, o usa «Otro color». Cualquier color vale; si no se lee bien, te lo dice y los botones usan un tono más oscuro.",
          "También pones la portada, el nombre que ve la clienta y tu link, sin tildes ni espacios: al escribirlo te dice si está libre. Al lado (en el celular, «Ver cómo queda») ves cómo lo verá tu clienta. Nada se guarda hasta «Guardar»; si sales antes, te pregunta.",
        ],
        needs: "configuracion",
        screen: "marca",
      },
      {
        id: "medios-de-pago",
        q: "¿Cómo agrego Yape, Plin o una cuenta para transferencias?",
        a: [
          "En Configuración, en Cobros, «Agregar otra forma de cobro» y eliges cómo te paga. Yape y Plin piden tu celular, a nombre de quién está y tu QR (lo sueltas o lo pegas con Ctrl+V). Ves cómo le llega el dato a la clienta: tu número, a nombre de quién y el monto. Tu QR queda guardado: Sofi lo enviará cuando el chat por WhatsApp esté conectado. La transferencia pide tu banco de la lista, la cuenta y el CCI, que se revisa con sus dígitos de control.",
          "Lo que confirma una persona (Yape, Plin, la transferencia) espera a que alguien del equipo revise la captura; lo que se cobra al recibir lo confirma el repartidor. Si lo apagas, Sofi deja de ofrecerlo.",
        ],
        needs: "configuracion",
        screen: "pagos",
      },
      {
        id: "formas-de-entrega",
        q: "¿Cómo pongo el costo del envío por zona?",
        a: [
          "En Configuración, en Entregas. Mientras no tienes zonas, eliges desde qué distrito despachas y «Usar la plantilla de Lima» (los 50 distritos de Lima y el Callao en 6 zonas, con precios de partida que cambias) o «Prefiero armarlas yo». Con las zonas ya hechas esos botones no están: los distritos se cambian en el mapa (tocas uno y eliges su zona o «No entrego ahí») o en la lista de cada zona, con «Editar», y una zona nueva (por ejemplo, solo para Lurín) con «Agregar zona». Un distrito está en una sola zona.",
          "Cada zona, con «Editar»: su precio, cuándo llega (hoy antes de una hora, al día siguiente o en días fijos), sus franjas, si acepta pago al recibir y si tiene envío gratis. En «Reglas», desde qué compra es gratis, quién paga si la clienta no está y dónde se paga al recibir. Sofi cotiza con el distrito de la clienta.",
          "El recojo y la agencia van en sus tarjetas («Agregar recojo», «Agregar agencia»). A una clienta de provincia, Sofi le nombra tus agencias, le dice lo que cobras por llevarlo y quién paga el flete, y le pide la ciudad, la agencia de destino y el nombre y DNI de quien recoge. Las franjas, en «Franjas de entrega», «Agregar franja» con su hora de inicio y de fin. Son opcionales: un pedido sin franja sale igual.",
        ],
        needs: "configuracion",
        screen: "entregas",
      },
      {
        id: "mercado-pago",
        q: "¿Cómo conecto Mercado Pago?",
        a: [
          "En Configuración, en Cobros, «Conectar con Mercado Pago»: entras con la cuenta de la tienda y das permiso, sin copiar ninguna clave. El dinero de cada link llega directo a tu cuenta.",
          "Empieza en modo prueba: «Probar con S/ 1» crea un link que pagas con la tarjeta de prueba de Mercado Pago, y ves cómo queda pagado solo. En modo prueba ningún pedido se cobra por link. Cuando te guste, «Cobrar de verdad» vuelve a pedir el permiso, esta vez para cobrar.",
          "Si lo desconectas, los links ya enviados dejan de confirmarse solos: esos pagos los revisas tú.",
        ],
        needs: "configuracion",
        screen: "pagos",
      },
      {
        id: "avisos-al-celular",
        q: "¿Cómo me entero de un pago o de una entrega aunque gestorIA esté cerrada?",
        a: [
          "Instala gestorIA en tu celular y activa los avisos: en Inicio, la tarjeta «Recibe los avisos en este celular» te guía, o en Configuración, en Avisos al celular, «Activar en este celular». No cuesta nada. En iPhone, primero agrégala a la pantalla de inicio desde Safari y ábrela desde ese ícono.",
          "Te llega lo que tu rol puede resolver: los pagos por confirmar, los chats que esperan a una persona, lo que no se entregó y, si lo eliges, los pedidos que armó Sofi; a quien ve Reportes, también lo de dinero. Cada aviso abre lo que toca resolver, y el siguiente del mismo tipo reemplaza al anterior.",
          "En Avisos al celular eliges qué te llega, y vale en todos tus celulares. «Apagar en este celular» los apaga solo en ese celular; al cerrar sesión también se apagan en él.",
        ],
        needs: "avisos.recibir",
        screen: "avisos",
      },
      {
        id: "invitar",
        q: "¿Cómo invito a alguien a mi equipo?",
        a: [
          "En Configuración, en Equipo y repartidores, «Invitar»: su nombre, su celular, el correo con el que entrará y su rol; cada rol dice lo que puede hacer. «Crear la invitación» y después «Enviar por WhatsApp»: se abre el WhatsApp de tu celular con el mensaje escrito y lo envías tú. En la lista dice quién la envió por WhatsApp: gestorIA no sabe si le llegó.",
          "Entra solo con la cuenta de ese correo: el link solo no basta. La invitación vence en 7 días; si venció, «Invitar otra vez». Si un dato estaba mal, «Corregir»: se abre con sus datos puestos y, al crear la nueva, la anterior queda anulada. Para que ya no sirva, «Anular» y confírmalo.",
          "Para cambiar el rol de alguien o quitarlo del equipo, tócalo en la lista: cada rol dice lo que puede hacer. A quien tiene el plan solo lo cambia o lo quita alguien con su mismo rol, y la tienda nunca se queda sin quien tiene el plan.",
        ],
        needs: "equipo.gestionar",
        screen: "equipo",
      },
      {
        id: "repartidores",
        q: "¿Cómo sumo a un repartidor y anoto lo que le pago?",
        a: [
          "En Configuración, en Equipo y repartidores, «Agregar repartidor»: su nombre, su celular, «Le pagas por entrega» y qué pasa «Si la clienta no estaba». Desde ese momento lo eliges al despachar, en Despachos, y le puedes avisar por WhatsApp desde tu celular.",
          "Lo que le pagas por entrega es para que sepas cuánto le debes: gestorIA no le paga ni lo descuenta de nada. Quien es de tu equipo y ya llevó un pedido también aparece, con su pago si se lo anotas.",
          "Para que deje de repartir, tócalo en la lista y «Sacar»: lo que tenía asignado y todavía no salió queda sin repartidor en Despachos; lo que llevó y cobró sigue con su nombre.",
        ],
        needs: "equipo.gestionar",
        screen: "equipo",
      },
      {
        id: "soporte-mira",
        q: "¿Qué ve soporte cuando lo dejo entrar y cómo sé si entró?",
        a: [
          "Soporte de gestorIA entra solo si lo dejan entrar, y por los minutos que pidió, que empiezan cuando lo dejan entrar. Ve tu tienda, tu catálogo sin costos y tu equipo (nombres, correos y roles). No ve tus pedidos ni tus conversaciones, y no cambia nada. Solo el equipo de gestorIA puede pedirlo.",
          "Cuando soporte pide mirar tu tienda, lo ves una sola vez en la franja de arriba, en cualquier pantalla: «Revisar» te lleva a Configuración, en Equipo y repartidores, donde respondes «Dejar entrar» o «No». Mientras mira, la franja lo dice hasta que termina.",
          "En Equipo y repartidores ves también quién miró, desde qué hora, quién lo dejó entrar y cómo terminó. Mientras mira, «Sacar ahora» lo saca al momento.",
        ],
        needs: "equipo.gestionar",
        screen: "equipo",
      },
      {
        id: "caja",
        q: "¿Cómo recibo el efectivo que cobró un repartidor?",
        a: [
          "En Caja, en «Efectivo por recibir»: lo que cobró en efectivo cada repartidor (y lo cobrado en la tienda), pedido por pedido. Al recibirlo, «Recibí» con lo que te entregó; si no cuadra, escribe qué pasó. Queda a tu nombre, con la hora.",
          "Caja también dice lo cobrado del día por medio, la misma cifra de Reportes, y lo que falta cobrar en las entregas del día, lo mismo que dice Despachos.",
        ],
        needs: "caja",
        screen: "caja",
      },
      {
        id: "reportes",
        q: "¿Dónde veo cuánto vendí?",
        a: [
          "En Reportes: lo vendido y cobrado, lo que falta cobrar, quiénes volvieron a comprar, lo más vendido y lo que se acaba, y lo que hicieron Sofi y Argos. Lo de hoy y lo que queda pendiente está en Inicio, en «Te toca».",
        ],
        needs: "reportes.ver",
        screen: "reportes",
      },
      {
        id: "plan",
        q: "¿Dónde veo mi plan y lo que se me cobró?",
        a: [
          "En Configuración, en «Plan y pagos» (también se abre desde el nombre de la tienda, arriba en el menú): primero, lo que tienes por pagar y cuándo vence, o «Nada por pagar». Si tienes algo por pagar, ahí mismo está «Subir comprobante»; si no aparece, avísanos que pagaste escribiendo a soporte desde la «Ayuda», arriba. Debajo, tu plan, cuánto usaste de tu saldo y cuánto te queda, tu tope y cuándo cierra tu mes. Más abajo, lo que se te cobró y pagaste antes.",
          "Para cambiar tu tope, «Pedir otro tope» (o «Pedir un tope», si no tienes): se abre la Ayuda con tu mensaje a soporte de gestorIA ya escrito, lo completas y lo envías. Para preguntar por un cobro, escribe a soporte desde la «Ayuda», arriba en cualquier pantalla. En «Plan y pagos» ves las respuestas de toda la tienda.",
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

/* ---------- Lo que la Ayuda muestra y lo que Ariadna lee ---------- */

const SCREEN_KEYS = Object.keys(HELP_SCREENS) as HelpScreen[]
const FAQS = HELP_GUIDE.flatMap((group) => group.faqs)

/** Lo que dice cuando no responde. */
export const HELP_WORDS = {
  notInGuide: "Esto no está en la guía, y no quiero inventarlo.",
  cannotSearch: "Ahora no puedo buscar bien en la guía.",
  doubt: "No estoy segura de qué preguntas. ¿Es alguna de estas?",
} as const

/** Una respuesta de la guía como la muestra el panel común (`helpReply` de la Ayuda). */
export interface HelpAnswerText {
  topicId: string
  where: string
  text: string
  /** Su pantalla en la tienda, solo si el rol de quien pregunta la abre. */
  path: string | null
  /** Si su rol no puede hacerlo: a quién pedírselo. */
  restriction: string | null
}

/** Lo que responde la Ayuda, con la forma del panel común (`helpReply` de `@odentia/ui-patterns`). */
export interface HelpReplyBody {
  askId: string
  kind: "guia" | "duda" | "nada" | "datos"
  say: string | null
  written: string | null
  answers: HelpAnswerText[]
  blockers: { text: string; where: string | null; path: string | null }[]
  choices: { question: string; where: string }[]
  /** gestorIA no tiene un agente de las cifras en la Ayuda. */
  argos: false
  argosNote: null
  basedOn: string
}

/** La ruta dentro de la tienda, sin lo que va tras `?` o `#`: `/tiendas/<id>/pedidos` → `/pedidos`. */
export function storePath(path: string, storeId: string): string {
  const base = `/tiendas/${storeId}`
  const bare = path.split(/[?#]/, 1)[0] ?? ""
  const inside = bare === base || bare.startsWith(`${base}/`) ? bare.slice(base.length) : bare
  return (inside.startsWith("/") ? inside : `/${inside}`).slice(0, 200)
}

/**
 * Si la ruta está en esa pantalla o debajo de ella. Una parte variable (`/catalogo/$productId`)
 * vale para cualquier valor de esa parte.
 */
function routeHas(screen: string, path: string): boolean {
  const want = screen.split("/")
  const have = path.split("/")
  if (have.length < want.length) return false
  return want.every((part, i) => (part.startsWith("$") ? have[i] !== "" : part === have[i]))
}

/** La pantalla de la guía de una ruta dentro de la tienda: la más precisa que la contiene. */
export function helpScreenOf(path: string): HelpScreen | null {
  let found: HelpScreen | null = null
  for (const key of SCREEN_KEYS) {
    const screen: string = HELP_SCREENS[key].path
    const inside = screen === "/" ? path === "/" : routeHas(screen, path)
    if (inside && (!found || screen.length > HELP_SCREENS[found].path.length)) found = key
  }
  return found
}

/** El nombre de la pantalla y hasta tres preguntas suyas que el rol de quien la abre puede hacer. */
export function helpScreenView(
  seat: StoreSeat,
  path: string,
): { title: string | null; suggestions: string[] } {
  const screen = helpScreenOf(path)
  if (!screen) return { title: null, suggestions: [] }
  return {
    title: HELP_SCREENS[screen].label,
    suggestions: FAQS.filter(
      (faq) =>
        faq.screen === screen &&
        (faq.forWhoCannot
          ? !can(seat, faq.needs) && can(seat, HELP_SCREENS[screen].opens)
          : can(seat, faq.needs)),
    )
      .slice(0, 3)
      .map((faq) => faq.q),
  }
}

/** La guía entera para Ariadna: un tema por pantalla, con sus preguntas. Nada de la tienda. */
export function helpTopics(): HelpGuideTopic[] {
  return SCREEN_KEYS.map((key) => {
    const screen = HELP_SCREENS[key]
    return {
      id: key,
      path: screen.path,
      title: screen.label,
      // Los apartados de Configuración cuelgan de ella en el menú.
      parent: screen.path.startsWith("/configuracion") ? "Configuración" : null,
      purpose: screen.purpose,
      terms: [...screen.terms],
      faqs: FAQS.filter((faq) => faq.screen === key).map((faq) => ({
        id: faq.id,
        q: faq.q,
        a: faq.a.join("\n\n"),
      })),
    }
  })
}

/** «Con tu rol (Ventas) no se puede: …», si el rol no tiene el permiso. */
function restrictionFor(seat: StoreSeat, needs: StorePermission): string | null {
  if (can(seat, needs)) return null
  const many = TEAM_ROLES.filter((role) => can(role, needs)).length > 1
  return `Con tu rol (${ROLE_NAMES[seat]}) no se puede: pídeselo a quien sí puede. ${many ? "Lo pueden hacer" : "Lo puede hacer"}: ${whoCan(needs)}.`
}

/** La pantalla en la tienda, si el rol la abre. */
function pathFor(seat: StoreSeat, storeId: string, screen: HelpScreen): string | null {
  const { path: full, opens } = HELP_SCREENS[screen]
  if (!can(seat, opens)) return null
  // Una ruta con su parte variable lleva a lo de antes de ella (la ficha, al Catálogo).
  const path = full.split("/$")[0] || "/"
  return `/tiendas/${storeId}${path === "/" ? "" : path}`
}

function isScreen(id: string): id is HelpScreen {
  return Object.hasOwn(HELP_SCREENS, id)
}

/** Lo que la guía dice de un id de Ariadna (`faq:<id>` o `tema:<id>`) para ese rol; nulo si no es de la guía. */
export function helpAnswerFor(
  seat: StoreSeat,
  storeId: string,
  ref: string,
): HelpAnswerText | null {
  const at = ref.indexOf(":")
  const kind = ref.slice(0, at)
  const id = ref.slice(at + 1)
  if (kind === "faq") {
    const faq = FAQS.find((one) => one.id === id)
    if (!faq) return null
    return {
      topicId: faq.screen,
      where: HELP_SCREENS[faq.screen].label,
      text: faq.a.join("\n\n"),
      path: pathFor(seat, storeId, faq.screen),
      restriction: restrictionFor(seat, faq.needs),
    }
  }
  if (kind === "tema" && isScreen(id)) {
    const screen = HELP_SCREENS[id]
    return {
      topicId: id,
      where: screen.label,
      text: screen.purpose,
      path: pathFor(seat, storeId, id),
      restriction: restrictionFor(seat, screen.opens),
    }
  }
  return null
}

/** Una opción de la duda: tocarla pregunta su texto tal cual. */
function choiceFor(ref: string): { question: string; where: string } | null {
  const id = ref.slice(ref.indexOf(":") + 1)
  if (ref.startsWith("faq:")) {
    const faq = FAQS.find((one) => one.id === id)
    return faq ? { question: faq.q, where: HELP_SCREENS[faq.screen].label } : null
  }
  if (ref.startsWith("tema:") && isScreen(id)) {
    const { label } = HELP_SCREENS[id]
    return { question: `¿Para qué sirve ${label}?`, where: label }
  }
  return null
}

function reply(
  kind: HelpReplyBody["kind"],
  parts: Partial<HelpReplyBody> & { askId: string },
): HelpReplyBody {
  return {
    kind,
    say: null,
    written: null,
    answers: [],
    blockers: [],
    choices: [],
    argos: false,
    argosNote: null,
    basedOn: "",
    ...parts,
  }
}

function guideReply(askId: string, answers: HelpAnswerText[], written: string | null) {
  const places = [...new Set(answers.map((answer) => answer.where))]
  return reply("guia", {
    askId,
    written,
    answers,
    basedOn: `La guía de gestorIA: ${places.join(" y ")}.`,
  })
}

/**
 * Lo que respondió Ariadna (solo ids de esta guía) hecho texto para el rol de quien preguntó:
 * cada respuesta con su pantalla, si la abre, y a quién pedírselo, si su rol no puede.
 */
export function helpReplyOf(
  answer: HelpAskAnswer,
  seat: StoreSeat,
  storeId: string,
): HelpReplyBody {
  const { askId } = answer
  if (answer.verdict === "seguro") {
    const answers = answer.shown
      .map((ref) => helpAnswerFor(seat, storeId, ref))
      .filter((one): one is HelpAnswerText => one !== null)
    if (answers.length > 0) return guideReply(askId, answers, answer.written)
  }
  if (answer.verdict === "duda") {
    const choices = answer.offered
      .map(choiceFor)
      .filter((one): one is { question: string; where: string } => one !== null)
    if (choices.length > 0) return reply("duda", { askId, say: HELP_WORDS.doubt, choices })
  }
  if (answer.verdict === "datos") {
    const path = pathFor(seat, storeId, "reportes")
    if (path)
      return reply("datos", {
        askId,
        say: "Eso es de las cifras de tu tienda, y no está en la guía. Las ves en Reportes.",
        answers: [{ topicId: "reportes", where: "Reportes", text: "", path, restriction: null }],
      })
    return reply("datos", {
      askId,
      say: `Eso es de las cifras de tu tienda, y no está en la guía. Pídeselo a quien ve Reportes: ${whoCan("reportes.ver")}.`,
    })
  }
  return reply("nada", { askId, say: HELP_WORDS.notInGuide })
}

/** Para comparar una pregunta con las de la guía: sin tildes, signos ni mayúsculas. */
function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/**
 * Sin Ariadna (sin el acuerdo, o la administración no respondió): una pregunta que es
 * exactamente una de la guía se responde tal cual, sin modelo; cualquier otra, no se inventa.
 */
export function helpReplyWithoutAriadna(
  question: string,
  seat: StoreSeat,
  storeId: string,
  askId: string,
): HelpReplyBody {
  const asked = plain(question)
  const faq = FAQS.find((one) => plain(one.q) === asked)
  const answer = faq ? helpAnswerFor(seat, storeId, `faq:${faq.id}`) : null
  if (answer) return guideReply(askId, [answer], null)
  return reply("nada", { askId, say: HELP_WORDS.cannotSearch })
}

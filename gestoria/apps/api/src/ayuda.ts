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
  inicio: { label: "Inicio", path: "/", opens: "ventas.atender" },
  despachos: { label: "Despachos", path: "/despachos", opens: "entregas" },
  pedidos: { label: "Pedidos", path: "/pedidos", opens: "ventas.atender" },
  catalogo: { label: "Catálogo", path: "/catalogo", opens: "catalogo.ver" },
  caja: { label: "Caja", path: "/caja", opens: "caja" },
  reportes: { label: "Reportes", path: "/reportes", opens: "reportes.ver" },
  // Configuración, al pie del menú: abre en «Lo que falta» y cada apartado lo abre quien puede
  // cambiarlo.
  configuracion: { label: "Lo que falta", path: "/configuracion", opens: "configuracion" },
  datos: { label: "Datos de la tienda", path: "/configuracion/datos", opens: "configuracion" },
  marca: { label: "Tu marca", path: "/configuracion/marca", opens: "configuracion" },
  equipo: {
    label: "Equipo y repartidores",
    path: "/configuracion/equipo",
    opens: "equipo.gestionar",
  },
  sofi: { label: "Sofi", path: "/configuracion/sofi", opens: "configuracion" },
  pagos: { label: "Cobros", path: "/configuracion/medios-de-pago", opens: "configuracion" },
  entregas: { label: "Entregas", path: "/configuracion/entregas", opens: "configuracion" },
  avisos: { label: "Avisos al celular", path: "/configuracion/avisos", opens: "avisos.recibir" },
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
          "Lo que no está en tu catálogo ni en «Lo que sabe», no lo inventa: pasa la conversación a una persona y la pregunta aparece en «Lo que aprendió». Por ahora la pruebas en Configuración, en Sofi, con «Probar a Sofi», escribiendo como si fueras un cliente: debajo de cada respuesta, «Por qué» dice qué usó. Esos pedidos son de prueba: no mueven el stock ni cuentan en Reportes.",
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
          "En «Lo que aprendió» ves lo que clientas preguntaron en tus chats y Sofi no supo: con «Responder» lo guardas en «Lo que sabe». Nada se agrega solo. Tus productos, precios, medios de pago y formas de entrega los toma del catálogo y de Configuración: no hace falta repetirlos.",
        ],
        needs: "configuracion",
        screen: "sofi",
      },
      {
        id: "sofi-como-habla",
        q: "¿Cómo elijo cómo habla Sofi y qué puede ofrecer?",
        a: [
          "En Configuración, en Sofi, cada parte tiene su «Cambiar». En «Cómo habla» eliges su tono viendo un ejemplo de cada uno (cercana, amable y formal o directa), si trata de tú o de usted, los emojis y cómo se presenta. En «Qué ofrece» marcas lo que puede ofrecer para cerrar: envío gratis, un descuento, un regalo o una rebaja si lleva dos.",
          "En «Cuándo te pasa el chat» eliges si te lo pasa cuando la clienta está molesta o cuando el pedido pasa de un monto, y el horario de tu equipo: fuera de él, Sofi dice cuándo le responden y tú decides si sigue vendiendo. Con «Pausar» deja de atender y tus chats esperan a una persona.",
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
          "En Despachos, en «Más», o en el pedido en camino, «No se entregó»: elige qué pasó (no contestó, dirección errada, no lo quiso u otro motivo), cuándo va, en qué franja y quién lo lleva. Vuelve a «Por salir» ese día, sin anular nada, y el stock no se mueve.",
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
          "Configuración abre en «Lo que falta»: arriba, lo que falta para vender, cada cosa con su botón para hacerla (como «Conectar pasarela» o «Probar a Sofi»); lo que ya está lleva su ✓. Se marca solo con lo que guardas en cada parte: nadie lo marca a mano. Cuando no falta nada, lo dice en una línea.",
          "Debajo, en «Cómo está cada parte», cada parte dice en una línea cómo está, y la que tiene algo pendiente lleva un punto y lo dice, como «Sin pasarela». Toca la línea para abrirla.",
        ],
        needs: "configuracion",
        screen: "configuracion",
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
          "En Configuración, en Cobros, «Agregar medio»: el nombre como lo dirá Sofi y los datos que envía tal cual (el número, la cuenta, a nombre de quién). Si lo apagas, Sofi deja de ofrecerlo.",
        ],
        needs: "configuracion",
        screen: "pagos",
      },
      {
        id: "formas-de-entrega",
        q: "¿Cómo pongo el costo del envío por zona?",
        a: [
          "En Configuración, en Entregas, «Agregar forma»: tu reparto, el recojo en tienda o la agencia, con su precio por zona y cuándo llega. También dices hasta cuánto puede rebajarlo Sofi y desde qué compra es gratis.",
          "Ahí mismo, en «Franjas de entrega», «Agregar franja» con su hora de inicio y de fin (como de 9 a 13 h). Son opcionales: un pedido sin franja sale igual.",
        ],
        needs: "configuracion",
        screen: "entregas",
      },
      {
        id: "mercado-pago",
        q: "¿Cómo conecto Mercado Pago?",
        a: [
          "En Configuración, en Cobros, «Conectar Mercado Pago», con la cuenta de la tienda: el dinero de cada link llega directo a ella. Desde entonces, cada pedido por pagar puede llevar su link de pago.",
        ],
        needs: "configuracion",
        screen: "pagos",
      },
      {
        id: "avisos-al-celular",
        q: "¿Cómo me entero de un pago o de una entrega aunque gestorIA esté cerrada?",
        a: [
          "Instala gestorIA en tu celular y activa los avisos: en Pedidos, la tarjeta «Recibe los avisos en este celular» te guía, o en Configuración, en Avisos al celular, «Activar en este celular». No cuesta nada. En iPhone, primero agrégala a la pantalla de inicio desde Safari y ábrela desde ese ícono.",
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
          "En Configuración, en Equipo y repartidores, «Invitar»: su correo y su rol; al elegirlo, cada rol dice lo que puede hacer. Comparte el enlace: entra con la cuenta de ese correo, y la invitación vence en 7 días.",
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

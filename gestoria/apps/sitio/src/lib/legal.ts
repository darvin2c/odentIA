// Términos y Privacidad de gestorIA. Siguen la forma de los de las clínicas (apps/web/src/lib/legal)
// y dicen solo lo que gestorIA hace hoy: sus proveedores, sus reglas y su plan (el de la página
// Precios). Marco: Ley 29733 y su Reglamento (D.S. 016-2024-JUS). Si se vuelve a marcar algo
// «[Por completar…]» o «[Por confirmar…]», el documento va con noindex y fuera del mapa del sitio.
import { CONTACT_EMAIL } from "./sitio"

/** Un bloque de una sección: un párrafo, una lista o un subtítulo. */
export type LegalBlock = string | { list: string[] } | { h: string }

export type LegalSection = { id: string; title: string; blocks: LegalBlock[] }

export type LegalDoc = {
  path: "/terminos" | "/privacidad"
  title: string
  description: string
  intro: string
  /** Desde cuándo rige. */
  since: string
  sections: LegalSection[]
}

/** El titular de gestorIA, como figura en odentia32.com/privacidad. */
export const TITULAR = {
  razonSocial: "SALLCA GROUP E.I.R.L.",
  ruc: "20603338741",
  domicilio: "Av. General Andrés de Santa Cruz 176, Urb. Fundo Oyague, Jesús María, Lima, Perú",
} as const

const RESPONSABLE = `gestorIA es una marca del Grupo Sallca. El responsable es ${TITULAR.razonSocial}, con RUC ${TITULAR.ruc} y domicilio en ${TITULAR.domicilio}.`

const MARCA = /\[Por (completar|confirmar)/

/** Verdadero si el documento conserva algún «[Por completar…]» o «[Por confirmar…]». */
export function hasPending(doc: LegalDoc): boolean {
  return MARCA.test(JSON.stringify(doc))
}

export type Segment = { text: string; mark?: true; href?: string }

/**
 * Parte un texto en trozos: el texto normal, los marcadores de lo que falta (para resaltarlos) y los
 * enlaces escritos «[texto](dirección)».
 */
export function segments(text: string): Segment[] {
  const out: Segment[] = []
  const pattern = /\[(Por (?:completar|confirmar)[^\]]*)\]|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at) })
    if (match[1]) out.push({ text: `[${match[1]}]`, mark: true })
    else out.push({ text: match[2] ?? "", href: match[3] ?? "" })
    last = at + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** Fecha de la versión vigente de los dos documentos. */
export const LEGAL_VIGENTE = "27 de noviembre de 2026"

const CORREO = `[${CONTACT_EMAIL}](mailto:${CONTACT_EMAIL})`

const ENTRENAMIENTO =
  "gestorIA no usa los datos de las tiendas ni de sus clientes para entrenar modelos propios. OpenAI, el proveedor del modelo de lenguaje de Sofi, no usa para entrenar sus modelos los datos que recibe por su API, según sus condiciones de uso."

export const PRIVACIDAD: LegalDoc = {
  path: "/privacidad",
  title: "Política de privacidad",
  description:
    "Cómo trata gestorIA los datos de quien visita la web, de quien vende con la app y, por encargo de cada tienda, los de sus clientes. Tus derechos y cómo pedirlos.",
  intro:
    "Qué datos trata gestorIA, para qué, cuánto tiempo, con quién los comparte y cómo pides lo que te corresponde. Se aplica conforme a la Ley N.º 29733, Ley de Protección de Datos Personales, y su Reglamento, aprobado por Decreto Supremo N.º 016-2024-JUS.",
  since: LEGAL_VIGENTE,
  sections: [
    {
      id: "responsable",
      title: "Quién es el responsable",
      blocks: [RESPONSABLE, `Para cualquier asunto de privacidad, escríbenos a ${CORREO}.`],
    },
    {
      id: "papeles",
      title: "Los dos papeles de gestorIA",
      blocks: [
        {
          list: [
            "De los datos de quien visita la web o nos escribe, y de quien usa la app (el Dueño de la tienda y su equipo), gestorIA es el responsable.",
            "De los datos de quien le compra a una tienda (sus clientes), la responsable es la tienda. gestorIA los trata por su encargo: solo para atender, vender y entregar por ella, y según sus instrucciones.",
          ],
        },
        "Las secciones 3 a 10 tratan de los datos de los que gestorIA es responsable. La sección 11, de los clientes de cada tienda.",
      ],
    },
    {
      id: "datos",
      title: "Qué datos tratamos",
      blocks: [
        { h: "Quien visita la web" },
        "Esta web no usa cookies ni carga herramientas de analítica, de publicidad ni tipografías de otros sitios. Cloudflare, que la sirve, procesa datos técnicos de cada visita (dirección IP, navegador, página pedida) para entregarla y protegerla.",
        "Si nos escribes por WhatsApp o por correo, tratamos lo que nos envías: tu nombre, tu número o tu correo, tu tienda y tu mensaje.",
        { h: "Quien usa la app" },
        {
          list: [
            "Tu cuenta: nombre, correo y foto. Es la misma cuenta de las apps del Grupo Sallca.",
            "Tu lugar en cada tienda: el rol (Dueño, Administrador o Ventas) y la bitácora de lo que haces en ella, con fecha y hora.",
            "Si activas los avisos al celular, el identificador que tu navegador da para recibirlos.",
            "Para el plan: los comprobantes de pago que sube el Dueño y los datos de la tienda para emitir el comprobante. gestorIA no recibe ni guarda datos de tarjetas.",
          ],
        },
      ],
    },
    {
      id: "para-que",
      title: "Para qué los usamos y con qué base",
      blocks: [
        {
          list: [
            "Darte el servicio: crear la cuenta y la tienda, aplicar el permiso de cada rol y darte soporte. Base: el contrato con la tienda.",
            "Cobrar el plan y emitir sus comprobantes. Base: el contrato y las obligaciones tributarias.",
            "Mantener la seguridad: la bitácora de cada tienda y la prevención de fraudes y accesos no autorizados. Base: interés legítimo y el deber de adoptar medidas de seguridad.",
            "Responder a quien nos escribe. Base: su consentimiento.",
            "Avisarte de cambios del servicio, del precio o de estos textos. Base: el contrato.",
            "Enviarte novedades de gestorIA. Base: tu consentimiento, que puedes retirar cuando quieras.",
          ],
        },
        "No tomamos decisiones con efectos jurídicos sobre las personas basadas solo en un tratamiento automatizado de sus datos.",
      ],
    },
    {
      id: "plazos",
      title: "Cuánto tiempo los guardamos",
      blocks: [
        {
          list: [
            "Tu cuenta: mientras la uses. Si la cierras, sales de los equipos y nadie puede entrar con ella. Lo que hiciste en una tienda (pedidos, pagos confirmados, entregas) sigue en la historia de esa tienda.",
            "Los datos del plan y sus comprobantes: el plazo que exija la norma tributaria.",
            "Las copias de seguridad: son diarias y se guardan las 14 más recientes.",
            "Lo que nos escribe quien no tiene tienda: el tiempo de atenderlo y hasta un año después.",
          ],
        },
        "Vencidos esos plazos, los datos se eliminan o se anonimizan.",
      ],
    },
    {
      id: "proveedores",
      title: "Con quién los compartimos",
      blocks: [
        "No vendemos datos personales. Los compartimos solo con los proveedores que hacen funcionar gestorIA y con las autoridades cuando la ley lo exige:",
        {
          list: [
            "Cloudflare (Estados Unidos): sirve la web y la app, protege la entrada al servidor y guarda las copias de seguridad.",
            "OVHcloud (Canadá): el servidor donde vive la base de datos.",
            "OpenAI (Estados Unidos): el modelo de lenguaje con que Sofi entiende y redacta. Recibe la conversación y lo que Sofi necesita del catálogo para contestar.",
            "Meta (Estados Unidos): WhatsApp, Instagram y Messenger, cuando la tienda los conecta.",
            "Mercado Pago: el link de pago, con la cuenta de cada tienda. El dinero de las ventas va directo a la tienda; gestorIA no lo recibe.",
            "ZeptoMail: los correos de la cuenta y nuestras respuestas.",
            "Los servicios de avisos de Google, Apple, Mozilla y Microsoft, si activas los avisos al celular.",
          ],
        },
        "Varios están fuera del Perú. Esos envíos son flujo transfronterizo de datos personales y los hacemos con proveedores que ofrecen un nivel de protección adecuado o garantías contractuales suficientes, conforme a la Ley 29733 y su Reglamento.",
        ENTRENAMIENTO,
      ],
    },
    {
      id: "meta",
      title: "Datos de WhatsApp, Instagram y Messenger",
      blocks: [
        "Cuando una tienda conecta su WhatsApp, su página de Facebook o su cuenta de Instagram, gestorIA recibe de Meta, y solo de las cuentas que la tienda elige: el nombre y el identificador de cada cuenta, una clave de acceso para leer y responder sus mensajes (se guarda cifrada y nunca se muestra) y los mensajes que llegan, con sus adjuntos y el identificador con que Meta nombra a quien escribe.",
        "gestorIA usa esos datos solo para mostrar las conversaciones en la app y enviar las respuestas de la tienda o de Sofi. No los usa para publicidad, no los vende y no los comparte, salvo con los proveedores que prestan el servicio. Las conversaciones son datos de la tienda.",
        `La tienda puede desconectar cada cuenta cuando quiera. Para que eliminemos los datos recibidos de Meta, escríbenos a ${CORREO} indicando la cuenta: los eliminamos dentro de los 30 días siguientes y te lo confirmamos por correo; si son conversaciones con clientes de una tienda, antes lo consultamos con ella.`,
      ],
    },
    {
      id: "seguridad",
      title: "Cómo los cuidamos",
      blocks: [
        {
          list: [
            "Cada tienda está separada en la base de datos: una tienda no ve los datos de otra.",
            "Cada persona ve lo que su rol le permite. Soporte solo entra a mirar con el sí del Dueño o de un Administrador, y por un tiempo corto.",
            "La bitácora de cada tienda registra quién hizo qué y cuándo.",
            "Las comunicaciones van cifradas, y las credenciales de Mercado Pago de cada tienda se guardan cifradas.",
            "Sofi no puede confirmar pagos ni vender por debajo del mínimo: la base de datos se lo impide.",
            "Copias de seguridad diarias.",
          ],
        },
        "Ningún sistema es invulnerable. Si un incidente de seguridad afecta tus datos, te lo comunicaremos conforme a la ley.",
      ],
    },
    {
      id: "derechos",
      title: "Tus derechos y cómo pedirlos",
      blocks: [
        "Puedes ejercer, gratis, los derechos de información, acceso, rectificación, cancelación (supresión) y oposición, y los demás que reconocen la Ley 29733 y su Reglamento, incluido revocar tu consentimiento.",
        `Escríbenos a ${CORREO} con tu nombre, el derecho que ejerces, lo que pides y cómo responderte. Podemos pedirte que acredites tu identidad o, si actúas por otra persona, tu representación.`,
        "Respondemos en los plazos del Reglamento (artículo 69), en días hábiles desde el día siguiente a tu pedido: 8 días para el derecho de información, 20 para el de acceso y 10 para los de rectificación, cancelación y oposición.",
        "Si crees que no atendimos bien tu pedido, puedes reclamar ante la Autoridad Nacional de Protección de Datos Personales (ANPD) del Ministerio de Justicia y Derechos Humanos.",
        "Si le compraste a una tienda que usa gestorIA, dirígete primero a esa tienda, que es la responsable de tus datos. Si nos escribes a nosotros, le pasamos tu pedido.",
      ],
    },
    {
      id: "banco",
      title: "Banco de datos",
      blocks: [
        "Los datos de los que gestorIA es responsable se guardan en el banco de datos del titular. Lo inscribiremos en el Registro Nacional de Protección de Datos Personales de la ANPD y publicaremos aquí su código de inscripción.",
      ],
    },
    {
      id: "clientes",
      title: "Los datos de los clientes de cada tienda",
      blocks: [
        "Cada tienda es la titular del banco de datos de sus clientes y la responsable de su tratamiento: decide qué datos guarda en gestorIA y para qué, informa a sus clientes y obtiene los consentimientos que pida la ley, en especial para enviarles promociones.",
        "Son el nombre, el teléfono, la dirección de entrega, los pedidos, los pagos con sus capturas, las conversaciones por los canales que la tienda conecta y la nota «Lo que sabemos» que escribe el equipo.",
        "gestorIA los trata como encargado, solo para prestar el servicio a la tienda y según sus instrucciones. Si la tienda deja gestorIA, puede pedirnos una copia de sus datos dentro de los 30 días siguientes; después los eliminamos, salvo lo que la ley obligue a conservar.",
        ENTRENAMIENTO,
        "Si la tienda vende fuera del Perú, se aplica además la ley de protección de datos de su país y la tienda es responsable de cumplirla.",
      ],
    },
    {
      id: "cambios",
      title: "Cambios en esta política",
      blocks: [
        "Podemos actualizar esta política. Publicaremos la nueva versión aquí, con su fecha, y si el cambio es importante te avisaremos por correo o dentro de la app.",
      ],
    },
  ],
}

export const TERMINOS: LegalDoc = {
  path: "/terminos",
  title: "Términos y condiciones",
  description:
    "Las condiciones para usar gestorIA y vender con Sofi y Argos: tu cuenta y tu equipo, lo que hacen los agentes, el plan, el uso aceptable, la responsabilidad y la ley aplicable.",
  intro:
    "Estas condiciones regulan el uso de gestorIA, una app en la nube para vender por WhatsApp, Instagram y Messenger con agentes de inteligencia artificial. Al crear una tienda o usar el servicio, la tienda las acepta. El servicio es para negocios: está dirigido a tiendas y a quienes venden, no a sus clientes.",
  since: LEGAL_VIGENTE,
  sections: [
    {
      id: "partes",
      title: "Partes",
      blocks: [
        `${RESPONSABLE} En estos términos, «gestorIA».`,
        "La otra parte es la persona natural con negocio o la empresa que crea la tienda (en adelante, «la Tienda»). Las personas que la Tienda invita a su equipo actúan por su cuenta.",
      ],
    },
    {
      id: "servicio",
      title: "Qué es gestorIA",
      blocks: [
        "Un software por suscripción para vender por chat: catálogo, inventario, pedidos, cobros, entregas, la ficha de cada cliente y dos agentes de inteligencia artificial, Sofi y Argos.",
        "gestorIA es una herramienta: no compra ni vende productos, no recibe el dinero de las ventas y no es parte de lo que la Tienda acuerda con sus clientes. La Tienda es la vendedora ante ellos. gestorIA no garantiza un nivel de ventas.",
      ],
    },
    {
      id: "cuenta",
      title: "Tu cuenta, tu tienda y tu equipo",
      blocks: [
        "Quien crea la tienda declara ser mayor de edad y tener facultades para obligarla, y entra con la cuenta de las apps del Grupo Sallca. Debe dar información veraz y mantenerla al día.",
        "Cada tienda tiene su equipo con tres roles: Dueño (todo, incluido el plan), Administrador (todo menos el plan) y Ventas (atiende, confirma pagos y entrega). La Tienda responde por lo que se hace desde sus cuentas, da a cada persona el rol que le toca y quita el acceso a quien deja de trabajar con ella.",
        "Las credenciales son personales. Avísanos apenas sospeches un acceso no autorizado.",
      ],
    },
    {
      id: "agentes",
      title: "Lo que hacen Sofi y Argos, y lo que decides tú",
      blocks: [
        "Sofi atiende a los clientes de la Tienda por los canales que conecta, con su catálogo, su stock y sus reglas. Estas reglas no las cambia nadie desde un chat:",
        {
          list: [
            "Sofi nunca vende por debajo del precio mínimo que la Tienda pone a cada producto. Un precio negociado vence a las 24 horas.",
            "Sofi nunca da por confirmado un pago: lo confirma una persona del equipo.",
            "Si Sofi no puede responder bien, la conversación pasa a una persona. La Tienda puede apagar a Sofi cuando quiera y sus conversaciones esperan a su equipo.",
          ],
        },
        "Argos ordena el día de la Tienda: le muestra sus números y lo que le toca, y le encarga a Sofi los seguimientos que la Tienda deja prendidos. Cada seguimiento se apaga por separado.",
        "La inteligencia artificial puede equivocarse o entender mal un mensaje. La Tienda debe revisar lo que hacen los agentes y corregir lo necesario; gestorIA no garantiza que cada respuesta sea exacta. La Tienda elige el nombre con que se presenta Sofi y no debe usarlo para hacer creer a un cliente que habla con una persona si lo pregunta.",
      ],
    },
    {
      id: "plan",
      title: "Plan y precio",
      blocks: [
        "El plan cuesta USD 19 al mes y ese monto vuelve como saldo. Del saldo sale el 1 % del total, con el envío, de cada venta completada: cuando el pedido está pagado y entregado a la clienta o despachado por agencia, venga del chat, del catálogo, de una campaña o lo anote el equipo. Si en un mes el 1 % pasa de USD 19, la Tienda paga la diferencia solo ese mes. Lo que se devuelve de un pedido se descuenta. No hay cobro por persona del equipo.",
        "Los precios no incluyen impuestos: se suman los que correspondan según el país de la Tienda (en el Perú, el IGV), y el comprobante se emite conforme a la ley.",
        "Las tarifas de terceros las cobra cada uno directamente a la Tienda: Meta por las plantillas de WhatsApp para iniciar conversaciones y Mercado Pago por cada cobro, según sus propias tarifas.",
        "gestorIA puede cambiar el precio avisando con al menos 30 días por correo y dentro de la app. El nuevo precio rige desde el periodo siguiente al aviso; si la Tienda no está de acuerdo, puede irse antes.",
      ],
    },
    {
      id: "pagos",
      title: "Pagos",
      blocks: [
        "El Dueño paga el plan desde «Plan y pagos»: sube el comprobante de su transferencia y gestorIA confirma el pago.",
        "Si un pago no llega, gestorIA avisa al Dueño. Mientras siga pendiente, puede detenerse Sofi; la app sigue funcionando y los datos de la Tienda no se borran. Al regularizar, Sofi vuelve.",
        "Salvo que la ley disponga otra cosa, lo pagado no es reembolsable, incluido el periodo ya empezado.",
      ],
    },
    {
      id: "obligaciones",
      title: "Lo que corresponde a la Tienda",
      blocks: [
        {
          list: [
            "Vender productos lícitos, con precios, stock y condiciones de entrega correctos, y cumplir lo que vende: entregar, emitir sus comprobantes y atender cambios y reclamos de sus clientes según la ley de protección al consumidor.",
            "Tratar los datos de sus clientes conforme a la ley y enviar promociones solo a quien dio su consentimiento.",
            "Usar cada canal conforme a las políticas de Meta y mantener vigentes sus cuentas, y usar Mercado Pago según sus condiciones.",
          ],
        },
      ],
    },
    {
      id: "uso",
      title: "Uso aceptable",
      blocks: [
        "No está permitido usar gestorIA para:",
        {
          list: [
            "Enviar mensajes masivos no solicitados (spam) o contenido engañoso, ilícito, ofensivo o discriminatorio.",
            "Vender productos prohibidos, falsificados o de origen ilícito.",
            "Intentar entrar a datos de otras tiendas, eludir la seguridad, probar vulnerabilidades sin permiso escrito o sobrecargar el servicio.",
            "Copiar, descompilar o revender el software, o usarlo para hacer un producto competidor.",
          ],
        },
        "Si gestorIA detecta un uso así, puede suspender la función afectada o la tienda, avisándole salvo que la urgencia o la ley lo impidan.",
      ],
    },
    {
      id: "propiedad",
      title: "Propiedad intelectual y datos",
      blocks: [
        "El software, la marca gestorIA, Sofi, Argos, los diseños y la documentación son del titular o de sus licenciantes. La suscripción da a la Tienda un derecho de uso no exclusivo, intransferible y limitado a su duración.",
        "Los datos y contenidos que la Tienda carga (catálogo, fotos, clientes, pedidos, conversaciones) son de la Tienda. gestorIA los usa solo para prestar el servicio, como encargado del tratamiento de los datos de sus clientes, según la [política de privacidad](/privacidad).",
      ],
    },
    {
      id: "disponibilidad",
      title: "Disponibilidad y soporte",
      blocks: [
        "gestorIA hace esfuerzos razonables para mantener el servicio disponible y avisa con anticipación de los mantenimientos que puedan interrumpirlo. Puede haber interrupciones por causas ajenas, como fallos de Meta, de Mercado Pago, del modelo de lenguaje o de la infraestructura. No se ofrece un nivel de servicio garantizado.",
        `El soporte se da dentro de la app, desde Ayuda, y por correo en ${CORREO}.`,
        "gestorIA puede mejorar o cambiar funciones. Si retira una función esencial, lo avisa con anticipación razonable.",
      ],
    },
    {
      id: "responsabilidad",
      title: "Responsabilidad",
      blocks: [
        "gestorIA responde por los daños que cause con dolo o culpa inexcusable, conforme a la ley peruana. Fuera de esos casos, y en la medida en que la ley lo permita:",
        {
          list: [
            "No responde por lo que la Tienda vende ni por sus acuerdos con sus clientes.",
            "No responde por respuestas de los agentes que la Tienda no revisó, ni por fallos de Meta, Mercado Pago o del modelo de lenguaje que no dependan de gestorIA.",
            "No responde por lucro cesante, ventas perdidas ni daños indirectos.",
            "Su responsabilidad total frente a la Tienda se limita a lo que la Tienda pagó en los doce meses anteriores al hecho.",
          ],
        },
      ],
    },
    {
      id: "duracion",
      title: "Duración y salida",
      blocks: [
        `El contrato es por tiempo indefinido y se renueva cada mes. La Tienda puede terminarlo cuando quiera desde Ayuda o escribiendo a ${CORREO}; rige al terminar el mes en curso y se cobra el 1 % de lo vendido hasta ese día.`,
        "gestorIA puede terminarlo por un incumplimiento grave de la Tienda o avisando con 30 días de anticipación.",
        "Durante el contrato y los 30 días siguientes, la Tienda puede pedirnos una copia de sus datos en formatos de uso común. Vencido ese plazo, los eliminamos, salvo lo que la ley obligue a conservar.",
      ],
    },
    {
      id: "cambios",
      title: "Cambios en estos términos",
      blocks: [
        "gestorIA puede cambiar estos términos. Los cambios importantes se avisan por correo y dentro de la app con al menos 30 días de anticipación. Si la Tienda sigue usando el servicio después, acepta los nuevos; si no está de acuerdo, puede irse antes.",
      ],
    },
    {
      id: "ley",
      title: "Ley aplicable",
      blocks: [
        "Estos términos se rigen por las leyes del Perú. Las partes buscarán resolver cualquier controversia de buena fe; si no lo logran, se someten a los jueces y tribunales de Lima.",
        "Si alguna cláusula fuera inválida, las demás siguen vigentes.",
      ],
    },
  ],
}

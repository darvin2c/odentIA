// Términos y condiciones del servicio (contrato entre odentIA y la clínica). Un solo contrato para
// sus dos marcas, odentIA y latidIA (issue 229, decisión 19): las dos webs muestran el mismo texto.
// Las cifras son las del plan de lista publicado y las condiciones comerciales (la administración),
// las mismas de la página Precios.
import { days, hours, money, type Pricing } from "../pricing"
import { contactEmail } from "../site"
import { type LegalDoc, TITULAR } from "./types"

/** Los términos con las cifras vigentes del plan de lista; sin plan publicado, remiten a la página Precios. */
export function terminosFor(pricing: Pricing): LegalDoc {
  const list = pricing.list
  /** Importe sin corte de línea entre la moneda y la cifra (para las celdas estrechas de la tabla). */
  const price = (v: number | null | undefined) =>
    list && v !== null && v !== undefined ? money(v, list.currency).replace(" ", " ") : "Según la página Precios"
  const PLAN = list?.plan
  const TIERS = list?.tiers
  const RECOVERED = list?.recovered
  const terms = pricing.terms
  return {
  path: "/terminos",
  title: "Términos y condiciones del servicio",
  description:
    "Condiciones de uso de odentIA y latidIA para clínicas dentales y consultorios médicos: cuenta, prueba gratuita, plan y cobro por acción, uso de los agentes de IA, datos, cancelación y ley aplicable.",
  intro: [
    "Estos términos regulan el uso de una plataforma en la nube para la gestión de clínicas y consultorios que incluye agentes de inteligencia artificial y se ofrece con dos marcas: odentIA, para clínicas dentales, y latidIA, para consultorios médicos. Al crear una cuenta o usar el servicio con cualquiera de las dos, la clínica acepta estos términos.",
    "El servicio se presta entre empresas: está dirigido a clínicas, consultorios y profesionales de la odontología y de la medicina, no a pacientes ni a consumidores finales.",
  ],
  sections: [
    {
      id: "partes",
      title: "Partes",
      blocks: [
        `El servicio lo presta ${TITULAR.razonSocial}, con RUC ${TITULAR.ruc} y domicilio en ${TITULAR.domicilio}, Perú (en adelante, «odentIA»), que ofrece el servicio con dos marcas: odentIA y latidIA.`,
        "La otra parte es la persona jurídica o el profesional independiente que crea la cuenta y contrata el servicio con cualquiera de las dos marcas (en adelante, «la Clínica», también cuando es un consultorio). Las personas que la Clínica invita a su cuenta (recepción, odontólogos o médicos, caja, administración) son «Usuarios» y actúan por cuenta de la Clínica.",
      ],
    },
    {
      id: "objeto",
      title: "Objeto del servicio",
      blocks: [
        "odentIA pone a disposición de la Clínica, mediante suscripción, un software para coordinar la atención de sus pacientes: agenda, historia clínica (con el odontograma en odentIA y el examen físico y los signos vitales en latidIA), presupuestos, caja, comunicaciones por varios canales, reportes y tres agentes de inteligencia artificial: Sofi (agente de recepción), Clío (agente clínico) y Argos (agente administrador).",
        "odentIA no presta servicios de salud, no diagnostica ni trata pacientes y no sustituye el criterio profesional del odontólogo ni del médico. La atención clínica es responsabilidad exclusiva de la Clínica y de sus profesionales.",
      ],
    },
    {
      id: "cuenta",
      title: "Cuenta y registro",
      blocks: [
        "Pueden contratar el servicio las clínicas dentales, los consultorios médicos y los profesionales de la odontología y de la medicina. Quien crea la cuenta declara ser mayor de edad y tener facultades suficientes para obligar a la Clínica.",
        "La Clínica debe proporcionar información veraz al registrarse y mantenerla actualizada. Es responsable de lo que se haga desde su cuenta, de asignar a cada Usuario el rol que corresponda a su función y de retirar el acceso a quien deje de trabajar con ella.",
        "Las credenciales son personales. La Clínica y sus Usuarios deben custodiarlas y avisar a odentIA en cuanto sospechen un acceso no autorizado.",
      ],
    },
    {
      id: "prueba",
      title: "Prueba gratuita",
      blocks: [
        list
          ? `La Clínica puede probar el servicio durante ${list.trialDays} días con un crédito de ${money(list.trialCredit, list.currency)} para los agentes, sin registrar una tarjeta.`
          : "La Clínica puede probar el servicio con el crédito de prueba que indica la página Precios, sin registrar una tarjeta.",
        "Si el crédito de prueba se agota antes de terminar el periodo, los agentes se pausan; el resto del sistema sigue disponible hasta el fin de la prueba. El crédito de prueba no es reembolsable, no se puede canjear por dinero y vence al terminar la prueba.",
        "Al terminar la prueba, la Clínica puede activar un plan para seguir usando el servicio. Si no lo hace, odentIA conserva sus datos durante el plazo indicado en la sección «Cancelación y exportación de datos».",
      ],
    },
    {
      id: "plan-y-cobro",
      title: "Plan y cobro por acción",
      blocks: [
        "El servicio se cobra con un plan mensual más un cobro por cada acción que realizan los agentes, según su tipo: lo que el agente deja hecho determina el precio. Los precios vigentes son los publicados en la página [Precios](/precios); a la fecha de esta versión son los siguientes:",
        {
          table: {
            caption:
              "Precios vigentes a la fecha de esta versión (en dólares estadounidenses, más impuestos)",
            head: ["Concepto", "Precio", "Cuándo se cobra"],
            rows: [
              [
                "Plan mensual",
                price(PLAN),
                "Cada mes, desde el día en que se activa el plan. El importe del plan vuelve a la Clínica como crédito para los agentes de ese mes.",
              ],
              [
                "Conversación de Sofi que informa",
                price(TIERS?.informa),
                `Una vez por persona cada ${hours(terms.conversationWindowHours)}, cuando Sofi responde, confirma o informa sin cambiar la agenda.`,
              ],
              [
                "Conversación de Sofi que gestiona una cita",
                price(TIERS?.gestiona),
                `En lugar de la anterior, cuando en esas ${hours(terms.conversationWindowHours)} Sofi reserva, mueve o cancela una cita.`,
              ],
              [
                "Cita que reservó Sofi y se dio",
                price(TIERS?.agenda),
                "Cuando el paciente asiste a la cita que reservó Sofi. Se cobra solo la diferencia con la conversación que la gestionó; si el paciente no asiste, no se cobra.",
              ],
              [
                "Consulta de Clío simple",
                price(TIERS?.simple),
                "Una vez por atención, cuando el profesional confirma un solo registro propuesto por Clío: una receta, una nota, un control o, en latidIA, los signos vitales.",
              ],
              [
                "Consulta de Clío estándar",
                price(TIERS?.estandar),
                "Una vez por atención, cuando el profesional confirma un diagnóstico, el odontograma (en latidIA, el examen físico) o dos registros o más.",
              ],
              [
                "Consulta de Clío completa",
                price(TIERS?.completa),
                "Una vez por atención, cuando el profesional confirma el presupuesto que armó Clío (en latidIA, lo que sigue que dejó indicado).",
              ],
              [
                "Cita recuperada",
                price(RECOVERED),
                `Cuando un paciente que no tenía cita ni tratamiento en curso reserva en los ${days(terms.recoveryWindowDays)} siguientes a un mensaje de Argos y asiste. Si no asiste, no se cobra; la conversación que llevó a ella va incluida.`,
              ],
              ...(list?.argos
                ? [
                    [
                      `Paquete de ${list.argos.packQuestions} preguntas a Argos`,
                      price(list.argos.pack),
                      `El plan incluye ${list.argos.included} preguntas al mes. Cada paquete adicional se suma solo con la autorización de la Clínica, o automáticamente si la Clínica lo activa. Vale hasta el cierre del mes; si se suma en los últimos 7 días del mes, hasta el cierre del siguiente.`,
                    ],
                  ]
                : []),
              ...(list?.storage
                ? [
                    [
                      "Almacenamiento adicional, por GB al mes",
                      price(list.storage.perGb),
                      `El plan incluye ${list.storage.includedGb} GB. Lo adicional se calcula con el promedio diario de lo almacenado en el periodo.`,
                    ],
                  ]
                : []),
            ],
          },
        },
        { h: "Qué no se cobra" },
        {
          list: [
            "Las propuestas de Clío que el profesional no confirma.",
            "Las citas recuperadas a las que el paciente no asiste.",
            "El spam, los mensajes ajenos a la Clínica y los recordatorios y avisos de cita.",
            "Lo que ocupa en la base de datos la información de la Clínica (fichas, citas, mensajes).",
            "Los mensajes que envían las personas del equipo de la Clínica sin intervención de un agente.",
            "El uso del resto del sistema (agenda, historia clínica, caja, reportes) dentro del plan.",
          ],
        },
        { h: "Crédito, presupuesto y facturación" },
        "Las acciones se descuentan primero del crédito del mes. Lo que exceda el crédito se factura como consumo variable, de forma mensual o quincenal según la modalidad elegida por la Clínica. El crédito no usado en un mes no se acumula para el siguiente.",
        "La Clínica puede fijar un presupuesto mensual y odentIA le avisa cuando el consumo se acerca a ese presupuesto. Al alcanzarlo, las conversaciones nuevas pasan al equipo de la Clínica con un mensaje fijo y el paciente siempre recibe respuesta; Clío no inicia la escucha en nuevas atenciones y Argos no inicia nuevas acciones de recuperación ni suma paquetes de preguntas, hasta que la Clínica amplíe el presupuesto o empiece un nuevo periodo. Lo que ya había empezado se termina y se cobra. El almacenamiento no cuenta para el presupuesto.",
        "El servicio es pospago: el plan, las acciones, los paquetes de preguntas y el almacenamiento adicional se pagan al cerrar el periodo, después de usarlos.",
        { h: "Impuestos y terceros" },
        "Los precios están expresados en dólares estadounidenses y no incluyen impuestos. Se añaden los impuestos que correspondan según la ley aplicable; en Perú, el Impuesto General a las Ventas (IGV). Los comprobantes se emiten conforme a la normativa tributaria peruana.",
        "Las plantillas de mensajes de WhatsApp que exige Meta para iniciar conversaciones las cobra Meta directamente a la Clínica, según sus propias tarifas. Esos importes no forman parte del precio de odentIA.",
        { h: "Cambios de precio" },
        "odentIA puede modificar los precios avisando a la Clínica con al menos 30 días de anticipación por correo electrónico y dentro de la aplicación. Los nuevos precios se aplican desde el siguiente periodo de facturación posterior al aviso. Si la Clínica no está de acuerdo, puede cancelar el servicio antes de que entren en vigor.",
      ],
    },
    {
      id: "pagos",
      title: "Pagos y suspensión por falta de pago",
      blocks: [
        "La Clínica paga el plan y el consumo variable de cada periodo por los medios que odentIA le indica en la aplicación, como la transferencia bancaria. odentIA no guarda datos de tarjetas.",
        `Si un pago no se puede cobrar, odentIA avisará a la Clínica y le dará un plazo de ${days(terms.graceDays)} para regularizarlo. Vencido ese plazo, odentIA puede suspender los agentes y, después, el acceso a la cuenta, salvo la exportación de datos. La suspensión no elimina los datos y el servicio se reactiva al regularizar el pago.`,
        "Salvo que la ley disponga otra cosa, los importes pagados no son reembolsables, incluidos los periodos ya iniciados.",
      ],
    },
    {
      id: "agentes",
      title: "Uso de los agentes de inteligencia artificial",
      blocks: [
        "Los agentes son asistentes que ayudan al equipo de la Clínica; no lo sustituyen. En particular:",
        {
          list: [
            "Sofi responde por los canales que la Clínica conecta (WhatsApp, Instagram, Messenger, Telegram, chat web y correo electrónico). Siempre se presenta como asistente virtual y deriva la conversación a una persona del equipo cuando corresponde o cuando el interlocutor lo pide.",
            "Clío propone notas, diagnósticos y planes de tratamiento a partir del dictado del profesional. Nada entra en la historia clínica sin la confirmación expresa del profesional, que es responsable de su contenido.",
            "Argos envía recordatorios, avisos de controles y seguimiento de presupuestos según lo que la Clínica configure.",
          ],
        },
        "La Clínica decide qué puede hacer cada agente y puede activar o desactivar cada capacidad en cualquier momento. odentIA elige el modelo de inteligencia artificial que usan los agentes y pone la cuenta.",
        "La inteligencia artificial puede equivocarse, entender mal un mensaje o dar una respuesta incompleta. La Clínica debe supervisar el trabajo de los agentes, revisar lo que proponen y corregir lo que sea necesario. odentIA no garantiza que las respuestas de los agentes sean exactas en todos los casos.",
        "La Clínica no debe usar los agentes para dar indicaciones clínicas a pacientes sin la intervención de un profesional, ni para atender urgencias médicas.",
      ],
    },
    {
      id: "obligaciones",
      title: "Obligaciones de la Clínica",
      blocks: [
        "La Clínica se obliga a:",
        {
          list: [
            "Cargar y tratar en el servicio solo datos obtenidos de forma lícita y contar con las autorizaciones o consentimientos de sus pacientes que exija la ley, incluidos los necesarios para tratar datos de salud y para enviar comunicaciones promocionales.",
            "Enviar promociones solo a los pacientes que hayan dado su consentimiento. Los mensajes de atención (citas, controles y presupuestos) forman parte del servicio que la Clínica presta a sus pacientes.",
            "Usar cada canal conectado conforme a las políticas de su proveedor (Meta para WhatsApp, Instagram y Messenger; Telegram; Google; Microsoft) y mantener vigentes las cuentas y autorizaciones necesarias.",
            "Mantener su historia clínica conforme a la normativa sanitaria aplicable. En Perú, la Clínica es la responsable de la historia clínica de sus pacientes según la Ley 30024 y la norma técnica de salud de historia clínica vigente.",
            "Cumplir la normativa de protección de datos aplicable a su actividad. Si la Clínica opera fuera de Perú, se aplica además la ley de protección de datos de su país y la Clínica es responsable de cumplirla.",
          ],
        },
      ],
    },
    {
      id: "uso-aceptable",
      title: "Uso aceptable",
      blocks: [
        "No está permitido usar el servicio para:",
        {
          list: [
            "Enviar mensajes no solicitados masivos (spam) o contenido engañoso, ilícito, ofensivo o discriminatorio.",
            "Suplantar a otra persona o presentar a un agente como si fuera una persona.",
            "Intentar acceder a datos de otras clínicas, eludir las medidas de seguridad, probar vulnerabilidades sin autorización escrita o sobrecargar el servicio.",
            "Copiar, descompilar o revender el software, o usarlo para desarrollar un producto competidor.",
            "Cualquier actividad contraria a la ley o a las políticas de los proveedores de canales.",
          ],
        },
        "Si odentIA detecta un uso contrario a esta sección, puede suspender la función afectada o la cuenta, avisando a la Clínica salvo que la urgencia o la ley lo impidan.",
      ],
    },
    {
      id: "propiedad-intelectual",
      title: "Propiedad intelectual",
      blocks: [
        "El software, las marcas odentIA y latidIA, los diseños y la documentación son propiedad de odentIA o de sus licenciantes. La suscripción concede a la Clínica un derecho de uso no exclusivo, intransferible y limitado a la duración del contrato.",
        "Los datos y contenidos que la Clínica carga en el servicio son de la Clínica (o de sus pacientes, según corresponda). odentIA solo los usa para prestar el servicio, conforme al [encargo de tratamiento](/encargo-de-tratamiento).",
        "Si la Clínica envía sugerencias de mejora, odentIA puede usarlas libremente sin obligación de compensación.",
      ],
    },
    {
      id: "datos",
      title: "Protección de datos",
      blocks: [
        "Sobre los datos de sus pacientes, la Clínica es la titular del banco de datos y la responsable del tratamiento; odentIA actúa como encargado del tratamiento. Las condiciones de ese encargo forman parte de estos términos y están en el [contrato de encargo de tratamiento](/encargo-de-tratamiento). Los proveedores que intervienen están en la página de [subencargados](/subencargados).",
        "Sobre los datos de los Usuarios y de los visitantes de la web, odentIA es responsable del tratamiento según su [política de privacidad](/privacidad).",
      ],
    },
    {
      id: "disponibilidad",
      title: "Disponibilidad y soporte",
      blocks: [
        "odentIA hará esfuerzos razonables para mantener el servicio disponible y avisará con anticipación de los mantenimientos programados que puedan interrumpirlo. Pueden producirse interrupciones por causas ajenas a odentIA, como fallos de proveedores de canales, de modelos de inteligencia artificial o de infraestructura.",
        "odentIA no ofrece un nivel de servicio garantizado ni compensaciones por indisponibilidad.",
        `El soporte se presta por correo electrónico en ${contactEmail} y dentro de la aplicación, de lunes a viernes de 9:00 a 18:00 (hora de Lima). Las consultas recibidas fuera de ese horario se atienden el siguiente día hábil.`,
        "odentIA puede mejorar o modificar funciones del servicio. Si retira una función esencial, lo avisará con antelación razonable.",
      ],
    },
    {
      id: "responsabilidad",
      title: "Limitación de responsabilidad",
      blocks: [
        "odentIA responde por los daños que cause por dolo o culpa inexcusable, de acuerdo con la ley peruana. Fuera de esos casos, y en la medida en que la ley lo permita:",
        {
          list: [
            "odentIA no responde por decisiones clínicas, diagnósticos o tratamientos, ni por el contenido que el profesional confirma en la historia clínica.",
            "odentIA no responde por las respuestas de los agentes que la Clínica no haya supervisado conforme a estos términos, ni por fallos de los proveedores de canales o de modelos de inteligencia artificial que no dependan de odentIA.",
            "odentIA no responde por lucro cesante, pérdida de oportunidades ni daños indirectos.",
            "La responsabilidad total de odentIA frente a la Clínica se limita al importe pagado por la Clínica en los doce meses anteriores al hecho que la origina.",
          ],
        },
        "Estas limitaciones no se aplican a las obligaciones de confidencialidad y seguridad de los datos cuando su incumplimiento se deba a dolo o culpa inexcusable de odentIA.",
      ],
    },
    {
      id: "cancelacion",
      title: "Duración, cancelación y exportación de datos",
      blocks: [
        "El contrato es de duración indefinida y se renueva cada mes. La Clínica puede cancelarlo en cualquier momento desde la aplicación; la cancelación surte efecto al terminar el periodo en curso y se factura el consumo variable producido hasta esa fecha.",
        "odentIA puede terminar el contrato por incumplimiento grave de la Clínica, por falta de pago no regularizada o avisando con 30 días de anticipación.",
        "Antes y después de cancelar, la Clínica puede exportar sus datos en formatos de uso común. odentIA conserva los datos durante 30 días después de terminar el contrato para permitir su exportación y luego los elimina, salvo que la ley obligue a conservarlos. La Clínica es responsable de conservar su historia clínica durante el plazo que exija la normativa sanitaria.",
      ],
    },
    {
      id: "cambios",
      title: "Cambios en estos términos",
      blocks: [
        "odentIA puede modificar estos términos. Los cambios relevantes se avisarán por correo electrónico y dentro de la aplicación con al menos 30 días de anticipación. Si la Clínica sigue usando el servicio después de esa fecha, acepta los nuevos términos; si no está de acuerdo, puede cancelar antes de que entren en vigor.",
      ],
    },
    {
      id: "ley",
      title: "Ley aplicable y jurisdicción",
      blocks: [
        "Estos términos se rigen por las leyes de la República del Perú. Las partes procurarán resolver cualquier controversia de buena fe. Si no lo consiguen, se someten a los jueces y tribunales del distrito judicial de Lima, Perú.",
        "Si alguna cláusula fuera declarada inválida, las demás seguirán vigentes.",
      ],
    },
    {
      id: "contacto",
      title: "Contacto",
      blocks: [
        `Para cualquier consulta sobre estos términos, escriba a [${contactEmail}](mailto:${contactEmail}).`,
      ],
    },
  ],
}
}

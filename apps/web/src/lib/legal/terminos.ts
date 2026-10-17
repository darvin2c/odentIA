// Términos y condiciones del servicio odentIA (contrato entre odentIA y la clínica).
// Las cifras salen de src/lib/pricing.ts para que nunca difieran de la página Precios.
import { CONSULTATION, CONVERSATION, PLAN, PRICING, RECOVERED, TRIAL_CREDIT, usd } from "../pricing"
import { contactEmail } from "../site"
import { type LegalDoc, TITULAR } from "./types"

/** Importe sin corte de línea entre «USD» y la cifra (para las celdas estrechas de la tabla). */
const price = (v: number) => usd(v).replace(" ", " ")

export const TERMINOS: LegalDoc = {
  path: "/terminos",
  title: "Términos y condiciones del servicio",
  description:
    "Condiciones de uso de odentIA para clínicas dentales: cuenta, prueba gratuita, plan y cobro por acción, uso de los agentes de IA, datos, cancelación y ley aplicable.",
  intro: [
    "Estos términos regulan el uso de odentIA, una plataforma en la nube para la gestión de clínicas dentales que incluye agentes de inteligencia artificial. Al crear una cuenta o usar el servicio, la clínica acepta estos términos.",
    "El servicio se presta entre empresas: está dirigido a clínicas y profesionales de la odontología, no a pacientes ni a consumidores finales.",
  ],
  sections: [
    {
      id: "partes",
      title: "Partes",
      blocks: [
        `El servicio lo presta ${TITULAR.razonSocial}, con RUC ${TITULAR.ruc} y domicilio en ${TITULAR.domicilio}, Perú (en adelante, «odentIA»).`,
        "La otra parte es la persona jurídica o el profesional independiente que crea la cuenta y contrata el servicio (en adelante, «la Clínica»). Las personas que la Clínica invita a su cuenta (recepción, odontólogos, caja, administración) son «Usuarios» y actúan por cuenta de la Clínica.",
      ],
    },
    {
      id: "objeto",
      title: "Objeto del servicio",
      blocks: [
        "odentIA pone a disposición de la Clínica, mediante suscripción, un software para coordinar la atención de sus pacientes: agenda, historia clínica y odontograma, presupuestos, caja, comunicaciones por varios canales, reportes y tres agentes de inteligencia artificial (Recepción, Asistente clínico y Administrador).",
        "odentIA no presta servicios de salud, no diagnostica ni trata pacientes y no sustituye el criterio profesional del odontólogo. La atención clínica es responsabilidad exclusiva de la Clínica y de sus profesionales.",
      ],
    },
    {
      id: "cuenta",
      title: "Cuenta y registro",
      blocks: [
        "Pueden contratar el servicio las clínicas dentales y los profesionales de la odontología. Quien crea la cuenta declara ser mayor de edad y tener facultades suficientes para obligar a la Clínica.",
        "La Clínica debe proporcionar información veraz al registrarse y mantenerla actualizada. Es responsable de lo que se haga desde su cuenta, de asignar a cada Usuario el rol que corresponda a su función y de retirar el acceso a quien deje de trabajar con ella.",
        "Las credenciales son personales. La Clínica y sus Usuarios deben custodiarlas y avisar a odentIA en cuanto sospechen un acceso no autorizado.",
      ],
    },
    {
      id: "prueba",
      title: "Prueba gratuita",
      blocks: [
        `La Clínica puede probar el servicio durante ${PRICING.trialDays} días con un crédito de ${usd(TRIAL_CREDIT)} para los agentes, sin registrar una tarjeta.`,
        "Si el crédito de prueba se agota antes de terminar el periodo, los agentes se pausan; el resto del sistema sigue disponible hasta el fin de la prueba. El crédito de prueba no es reembolsable, no se puede canjear por dinero y vence al terminar la prueba.",
        "Al terminar la prueba, la Clínica puede activar un plan para seguir usando el servicio. Si no lo hace, odentIA conserva sus datos durante el plazo indicado en la sección «Cancelación y exportación de datos».",
      ],
    },
    {
      id: "plan-y-cobro",
      title: "Plan y cobro por acción",
      blocks: [
        "El servicio se cobra con un plan mensual más un cobro por cada acción de valor que realizan los agentes. Los precios vigentes son los publicados en la página [Precios](/precios); a la fecha de esta versión son los siguientes:",
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
                "Conversación atendida",
                price(CONVERSATION),
                "Cuando el agente Recepción responde a una persona; incluye todo lo que le responda en las 24 horas siguientes.",
              ],
              [
                "Consulta documentada",
                price(CONSULTATION),
                "Cuando el odontólogo confirma la nota propuesta por el Asistente clínico.",
              ],
              [
                "Cita recuperada",
                price(RECOVERED),
                "Cuando un paciente recupera una cita gracias a un agente y asiste a ella. Si no asiste, no se cobra.",
              ],
            ],
          },
        },
        { h: "Qué no se cobra" },
        {
          list: [
            "Las propuestas del Asistente clínico que el odontólogo no confirma.",
            "Las citas recuperadas a las que el paciente no asiste.",
            "Los mensajes que envían las personas del equipo de la Clínica sin intervención de un agente.",
            "El uso del resto del sistema (agenda, historia clínica, caja, reportes) dentro del plan.",
          ],
        },
        { h: "Crédito, tope y facturación" },
        "Las acciones se descuentan primero del crédito del mes. Lo que exceda el crédito se factura como consumo variable, de forma mensual o quincenal según la modalidad elegida por la Clínica. El crédito no usado en un mes no se acumula para el siguiente.",
        "La Clínica puede fijar un tope de gasto y odentIA le avisa cuando el consumo se acerca a ese tope. Al alcanzarlo, los casos nuevos pasan al equipo de la Clínica y el paciente siempre recibe respuesta; los agentes no realizan nuevas acciones con cobro hasta que la Clínica amplíe el tope o empiece un nuevo periodo.",
        { h: "Impuestos y terceros" },
        "Los precios están expresados en dólares estadounidenses y no incluyen impuestos. Se añaden los impuestos que correspondan según la ley aplicable; en Perú, el Impuesto General a las Ventas (IGV). Los comprobantes se emiten conforme a la normativa tributaria peruana.",
        "Las plantillas de mensajes de WhatsApp que exige Meta para iniciar conversaciones las cobra Meta directamente a la Clínica, según sus propias tarifas. Esos importes no forman parte del precio de odentIA.",
        { h: "Cambios de precio" },
        "odentIA puede modificar los precios avisando a la Clínica con al menos [Por completar: días de aviso previo] días de anticipación por correo electrónico y dentro de la aplicación. Los nuevos precios se aplican desde el siguiente periodo de facturación posterior al aviso. Si la Clínica no está de acuerdo, puede cancelar el servicio antes de que entren en vigor.",
      ],
    },
    {
      id: "pagos",
      title: "Pagos y suspensión por falta de pago",
      blocks: [
        "La Clínica paga por los medios de pago que odentIA ofrece en la aplicación [Por completar: medios de pago aceptados]. Al registrar un medio de pago, autoriza los cargos del plan y del consumo variable en las fechas de facturación.",
        "Si un pago no se puede cobrar, odentIA avisará a la Clínica y le dará un plazo de [Por completar: días de gracia] días para regularizarlo. Vencido ese plazo, odentIA puede suspender los agentes y, después, el acceso a la cuenta, salvo la exportación de datos. La suspensión no elimina los datos y el servicio se reactiva al regularizar el pago.",
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
            "Recepción responde por los canales que la Clínica conecta (WhatsApp, Instagram, Messenger, Telegram, chat web y correo electrónico). Siempre se presenta como asistente virtual y deriva la conversación a una persona del equipo cuando corresponde o cuando el interlocutor lo pide.",
            "El Asistente clínico propone notas, diagnósticos y planes de tratamiento a partir del dictado del odontólogo. Nada entra en la historia clínica sin la confirmación expresa del odontólogo, que es responsable de su contenido.",
            "El Administrador envía recordatorios, avisos de controles y seguimiento de presupuestos según lo que la Clínica configure.",
          ],
        },
        "La Clínica decide qué puede hacer cada agente y puede activar o desactivar cada capacidad en cualquier momento. También elige el modelo de inteligencia artificial que usan los agentes entre los que odentIA ofrece.",
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
            "Cargar y tratar en odentIA solo datos obtenidos de forma lícita y contar con las autorizaciones o consentimientos de sus pacientes que exija la ley, incluidos los necesarios para tratar datos de salud y para enviar comunicaciones promocionales.",
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
        "No está permitido usar odentIA para:",
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
        "El software, la marca odentIA, los diseños y la documentación son propiedad de odentIA o de sus licenciantes. La suscripción concede a la Clínica un derecho de uso no exclusivo, intransferible y limitado a la duración del contrato.",
        "Los datos y contenidos que la Clínica carga en odentIA son de la Clínica (o de sus pacientes, según corresponda). odentIA solo los usa para prestar el servicio, conforme al [encargo de tratamiento](/encargo-de-tratamiento).",
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
        "Nivel de servicio: [Por completar: nivel de servicio si se ofrece].",
        `El soporte se presta por correo electrónico en ${contactEmail} y dentro de la aplicación [Por completar: horario y canales de soporte].`,
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
            "odentIA no responde por decisiones clínicas, diagnósticos o tratamientos, ni por el contenido que el odontólogo confirma en la historia clínica.",
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
        "odentIA puede terminar el contrato por incumplimiento grave de la Clínica, por falta de pago no regularizada o avisando con [Por completar: días de aviso para terminar sin causa] días de anticipación.",
        "Antes y después de cancelar, la Clínica puede exportar sus datos en formatos de uso común. odentIA conserva los datos durante [Por completar: plazo de conservación tras la cancelación] días después de terminar el contrato para permitir su exportación y luego los elimina, salvo que la ley obligue a conservarlos. La Clínica es responsable de conservar su historia clínica durante el plazo que exija la normativa sanitaria.",
      ],
    },
    {
      id: "cambios",
      title: "Cambios en estos términos",
      blocks: [
        "odentIA puede modificar estos términos. Los cambios relevantes se avisarán por correo electrónico y dentro de la aplicación con al menos [Por completar: días de aviso previo] días de anticipación. Si la Clínica sigue usando el servicio después de esa fecha, acepta los nuevos términos; si no está de acuerdo, puede cancelar antes de que entren en vigor.",
      ],
    },
    {
      id: "ley",
      title: "Ley aplicable y jurisdicción",
      blocks: [
        "Estos términos se rigen por las leyes de la República del Perú. Las partes procurarán resolver cualquier controversia de buena fe. Si no lo consiguen, se someten a los jueces y tribunales del distrito judicial de Lima, Perú [Por confirmar: jueces de Lima o arbitraje].",
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

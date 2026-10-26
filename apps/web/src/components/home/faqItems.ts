// Preguntas del inicio (sección 09). Los textos vienen del lienzo aprobado.
import type { FaqItem } from "../../lib/faq"
import { hours, type PlanPrices, type Terms } from "../../lib/pricing"

/**
 * Las preguntas con los días de prueba del plan que se muestra y las condiciones comerciales (no van fijos en el código).
 * `founder`: el plan que se muestra es el de Fundadores, sin cuota y por invitación, como en Precios.
 */
export const homeFaq = (plan: PlanPrices | null, terms: Terms, founder = false): (FaqItem & { pending?: boolean })[] => {
  const days = plan ? `${plan.trialDays} días` : "la prueba"
  return [
  {
    q: "¿Qué significa omnicanal y agéntica?",
    a: "Omnicanal: atiendes por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo, y todo queda en una sola ficha por persona. Agéntica: los agentes no solo conversan, también actúan. Agendan, mueven citas, preparan la nota, recuerdan y retoman presupuestos, siempre dentro de lo que tú les permites.",
  },
  {
    q: "¿Cuánto voy a pagar al mes?",
    // ADR 0085: también se suman los paquetes de preguntas a Argos y el espacio que pasa de lo incluido.
    a: `${
      founder
        ? "Como Fundador no pagas cuota: pagas lo que hacen tus agentes"
        : "La cuota del plan, que vuelve como crédito, más lo que tus agentes hagan por encima de ese crédito"
    }, los paquetes de preguntas a Argos que sumes y el espacio que pase de lo incluido. Lo calculas con tus números en la página de precios y puedes poner un presupuesto del mes: te avisamos antes de llegar.`,
  },
  {
    q: "¿Qué cuenta como una conversación?",
    a: `Todo lo que Sofi responde a una misma persona en ${hours(terms.conversationWindowHours)}, aunque sean muchos mensajes. Si el agente no llegó a responder, no cuenta. Si la conversación termina en una cita recuperada, se cobra solo la cita.`,
  },
  {
    q: "¿Qué inteligencia artificial usa?",
    a: "ChatGPT 6, de OpenAI, con la cuenta de odentIA. No necesitas una cuenta propia ni una clave.",
  },
  // Pendiente de confirmar: se muestra con su marcador y queda fuera de los datos estructurados.
  {
    q: "¿Usan los datos de mi clínica para entrenar la IA?",
    a: "[Por confirmar con el proveedor de IA y el abogado antes de publicar] No. Los datos de tu clínica se usan solo para atender a tus pacientes y no se usan para entrenar modelos de inteligencia artificial.",
    pending: true,
  },
  {
    q: "¿Y si el agente no sabe qué responder o se equivoca?",
    a: "Si no sabe, le dice a la persona que alguien de tu equipo la va a atender y te deja el caso con todo lo que se habló. Todo lo que hace queda registrado, así que si se equivoca lo ves y lo corriges. Y nada clínico entra a la historia sin el sí del odontólogo.",
  },
  {
    q: "¿Cómo encuentro rápido a un paciente?",
    a: "Con Ctrl K (⌘K en Mac) desde cualquier pantalla, o con la lupa en el teléfono. Escribe parte del nombre sin preocuparte por las tildes, el teléfono, el DNI o el número de historia, y aparece la persona con su próxima cita, su última conversación, lo que debe y el presupuesto por aceptar. Las citas, los mensajes, la historia clínica, los presupuestos y los pagos también se encuentran por lo que dicen, cada uno debajo de su persona y según lo que tu rol puede ver. Los documentos e imágenes se encuentran por su nombre.",
  },
  {
    q: "¿Tengo que pagarle algo más a WhatsApp?",
    a: "WhatsApp lo cobra Meta directamente a tu clínica, con sus propias tarifas, y lo revisas en tu cuenta de Meta. odentIA no lo cobra ni lo estima.",
  },
  {
    q: "¿Funciona en mi país?",
    a: "odentIA está hecho para clínicas de habla hispana. La moneda, la zona horaria y los documentos se configuran por clínica.",
  },
  {
    q: "¿Qué pasa cuando termina la prueba?",
    a: "Activas el plan y sigues donde estabas. Si el crédito de la prueba se termina antes de terminar la prueba, te avisamos con tiempo y los agentes se pausan hasta que actives el plan.",
  },
  {
    q: "¿La prueba pide tarjeta?",
    a: founder
      ? "No. Pides tu invitación, abres tu clínica y tus agentes empiezan con el crédito de regalo. La tarjeta no se pide."
      : `No. Te registras, conectas tus canales y tus agentes trabajan ${days} con el crédito de prueba. La tarjeta solo se pide si decides activar el plan.`,
  },
]
}

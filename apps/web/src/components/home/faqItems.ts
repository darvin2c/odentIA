// Preguntas del inicio (sección 09). Los textos vienen del lienzo aprobado.
import type { FaqItem } from "../../lib/faq"
import { offerOf, trialFaq } from "../../lib/offer"
import { hours, type Pricing } from "../../lib/pricing"

/**
 * Las preguntas con la oferta del plan que se muestra y las condiciones comerciales (no van fijos en el código).
 * Con Fundadores, el plan es sin cuota y por invitación, como en Precios; la prueba la cuenta `trialFaq`, igual en las tres webs.
 */
export const homeFaq = (pricing: Pricing): (FaqItem & { pending?: boolean })[] => {
  const { founder } = offerOf(pricing)
  const terms = pricing.terms
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
    a: "No. Los datos de tu clínica se usan solo para atender a tus pacientes. odentIA no los usa para entrenar modelos, y los proveedores de inteligencia artificial que usa por API tampoco: OpenAI, el de ChatGPT, y TypeSafe AI, cuyo modelo entiende qué pide cada mensaje.",
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
    q: "¿Puedo traer a mis pacientes?",
    a: "Sí. Nos envías tu Excel o lo que exporta tu sistema, tal como lo tienes, y nuestro equipo carga a tus pacientes por ti; lo dudoso lo revisamos contigo antes de cargarlo. Las citas, los saldos y la historia anterior todavía no se cargan. Desde ahí, lo que escriban por cualquier canal cae en su ficha, y los nuevos se registran solos con el código QR o el enlace de registro de tu clínica.",
  },
  {
    q: "¿Puedo usar odentIA desde el celular?",
    a: "Sí. Se abre en el navegador del teléfono, con las mismas pantallas adaptadas. Si quieres, instalas tu clínica como una app con su ícono, sin tienda, y te avisa, en tu horario de atención, cuando alguien queda esperándote o Sofi te pasa a alguien, aunque la tengas cerrada. El aviso no dice el nombre de la persona ni lo que escribió: eso se ve al abrirlo.",
  },
  {
    q: "¿Mi equipo necesita capacitación?",
    a: "Inicio le dice a cada persona qué le toca hoy, en una sola lista: «Te espera». A quien atiende le muestra también su sala de espera: quién llegó y cuánto lleva esperando. Y en todas las pantallas está «Ayuda»: escribes con tus palabras qué quieres hacer, responde con la guía del sistema y «Llévame» te deja en la pantalla.",
  },
  {
    q: "¿Tengo que pagarle algo más a WhatsApp?",
    a: "WhatsApp lo cobra Meta directamente a tu clínica, con sus propias tarifas, y lo revisas en tu cuenta de Meta. odentIA no lo cobra ni lo estima.",
  },
  {
    q: "¿Funciona en mi país?",
    a: "odentIA está hecho para clínicas de habla hispana. La moneda, la zona horaria y los documentos se configuran por clínica.",
  },
  ...trialFaq(pricing, "clínica"),
]
}

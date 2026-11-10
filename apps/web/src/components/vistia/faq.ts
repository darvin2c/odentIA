// Las preguntas del inicio de vistIA. Las usa la página y sus datos estructurados (FAQPage en
// index.astro). El regalo sale del plan que se muestra, nunca del código.
import type { FaqItem } from "../../lib/faq"

export function homeFaq(gift: string | null): FaqItem[] {
  return [
    {
      q: "¿Sirve para una óptica que solo vende?",
      a: "Sí. La agenda, las conversaciones con Sofi, la caja y el inventario sirven igual. La historia clínica la usas cuando examinas.",
    },
    {
      q: "¿Qué hacen los agentes?",
      a: "Sofi responde por WhatsApp y tus demás canales, informa tus servicios y precios y agenda con el sí de la persona. Argos recuerda las citas, ofrece otro horario a quien faltó, invita al control y responde lo que le preguntes de tu óptica.",
    },
    {
      q: "¿Hay un agente que escuche el examen?",
      a: "No. En vistIA no trabaja Clío, el agente que escucha la consulta: en una óptica la medida de la vista la escribe quien examina, porque un número mal oído son unos lentes mal hechos.",
    },
    {
      q: "¿Sofi ve la historia clínica?",
      a: "No. Responde y agenda con lo que tu óptica le enseña: servicios, precios, horarios y medios de pago. La historia la ve quien examina, según los permisos de cada rol.",
    },
    {
      q: "¿Cómo se cobra?",
      a: `Por lo que hacen tus agentes, no por el software ni por usuario. Lo simple cuesta poco y lo que te trae clientes cuesta más.${gift ? ` Los primeros ${gift} van por nuestra cuenta.` : ""}`,
    },
    {
      q: "¿Cómo encuentro rápido a un cliente?",
      a: "Con Ctrl K (⌘K en Mac) desde cualquier pantalla, o con la lupa en el teléfono. Escribe parte del nombre sin preocuparte por las tildes, el teléfono, el documento o el número de historia, y aparece la persona con su próxima cita, su última conversación y lo que debe.",
    },
    {
      q: "¿Puedo traer a mis clientes?",
      a: "Sí. Los registras con sus datos y, desde ese momento, lo que escriban por cualquier canal cae en su ficha. También se registran solos con el código QR o el enlace de registro, desde su celular.",
    },
    {
      q: "¿Sirve en mi país?",
      a: "Está hecho para ópticas de habla hispana. La moneda y la zona horaria se ajustan a tu país, y los diagnósticos usan CIE-10 o CIE-11.",
    },
  ]
}

// Las preguntas del inicio de vistIA. Las usa la página y sus datos estructurados (FAQPage en
// index.astro). El regalo sale del plan que se muestra, nunca del código.
import type { FaqItem } from "../../lib/faq"

export function homeFaq(gift: string | null): FaqItem[] {
  return [
    {
      q: "¿Sirve para una óptica que solo vende?",
      a: "Sí. La agenda, las conversaciones con Sofi, la caja, el inventario y los pedidos de lentes sirven igual: transcribes la receta que trae tu cliente y vendes con ella. El examen de la vista lo usas cuando examinas.",
    },
    {
      q: "¿Qué hacen los agentes?",
      a: "Sofi responde por WhatsApp y tus demás canales, informa tus servicios y precios, agenda con el sí de la persona y le dice cómo va su pedido de lentes. Argos recuerda las citas, ofrece otro horario a quien faltó, invita al control y responde lo que le preguntes de tu óptica.",
    },
    {
      q: "¿Lleva los pedidos de lentes al laboratorio?",
      a: "Sí. Vendes con «Vender lentes», con la receta, la montura y el adelanto, y cada pedido dice en qué paso está: por enviar, en laboratorio, por revisar, listo o entregado. Al marcarlo listo, tu cliente recibe «Tus lentes ya están listos para recoger».",
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
      a: "Sí. Los registras con sus datos y, desde ese momento, lo que escriban por cualquier canal cae en su ficha. También se registran solos con el código QR o el enlace de registro, desde su celular, y tú eliges qué datos se les piden.",
    },
    {
      q: "¿Hay aplicación para el celular?",
      a: "Se abre en el navegador del teléfono, con las mismas pantallas adaptadas. Y puedes instalar tu óptica como una app con su ícono, sin tienda de aplicaciones. Instalada, te avisa en tu horario de atención cuando alguien queda esperándote o un agente te pasa a alguien, aunque la tengas cerrada.",
    },
    {
      q: "¿Puedo ponerle mi logo y el color de mi marca?",
      a: "Sí. Subes tu logo y eliges el color de tu marca. Lo ve tu equipo en la aplicación y tus clientes en la página de sus citas, en la reserva y en el chat de tu web.",
    },
    {
      q: "¿Y si no sé cómo hacer algo?",
      a: "Dentro de la aplicación está Ayuda, en todas las pantallas. Le preguntas con tus palabras a Ariadna, la guía virtual, y te dice dónde está cada cosa y te lleva con «Llévame». Lo que no sabe, te ofrece enviárselo a nuestro equipo.",
    },
    {
      q: "¿Sirve en mi país?",
      a: "Está hecho para ópticas de habla hispana. La moneda y la zona horaria se ajustan a tu país, y los diagnósticos usan CIE-10 o CIE-11.",
    },
  ]
}

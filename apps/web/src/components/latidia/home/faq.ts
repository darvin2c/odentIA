// Las preguntas del inicio de latidIA (lienzo «Inicio», sección 9). Las usa la página y sus datos
// estructurados (FAQPage en index.astro). El regalo sale del plan que se muestra, nunca del código.
import type { FaqItem } from "../../../lib/faq"

export function homeFaq(gift: string | null): FaqItem[] {
  return [
    {
      q: "¿Para qué especialidades sirve?",
      a: "Para medicina general, medicina familiar, medicina interna, pediatría y ginecología y obstetricia. Tu consultorio empieza con sus servicios y un tarifario que ajustas a tus precios.",
    },
    {
      q: "¿Tengo que dictar?",
      a: "No. Puedes escribir la consulta como siempre. Dictar es una vía más: Clío ordena lo que dices y tú confirmas cada cosa.",
    },
    {
      q: "¿Y si Clío se equivoca?",
      a: "Lo corriges por voz («No, la temperatura es 38,4») o con Editar. Nada entra a la historia hasta que confirmas, y la receta y el descanso solo se emiten con tu firma.",
    },
    {
      q: "¿Sofi atiende urgencias?",
      a: "No las atiende: las reconoce. Ante una señal de alarma, como una embarazada con sangrado o el peor dolor de cabeza de su vida, da el número de emergencias de tu país y el teléfono del consultorio, y avisa a tu equipo.",
    },
    {
      q: "¿Sofi ve la historia clínica?",
      a: "No. Responde y agenda con lo que el consultorio le enseña. La historia la ven los médicos, según los permisos de cada rol.",
    },
    {
      q: "¿Cómo se cobra?",
      a: `Por lo que hacen tus agentes, no por el software ni por usuario. Lo simple cuesta poco y lo que te trae pacientes cuesta más.${gift ? ` Los primeros ${gift} van por nuestra cuenta.` : ""}`,
    },
    {
      q: "¿Cómo encuentro rápido a un paciente?",
      a: "Con Ctrl K (⌘K en Mac) desde cualquier pantalla, o con la lupa en el teléfono. Escribe parte del nombre sin preocuparte por las tildes, el teléfono, el DNI o el número de historia, y aparece la persona con su próxima cita, su última conversación y lo que debe. Las recetas, los diagnósticos, los mensajes y los cobros también se encuentran por lo que dicen, cada uno debajo de su persona y según lo que tu rol puede ver. Los documentos e imágenes se encuentran por su nombre.",
    },
    {
      q: "¿Puedo traer a mis pacientes?",
      a: "Sí. Los registras con sus datos y, desde ese momento, lo que escriban por cualquier canal cae en su ficha. También se registran solos con el código QR o el enlace de registro, desde su celular.",
    },
    {
      q: "¿Sirve en mi país?",
      a: "Está hecho para consultorios de habla hispana. La moneda, la zona horaria y el número de emergencias se ajustan a tu país (106 en Perú, 911 en México, 123 en Colombia), y los diagnósticos usan CIE-10 o CIE-11.",
    },
  ]
}

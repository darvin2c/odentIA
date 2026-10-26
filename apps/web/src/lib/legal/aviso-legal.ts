// Aviso legal de la web: titular, objeto, propiedad intelectual, enlaces, ejemplos y ley aplicable.
import { contactEmail } from "../site"
import { type LegalDoc, TITULAR } from "./types"

export const AVISO_LEGAL: LegalDoc = {
  path: "/aviso-legal",
  title: "Aviso legal",
  description:
    "Titular de las webs de odentIA y latidIA, condiciones de uso del sitio, propiedad intelectual, enlaces, ejemplos y ley aplicable.",
  intro: [
    "Este aviso regula el acceso y el uso de las webs de odentIA y de latidIA, las dos marcas del mismo servicio. Al navegar por ella, usted acepta estas condiciones.",
  ],
  sections: [
    {
      id: "titular",
      title: "Titular de la web",
      blocks: [
        {
          table: {
            caption: "Datos del titular",
            head: ["Dato", "Valor"],
            rows: [
              ["Razón social", TITULAR.razonSocial],
              ["RUC", TITULAR.ruc],
              ["Domicilio fiscal", `${TITULAR.domicilio}, Perú`],
              ["Correo de contacto", `[${contactEmail}](mailto:${contactEmail})`],
              ["Correo de privacidad", TITULAR.correoPrivacidad],
            ],
          },
        },
      ],
    },
    {
      id: "objeto",
      title: "Objeto de la web",
      blocks: [
        "Esta web informa sobre una plataforma con agentes de inteligencia artificial que se ofrece con dos marcas, odentIA para clínicas dentales y latidIA para consultorios médicos, y permite registrarse para probarla. La contratación del servicio se rige por los [términos y condiciones](/terminos).",
        "La información de la web es general y puede cambiar. Los precios vigentes son los publicados en la página [Precios](/precios).",
      ],
    },
    {
      id: "propiedad-intelectual",
      title: "Propiedad intelectual e industrial",
      blocks: [
        "Los textos, diseños, imágenes, logotipos, código y demás contenidos de esta web, así como las marcas odentIA, Odentia32, latidIA y Latidia72, son propiedad del titular o de terceros que han autorizado su uso.",
        "No se permite reproducir, distribuir, transformar ni comunicar públicamente esos contenidos sin autorización escrita del titular, salvo para uso personal y no comercial o cuando la ley lo permita.",
        "Las marcas de terceros que aparecen en la web (por ejemplo, WhatsApp, Instagram, Messenger, Telegram o ChatGPT) pertenecen a sus respectivos titulares y se mencionan solo para describir integraciones o compatibilidades.",
      ],
    },
    {
      id: "enlaces",
      title: "Enlaces",
      blocks: [
        "La web puede contener enlaces a sitios de terceros. El titular no controla esos sitios ni responde por su contenido, sus condiciones o su política de privacidad.",
        "Quien quiera enlazar a esta web puede hacerlo siempre que no sugiera una relación inexistente con odentIA ni presente sus contenidos de forma engañosa.",
      ],
    },
    {
      id: "ejemplos",
      title: "Ejemplos y resultados",
      blocks: [
        "Los ejemplos de esta web, como conversaciones, pacientes, clínicas, cifras y cálculos, usan datos inventados para ilustrar cómo funciona el servicio. No corresponden a personas reales y no son promesas de resultados: lo que obtenga cada clínica depende de su actividad, de sus pacientes y de cómo configure el servicio.",
      ],
    },
    {
      id: "responsabilidad",
      title: "Responsabilidad sobre el uso de la web",
      blocks: [
        "El titular procura que la web esté disponible y que su información sea correcta, pero no garantiza la ausencia de interrupciones o errores. No responde por los daños derivados del uso de la web, salvo en los casos en que la ley no permita excluir esa responsabilidad.",
        "El tratamiento de los datos de quienes visitan la web se explica en la [política de privacidad](/privacidad) y en la [política de cookies](/cookies).",
      ],
    },
    {
      id: "ley",
      title: "Ley aplicable y jurisdicción",
      blocks: [
        "Este aviso se rige por las leyes de la República del Perú. Cualquier controversia se somete a los jueces y tribunales del distrito judicial de Lima, Perú.",
      ],
    },
  ],
}

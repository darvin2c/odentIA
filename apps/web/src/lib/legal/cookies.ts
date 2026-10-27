// Política de cookies: la web no usa cookies; la aplicación usa solo las necesarias y almacenamiento local.
import { contactEmail } from "../site"
import type { LegalDoc } from "./types"

export const COOKIES: LegalDoc = {
  path: "/cookies",
  title: "Política de cookies",
  description:
    "Las webs de odentIA y latidIA no usan cookies. La aplicación usa solo cookies necesarias para la sesión, una que recuerda el menú lateral y almacenamiento local para preferencias y borradores.",
  intro: [
    "Las cookies son pequeños archivos que un sitio web guarda en su navegador. El almacenamiento local es un espacio similar del navegador que una aplicación usa para recordar información en su dispositivo.",
  ],
  sections: [
    {
      id: "web",
      title: "Las webs de odentIA y latidIA",
      blocks: [
        "Esta web no instala cookies ni carga herramientas de analítica, publicidad, redes sociales o tipografías de terceros. Para conocer el tráfico de forma agregada, usamos los registros de nuestro propio servidor, como se explica en la [política de privacidad](/privacidad).",
        "Por eso no le pedimos que acepte cookies al visitar la web.",
      ],
    },
    {
      id: "aplicacion",
      title: "La aplicación",
      blocks: [
        "La aplicación que usan las clínicas y los consultorios usa cookies estrictamente necesarias para iniciar y mantener la sesión, una cookie que recuerda si el menú lateral está abierto, y el almacenamiento local del navegador para recordar preferencias y conservar borradores. No usa cookies de analítica ni de publicidad.",
        "Como sirven para que el servicio funcione o para recordar lo que el propio usuario eligió, no requieren consentimiento. Si bloquea las de sesión, no podrá iniciar sesión.",
        {
          table: {
            caption: "Cookies y almacenamiento local de la aplicación",
            head: ["Tipo", "Para qué sirve", "Duración"],
            rows: [
              [
                "Cookie de sesión",
                "Mantener iniciada la sesión del usuario de forma segura.",
                "7 días; se renueva mientras el usuario usa la aplicación y se borra al cerrar sesión.",
              ],
              [
                "Cookie del segundo paso de verificación",
                "Recordar, mientras se inicia sesión, que falta el código del segundo paso.",
                "10 minutos.",
              ],
              [
                "Cookies del inicio de sesión con Google",
                "Comprobar, mientras se entra con Google, que la respuesta de Google corresponde a ese intento.",
                "Unos minutos; se borran al terminar de entrar.",
              ],
              [
                "Cookie del menú lateral",
                "Recordar si el usuario dejó el menú lateral abierto o cerrado.",
                "7 días.",
              ],
              [
                "Cookie del equipo reconocido (solo la administración de odentIA)",
                "Recordar que el personal de odentIA ya confirmó su segundo paso en ese equipo.",
                "30 días sin usarlo.",
              ],
              [
                "Almacenamiento local: preferencias",
                "Recordar elecciones de la interfaz, como la sede o la vista elegida.",
                "Hasta que el usuario lo borre.",
              ],
              [
                "Almacenamiento local: borradores",
                "Conservar lo que el usuario está escribiendo para que no lo pierda si cierra la página.",
                "Hasta que el usuario envíe o descarte el borrador, o lo borre.",
              ],
            ],
          },
        },
      ],
    },
    {
      id: "borrar",
      title: "Cómo borrarlas",
      blocks: [
        "Puede borrar las cookies y el almacenamiento local desde la configuración de su navegador, normalmente en el apartado de privacidad o de datos de sitios. Al hacerlo se cerrará su sesión en la aplicación y se perderán los borradores que no haya enviado.",
        "Cerrar sesión desde la aplicación elimina la cookie de sesión.",
      ],
    },
    {
      id: "cambios",
      title: "Cambios y contacto",
      blocks: [
        "Si en el futuro usamos otras cookies, actualizaremos esta política y, cuando la ley lo exija, le pediremos su consentimiento antes de instalarlas.",
        `Para cualquier duda, escriba a [${contactEmail}](mailto:${contactEmail}).`,
      ],
    },
  ],
}

// Política de privacidad: odentIA como responsable (visitantes de la web y usuarios de la cuenta) y
// como encargado de la clínica (datos de pacientes). Marco: Ley 29733 y su Reglamento (D.S. 016-2024-JUS).
import { contactEmail } from "../site"
import { type LegalDoc, TITULAR } from "./types"

const ENTRENAMIENTO =
  "odentIA no usa los datos de las clínicas ni de sus pacientes para entrenar modelos propios. Los proveedores de inteligencia artificial tratan los datos que reciben según sus condiciones de uso de API [Por confirmar con el proveedor de IA y el abogado: si los proveedores usan o no los datos para entrenar]."

export const PRIVACIDAD: LegalDoc = {
  path: "/privacidad",
  title: "Política de privacidad",
  description:
    "Cómo trata odentIA los datos personales de los visitantes de su web, de los usuarios de las clínicas y, por encargo de cada clínica, de sus pacientes. Derechos y cómo ejercerlos.",
  intro: [
    "Esta política explica qué datos personales trata odentIA, para qué, durante cuánto tiempo, con quién los comparte y cómo puede ejercer sus derechos. Se aplica conforme a la Ley N.º 29733, Ley de Protección de Datos Personales, y su Reglamento, aprobado por Decreto Supremo N.º 016-2024-JUS.",
    "odentIA trata datos en dos papeles distintos, que esta política diferencia en todo momento.",
  ],
  sections: [
    {
      id: "titular",
      title: "Quién es el responsable",
      blocks: [
        `${TITULAR.razonSocial}, con RUC ${TITULAR.ruc} y domicilio en ${TITULAR.domicilio}, Perú («odentIA»), que ofrece el servicio con dos marcas: odentIA y latidIA. Esta política se aplica a las dos.`,
        `Contacto para asuntos de privacidad: ${TITULAR.correoPrivacidad}. Para consultas generales: [${contactEmail}](mailto:${contactEmail}).`,
      ],
    },
    {
      id: "dos-papeles",
      title: "Los dos papeles de odentIA",
      blocks: [
        {
          table: {
            caption: "Papel de odentIA según el tipo de dato",
            head: ["Datos", "Quién es responsable", "Papel de odentIA"],
            rows: [
              [
                "Visitantes de la web y personas que nos escriben",
                "odentIA",
                "Responsable del tratamiento y titular del banco de datos.",
              ],
              [
                "Usuarios de la cuenta de una clínica (recepción, odontólogos o médicos, caja, administración) y datos de facturación de la clínica",
                "odentIA",
                "Responsable del tratamiento y titular del banco de datos.",
              ],
              [
                "Pacientes de la clínica y personas que escriben a la clínica por sus canales",
                "La clínica",
                "Encargado del tratamiento: trata los datos solo por cuenta y según las instrucciones de la clínica.",
              ],
            ],
          },
        },
        "Las secciones 3 a 9 se refieren a los datos de los que odentIA es responsable. La sección 10 explica el tratamiento de los datos de pacientes.",
      ],
    },
    {
      id: "datos",
      title: "Qué datos tratamos",
      blocks: [
        { h: "Visitantes de la web" },
        "La web de odentIA no usa cookies ni herramientas de analítica de terceros. El servidor registra datos técnicos de cada visita (dirección IP, fecha y hora, página solicitada, navegador) para mantener la web segura y medir el tráfico de forma agregada.",
        "Si nos escribe, tratamos los datos que nos envíe: nombre, correo electrónico, teléfono, clínica y el contenido del mensaje.",
        { h: "Usuarios de la cuenta" },
        {
          list: [
            "Datos de identificación y contacto: nombre, correo electrónico, teléfono y rol en la clínica.",
            "Datos de acceso: credenciales (la contraseña se guarda cifrada de forma irreversible) y sesiones.",
            "Registro de actividad: qué acciones realiza cada usuario en la cuenta, con fecha y hora.",
            "Datos de la clínica para facturar: razón social, número de contribuyente, domicilio y medio de pago [Por completar: proveedor de pagos y qué datos de la tarjeta recibe odentIA].",
          ],
        },
      ],
    },
    {
      id: "finalidades",
      title: "Para qué los usamos y con qué base",
      blocks: [
        {
          table: {
            caption: "Finalidades y bases de legitimación",
            head: ["Finalidad", "Base de legitimación"],
            rows: [
              [
                "Prestar el servicio contratado: crear la cuenta, permitir el acceso, aplicar los permisos de cada rol y dar soporte.",
                "Ejecución del contrato con la clínica.",
              ],
              [
                "Facturar y cobrar el servicio.",
                "Ejecución del contrato y obligaciones tributarias.",
              ],
              [
                "Mantener la seguridad: registros del servidor y de actividad, prevención de fraude y de accesos no autorizados.",
                "Interés legítimo de odentIA y obligación de adoptar medidas de seguridad.",
              ],
              [
                "Responder consultas recibidas por la web o por correo.",
                "Consentimiento de quien nos escribe.",
              ],
              [
                "Enviar avisos del servicio: cambios de precio o de términos, incidencias, facturación.",
                "Ejecución del contrato.",
              ],
              [
                "Enviar novedades comerciales de odentIA.",
                "Consentimiento, que puede retirarse en cualquier momento.",
              ],
            ],
          },
        },
        "No tomamos decisiones con efectos jurídicos sobre las personas basadas únicamente en un tratamiento automatizado de sus datos.",
      ],
    },
    {
      id: "conservacion",
      title: "Cuánto tiempo los conservamos",
      blocks: [
        {
          list: [
            "Datos de usuarios: mientras la cuenta esté activa y, después de cancelarla, durante [Por completar: plazo de conservación tras la cancelación] días para permitir la exportación.",
            "Registros del servidor: [Por completar: plazo de conservación de registros del servidor].",
            "Registro de actividad de la cuenta: [Por completar: plazo de conservación del registro de actividad].",
            "Datos de facturación: el plazo que exija la normativa tributaria.",
            "Consultas recibidas: el tiempo necesario para atenderlas y hasta [Por completar: plazo] después.",
          ],
        },
        "Vencidos esos plazos, los datos se eliminan o se anonimizan.",
      ],
    },
    {
      id: "destinatarios",
      title: "Con quién los compartimos y flujo transfronterizo",
      blocks: [
        "No vendemos datos personales. Los compartimos solo con proveedores que nos ayudan a prestar el servicio (alojamiento, almacenamiento, correo, modelos de inteligencia artificial, transcripción de audios y sugerencia de direcciones) y con las autoridades cuando la ley lo exige. La lista de proveedores, lo que hace cada uno y su país está en la página de [subencargados](/subencargados).",
        "Varios de esos proveedores están fuera del Perú, por ejemplo en los Estados Unidos. Esos envíos constituyen flujo transfronterizo de datos personales. odentIA los realiza con proveedores que ofrecen niveles de protección adecuados o garantías contractuales suficientes, conforme a la Ley 29733 y su Reglamento [Por confirmar: garantías contractuales con cada proveedor y comunicación a la ANPD si corresponde].",
        ENTRENAMIENTO,
      ],
    },
    {
      id: "seguridad",
      title: "Cómo protegemos los datos",
      blocks: [
        "Aplicamos medidas técnicas, organizativas y legales acordes con la naturaleza de los datos, entre ellas:",
        {
          list: [
            "Aislamiento de cada clínica en la base de datos: una clínica no puede ver los datos de otra.",
            "Acceso por roles: cada usuario ve solo lo que su rol le permite.",
            "Registro de actividad de los usuarios.",
            "Comunicaciones cifradas en tránsito [Por confirmar: cifrado en reposo de la base de datos y del almacenamiento].",
            "Copias de seguridad [Por completar: frecuencia y ubicación de las copias de seguridad].",
          ],
        },
        "Ningún sistema es invulnerable. Si se produce un incidente de seguridad que afecte a sus datos, se lo comunicaremos conforme a la ley.",
      ],
    },
    {
      id: "derechos",
      title: "Sus derechos y cómo ejercerlos",
      blocks: [
        "Usted puede ejercer, de forma gratuita, los derechos de información, acceso, rectificación, cancelación (supresión) y oposición, así como los demás reconocidos por la Ley 29733 y su Reglamento, incluido el de revocar el consentimiento que haya dado.",
        `Para ejercerlos, escriba a ${TITULAR.correoPrivacidad} indicando su nombre, el derecho que ejerce, lo que solicita y un medio para responderle. Podemos pedirle que acredite su identidad o, si actúa por otra persona, su representación.`,
        "Responderemos en los plazos que establece la normativa peruana: [Por confirmar: plazos vigentes del Reglamento D.S. 016-2024-JUS para cada derecho; como referencia, el reglamento anterior fijaba 8 días hábiles para información, 20 para acceso y 10 para rectificación, cancelación y oposición].",
        "Si considera que no hemos atendido su solicitud correctamente, puede presentar una reclamación ante la Autoridad Nacional de Protección de Datos Personales (ANPD) del Ministerio de Justicia y Derechos Humanos.",
        "Si usted es paciente de una clínica que usa odentIA, diríjase primero a la clínica, que es la responsable de sus datos. Si nos escribe a nosotros, trasladaremos su solicitud a la clínica.",
      ],
    },
    {
      id: "banco-de-datos",
      title: "Banco de datos",
      blocks: [
        "Los datos de los que odentIA es responsable se almacenan en el banco de datos de su titularidad, inscrito en el Registro Nacional de Protección de Datos Personales de la ANPD con el código [Por completar: código de inscripción].",
      ],
    },
    {
      id: "pacientes",
      title: "Datos de los pacientes de las clínicas",
      blocks: [
        "Cada clínica es la titular del banco de datos de sus pacientes y la responsable de su tratamiento. Ella decide qué datos carga en odentIA, con qué finalidad y durante cuánto tiempo, y debe informar a sus pacientes y obtener los consentimientos que exija la ley.",
        "Estos datos incluyen datos sensibles de salud: historia clínica (con el odontograma o el examen físico), diagnósticos, tratamientos y presupuestos, además de datos de contacto y las conversaciones mantenidas por los canales que la clínica conecta.",
        "odentIA trata esos datos como encargado del tratamiento, solo para prestar el servicio a la clínica y según sus instrucciones. Las condiciones están en el [contrato de encargo de tratamiento](/encargo-de-tratamiento).",
        "Cuando Sofi, el agente de recepción, atiende a una persona, se presenta como asistente virtual de la clínica. Los mensajes de atención (citas, controles y presupuestos) forman parte del servicio de la clínica; las promociones solo se envían con el consentimiento del paciente.",
        ENTRENAMIENTO,
        "Si la clínica opera fuera del Perú, se aplica además la ley de protección de datos de su país y la clínica es responsable de cumplirla. Si atiende a personas en la Unión Europea, puede aplicarse también el Reglamento General de Protección de Datos (RGPD).",
      ],
    },
    {
      id: "cambios",
      title: "Cambios en esta política",
      blocks: [
        "Podemos actualizar esta política. Publicaremos la nueva versión en esta página con su fecha y, si los cambios son relevantes, los avisaremos por correo electrónico o dentro de la aplicación.",
      ],
    },
  ],
}

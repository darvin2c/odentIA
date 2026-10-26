// Contrato de encargo de tratamiento entre la clínica (titular del banco de datos y responsable) y
// odentIA (encargado). Marco: Ley 29733 y su Reglamento (D.S. 016-2024-JUS).
import { contactEmail } from "../site"
import { type LegalDoc, TITULAR } from "./types"

export const ENCARGO: LegalDoc = {
  path: "/encargo-de-tratamiento",
  title: "Contrato de encargo de tratamiento de datos",
  description:
    "Cláusulas del encargo de tratamiento entre la clínica, responsable de los datos de sus pacientes, y odentIA, que los trata por su cuenta: instrucciones, seguridad, subencargados, incidentes y devolución.",
  intro: [
    "Este contrato forma parte de los [términos y condiciones del servicio](/terminos) y se acepta junto con ellos. Regula cómo odentIA trata los datos personales de los pacientes y demás personas que la clínica gestiona en la plataforma.",
  ],
  sections: [
    {
      id: "partes",
      title: "Partes y definiciones",
      blocks: [
        "«La Clínica» es la titular del banco de datos personales de sus pacientes y la responsable del tratamiento.",
        `«odentIA» (${TITULAR.razonSocial}, RUC ${TITULAR.ruc}) es el encargado del tratamiento con cualquiera de sus dos marcas, odentIA y latidIA: trata los datos por cuenta de la Clínica, sin decidir sobre su finalidad ni su contenido.`,
        "Los términos «datos personales», «datos sensibles», «titular de los datos», «tratamiento», «encargado» y «flujo transfronterizo» tienen el significado que les da la Ley N.º 29733, Ley de Protección de Datos Personales, y su Reglamento, aprobado por Decreto Supremo N.º 016-2024-JUS.",
      ],
    },
    {
      id: "objeto",
      title: "Objeto y alcance",
      blocks: [
        {
          table: {
            caption: "Alcance del tratamiento",
            head: ["Aspecto", "Detalle"],
            rows: [
              [
                "Finalidad",
                "Prestar a la Clínica el servicio odentIA: agenda, historia clínica, presupuestos, caja, comunicaciones, reportes y agentes de inteligencia artificial.",
              ],
              [
                "Personas afectadas",
                "Pacientes, sus responsables o representantes, personas que escriben a la Clínica por sus canales y personal de la Clínica.",
              ],
              [
                "Tipos de datos",
                "Identificación y contacto; datos de salud (historia clínica, odontograma o examen físico, diagnósticos, tratamientos, dictados); presupuestos y pagos; conversaciones y mensajes; archivos adjuntos.",
              ],
              [
                "Operaciones",
                "Registro, almacenamiento, consulta, organización, transcripción, análisis por modelos de inteligencia artificial, comunicación por los canales que la Clínica conecta y eliminación.",
              ],
              [
                "Duración",
                "La del contrato de servicio, más el plazo de devolución indicado en la cláusula 10.",
              ],
            ],
          },
        },
      ],
    },
    {
      id: "instrucciones",
      title: "Instrucciones de la Clínica",
      blocks: [
        "odentIA trata los datos únicamente según las instrucciones documentadas de la Clínica. Se consideran instrucciones estos términos, la configuración que la Clínica hace en la plataforma (qué canales conecta, qué puede hacer cada agente, qué modelo de inteligencia artificial elige, qué roles asigna) y las solicitudes que envíe por escrito.",
        "odentIA no usará los datos para fines propios ni distintos de los indicados. En particular, no usa los datos de la Clínica ni de sus pacientes para entrenar modelos propios. Los proveedores de inteligencia artificial que odentIA usa por API, OpenAI y TypeSafe (Jev), no usan los datos que reciben por esa vía para entrenar sus modelos, según sus condiciones de uso.",
        "Si odentIA considera que una instrucción infringe la ley, lo comunicará a la Clínica y podrá abstenerse de cumplirla.",
        "La Clínica garantiza que los datos se han obtenido lícitamente, que ha informado a los titulares y que cuenta con los consentimientos necesarios, incluido el consentimiento para tratar datos de salud cuando la ley lo exija y para enviar comunicaciones promocionales.",
      ],
    },
    {
      id: "confidencialidad",
      title: "Confidencialidad",
      blocks: [
        "odentIA guarda secreto sobre los datos de la Clínica y garantiza que las personas autorizadas a tratarlos se han comprometido a mantener su confidencialidad. Esta obligación subsiste después de terminado el contrato.",
        "El personal de odentIA solo accede a los datos de una clínica cuando es necesario para prestar soporte, resolver incidencias o cumplir una obligación legal, Para ver los datos de una clínica en un caso de soporte, el personal necesita el permiso de la Clínica, que dura como máximo una hora por caso y que la Clínica puede retirar en cualquier momento. Cada acceso y cada intento quedan registrados.",
      ],
    },
    {
      id: "seguridad",
      title: "Medidas de seguridad",
      blocks: [
        "odentIA aplica las medidas de seguridad técnicas, organizativas y legales que exige la normativa peruana para datos sensibles, entre ellas:",
        {
          list: [
            "Aislamiento por organización en la base de datos: cada clínica solo puede acceder a sus propios datos.",
            "Control de acceso por roles definido por la Clínica.",
            "Registro de actividad de los usuarios.",
            "Comunicaciones cifradas en tránsito, y archivos y copias de seguridad cifrados en reposo.",
            "Copias de seguridad diarias de la base de datos, guardadas en Cloudflare R2; se conservan las 14 más recientes.",
          ],
        },
        "La Clínica es responsable de la seguridad de las credenciales de sus usuarios y de asignar los roles de forma adecuada.",
      ],
    },
    {
      id: "subencargados",
      title: "Subencargados",
      blocks: [
        "La Clínica autoriza a odentIA a recurrir a los subencargados indicados en la página de [subencargados](/subencargados). Los proveedores de canales y de modelos de inteligencia artificial solo intervienen si la Clínica conecta el canal o usa los agentes.",
        "odentIA impone a cada subencargado obligaciones de protección de datos equivalentes a las de este contrato y responde ante la Clínica por su cumplimiento.",
        "odentIA avisará a la Clínica de cualquier alta o sustitución de subencargados con al menos 15 días de anticipación, por correo electrónico y dentro de la aplicación. La Clínica puede oponerse por motivos razonables relacionados con la protección de datos dentro de ese plazo. Si no se llega a una solución, la Clínica puede cancelar el servicio sin penalización.",
      ],
    },
    {
      id: "derechos",
      title: "Asistencia con los derechos de los titulares",
      blocks: [
        "Para atender los derechos de acceso, rectificación, cancelación, oposición y demás derechos reconocidos por la ley, la plataforma permite a la Clínica consultar y corregir los datos de sus pacientes (la historia clínica se corrige con adendas, sin reescribir lo registrado), descargar o imprimir sus documentos, retirar el consentimiento para el tratamiento de datos y dar de baja a una persona de los mensajes que no quiere recibir.",
        "La plataforma aún no entrega por sí sola una copia completa de los datos de una persona ni suprime o anonimiza sus datos. Cuando la Clínica lo necesite para responder a un titular, lo pide a odentIA desde Soporte y odentIA lo hace por ella dentro de los plazos legales. La historia clínica no se suprime mientras la normativa sanitaria exija conservarla.",
        "Si un titular dirige su solicitud a odentIA, odentIA la trasladará a la Clínica sin demora y no la responderá directamente salvo instrucción de la Clínica. odentIA asistirá a la Clínica en lo razonable para que pueda responder dentro de los plazos legales.",
      ],
    },
    {
      id: "incidentes",
      title: "Notificación de incidentes de seguridad",
      blocks: [
        "Si odentIA tiene conocimiento de un incidente de seguridad que afecte a los datos de la Clínica, se lo notificará en un plazo máximo de 24 horas desde que tenga conocimiento de él.",
        "La notificación incluirá, en la medida en que se conozca: la naturaleza del incidente, los datos y personas afectados, las consecuencias probables y las medidas adoptadas o propuestas. odentIA colaborará con la Clínica para que esta cumpla sus obligaciones de comunicación a la Autoridad Nacional de Protección de Datos Personales y a los titulares afectados, conforme al Reglamento.",
      ],
    },
    {
      id: "transferencias",
      title: "Transferencias internacionales",
      blocks: [
        "Algunos subencargados tratan los datos fuera del Perú, como se indica en la página de [subencargados](/subencargados). La Clínica autoriza ese flujo transfronterizo. odentIA lo realiza con proveedores que ofrecen niveles de protección adecuados o garantías contractuales suficientes, conforme a la Ley 29733 y su Reglamento. Las garantías son las condiciones de protección de datos que cada proveedor aplica a sus clientes empresariales.",
        "Si la Clínica opera fuera del Perú, se aplica además la ley de protección de datos de su país y la Clínica es responsable de cumplirla. Si atiende a personas en la Unión Europea, puede ser aplicable el Reglamento General de Protección de Datos (RGPD) y las partes acordarán las garantías adicionales necesarias.",
      ],
    },
    {
      id: "devolucion",
      title: "Devolución y eliminación al terminar",
      blocks: [
        "Al terminar el contrato, la Clínica dispone de 30 días para pedir a odentIA una copia de sus datos en formatos de uso común, que odentIA le entrega. Vencido ese plazo, odentIA elimina los datos de sus sistemas, incluidas las copias de seguridad en cuanto se renuevan, en un máximo de 14 días, salvo que una ley obligue a conservarlos.",
        "La Clínica es responsable de conservar la historia clínica de sus pacientes durante el plazo que exija la normativa sanitaria aplicable; en Perú, según la Ley 30024 y la norma técnica de salud de historia clínica vigente.",
      ],
    },
    {
      id: "auditorias",
      title: "Auditorías",
      blocks: [
        "odentIA pondrá a disposición de la Clínica la información razonablemente necesaria para demostrar el cumplimiento de este contrato.",
        "La Clínica puede solicitar una auditoría, con un aviso previo de al menos 30 días, como máximo una vez al año salvo que exista un incidente o lo exija una autoridad. La auditoría se realizará en horario laboral, sin acceder a datos de otras clínicas y con compromiso de confidencialidad del auditor. Sus costos corren a cargo de la Clínica.",
      ],
    },
    {
      id: "responsabilidad",
      title: "Responsabilidad, vigencia y ley aplicable",
      blocks: [
        "Cada parte responde por los incumplimientos que le sean imputables según este contrato y la ley. La limitación de responsabilidad de los [términos y condiciones](/terminos) se aplica a este contrato.",
        "Este contrato se rige por las leyes de la República del Perú y está vigente mientras odentIA trate datos por cuenta de la Clínica. Las controversias se someten a los jueces y tribunales del distrito judicial de Lima, Perú.",
        `Para asuntos relacionados con este contrato, escriba a ${TITULAR.correoPrivacidad} o a [${contactEmail}](mailto:${contactEmail}).`,
      ],
    },
  ],
}

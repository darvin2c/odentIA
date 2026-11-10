import { AGENT_NAMES } from "./agent-names.js"
import { normalizeForSearch } from "./knowledge.js"

/* ---------- Guía de odentIA: el mapa del sistema con el que responde Ariadna (latidIA: `medical/help.ts`) ---------- */

/** Una pregunta frecuente de una pantalla, con su respuesta. */
export interface HelpFaq {
  q: string
  a: string
  /** Otras formas de preguntar exactamente lo mismo, enteras. */
  forms?: string[]
  /** No es de la pantalla de su tema: la respuesta no lleva a ella ni depende de poder abrirla. */
  general?: boolean
}

/**
 * Un tema por pantalla. Lo que identifica a la pantalla —ruta y nombre— tiene
 * que coincidir con el código: una prueba lo compara con las rutas y los menús
 * reales, y falla si un tema nombra algo que ya no existe o si aparece una
 * pantalla sin tema. Lo escrito a mano es poco: para qué sirve y con qué
 * palabras la busca la gente. Se cambia en el mismo cambio que la pantalla.
 */
export interface HelpTopic {
  id: string
  /** Ruta de la pantalla, tal como está en la aplicación. */
  path: string
  /** Otras direcciones de la misma pantalla (las que redirigen o cuelgan de ella). */
  alsoAt?: string[]
  /** Nombre con el que el sistema la llama (el del menú). */
  title: string
  /**
   * El nombre de su entrada del menú, si no es el del tema: quien llega por ahí solo ve lo suyo
   * («Mis honorarios» del profesional, en el tema de Comisiones que también es de administración).
   */
  menuLabel?: string
  /**
   * Cómo se nombra una página de una sola cosa de esta lista (`/people/<id>`): «la ficha de una
   * persona», no «Pacientes» (QA de la ficha del 9 nov).
   */
  itemLabel?: string
  /** Sección del menú o de Configuración donde está. */
  parent: string | null
  /** Para qué sirve, en una o dos frases. */
  purpose: string
  /** Con qué palabras la busca la gente, aunque el sistema la llame de otro modo. */
  terms: string[]
  /** Preguntas frecuentes de esa pantalla con su respuesta. */
  faqs?: HelpFaq[]
  /** Permiso que hace falta para cambiar cosas ahí (basta uno); ausente = basta con poder verla. */
  writePermission?: string | readonly string[]
}

const SETTINGS = "Configuración"
/** Pantallas que se abren desde Integraciones: no están en la lista, pero se llega por ahí. */
const INTEGRATIONS = `${SETTINGS} › Integraciones`

/**
 * Pantallas comunes que solo muestra el producto que las declara (los pedidos:
 * `productUi().orders`, ADR 0171): están en las rutas de todas las apps, pero su
 * tema lo pone la guía de ese producto, y las demás no las nombran.
 */
export const PRODUCT_ONLY_SCREENS: readonly string[] = ["/orders"]

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "inicio",
    path: "/home",
    title: "Inicio",
    parent: null,
    purpose:
      "Lo que te toca hoy. «Te espera» es la única lista de lo que hay que hacer, una fila por persona, en tres grupos: Ahora, Hoy y Sin apuro, que va plegado. Cada fila tiene un solo botón y abre al lado lo que necesitas para resolverla, con sus mensajes y la caja para responder: lo que te pasó el agente («Responder» si es tuyo o nadie lo tomó; si lo lleva otra persona, dice con quién está), tu atención de otro día que quedó sin firmar («Revisar»), las citas de días anteriores que nadie cerró («¿Vino?»; si atiendes, te salen las tuyas), las citas que no se confirmaron tras el recordatorio («Llamar»), cuántos tienen algo aceptado sin cita (para quien ve Reportes, con «Ver en Pacientes», que abre «Por agendar»; si Argos ya te recomienda «Presupuesto aceptado sin cita», va en esa fila), los controles vencidos sin ninguna cita (para quien ve la agenda de la sede, como recepción, la dueña o la administración, con la lista de la línea de Argos «Avisar un control»; si Argos ya te la recomienda, va en esa fila), los presupuestos sin enviar, las conversaciones sin responder (si atiendes, las que llevas), las tareas, lo que recomienda Argos y, con el Administrador encendido, las personas a las que Sofi no pudo escribir. Al lado, tu día: si hoy atiendes, «Mis pacientes de hoy» con la sala de espera, lo que estás atendiendo y lo que viene más tarde; si no, la agenda de la sede, donde recepción marca «Llegó», o la caja, según tu trabajo. La campana de avisos es solo para enterarte: no repite nada de «Te espera».",
    terms: [
      "resumen del día",
      "pendientes",
      "panel",
      "dashboard",
      "qué tengo hoy",
      "recomendaciones",
      "avisos",
      "campana",
      "notificaciones",
      "marcar todo leído",
      "avisos en el celular",
      "notificaciones en el teléfono",
      "instalar la app",
      "app en el celular",
      "sin conexión",
      "te lo pasó el agente",
      "no confirmó",
      "sala de espera",
      "pacientes de hoy",
      "llegó",
      "atención sin cerrar",
      "aceptaron y no tienen cita",
      "te espera",
      "qué me toca",
      "qué tengo que hacer",
      "mientras no estabas",
      "borrador",
      "sala de espera ahora",
    ],
    faqs: [
      {
        q: "¿Qué trae la campana?",
        a: "Lo que conviene saber y no pide trabajo: un consentimiento firmado, la caja que cerró con diferencia, una oportunidad ganada o perdida, un mensaje que WhatsApp aprobó. Abrir un aviso lo marca leído y «Marcar todo leído» los marca todos. Un aviso desaparece solo cuando su asunto se resuelve, y nunca te avisa de algo que hiciste tú. Lo que hay que hacer está en «Te espera».",
      },
      {
        q: "¿Cómo recibo avisos en el celular o la computadora aunque no tenga la clínica abierta?",
        a: "Abre la campana y prende «Recibir avisos en este equipo»; el navegador te pide permiso y llega un aviso de «Listo». Es de ese equipo y de esta clínica: si trabajas en otra, actívalo también ahí. Te avisa cuando alguien nuevo te espera en Inicio, solo con la clínica abierta (lo de la noche llega al abrir), y a cualquier hora si WhatsApp o el agente dejan de funcionar y tú lo ves en la campana. El aviso no dice el nombre de la persona ni lo que escribió: eso se ve al tocarlo, en la clínica. Leerlo en el celular no lo resuelve: sigue en «Te espera» hasta que alguien lo atiende. En iPhone, primero agrega la clínica a tu inicio desde Safari (Compartir › Agregar a inicio) y actívalo desde ese ícono. No lo actives en la tablet que le pasas al paciente. Al cerrar sesión, el equipo deja de recibir tus avisos.",
      },
      {
        q: "¿Puedo instalar la clínica como una app?",
        a: "Sí. En la campana, «Instalar en este equipo» aparece cuando el navegador lo permite (Chrome o Edge en la computadora y en Android); en iPhone, desde Safari con Compartir › Agregar a inicio. Queda un ícono con el nombre de tu clínica que abre en Inicio y sin la barra del navegador. Sigue necesitando internet: si se corta, arriba dice «Sin conexión» y lo que escribiste sigue ahí, pero no se guarda hasta que vuelva.",
      },
      {
        q: "¿Por qué aparece «No confirmó su cita»?",
        a: "Con «Recordar la cita» prendida, Sofi le pidió confirmar y la persona no lo hizo. La fila trae su teléfono y «Llamar», para hablar con ella con tiempo. Al abrirla te pregunta «¿Qué te dijo?»: «Confirmó por teléfono», «Quiere otra hora» o «No viene», que la cancela sin enviarle otro mensaje. Si no contestó, sigue en la lista. Si dice «No recibe recordatorios», es porque los apagó y hay que confirmarle la cita a ella.",
      },
      {
        q: "¿Cómo sé quién me espera?",
        a: "Si hoy atiendes, en «Mis pacientes de hoy»: «Sala de espera» muestra a quien recepción marcó con «Llegó», desde qué hora y cuánto lleva esperando; se actualiza solo. El nombre abre su página para mirarla antes de llamarla y «Atender» abre la atención en un clic. Si no hay nadie en sala ni en atención, la siguiente de «Más tarde» trae su «Atender», que marca la llegada sola. Si hoy no atiendes, quien llegó se ve en la agenda de la sede, en Inicio o en la Agenda.",
      },
      {
        q: "¿Por qué me aparece una atención de ayer?",
        a: "Porque quedó sin firmar y la ficha de esa persona sigue trabada. Al abrirla te dice lo que tiene y lo que le falta para cerrarse: «Continuar la atención» la abre para terminarla y «Anularla con motivo» la descarta dejando constancia de por qué.",
      },
      {
        q: "¿Quién es Ariadna?",
        a: "Soy la guía virtual de odentIA, la que responde en Ayuda. Te digo dónde está cada cosa y te llevo con «Llévame», qué se puede hacer y qué le falta a la clínica para que algo funcione. Respondo con la guía del sistema: no veo pacientes, conversaciones ni montos y no cambio nada. Si no lo sé, te lo digo y te ofrezco enviarlo a odentIA. Me llamo como la del hilo del laberinto: te ayudo a encontrar el camino.",
        forms: ["quien eres", "que eres", "como te llamas", "cual es tu nombre", "tu nombre", "que puedes hacer", "que sabes hacer", "para que sirves", "eres una persona", "eres un robot"],
        general: true,
      },
      {
        q: "¿Cómo respondo lo que me pasó Sofi sin entrar a la Bandeja?",
        a: "Si el tema es tuyo o nadie lo tomó (una duda clínica de tu paciente, o un pago si estás en caja), la fila trae «Responder»: ves su pregunta, escribes y «Enviar». Sale por su canal citando su pregunta, el tema queda resuelto y Sofi sigue con lo demás; si le debes algo más, «Dejar pendiente». Si lo lleva otra persona, «Responder yo» lo pasa a ti y se le avisa. Un tema pasa a «Ahora» a las dos horas de clínica abierta esperando: lo que llega con la clínica cerrada no cuenta.",
      },
      {
        q: "¿Qué son los horarios y precios que aparecen al responder?",
        a: "Son ayudas de la caja para responder: los horarios libres con quien la atendió y tu lista de precios. Tocar uno lo escribe en el mensaje, sin apartar la hora. Lo que escribes queda como borrador en este navegador y la fila dice «tienes un borrador sin enviar».",
        forms: ["no apartar la hora"],
      },
      {
        q: "¿Qué significa «Enseñárselo a Sofi»?",
        a: "Aparece después de responder algo que Sofi no supo. Deja tu respuesta por aprobar en Agente › Aprender: Sofi la usa recién cuando alguien la aprueba.",
      },
      {
        q: "¿Qué es «Mientras no estabas»?",
        a: "Una línea que sale una vez al día, la primera vez que miras Inicio: dice lo que hicieron los agentes desde tu visita anterior, solo con lo que tu rol puede ver. Se cierra con su X.",
      },
      {
        q: "¿Por qué dice que un mensaje automático no le llega a todos?",
        a: "Porque WhatsApp lo clasificó como publicidad y solo sale a quien aceptó novedades. «Arreglar» te lleva a sus mensajes para cambiarle el texto.",
      },
      {
        q: "¿Cómo cambio mi contraseña?",
        a: "En el menú con tu nombre, abajo a la izquierda, «Cambiar contraseña». Ahí mismo, «Mi perfil» tiene tu nombre, tu foto y la verificación en dos pasos.",
        forms: ["olvide mi contrasena", "cambiar contrasena", "mi perfil", "cambiar mi foto"],
        general: true,
      },
      {
        q: "¿Hay un manual?",
        a: "El manual soy yo: dime con tus palabras qué quieres hacer y te llevo a la pantalla. Abajo, «En esta pantalla suelen preguntar» trae lo más común de donde estás. Para empezar, Inicio muestra los pasos que le faltan a tu clínica.",
        forms: ["hay un manual", "hay un manual del sistema", "tienen un manual", "tienen una guia", "tienen una guia de inicio", "como uso el sistema", "como funciona el sistema", "como se usa el sistema", "como empiezo"],
        general: true,
      },
      {
        q: "¿Puedo usar odentIA desde el celular?",
        a: "Sí. Se abre en el navegador del teléfono, con las mismas pantallas adaptadas. No hace falta instalar nada.",
        forms: ["puedo usar el sistema desde mi celular", "funciona en el celular", "tienen aplicacion", "hay una app", "hay aplicacion", "tienen aplicacion para iphone"],
        general: true,
      },
    ],
  },
  {
    id: "bandeja",
    path: "/inbox",
    title: "Bandeja",
    parent: null,
    purpose:
      "Todas las conversaciones con pacientes y contactos, de todos los canales, en un solo lugar, en cuatro pestañas que no se pisan: «Por atender» (lo que Sofi te pasó, lo que espera a una persona del equipo y lo que no se pudo enviar), «Las atiende Sofi», «Esperan al paciente» y «Cerradas». Aparte, Spam y las personas bloqueadas. Cada persona sale una vez, aunque escriba por WhatsApp y por Telegram, y al abrirla ves lo que dijo por todos sus canales. Se buscan por nombre, teléfono, documento o algo que hayan escrito, en todas las pestañas a la vez, y «Solo las mías» deja tus temas y los que nadie tomó. Lo que Sofi no puede responder queda como un tema: lo respondes con «Responder» y ella sigue con lo demás; «Contexto» muestra a la persona, su próxima cita y te deja reservarle una. Sofi cierra sola las que atiende: con una despedida cuando termina o cuando la persona deja de responder y, si ya reservó su cita, a la hora y sin despedida. Las que lleva una persona del equipo no se cierran solas. Cualquier mensaje suyo la vuelve a abrir.",
    terms: [
      "mensajes",
      "chats",
      "conversaciones",
      "responder",
      "inbox",
      "escribir a un paciente",
      "escribirle",
      "nueva conversación",
      "iniciar conversación",
      "cerrar conversación",
      "responder un tema",
      "tema",
      "por atender",
      "reabrir",
      "cerradas",
      "responder por",
      "otro canal",
      "varios canales",
      "mensajes de whatsapp",
      "ver mensajes",
      "chat",
      "spam",
      "bloquear",
      "bloqueados",
      "publicidad",
      "solo las mías",
      "redes",
      "correo de un paciente",
      "pasar conversación",
      "desbloquear",
      "escribió",
      "telegram",
      "instagram",
      "messenger",
      "facebook",
      "correos de pacientes",
      "sin responder",
    ],
    writePermission: "conversations.write",
    faqs: [
      {
        q: "¿Cómo le escribo a alguien que nunca me escribió?",
        a: "En la Bandeja pulsa «Nueva conversación», búscalo por nombre o por teléfono y elígelo; si no existe, créalo con su número. Si tiene teléfono se le escribe por WhatsApp, sin escribir nada más. Como nunca escribió, WhatsApp pide empezar con uno de los mensajes aprobados de la clínica: la conversación te los ofrece y, si no hay ninguno, te dice qué falta y a quién pedírselo. Desde la ficha, la Agenda o Finanzas es el mismo botón: «Escribirle». En la ficha se abre ahí mismo, sin ir a la Bandeja.",
      },
      {
        q: "¿Cómo respondo yo en vez de Sofi?",
        a: "Lo que Sofi no puede responder te llega como un tema. Con un solo tema, la caja ya te dice a qué estás respondiendo; con varios, tocas el que quieres responder y el hilo baja hasta su mensaje. Escribe y pulsa «Enviar» o Enter: tu respuesta sale citando su pregunta y el tema queda resuelto; si le debes algo más, pulsa «Dejar pendiente». Lo que no necesita respuesta se cierra con «Resolver», sin enviarle nada. A cualquier otro mensaje le respondes con «Responder», junto a él. Un «sí» o un «gracias» que le dicen a Sofi no te piden nada: no entran a ningún tema. Sofi nunca deja de atender lo demás: mientras conversas en vivo espera 15 minutos. Si el tema lo tiene otra persona, la caja ofrece «Tomar este tema»; pasarlo a alguien está en su «…». Con el teclado, J y K pasan entre conversaciones y R lleva a la caja.",
      },
      {
        q: "¿Y si ya pasaron 24 horas desde que escribió?",
        a: "Por WhatsApp responde su pregunta igual: tu respuesta queda «Por entregar» y le llega un aviso, «Ver respuesta»; al tocarlo, o al volver a escribir, recibe tu respuesta citando su pregunta. Para ti el tema ya está resuelto. Una respuesta por entregar es solo texto, sin adjuntos, y si Meta aún no aprobó «Ver respuesta» queda guardada hasta que lo apruebe o la persona vuelva a escribir. Si no estás respondiendo una pregunta suya, «Elegir un mensaje aprobado». Por Instagram o Messenger no se puede escribirle hasta que vuelva a escribir: si tiene un WhatsApp marcado como suyo, «Escribirle por WhatsApp» le manda tu respuesta por ahí.",
      },
      {
        q: "¿Por qué canal le llega mi respuesta?",
        a: "Por donde preguntó: si respondes un tema, por el canal de ese tema; si no, por el de la conversación que la lista te muestra, la que más pide o la de su último mensaje. Arriba de donde escribes, «Responder por» dice cada canal por el que se le puede escribir y si está abierto, y te deja cambiarlo sin perder lo que escribiste. Un canal apagado en Configuración no aparece: su historial sigue en el hilo. Si tiene un tema en otro canal, arriba lo dice con «Responder por» ese canal.",
      },
      {
        q: "¿Qué pasa si nadie responde un tema?",
        a: "A las dos horas de clínica abierta sube a «Ahora». Si al día siguiente sigue sin respuesta y es una cita o un precio de la lista, Sofi le escribe a primera hora, dentro del horario de recontacto, para seguir ella; el tema queda «Lo retomó Sofi» y a quien lo tenía le llega el aviso. Una duda clínica, un descuento o un pago siempre esperan al equipo.",
      },
      {
        q: "¿Cómo cierro una conversación?",
        a: "Casi nunca hace falta: Sofi cierra las que atiende. Lo tuyo es responder sus temas; al responderlos quedan resueltos. Las que lleva una persona del equipo no se cierran solas y aparecen en «Te espera». Si de verdad hay que cerrarla sin más, en «…» está «Cerrar sin resolver». Si la persona vuelve a escribir, se reabre sola.",
      },
      {
        q: "¿Por qué se cerró sola una conversación?",
        a: "Sofi la cierra cuando la persona se despide y no queda nada pendiente («Resuelta»), cuando ya reservó su cita y pasó una hora sin mensajes («Resuelta», sin despedida) o cuando deja de responder («Sin respuesta del paciente»): antes insiste una vez si había algo por responder y se despide en un horario razonable. Las que tiene una persona del equipo no se cierran solas: aparecen en «Te espera» para que la cierres o sigas.",
      },
      {
        q: "¿Cómo dejo constancia de que la persona aceptó lo que le propuso Sofi?",
        a: "En la tarjeta de Sofi, dentro del hilo: «Registrar confirmación», si ya dijo que sí en el chat; el equipo no aprueba nada por ella. Si es una cita y te lo dijo por teléfono, en esa misma tarjeta, «Confirmó por teléfono».",
      },
      {
        q: "¿Cómo veo en qué se basó una respuesta de Sofi?",
        a: "En la conversación, debajo de cada mensaje de Sofi, pulsa «En qué se basó». Verás qué consultó y qué datos se comprobaron antes de enviarlo.",
      },
      {
        q: "¿Qué hago con el spam o con alguien a quien no quiero responder?",
        a: "En «…» de la conversación. «Es spam» la manda a la pestaña Spam: Sofi no responde y no se cobra; si escribe algo que no es spam, sale sola. «Bloquear a esta persona…» la deja en bloqueados: nadie le escribe y Sofi no le responde. A un paciente no se le marca ni se le bloquea: se archiva desde su página.",
        forms: ["como marco spam", "como bloqueo a alguien", "bloquear un numero", "marcar como spam"],
      },
    ],
  },
  {
    id: "agenda",
    path: "/agenda",
    title: "Agenda",
    parent: null,
    purpose:
      "Las citas por día, la semana de todo el equipo con sus horas libres y la vista Agenda, que las lista día por día; un odontólogo la abre en su columna. Desde ahí reservas, mueves y cancelas citas, marcas «Llegó» cuando la persona está en la clínica y, quien atiende, pulsa «Atender». Al abrir una cita ves en palabras cómo va (Por confirmar, Confirmada, Llegó, En atención, Atendida, No vino o Cancelada), el teléfono de la persona, de qué conversación salió y cuándo le pedirá Sofi que confirme, y puedes escribirle.",
    terms: [
      "citas",
      "calendario",
      "reservar",
      "turnos",
      "horario del día",
      "mover una cita",
      "cancelar una cita",
      "reprogramar",
      "confirmar cita",
      "escribirle",
      "avisar la cita",
      "llegó",
      "sala de espera",
      "atender",
      "no vino",
      "atendida",
      "sin cerrar",
      "cambiar la hora",
      "cambiar cita",
      "dos citas",
      "misma hora",
      "ver citas",
      "paciente llegó",
      "mi calendario",
      "vienes en camino",
      "calendario de google",
      "pasar a otra fecha",
      "reunión",
      "semana",
      "ver la semana",
      "marcar que llegó",
      "corregir hora",
    ],
    writePermission: "appointments.write",
    faqs: [
      {
        q: "¿Cómo bloqueo un horario?",
        a: "En Configuración › Horarios y ausencias: registra una ausencia del profesional (días enteros o unas horas) o un feriado o cierre de la sede. En ese tramo Sofi y el enlace de la persona no reservan; alguien del equipo sí puede, con una advertencia. Las citas que ya estaban no se mueven solas.",
      },
      {
        q: "¿Por qué no aparece un profesional en la agenda?",
        a: "En el día aparece quien atiende ese día, según su horario en Configuración › Horarios y ausencias. Para darle una cita a quien no atiende ese día, elígelo en «Profesionales» › «No atienden este día» y su columna se suma a la vista. Recepción y caja no atienden, así que no aparecen; un propietario o administrador aparece cuando le pones horario.",
      },
      {
        q: "¿Puedo dar una cita fuera de horario o a una hora ocupada?",
        a: "Sí. Toca lo gris en el día, o elige esa hora en «Nueva cita»: te avisa y puedes reservar igual. La cita queda marcada y al profesional le llega un aviso. También puedes dar dos citas a la misma hora con un profesional, cada una en su sala o unidad; lo único que no se puede es poner a dos personas en la misma. Estas excepciones las hace siempre alguien del equipo: Sofi y el enlace de la persona solo reservan lo libre.",
      },
      {
        q: "¿Cómo elijo qué tratamientos trae la cita?",
        a: "En «Nueva cita», «Para esta cita» muestra lo que la persona aceptó y aún no tiene cita, y lo que tiene sesiones por reservar, con la que sería esta («sesión 2 de 2»). Vienen marcados los del primer servicio; los demás se suman con un toque, y elegir otro servicio marca los de ese. Puedes desmarcarlos todos: la cita queda sin ninguno. Los marcados quedan listos en la atención de esa cita. Cuando reservan Sofi o la persona desde su enlace, la cita trae lo aceptado de su servicio que aún no tenía cita o al que le faltan sesiones por reservar.",
      },
      {
        q: "¿Cómo le reservo una cita desde la conversación?",
        a: "Abre «Contexto» y pulsa «Reservar cita». Si aún no es paciente, la Agenda crea su ficha con su nombre y su teléfono, unida a esa misma persona. Al guardar vuelves a la conversación y, con «Recordar la cita» prendida, Sofi le avisa solo la fecha y la sede.",
      },
      {
        q: "¿Quién le avisa a la persona su cita?",
        a: "Con «Recordar la cita» prendida y Sofi y Argos encendidos (una clínica nueva trae los tres), Sofi le avisa al reservar, al mover y al cancelar la cita, y le recuerda antes: por defecto un día antes, para confirmar, y tres horas antes; si ya confirmó, ese segundo aviso no le pide confirmar. Las horas se cambian en esa línea de Argos. Los avisos de reserva, cambio y cancelación llegan siempre, salvo a quien pidió no recibir ningún mensaje; los recordatorios, salvo que los haya apagado (entonces «Te espera» te pide llamarla el día antes). Si responde «sí, ahí estaré» o toca «Confirmar», la cita queda confirmada sola; si confirma por sus hijos, Sofi le dice de quiénes eran. «Confirmar cita» en la cita es para cuando te confirma por teléfono o en persona.",
      },
      {
        q: "¿Cómo marco que llegó?",
        a: "Con «Llegó» en la cita, en la Agenda o en Inicio. Queda la hora y quien atiende lo ve en su sala de espera. Si estaba por confirmar, queda confirmada y ya no se le envían recordatorios. Si fue un error, «Deshacer» la devuelve como estaba mientras no haya empezado su atención.",
      },
      {
        q: "¿Dónde quedó «Atendida»?",
        a: "La cita se cierra con su atención: al firmarla pasa a «Atendida» y quedan hechos el control reservado en ella y el que ya le tocaba, si quien firma lo deja marcado. Cancelar una cita o marcar «No vino» devuelve su control a estar por reservar. Si una cita ya pasó y nadie la cerró, aparece en «Ya pasaron · sin cerrar» con «Registrar la atención» o «No vino».",
      },
      {
        q: "¿Y si llega tarde después de marcar «No vino»?",
        a: "Si es el mismo día, abre la cita y pulsa «Llegó»: se recupera. Si su hora ya la ocupa otra cita, lo dice. Otro día, «Reagendar».",
      },
      {
        q: "¿Cómo le doy cita a alguien que llama y nunca vino?",
        a: "En «Nueva cita», «Registrar paciente nuevo»: con nombres, apellidos y teléfono basta para reservar, aunque la clínica pida más en su registro. Lo que falta queda pendiente en su página. Ahí mismo pregúntale si acepta novedades y promociones: sin su respuesta no se guarda.",
      },
      {
        q: "¿Qué es «¿Vienes en camino?»?",
        a: "Si a los 15 minutos de la hora nadie marcó su llegada, Sofi le pregunta si viene en camino. Solo en una sede que ya marcó alguna llegada en las últimas 12 horas, para no escribirle a quien ya está en la clínica, y dentro del horario de recontacto.",
      },
      {
        q: "¿Cómo veo mis citas en mi calendario?",
        a: "En la Agenda, «Mi calendario», junto a «Nueva cita»; en el teléfono está en el menú ⋯. Es solo para quien atiende. De cada cita muestra «Paciente» con sus iniciales, nunca el nombre, el servicio ni el motivo. Quien configura el equipo ve quién lo comparte y puede dejar de compartirlo.",
        forms: ["mi calendario", "calendario de google", "agenda en mi celular"],
      },
    ],
  },
  {
    id: "tareas",
    path: "/tasks",
    title: "Tareas",
    parent: null,
    purpose:
      "Los pendientes del equipo, con páginas y búsqueda: se abre en «Mías y de mi área» (las tuyas y las sin responsable de tu parte del equipo); «Vencidas» y «Hechas» las filtran, y «Toda la clínica» la ven el propietario y el administrador. Cada tarea dice de quién es y lleva a su persona. Las que dejó Argos se cierran solas cuando ya no hacen falta (la cita pasó, la persona confirmó, el presupuesto se decidió) y dicen por qué. Completar la tarea de un tema de Sofi lo da por resuelto, igual que «Marcar resuelto» en la conversación: Sofi sigue con lo demás. Lo que deja el sistema por su cuenta no está aquí: se decide en su fila de «Te espera».",
    terms: [
      "pendientes",
      "to do",
      "llamar",
      "asignar",
      "vencidas",
      "hechas",
      "mis tareas",
      "toda la clínica",
      "se cerró sola",
      "te lo pasó el agente",
      "crear tarea",
      "nueva tarea",
      "tarea",
      "tareas de otros",
      "pendiente",
      "acordarme",
      "recordar algo",
    ],
    writePermission: "tasks.write",
    faqs: [
      {
        q: "¿Por qué no veo las tareas de los demás?",
        a: "Tareas se abre en «Mías y de mi área»: las tuyas y las que no tienen responsable en tu parte del equipo. «Toda la clínica» solo la ven el propietario y el administrador.",
      },
      {
        q: "¿Por qué una tarea se marcó como hecha sola?",
        a: "Porque su motivo ya no estaba: la cita pasó, la persona confirmó o reservó otra, el presupuesto se decidió, la oportunidad se cerró o Sofi retomó el tema. La tarea dice «Se cerró sola» y el porqué.",
      },
    ],
  },
  {
    id: "pacientes",
    path: "/people",
    alsoAt: ["/patients", "/contacts"],
    title: "Pacientes",
    itemLabel: "la ficha de una persona",
    parent: "Personas",
    purpose:
      "Todas las personas de la clínica en una lista, con las vistas Pacientes, Contactos nuevos, Archivados y Todos, y atajos como «Por agendar», «Presupuesto sin enviar» o «Deben». Cada persona tiene una sola página, la misma antes y después de registrarla: resumen, citas, datos y, ya registrada, su clínica, su plan y sus cobros, según lo que tu rol puede ver. Arriba, en todas las pestañas, sus alergias (o si niega o no se le preguntó), su próxima cita si ves la agenda y lo que debe o tiene a favor si ves la caja; si lees la historia, también sus enfermedades y lo que toma. Sus conversaciones y oportunidades están en su Resumen.",
    terms: [
      "historia clínica",
      "ficha",
      "expediente",
      "registrar paciente",
      "nueva persona",
      "odontograma",
      "buscar paciente",
      "contactos",
      "contactos nuevos",
      "archivar",
      "notas",
      "plan de tratamiento",
      "presupuesto",
      "enviar presupuesto",
      "opciones",
      "controles",
      "qué sigue",
      "resumen clínico",
      "atenciones",
      "documentos",
      "recetas",
      "órdenes",
      "alergias",
      "atención",
      "empezar atención",
      "alergia",
      "imágenes",
      "foto del paciente",
      "nombre del paciente",
      "borrar paciente",
      "por agendar",
      "ya la invité",
      "antecedentes",
      "documento",
      "teléfono del paciente",
      "enlace personal",
      "fotos",
      "receta",
      "historia",
      "evolución",
      "papel firmado",
      "firmó",
      "buscar persona",
      "no encuentro a un paciente",
      "lo que le hice",
    ],
    // Recepción registra; quien atiende escribe en la historia y arma el presupuesto.
    writePermission: ["patients.write", "clinical.write", "budgets.write"],
    faqs: [
      {
        q: "¿Cómo registro un paciente nuevo?",
        a: "En Pacientes, «Nuevo paciente»: pide nombres, apellidos y celular, te muestra quién coincide para no duplicar y eliges quién completa lo demás (el paciente en su celular, con su código QR, o tú en la misma ventana). Si ya escribió, abre su página y pulsa «Registrar»: trae lo que se sabe de ella. También puedes «Escribirle con su enlace»: abre su conversación con el enlace listo para enviar, y ahí elige su cita y deja sus datos.",
        forms: ["como creo un paciente nuevo", "como creo un paciente", "como registro a un paciente", "como registro un paciente", "nuevo paciente"],
      },
      {
        q: "¿Puedo registrar a un menor si su madre o su padre no trae su documento?",
        a: "Sí. Desde la página de quien lo trae, en Datos › Familia y responsables, «Registrar a alguien a su cargo»: queda como su responsable y su documento es opcional. Si no lo trae, regístralo igual; se le pide cuando firme un consentimiento por el menor, en la misma pantalla de la firma. Sus datos y su salud los completa su responsable en su celular o tú en ese momento.",
        forms: ["menor sin dni de la madre", "registrar a un hijo sin documento", "no trae su dni", "registrar un menor"],
      },
      {
        q: "¿Qué significa «Faltan datos para la atención»?",
        a: "Que le falta algo de lo necesario para atenderla o atenderlo (nombres, apellidos, fecha de nacimiento y un teléfono o correo, suyo o de quien habla en su nombre) o de lo que tu clínica marcó como obligatorio en Configuración › Registro de pacientes; sin su sexo registrado se dice «para la atención». Si es menor de edad, también el documento de su representante legal cuando su ficha no lo tiene: se escribe en la ficha de esa persona o al firmar el consentimiento, y queda guardado en ella. «Completar» abre solo lo que falta; al guardar, sus apellidos quedan confirmados. Lo ven recepción y quien dirige la clínica.",
      },
      {
        q: "¿Por qué el documento, el seguro y la dirección cambian según la clínica?",
        a: "Porque dependen del país que la clínica eligió en «Datos de la clínica», sin ningún interruptor. En todos los países: documento nacional, pasaporte u otro, siempre con el país que lo emitió; seguro público, privado, particular u otro; y la dirección con calle, ciudad, región, código postal y país. En clínicas de Perú, además: DNI, CE, CNV y documento extranjero; SIS, EsSalud y EPS; departamento de la lista, provincia, distrito y referencia; y la procedencia. Lo ya guardado no cambia si la clínica cambia de país.",
      },
      {
        q: "¿Dónde quedaron los contactos?",
        a: "En Pacientes: elige «Contactos nuevos» para quienes escribieron y aún no son pacientes, o «Todos». Quien habla por un paciente se ve en su página, en Datos › «Familia y responsables». Cada persona tiene una sola página. Caja y odontología solo ven a los pacientes.",
      },
      {
        q: "¿Qué mensajes le podemos enviar sin preguntarle?",
        a: "Los avisos de lo que pasó (su cita reservada, movida o cancelada, su presupuesto, su enlace, su receta y su comprobante) llegan siempre, salvo que pida no recibir ningún mensaje. Los recordatorios de sus citas y los de controles y seguimiento llegan hasta que los apaga. Las novedades y promociones, y retomar un presupuesto o una consulta, solo con su sí. Son los tres interruptores de su página › Datos › Datos personales, en «Mensajes de la clínica», los mismos que ella ve en su enlace, en «Tus mensajes».",
      },
      {
        q: "¿Por qué dice «Aún no es su WhatsApp» junto a su teléfono?",
        a: "Porque ese número está en sus datos pero nadie lo marcó como su WhatsApp, así que no le llegan los recordatorios por ahí. Si sabes que lo usa, pulsa «Usarlo como su WhatsApp». Si dice «Este número no tiene WhatsApp», WhatsApp rechazó un mensaje: los recordatorios le llegan por correo o «Te espera» te pide llamarla. Si alguien escribe desde el teléfono de una ficha, la conversación pregunta «¿Es la misma persona?»: nunca se une sola.",
      },
      {
        q: "¿Por qué el Resumen dice «Su WhatsApp es otro» debajo de su teléfono?",
        a: "Porque su WhatsApp es un número distinto del de «Teléfono», por ejemplo si cambió de número: el Resumen dice «· WhatsApp» solo junto al número que de verdad es su WhatsApp, y si es otro, dice cuál. Al escribir un teléfono de otro país, empieza con «+» y su prefijo (+44…): el país cambia solo. También puedes buscar el país en la lista por su nombre o su prefijo.",
      },
      {
        q: "¿Dónde anoto su contacto de emergencia?",
        a: "En su página › Datos › Familia y responsables: vincula a la persona (o elígela si ya está) y marca «Contacto de emergencia», con su parentesco. Si la persona aún no existe, se crea en el mismo paso.",
      },
      {
        q: "¿Cómo anoto que no quiere recordatorios?",
        a: "En su página › Datos › Datos personales, en «Mensajes de la clínica», apaga «Recordatorios de sus citas» y di cómo lo pidió (por teléfono, en persona o por la conversación). Si no quiere nada, «No quiere ningún mensaje de la clínica»: tampoco le llegarán los avisos de sus citas. Ella también puede hacerlo desde el botón «No más recordatorios», escribiendo «BAJA» o pidiéndoselo a Sofi; escribir «cancelar» cancela su cita, no los mensajes.",
      },
      {
        q: "¿Cómo archivo a una persona?",
        a: "En su página, en el menú de «Más acciones», pulsa «Archivar». Se archiva entera, con su ficha, y se recupera igual desde la vista «Archivados». Si vuelve a escribir o se registra desde su enlace, sale sola del archivo y se le responde como a cualquiera. A quien no es paciente se le puede «Bloquear» desde la conversación para no responderle; a un paciente, no.",
      },
      {
        q: "¿Puedo enviarle el registro a quien ya es paciente?",
        a: "Sí, para que registre a su hijo o a un familiar: la conversación lo ofrece en «…» como «Enviar enlace de registro». Lo que a ella le falte lo completa con «Su enlace».",
      },
      {
        q: "¿Qué es «Su enlace»?",
        a: "Una página personal de cada persona, sin contraseña, con lo que tiene pendiente: su cita (confirmar, cambiar, cancelar o reservar otra), sus datos por completar, el presupuesto que se le envió y lo que aceptó por agendar, el consentimiento por firmar y el cuestionario antes de su cita. Cada mensaje abre directo lo suyo: «Firma tu consentimiento» abre la hoja, el presupuesto abre el presupuesto, y arriba siempre está «Tus pendientes». Nunca muestra su historia ni lo guardado; el consentimiento se lee igual que su hoja en papel, con el diagnóstico que lo motiva. Le llega con el aviso de su cita cuando le falta algo, o con «Enviarle su enlace» junto a «Completar». Lo que no es su cita (sus datos, el presupuesto, el consentimiento y el cuestionario) solo lo ve la propia persona si es mayor de edad o su representante legal; la cita, además, un autorizado vigente. A un familiar sin autorización no le muestra nada, aunque ya tuviera el enlace. Cada cosa deja de servir cuando ya no hace falta; si lo abre después, le pide responder el mensaje para recibir uno nuevo. Para dejarlo sin efecto antes, «Quitar enlace» está junto a «Copiar enlace» y «Mostrar su código»: corta también los botones de sus correos.",
      },
      {
        q: "¿Qué pasa si el documento que escribió ya es de otra persona?",
        a: "No se guarda y nunca se unen solas: en «Te espera» aparece «Posible ficha repetida» para que revises si son la misma persona.",
      },
      {
        q: "¿Qué pasa si alguien se registra en línea con el documento de otra persona?",
        a: "No se crea a nadie ni se cambia nada todavía: a quien se registró se le dice que recibimos sus datos y que, si ya estaba registrado, recepción los revisa. Si su documento o su celular ya son de alguien de la clínica, en «Te espera» aparece «Se registró en línea: ¿es la misma persona?» con cuántos datos son distintos. «Revisar» muestra cada dato distinto con lo de antes y lo nuevo: marca lo que quieres guardar y pulsa «Sí, guardar» (nombre, nacimiento, sexo, celular y correo vienen sin marcar: márcalos solo si comprobaste que es la misma persona). Lo de antes queda en una nota de su página y el documento no se cambia desde ahí. «Es otra persona» la registra aparte y «Descartar» borra lo que escribió sin cambiar ninguna ficha. Si al registrar a un menor escriben el documento de alguien que ya está en la clínica, aparece «¿Es representante de…?»: «Confirmar» la deja como su representante con el parentesco que escribieron (la madre que registra a su segundo hijo, con un clic) y «No es representante» lo descarta sin vincular a nadie.",
      },
      {
        q: "¿Dónde veo sus alergias, qué le toca y su última atención?",
        a: "Su próxima cita está arriba de su página, en todas las pestañas (si ya llegó, dice que está en la sala de espera). En el Resumen, «Qué sigue» dice en una sola lista todo lo que le toca: el presupuesto por enviar o que espera respuesta, la cita de lo aceptado (con sus nombres) o de su próxima sesión, y su próximo control, con quién lo indicó y cuándo. Lo aceptado va primero, salvo el control de un tratamiento, que va antes porque dice si el tratamiento funcionó; la limpieza o el control que también falta reservar va en la misma fila que lo aceptado, con «Reservar lo aceptado y el control», que abre una sola cita con los dos marcados. Si una cita suya de otro día quedó sin cerrar, va primero con «¿Vino?», que abre la cita para registrar la atención o marcar que no vino; y si una cita que llevaba lo aceptado se atendió sin registrar lo que se hizo, la fila de lo aceptado lo dice, para preguntarle a quien atendió antes de reservar. El Plan muestra la misma lista y la lista de Pacientes dice su primera fila. Cada fila tiene su botón y lo hace ahí mismo: «Reservar la sesión» con su número, «Reservar el control» o «¿Qué respondió?». Si lees la historia clínica, arriba están además sus alergias, enfermedades, medicación y ASA («niega» si lo negó, «no preguntado» si nadie lo preguntó) y, debajo, su última atención; abrir la página queda en «Consultas a la historia», como cualquier lectura de la historia. Recepción ve la misma lista, sin nada clínico; caja ve lo del presupuesto, sin citas ni controles, y donde falta reservar una cita dice que la reserva recepción.",
      },
      {
        q: "¿Tengo que cambiar de pestaña para revisar, firmar o cobrar desde el Resumen?",
        a: "No: cada botón de su página hace lo suyo ahí mismo. «Revisar» abre sus antecedentes con el formulario listo, «Firmar» abre la pantalla de firma, «Cobrar» abre el cobro y «Abrir» o «Escribirle» abren su conversación. Al cerrar sigues donde estabas. Adjuntos, audio y responder entre varios temas siguen en la Bandeja, con «Ver toda la conversación».",
      },
      {
        q: "¿Dónde quedaron Atenciones, Recetas u Órdenes?",
        a: "Clínica tiene cuatro secciones: Antecedentes, Odontograma, Historia y Documentos. Historia es lo que pasó y cuándo, día por día: cada atención es una tarjeta con quién atendió, el diagnóstico con su nombre y su código, lo que se hizo, lo que se indicó (tratamientos, presupuesto, controles, recetas y pedidos) y lo que se firmó; la atención que sigue en curso también es su tarjeta, marcada «En curso · sin firmar», porque lo de dentro aún puede cambiar; lo anulado va plegado al final de su día, con su motivo, quién y cuándo. En el celular, la lista de hallazgos va justo debajo del odontograma. Documentos es para buscar un papel: una sola lista con «Requieren acción» y un filtro por tipo (recetas, órdenes, consentimientos, formularios, imágenes y, en clínicas de Perú, odontogramas firmados); «Nuevo» abre directo el formulario.",
      },
      {
        q: "¿Cómo llevo un tratamiento de varias sesiones?",
        a: "Con sus sesiones previstas en el Plan, por ejemplo una corona en dos: al indicarlo nace con las sesiones habituales de su servicio, y las cambias ahí mismo o después con «Planificar…». Cada cita que lo lleva dice en qué sesión va («sesión 1 de 2») en la Agenda, en la cita y en «Qué sigue», y al reservar la siguiente, «Para esta cita» lo ofrece mientras le falten sesiones. Si vuelve sin cita, arriba de la atención «Hoy viene a…» lo dice con su sesión (por ejemplo, la endodoncia de la 46 en su sesión 2 de 2) y «Continuar hoy» lo trae, con el motivo y el diagnóstico que sigue si faltan; nada se da por hecho hasta registrar su procedimiento. En «Realizado hoy» dice en qué sesión va y «Registrar la sesión» hasta que registras su procedimiento; con la sesión de hoy, «Completar» lo cierra. Si lo indicas desde la pieza del odontograma, el panel también pide «Sesiones previstas» con las habituales del servicio, y «Cambiar» un tratamiento indicado hoy por otro también las pide, con las habituales del nuevo, y lo pasa a la fase que le toca (una exodoncia cambiada por una endodoncia deja la cirugía). Al firmar, lo que llega a sus sesiones previstas pregunta «¿Terminaste?» diciendo en qué sesión va, con «Sí, terminar» ya elegido: si firmas sin cambiarlo, queda realizado. Si su tratamiento resuelve un diagnóstico de esa pieza (la pulpitis de la 46 con su endodoncia), el cierre lo propone marcado como resuelto: desmárcalo si sigue activo. Una periodontitis apical o un absceso periapical vienen sin marcar: sanan en su control con radiografía, que queda indicado al año al terminar la endodoncia. Si no terminaste, elige «Falta otra sesión»: le suma una y sigue en curso. Lo que sigue en curso sale al firmar, en «Atención finalizada», con «Reservar la sesión» y su número: abre «Nueva cita» con el tratamiento, su servicio y quien atendió ya elegido, sin salir de la atención (la de una endodoncia busca hora desde una semana después, para que actúe la medicación); si no tiene horario en la sede o no está en la especialidad del servicio, lo dice ahí y se le reserva igual o eliges a otra persona. Al reservar dice cuándo vuelve y con quién. Mientras siga en curso, «¿Cuándo vuelve?» dice su próxima sesión (con su cita, si ya la tiene) y no pide un control. En «Qué sigue», la cita de la sesión que falta va antes que lo aceptado sin empezar; la siguiente sesión se pide cuando la anterior ya se hizo, y lo que ya tiene su cita dice cuándo es («Corona · sesión 1 de 2: mar 10 nov, 9:00 · la sesión 2 se reserva en esa cita»). Si ya quedó realizado y le falta otra, en el Plan toca «Falta otra sesión»: vuelve a en curso con una sesión más y sale en «Por agendar»; lo firmado y lo cobrado no cambian. Si terminaste antes de lo previsto, «Completar» en «Realizado hoy». Si registras como servicio algo que sigue en curso en esa pieza, te avisa antes de guardar que queda como su sesión siguiente, no como un tratamiento nuevo.",
        forms: [
          "endodoncia en dos sesiones",
          "segunda sesion",
          "sesion 2 de 2",
          "completar tratamiento",
          "no me deja completar",
          "tratamiento por sesiones",
          "se termino y faltaba otra sesion",
          "reabrir un tratamiento",
        ],
      },
      {
        q: "¿La atención queda unida a su cita?",
        a: "Sí. Si el paciente tiene una cita hoy, el botón de la cabecera dice «Atender (10:00)» y la atención se une a ella; al firmarla, la cita queda atendida y su control, hecho. Si ya hay una atención en curso, el botón dice «Continuar la atención» y te lleva a ella, sin perder lo escrito. Sin cita, «Atender» la abre en un clic: arriba, «Hoy viene a…» dice lo que tiene por hacer (un tratamiento en curso, un control por cumplir) para elegirlo con un toque, o «Es una urgencia»; el motivo se escribe en «Consulta» y lo pide el cierre.",
      },
      {
        q: "¿Dónde registro un hallazgo del odontograma?",
        a: "Dentro de la atención, en el Odontograma, que siempre está a la vista con lo registrado hoy debajo (una caries de varias caras es un solo hallazgo; en la ficha, bajo el dibujo, está la lista de todo lo que tiene la boca, y tocar un renglón abre esa pieza): eliges la pieza y, en un solo panel, registras lo que observas, su diagnóstico con el tipo (el hallazgo te propone el código; cuenta como diagnóstico de la atención: no lo escribes dos veces) y, si quieres, el tratamiento, que va a su plan abierto. «Registrar y agregar al plan» lo deja todo junto. Desde Clínica › Odontograma el gráfico se consulta, con un solo historial («Evolución» y «Ver estado al»), y «Atender» está a un clic.",
      },
      {
        q: "¿Por qué me avisa que el tratamiento es para otras piezas?",
        a: "Los tratamientos de la biblioteca saben para qué piezas son: la endodoncia anterior vital es para dientes anteriores y la posterior, para molares. Si indicas uno en una pieza de otro grupo (la anterior en la 46), te lo dice sin frenarte debajo del tratamiento elegido, en el panel de la pieza o en «Indicar un tratamiento», y en su fila de «Indicado hoy»; si tu lista tiene el que encaja, ofrece «Usar» con su nombre y su precio, y tocarlo cambia el servicio. Si no lo tiene, te dice que el consentimiento llevará el nombre del que elegiste y, a quien configura los servicios, ofrece «Agregarla en Servicios y precios». Un servicio propio, sin biblioteca, no avisa. El paciente no ve el aviso.",
      },
      {
        q: "¿Por qué la pieza quedó dibujada después del tratamiento?",
        a: "Lo tratado queda dibujado: al completar un tratamiento cuyo servicio dice qué deja en la pieza (la resina deja una restauración; la exodoncia, una pieza ausente), eso se registra solo en la atención, en buen estado (azul), y lo que se trató deja de estar pendiente al cerrar. Los servicios de la biblioteca de odentIA ya lo traen; en uno propio se elige en Servicios › «Deja en la pieza».",
      },
      {
        q: "¿Cómo se firma el odontograma?",
        a: "En clínicas de Perú (NTS 188) se firma solo al cerrar la atención que cambió el gráfico, con tu perfil profesional y sin dibujar nada: el cierre te dice el momento («Inicio del plan de tratamiento», «Nuevos hallazgos» o «Culminación del plan de tratamiento») y los hallazgos. Queda en Clínica › Odontograma y en Documentos, para verlo e imprimirlo en el gráfico de la norma, con la firma electrónica y un código QR para comprobarlo; «Ver como la norma» muestra el de hoy. «Firmar odontograma» queda para un pedido judicial o de la persona y para el reingreso. En otros países el odontograma no se firma: «Imprimir odontograma» da una hoja con la numeración FDI y los hallazgos por pieza.",
      },
      {
        q: "¿Dónde hago la receta, el consentimiento o la orden de la atención?",
        a: "En la misma atención, en su bloque «Documentos», con «Nuevo»: receta, consentimiento, orden, formulario o imagen. Cada uno viene lleno con lo de la atención (pieza, diagnóstico, procedimiento y quien atiende). «Ver» abre su PDF al lado, con «Enviar», «Descargar PDF» e «Imprimir»; un consentimiento se firma ahí mismo. El papel lleva un código QR con el que cualquiera comprueba, sin cuenta, si sigue vigente.",
      },
      {
        q: "¿Se puede cambiar una receta ya emitida? ¿Qué comprueba el QR?",
        a: "Receta, orden y descanso quedan guardados como archivo al emitirse: aunque después cambien los datos de la persona o de la clínica, siempre se abre, se envía y se descarga ese mismo papel. Para corregirlo, anúlalo con su motivo y emite otro; el anulado se ve con «ANULADA» encima. El QR dice si sigue vigente, quién lo firmó y las iniciales del paciente, sin nada de salud. Si a alguien le llegó como PDF, ahí mismo comprueba que es el original, sin subir el archivo. Un papel impreso no se puede comparar así: ante una duda sobre lo que dice, que llame a la clínica. La foto de un consentimiento firmado en papel tampoco se retira; si se cargó por error, revoca ese consentimiento, retírala y vuelve a firmar.",
      },
      {
        q: "¿Qué le doy al paciente para su seguro?",
        a: "Abre la atención firmada y, en «Documentos», «Hoja de atención»: lleva el diagnóstico, la fecha, lo que se hizo, los exámenes y el tratamiento sugerido, con tu firma y tu sello, sin la nota de evolución. Envíala con la receta y la orden; el odontograma, a color. La boleta o factura electrónica la emites aparte: el ticket de caja no la reemplaza. Cada aseguradora decide qué acepta: si no admite el sello impreso, imprime el papel, séllalo a mano y que suba la foto.",
      },
      {
        q: "¿Cómo pongo mi firma en los papeles?",
        a: "Dibújala una vez en tu perfil profesional: al finalizar una atención, con «Agregar mi firma», o en Configuración › Equipo › «Mi perfil profesional» si puedes entrar ahí. Sale sola en los papeles que emites, junto a un sello con tu nombre, tu título y tu colegiatura, y cambiarla no toca lo ya emitido. Sin ella, el papel lleva una línea para firmar a mano. Solo tú puedes guardarla. Es el dibujo que se ve, no una firma digital certificada: el papel sigue diciendo «Firmado electrónicamente».",
      },
      {
        q: "¿Cómo firma la persona su consentimiento?",
        a: "Con «Firmar ahora» se abre una pantalla completa para pasarle la tablet: lee la hoja como queda en el papel, en letra grande, marca que entendió y firma con el dedo donde va su firma; si son dos, van seguidos. Al final confirmas tú con tu perfil profesional, sin dibujar otra firma. Si firmó en papel, «Firmado en papel» pide la foto de la hoja y cierra el pendiente; si no sabe firmar, la hoja en papel trae el recuadro para su huella. Con «Enviar para firmar» le llega «Firma tu consentimiento»: lee la misma hoja y la firma desde su teléfono antes de llegar, escribiendo su documento. Si su ficha no tiene su documento, si no tiene fecha de nacimiento o si es menor, la lee igual y la firma en la cita: la hoja se lo dice arriba. Lo firmado queda pendiente hasta que lo confirmes dentro de su atención: al abrirla, arriba sale «Firmó un consentimiento en su enlace»; «Revisar y confirmar» abre la hoja con quién firmó, su documento abreviado y cuándo, y «Confirmar consentimiento» lo deja firmado y anotado en esa atención. Siempre se dice el nivel real, al pie de la hoja: «Firma simple · en la clínica», «en papel» o «por enlace».",
      },
      {
        q: "¿Por qué la atención me dice «Necesita consentimiento»?",
        a: "Porque hoy haces un servicio (lo registraste, o lo trajo su cita o «Hacerla hoy») para el que tu clínica pide un consentimiento (Configuración › Consentimientos › «Se pide para»). «Preparar» lo genera lleno. Lo indicado para otro día no lo pide: se firma el día que se hace (si lo quieres firmar hoy, «Nuevo» › Consentimiento). Lo que el paciente no aceptó o no eligió ya no lo pide; si después lo acepta, vuelve a pedirlo. Si la clínica aún no lo activó, fírmalo en papel; quien configura lo verá en «Te espera».",
      },
      {
        q: "¿Cómo dejo dicho cuándo vuelve?",
        a: "Al firmar, en «¿Cuándo vuelve?»: «En 1 semana», «En 1 mes», «En 6 meses», «Otra fecha» o «No hace falta». Con uno de ellos queda su control, con el nombre de lo que hiciste hoy o de mantenimiento, y recepción lo ve para reservarlo. Si no eliges, se firma igual y el cierre te avisa: «No indicaste cuándo vuelve: recepción no lo verá». Si ya tiene un control, dice cuándo vuelve; para cambiarlo, en «Próximo control», dentro del Plan de la atención. Si un tratamiento sigue en curso, dice su próxima sesión y no pide un control: lo indicas en la sesión en que termine. Si ya terminó y tiene algo aceptado sin empezar (la corona tras la endodoncia), dice que vuelve para eso y «Atención finalizada» lo reserva ahí mismo, sin crear un control aparte; «Indicar también un control» lo pide igual.",
      },
      {
        q: "¿Por qué la corona dice «va después de terminar» la endodoncia?",
        a: "Porque en la misma pieza hay otro tratamiento aceptado que va antes y sigue sin terminar. «Hoy viene a…», «Qué sigue» y el enlace del paciente lo dicen igual, y mientras la sesión que falta ya tiene su cita, la corona no aparece como «sin cita» en Inicio ni en Pacientes. Es solo un aviso: si decides hacerla igual, «Hacerla hoy» y «Reservar» siguen ahí.",
      },
      {
        q: "Al firmar, ¿qué es «Se cargó hoy a su cuenta» y qué es «Debe en total»?",
        a: "«Se cargó hoy a su cuenta» es lo que esta atención sumó a su cuenta y no cambia. «Debe en total» es lo que le falta pagar, con lo de antes y con lo que pague ahí mismo con «Cobrar». Un tratamiento que se cobra una vez se carga en su primera sesión: en las siguientes, el cierre dice que ya se cargó.",
      },
      {
        q: "¿Cuándo queda hecho un control si vino por otra cosa?",
        a: "Cualquier atención desde unos días antes de su fecha le sirve, aunque la cita no fuera la del control: arriba de la atención, «Hoy viene a…» lo muestra con «Viene a su control»: tócalo y el cierre lo trae marcado, aunque lo haya indicado otro doctor. Al firmar, el cierre muestra su control como casilla, marcada si lo indicaste tú o si dijiste que viene a él. Desmárcala antes de firmar si esta visita no lo cumple y sigue pendiente. Si se cumplió por error, indica otro control.",
      },
      {
        q: "¿Puedo cerrar sin el consentimiento firmado?",
        a: "Sí, pero el cierre te lo dice y te pide por qué (por ejemplo, una urgencia). El motivo queda en la atención. Lo mejor es «Firmar ahora» desde el mismo cierre.",
      },
      {
        q: "¿A quién se le envía una receta o una orden?",
        a: "Solo a la propia persona o, si es menor, a su representante legal: nunca a otro número. «Enviar» le manda el PDF por WhatsApp o, si no, por correo, y queda en su conversación. El cajón dice por cada canal qué le llega y, si ninguno sirve, el botón pasa a «Imprimir» y puedes agregarle un correo. El nombre del archivo no dice nada clínico: se ve en la notificación de su teléfono.",
        forms: ["enviar la receta", "mandar la orden", "enviar el pdf", "como le mando su receta"],
      },
      {
        q: "¿Le llega el documento si no me escribió en las últimas 24 horas?",
        a: "Sí, si WhatsApp ya aprobó el mensaje de la clínica para enviar documentos: le llega con el PDF aunque hoy no haya escrito. Mientras no esté aprobado, el cajón lo dice y te deja enviarlo por correo o imprimirlo; si te escribe, ya sale por su chat. El estado del mensaje está en Configuración › Integraciones › WhatsApp, «Documento listo».",
        forms: ["pasaron 24 horas y no sale la receta", "no puedo enviar el documento por whatsapp", "documento listo"],
      },
      {
        q: "¿Qué hago si anulo una receta que ya le envié?",
        a: "Al anularla, la pantalla te dice cuándo y por dónde se le envió: avísale que no la use, porque el PDF que tiene en su chat no lleva el sello. Si ya emitiste la nueva, la receta anulada te ofrece «Enviar la receta N.º …». En su portal la anulada se ve marcada como «Anulada».",
        forms: ["anule una receta que ya envie", "receta anulada enviada"],
      },
      {
        q: "¿Cómo le llega el comprobante de su pago?",
        a: "Al cobrar, sale solo por su correo, y si tiene acceso al portal también lo ve ahí. Si no tiene correo, la caja te lo dice: entrégalo impreso o agrégale su correo en «Enviar al paciente» del ticket. Desde «Enviar al paciente» también sale por WhatsApp con su PDF, aunque hayan pasado 24 horas, si WhatsApp ya aprobó el mensaje para documentos. Si la clínica no tiene un correo conectado, solo puede ir impreso.",
      },
      {
        q: "¿Dónde está el plan de tratamiento?",
        a: "En su página, en la pestaña Plan: arriba «Qué sigue» (la misma lista del Resumen, cada fila con su botón: lo aceptado y los controles se reservan ahí, en un solo lugar), los tratamientos por fases (con «Ver» se abre su recorrido al lado), el presupuesto, los controles («Reservar» solo en el que no está ya en «Qué sigue») (el que ya pasó su día sin cita dice «Vencido»; el de quien vino hoy se cumple al firmar su atención; y si su próxima cita cae cerca de su fecha, dice que se puede hacer en esa cita) y, plegados, los planes ya terminados. Recepción ve los tratamientos con su título y estado, el presupuesto como lo recibe la persona y los controles; caja, el presupuesto y lo aceptado.",
      },
      {
        q: "¿Cómo se arma y se envía el presupuesto?",
        a: "Lo que indicas en la atención se suma solo al presupuesto por enviar de la persona y queda armado al firmarla; el cierre te pregunta «¿Enviárselo ahora?». En su Plan, «Revisar y enviar» muestra lo que encontraron, lo que se propone, hasta cuándo vale y cómo se explica cada tratamiento (la explicación sale de cada servicio y se puede cambiar solo para este paciente), con «Ver el PDF» antes de enviar. «Enviar por WhatsApp» (o por correo, si no tiene WhatsApp) dice antes a quién le llega. Si nadie lo envía, al día siguiente aparece en «Te espera» de recepción. Recepción lo envía y anota la respuesta, pero no cambia precios.",
      },
      {
        q: "¿Puedo ofrecer dos opciones, por ejemplo resina o corona?",
        a: "Sí. Lo más simple es en la atención: al indicar otro tratamiento de la misma pieza, la fila pregunta si es otro camino; con «Es otro camino», el presupuesto tiene dos opciones, y lo demás (por ejemplo la limpieza) va en las dos. También se puede en su Plan con «Duplicar como otra opción». Cada camino tiene su total (nunca se suman) y uno es el recomendado. En el plan, los caminos se ven juntos y fuera de las fases hasta que elija.",
        forms: ["dos caminos", "conservar o extraer", "otro camino para la pieza", "alternativas de tratamiento"],
      },
      {
        q: "¿Cómo anoto que aceptó una parte y lo otro lo está pensando?",
        a: "En su Plan, «¿Qué respondió?»: no hace falta que elija un camino. Lo que va en todos los caminos se marca Acepta, Para después o No; en la pieza con caminos eliges el camino, «Lo piensa» o «No acepta». Si lo piensa, sigue esperando respuesta y su oportunidad sigue abierta hasta que decida; después se completa ahí mismo, también eligiendo el camino. Lo que ya respondió no se vuelve a preguntar.",
        forms: ["acepta una parte", "aceptación parcial", "lo piensa con la muela", "no eligió opción"],
      },
      {
        q: "¿Cómo anoto que dijo que sí en la consulta, sin imprimir ni enviar?",
        a: "En la atención, el presupuesto por enviar tiene «Anotar su respuesta», también al mostrárselo en pantalla y en su Plan. Abre un solo cajón: con caminos, eliges el camino, «Lo piensa» o «No acepta»; sin caminos, «Acepta todo», «Lo piensa» o «No acepta», y si acepta solo una parte cambias cada tratamiento. Al guardar queda entregado y con su respuesta, sin enviarle nada. Si acepta algo, «Que lo firme en la tablet» es opcional: quien decide (la persona o, si es menor, su representante legal) lee su decisión en pantalla completa y firma con el dedo, y después tú guardas. Con firma, su presupuesto dice que aceptó y firmó en la clínica, con su firma; sin firma, quién decide y quién lo anotó. Lo aceptado no se cambia ahí: se corrige con una revisión, que se entrega primero y después se anota su respuesta.",
        forms: ["dijo que si en la consulta", "acepto en el sillon", "firmar el presupuesto", "firma del presupuesto en la tablet", "anotar la respuesta sin imprimir"],
      },
      {
        q: "¿Qué pasa si cambio un precio después de enviarlo?",
        a: "Se crea una revisión con el mismo número. Arriba dice qué cambió, por ejemplo que la corona sube de S/ 900 a S/ 1,000, y al enviarla, solo eso pide respuesta: lo que ya aceptó y no cambió sigue aceptado, y lo que ya se hizo o se cobró no cambia de precio. Si todavía no eligió camino, la revisión lleva todos los caminos: desmarca solo lo que ya no le ofreces. Mientras no responda, se cobra lo que ya había aceptado.",
        forms: ["revisión del presupuesto", "subir un precio", "cambiar el precio", "nuevo precio"],
      },
      {
        q: "¿Puedo ver el presupuesto que preparó una colega?",
        a: "Sí, completo, para leer: el de cualquier profesional del paciente. Cambiar precios, enviarlo o anularlo es de quien lo preparó (o de recepción, que lo envía y anota la respuesta).",
        forms: ["presupuesto de otro doctor", "presupuesto de una colega", "no veo el presupuesto"],
      },
      {
        q: "¿Un presupuesto puede tener líneas en dólares y en soles?",
        a: "Sí. Es un solo presupuesto: cada línea va en la moneda de su servicio y el total sale por moneda, como S/ 300.00 + USD 1,000.00; entre monedas no se suma ni se convierte. La persona lo ve igual en su enlace, en el portal y en el papel, y responde una sola vez. Lo aceptado se cobra después, cada moneda con su ticket.",
        forms: ["presupuesto en dos monedas", "presupuesto en dolares", "presupuesto con dolares y soles", "dos totales en el presupuesto"],
      },
      {
        q: "¿Qué quiere decir cada estado del presupuesto?",
        a: "«Por enviar»: armado y sin enviar. «Entregado · espera respuesta», impreso, enviado o mostrado en la atención. «Lo está pensando». «Aceptó todo» o «Aceptó 2 de 3»; con caminos sin elegir, dice que falta elegir el camino. En la atención, con dos opciones, dice cada una con su total y «falta que elija», y después que eligió la opción A, con lo que cuesta esa opción. «No aceptó». «Reemplazado», cuando se hizo una revisión, y «Anulado». Si pasó su vigencia sin respuesta, dice «Venció el…». Son las mismas palabras en toda la aplicación.",
      },
      {
        q: "¿Puedo anular una atención si ya preparé su presupuesto?",
        a: "Sí. Al tocar «Anular esta atención…» te dice antes de confirmar qué pasa con su presupuesto. Si no se le entregó, se anula con ella; si además lleva tratamientos de otras atenciones, solo se le quita lo de esta. Si ya se le entregó, aunque lo haya aceptado, el botón dice «Anular atención y presupuesto» y lo hace en el mismo paso; si tenía una cita para eso, sigue en la agenda y le avisas a recepción. No se puede si caja ya cobró algo de ese presupuesto (primero se anula el cobro), si algo ya se hizo en otra atención, si quien decide firmó que lo acepta o si ya respondió y lleva otros tratamientos: te dice por qué y, cuando hay dónde, te lleva a resolverlo.",
        forms: ["anular atencion con presupuesto", "no me deja anular la atencion", "anular borrador con presupuesto enviado"],
      },
      {
        q: "¿Se guarda lo que escribo en la atención?",
        a: "Sí, solo, mientras escribes: todo se escribe en la misma página, sin abrir nada, y arriba dice «Guardado» con la hora o «Guardando…». Si no se pudo guardar, el aviso dice por qué, con «Reintentar». Sin conexión, lo escrito se queda en la pantalla y se guarda al volver; mientras tanto no se puede firmar.",
      },
      {
        q: "¿Qué va en cada campo de «Consulta»?",
        a: "El motivo de consulta es lo que trae a la persona, en una línea y en sus palabras, por ejemplo: vengo porque me duele. Es lo único de «Consulta» que se pide para cerrar. El tiempo de enfermedad es cuánto lleva así, por ejemplo, 3 días. El relato de la enfermedad cuenta cómo empezó, cómo siguió, qué lo alivia o empeora y qué tomó. En un control o una revisión sin molestias, el tiempo y el relato quedan vacíos. Arriba de la atención, «Hoy viene a…» dice para qué viene: lo que se escribió al reservar su cita («Su cita: …» con «Usar como motivo»), el tratamiento que continúa o el control que le toca; elegirlo pone el motivo si está vacío. Si escribes o dictas otro, queda ese. «+ Relato de la enfermedad» abre el relato debajo del motivo.",
        forms: [
          "que va en el motivo de consulta",
          "que pongo en enfermedad actual",
          "que va en el relato de la enfermedad",
          "tiempo de enfermedad",
        ],
      },
      {
        q: "¿Cómo atiendo a un paciente?",
        a: "Con «Atender»: en la cabecera de su página, en la cita de la Agenda o en «Mis pacientes de hoy» de Inicio. Abre la atención en un clic y, si tiene una cita hoy, queda unida a ella. Lo que falta para firmar lo dice «Cierre de la atención», cada cosa con «Registrar»; cuando no falta nada, dice «Lista para firmar». Solo lo ve quien escribe en la historia clínica.",
        forms: ["como empiezo una atencion", "como inicio una atencion", "como abro una atencion", "nueva atencion"],
      },
      {
        q: "¿Por qué la atención me pide sus enfermedades y su medicación?",
        a: "Porque nunca se le preguntaron, y un problema del corazón, la presión alta, la diabetes, un anticoagulante o un embarazo cambian la anestesia y lo que se receta. Arriba de la atención, «Pregúntale a…» trae una fila por lo que falta: alergias, enfermedades y medicación, cada una con su respuesta a un toque. «Niega enfermedades» y «No toma medicación» lo dejan anotado con quién y cuándo. Lo que sí tiene se escribe con «Registrar enfermedades o medicación», que abre Antecedentes encima de la atención; al cerrar sigues donde estabas. Si se usa un anestésico local (lidocaína, articaína…) y todavía falta algo de eso o su riesgo anestésico (ASA), el cierre lo dice junto a los materiales. Nada de esto impide firmar: queda anotado lo que faltaba. La ASA se ve en «Antecedentes y última atención» y se elige en Antecedentes, en «Riesgo anestésico (ASA)».",
        forms: [
          "por que me pide antecedentes",
          "aviso de enfermedades y medicacion",
          "asa antes de la anestesia",
          "donde pongo la clasificacion asa",
          "niega enfermedades",
          "no toma medicacion",
        ],
      },
      {
        q: "¿Cómo dicto una atención?",
        a: "Dentro de la atención, pulsa «Dictar», arriba junto a «Antecedentes y última atención», y habla: Clío ordena lo que dices en sugerencias dentro de cada parte, y tú las confirmas o firmas. Al lado, «¿Qué puedo decir?» muestra ejemplos (la primera vez se abre solo) y «Escribir en vez de dictar». Aparece con Clío encendida (una clínica nueva la trae encendida; se apaga en Agente › Clío) y para quien lleva la atención. Si confirmas algo, al cerrar la atención se cuenta como una consulta de Clío de tu plan; si nadie dicta, no cuesta nada. El micrófono solo se enciende con «Dictar» o «Reanudar», y nada entra a la historia sin que lo confirmes. Lo que dictas para la nota se agrega al texto que ya estaba, no lo reemplaza, y la tarjeta lo dice antes de confirmar.",
        forms: [
          "como uso el dictado",
          "dictado",
          "dictar",
          "como funciona clio",
          "como funciona el dictado",
        ],
        general: true,
      },
      {
        q: "¿Cómo corrijo el nombre de una persona?",
        a: "En su página, en «Más acciones», «Editar datos personales»; lo que escribió el equipo manda. Ella puede pulsar «Corregir» junto a su nombre en su enlace, y si por el chat dice que se llama de otra forma, a recepción le llega la tarea «Revisar su nombre».",
        forms: ["como corrijo el nombre de un paciente", "como cambio el nombre de un paciente", "nombre mal escrito"],
      },
      {
        q: "¿Cómo borro a un paciente?",
        a: "Normalmente se archiva. Borrar de verdad es de Administración y responde a un pedido: en su página, Datos › «Privacidad y pedidos», «Revisar y borrar…» dice lo que se borra, lo que queda bloqueado y lo que hay que saber (citas, deuda), y se confirma escribiendo BORRAR.",
        forms: ["quiero borrar a un paciente", "como elimino a un paciente", "eliminar paciente", "borrar paciente"],
      },
      {
        q: "¿Cómo pongo la foto de un paciente?",
        a: "En su página, toca su foto o sus iniciales, arriba: eliges la imagen, la encuadras y «Guardar». Ahí mismo está «Quitar foto».",
        forms: ["como subo una foto del paciente", "foto del paciente", "cambiar foto del paciente"],
      },
      {
        q: "¿Dónde subo una radiografía?",
        a: "En su página › Clínica › Documentos, con «Nuevo», o en el bloque «Documentos» de la atención: imagen o archivo, con su tipo y la fecha de toma. Es una fila más de la lista y «Ver» la abre a toda la ventana: dos dedos, Ctrl + rueda o doble clic la acercan, «Más» la gira, la voltea o la pone en negativo, y «Informe y datos» trae «Comparar con».",
        forms: ["donde subo una radiografia", "subir imagen", "subir radiografia", "subir examen"],
      },
      {
        q: "¿Cómo veo una tomografía?",
        a: "En su página › Clínica › Documentos, «Ver» la abre a toda la ventana. «Panorámica» arma la panorámica con cinco cortes de la pieza: «Ir a la pieza» lleva a la pieza de la orden, también a las terceras molares, y la barra «Cortes» recorre el arco. «Cortes» la muestra desde arriba, de frente y de lado, y «3D» sirve para explicarla, no para medir. «Medir» marca dos puntos y «Ángulo», tres, con un clic o con el teclado (las flechas mueven la mira y Enter marca): quedan con tu nombre y son orientativas; para planificar una cirugía, confírmalas en el programa del tomógrafo. Si quitas una medida, «Deshacer» la vuelve a poner. Si el arco no sigue los dientes, «Más» › «Ajustar el arco» y «Terminar y guardar»: queda guardado con la tomografía. «Informe y datos» muestra el informe, la toma y las piezas sin salir de la imagen. Si el estudio trae más de una serie, «Serie» arriba elige cuál ver. En el celular, la pieza y las medidas van en la hoja de abajo.",
        forms: ["como veo una tomografia", "tomografia en 3d", "ir a la pieza", "como mido en la tomografia", "ajustar el arco", "cbct"],
      },
      {
        q: "¿Para qué es «Guardar en tu atención de hoy» en la tomografía?",
        a: "Guarda como imagen lo que estás viendo (la panorámica, los cinco cortes y tus medidas) en la nota de tu atención de hoy con ese paciente, para que quede a la vista sin abrir la tomografía. Aparece solo si tienes una atención tuya abierta hoy; si no, la pantalla te dice que la abras.",
        forms: ["guardar vista en la atencion", "guardar en tu atencion de hoy", "para que sirve guardar vista"],
      },
      {
        q: "¿Cómo cierro una orden de imagen con su resultado?",
        a: "En su página › Clínica › Documentos › Órdenes, «Subir resultado». «Ya está en la ficha» elige la tomografía o la radiografía que ya se subió (por ejemplo, la del CD que trajo) y la une a la orden sin copiarla. «Archivo nuevo» sube una imagen, un PDF o el archivo DICOM de una radiografía. Una tomografía (la carpeta del CD) se sube primero en Documentos y después se elige. La orden queda «Con resultado».",
        forms: ["como cierro una orden", "subir resultado de la orden", "resultado de la tomografia", "cerrar la orden de imagen"],
      },
      {
        q: "¿Qué son «Por agendar», «Deben» y los demás atajos?",
        a: "Filtros de la lista de Pacientes con lo que hay que mover: «Por agendar», «Presupuesto sin enviar», «Presupuesto sin respuesta», «Control vencido», «Faltan datos», «Por invitar a volver» y «Deben». Cada uno dice su regla al elegirlo. «Por agendar» es quien tiene algo aceptado sin una cita que lo lleve, aunque tenga otra cita, y «Control vencido» quien tiene un control cuyo día ya pasó y ninguna cita por venir: son las mismas cuentas de Inicio y de Argos. «Por invitar a volver» es quien no vino en 6 meses y no tiene cita, presupuesto por responder ni un control de ese tiempo: entra también quien tiene un control vencido hace más de 6 meses. Ahí, «Ya la invité» anota que la invitaste por teléfono o en persona.",
      },
      {
        q: "¿Qué hago si no se le puede enviar su enlace?",
        a: "La página dice por qué y deja «Copiar enlace», para pegarlo cuando escriba, y «Mostrar su código», para que lo escanee ahí mismo.",
        forms: ["no le puedo enviar su enlace"],
      },
      {
        q: "¿Cómo le doy acceso al portal?",
        a: "Lo puede dar recepción, el odontólogo, el administrador o la dueña. En el «…» de su página, «Portal del paciente» (también en Datos › Enlace y portal), «Dar acceso al portal»: quién entra (la persona, o su representante si es menor), comprobaste su identidad comparando el número de su documento con el que tiene en la mano, y cómo le llega (QR si está aquí, o su WhatsApp si te escribió en las últimas 24 horas). Lo que verá no se elige: todo lo suyo que la clínica deja ver. El código de 6 dígitos se lo dices tú, en persona o por llamada: nunca va con el enlace. Su enlace es otra cosa: lo que tiene pendiente (su cita, sus datos, su presupuesto, lo que tiene por firmar) sin crear una cuenta.",
        forms: ["recepcion puede dar acceso al portal", "quien da acceso al portal"],
      },
      {
        q: "¿Qué ve el paciente en su portal?",
        a: "Todo lo suyo, sin que nadie lo elija: sus citas, sus presupuestos, su cuenta y sus documentos terminados. Recetas, órdenes (con su resultado) y descansos desde que se emiten; la hoja de atención si se emitió; los consentimientos firmados; los comprobantes; los archivos subidos; y las radiografías y fotos con su informe o que no lo requieren. Lo anulado se ve marcado («Anulada», «Revocado») y una receta vencida dice «Vencida». No ve las notas de sus atenciones, la tomografía ni los archivos DICOM (no se abren en el teléfono), ni lo que es de otra persona o de un pago (la prueba de una representación, un voucher). Si representa a un menor, ve lo de su representado. Cada archivo dice en «Su portal» si se ve.",
        forms: ["que ve el paciente en el portal", "que documentos ve en el portal", "el paciente ve sus radiografias"],
      },
      {
        q: "¿Cómo oculto una imagen o un archivo de su portal?",
        a: "Abre el archivo en Documentos y, en «Su portal», toca «No mostrar en su portal». Vale para cualquier archivo subido, también un documento escaneado, y para todo acceso, de hoy y de mañana. La fila dice «Oculto en su portal» y se vuelve a mostrar con «Mostrar en su portal». Lo cambia quien escribe en la historia. El PDF de un consentimiento no se oculta suelto: en su portal se ve el consentimiento.",
        forms: ["no mostrar en su portal", "ocultar una foto del portal", "que no vea una radiografia"],
      },
      {
        q: "¿Qué hago si cambió de teléfono y no entra al portal?",
        a: "Si lo pide por el chat, Sofi lo deja en «Te espera». En su página, «…» › «Portal del paciente», «Enviar nuevo enlace»: no hace falta volver a comprobar su identidad; el enlace anterior y las sesiones que tenía abiertas dejan de servir. Puedes mostrarle el QR o enviárselo por su WhatsApp, y el código se lo dices tú. «Quitar acceso» cierra todo, también su acceso guardado.",
      },
    ],
  },
  {
    id: "oportunidades",
    path: "/pipeline",
    alsoAt: ["/opportunities"],
    title: "Oportunidades",
    parent: "Personas",
    purpose:
      "El tablero de ventas: cada interés concreto de una persona (un precio, un tratamiento, una evaluación, un presupuesto que se le entregó) en cuatro pasos que avanzan solos: Interesado, Evaluación agendada (al agendar su cita), Presupuesto enviado (al presentarle el presupuesto) y Decidió (al aceptarlo o rechazarlo), que se ve en dos mitades: Ganadas y Perdidas. Cada tarjeta dice por qué está donde está y cuál es su tarea. Muestra lo abierto y lo decidido en los últimos 30 días; el total suma solo lo abierto.",
    terms: [
      "embudo",
      "pipeline",
      "ventas",
      "interesados",
      "tablero",
      "kanban",
      "cerrar una oportunidad",
      "ganada",
      "perdida",
      "mover a",
      "avanza sola",
      "tomar",
      "no se decidieron",
      "seguimiento de interesados",
      "preguntaron",
      "no cierran",
    ],
    writePermission: "crm.write",
    faqs: [
      {
        q: "¿Por qué una oportunidad cambió de paso sola?",
        a: "Porque pasó algo real: al agendar su cita pasa a «Evaluación agendada», al presentarle el presupuesto a «Presupuesto enviado», y al aceptarlo (aunque sea en parte) se gana; al rechazarlo se pierde. Si cancela la evaluación y no le queda otra cita, vuelve sola a «Interesado». La tarjeta y el historial dicen qué la movió.",
      },
      {
        q: "¿Cómo cierro una oportunidad?",
        a: "Ábrela y pulsa «Ganada» o «Perdida», o arrástrala a esas columnas de «Decidió». Perdida pide el motivo: precio, eligió otra clínica, no responde, ya no lo necesita u otro.",
      },
      {
        q: "¿Qué es «Recepción · sin persona asignada»?",
        a: "La oportunidad que creó Sofi o que nadie lleva todavía es de Recepción. «Tomar» la deja a tu nombre, con su tarea.",
      },
      {
        q: "¿Por qué apareció una oportunidad que nadie creó?",
        a: "Con «Oportunidades» encendida en Sofi, quien pregunta por el precio o la disponibilidad de un servicio concreto queda anotado en «Interesado», en Recepción. Si ya tenía una abierta de ese servicio se actualiza, y si ya aceptó un presupuesto con él no se anota nada. También se abre sola al entregar un presupuesto (imprimirlo o enviarlo) a quien no tenía una abierta, por ejemplo el que se hizo con el paciente en el sillón: aparece en «Presupuesto enviado», en Recepción, con sus tratamientos por nombre y el total como valor, y su historial dice quién lo entregó. Si ya tenía una abierta, el presupuesto se une a esa, aunque sea de otro tratamiento, y la tarjeta conserva su nombre; si esa esperaba la respuesta a otro presupuesto, cada uno tiene la suya. Reenviarlo no abre otra. Si se anula, la que nació de él se cierra como perdida, salvo que ya tenga una tarea o una nota: entonces sigue abierta, sin el presupuesto. Si nadie lo responde, a los 30 días de vencido la que nació de él se cierra sola como perdida, «No responde», y la tarjeta avisa la fecha antes. No pasa si alguien la lleva, le dejó una tarea o una nota o la cambió a mano, si la persona escribió por ese tratamiento o si hay una nueva versión del presupuesto en preparación. Si la persona responde después, se reabre: aceptarlo o rechazarlo la cierra con su respuesta, y si contesta que lo está pensando, queda abierta. Entregar una nueva versión de un presupuesto perdido también la reabre.",
      },
    ],
  },
  {
    id: "agente",
    path: "/agent",
    title: "Agente",
    parent: null,
    purpose:
      "El resumen de tus agentes (Sofi, tu agente de recepción; Clío, tu agente clínico, y Argos, tu agente administrador): cómo van, qué necesita de ti y la entrada para configurar cada uno, el «Horario de recontacto», lo que aprenden y lo que sabe Sofi. El número junto a Agente en el menú cuenta lo que se resuelve aquí: respuestas por revisar y lecciones por aprobar. Los casos que te pasa Sofi están en «Te espera», y el número junto a Inicio cuenta las personas que te esperan. En «Actividad» ves lo que envió, propuso o te pasó (recepción entra directo ahí); lo que espera el sí de una persona, en su conversación de la Bandeja.",
    terms: [
      "sofi",
      "clío",
      "inteligencia artificial",
      "ia",
      "bot",
      "asistente virtual",
      "automático",
      "pendientes",
      "aprobaciones",
      "esperan su sí",
      "confirmó por teléfono",
      "casos derivados",
      "casos del agente",
      "te lo pasó el agente",
      "conocimiento",
      "aprender",
      "tope diario",
      "autonomía",
      "cerrar conversaciones",
      "horario de recontacto",
      "horario de silencio",
      "a qué hora escribe",
      "lo que el agente debe saber",
      "indicaciones",
      "reglas",
      "apagar sofi",
      "encender sofi",
      "encender clío",
      "apagar clío",
      "probar sofi",
      "qué sabe sofi",
      "lo que sofi debe saber",
      "recepcionista virtual",
      "activar inteligencia artificial",
      "enseñar",
      "corregir",
      "la ia",
      "dato mal",
      "qué sabe el bot",
    ],
    writePermission: "agent.write",
    faqs: [
      {
        q: "¿Cómo enciendo el agente?",
        a: "En Agente › Sofi, usa el interruptor de arriba («Ver y encender» te lleva desde Agente). Te muestra cinco comprobaciones (canal, que el modelo responda, que sepa tu horario y tus servicios, si lo probaste y quién recibe los casos); lo que falta te lleva a donde se resuelve. Sin un canal o sin un modelo que responda no se enciende. Una clínica nueva la trae encendida: responde desde que conectas un canal. Clío y Argos tienen el suyo en su página.",
      },
      {
        q: "¿Qué hago si el modelo no responde?",
        a: "Los mensajes pasan a tu equipo y odentIA ya lo sabe: no tienes que arreglar nada. El aviso se va solo cuando el modelo vuelve a responder.",
      },
      {
        q: "¿Cuándo cierra Sofi una conversación?",
        a: "Cuando la persona agradece o se despide y no queda nada pendiente, cuando ya reservó su cita y pasó una hora sin mensajes, y cuando deja de responder: por defecto a las 22 horas de su último mensaje (lo cambias en la página de Sofi, entre 6 y 23 horas, porque pasadas 24 WhatsApp ya no deja despedirse). Con una persona del equipo a cargo no se cierra sola. Cuando la persona escribe, Sofi responde siempre, a cualquier hora y por cualquier canal; y si pasa el caso a una persona, siempre le avisa.",
      },
      {
        q: "¿Cómo le enseño algo al agente?",
        a: "Sofi lee al momento los datos de tu clínica: horario del equipo, sedes, servicios y precios, promociones y medios de pago; se editan donde viven y Agente › Conocimiento te muestra todo lo que toma. Ahí agregas lo que solo tú sabes (estacionamiento, cuotas, seguros…). Cómo quieres que atienda va en Agente › Sofi, en «Lo que Sofi debe saber»: una sola lista, de hasta 40 reglas de 300 caracteres, con lo que escribe la clínica («Escrita por la clínica», con quién y cuándo) y lo que aprendió de tus correcciones («Aprendida», con la conversación de la que salió y quién la aprobó). Todas se editan y se retiran igual, y lo retirado se puede restaurar. Si respondió mal o buscó algo y no lo encontró, está en Agente › Aprender, en «Por revisar»: lo corriges o lo das por bueno, y lo que apruebes se puede retirar después. Al aprobar o escribir una regla que contradice otra te lo dice antes, y eliges cuál queda.",
        forms: ["como le enseno algo a sofi", "como le enseno a sofi", "como entreno a sofi"],
      },
      {
        q: "¿A qué hora le escribe odentIA a una persona?",
        a: "En el «Horario de recontacto», en Agente: es el horario decente para volver a contactar. Se configura por día, con el mismo editor de los horarios del equipo, y viene así: lunes a viernes de 8:00 a 20:00 (escribimos), sábado de 8:00 a 14:00 (escribimos) y domingo sin mensajes (no escribimos). Vale para todo lo que odentIA envía por su cuenta —recordatorios, controles, seguimientos, novedades y lo que inicia Sofi—, con la hora de cada sede. Si un mensaje toca fuera del horario, sale en el último momento permitido antes o, si no hay, en el primero después, siempre que falte al menos una hora para la cita. Los avisos de algo que pasó, como una cita cancelada, salen al momento. Cuando la persona escribe, Sofi responde siempre, a cualquier hora.",
      },
      {
        q: "¿Qué horario usa cada cosa?",
        a: "Hay dos y cada uno sirve para algo distinto. De atención: la agenda y las horas que se ofrecen para reservar (Configuración › Horarios y ausencias). De recontacto: cuándo Sofi escribe primero (Agente). Para responder no hay horario: cuando la persona escribe, Sofi responde siempre.",
      },
      {
        q: "¿Dónde veo las citas que esperan el sí de alguien?",
        a: "En su conversación de la Bandeja: la fila dice «Espera su sí» y la tarjeta de Sofi tiene «Registrar confirmación» (si dijo que sí en el chat) y «Confirmó por teléfono» (si lo dijo por otra vía); las dos reservan con la misma regla que Sofi y, si el horario ya no está libre, te lo dicen. Si no responde, Sofi insiste una vez y, al despedirse, le dice que dejó libre ese horario.",
      },
      {
        q: "¿Qué es Sofi?",
        a: "Tu agente de recepción: atiende a quien escribe a la clínica por todos los canales, responde, agenda y hace seguimiento, y pasa el caso a una persona cuando corresponde. Clío es tu agente clínico, que ordena lo que dicta quien atiende, y Argos tu agente administrador, que mira cómo va la clínica y hace lo que le encargues.",
        forms: ["quien es sofi", "que hace sofi", "quien es clio", "que es clio", "que hace clio"],
      },
      {
        q: "¿Cómo apago a Sofi?",
        a: "En Agente, con el interruptor de su fila, o en Agente › Sofi. Apagada, los mensajes pasan a tu equipo.",
        forms: ["como apago el agente", "apagar el agente"],
      },
      {
        q: "¿Cómo enciendo a Clío?",
        a: "Una clínica nueva la trae encendida. Se enciende o se apaga en Agente › Clío, con su interruptor; encendida, quien lleva la atención ve «Dictar» dentro de ella.",
        forms: ["como activo a clio", "como apago a clio"],
      },
      {
        q: "¿Cómo cambio el nombre de Sofi?",
        a: "En Agente › Sofi, abre «La base» y cambia «Se presenta como». Vale solo para tu clínica; si lo dejas vacío, se llama Sofi.",
        forms: ["como le cambio el nombre a sofi", "como le pongo otro nombre a sofi"],
      },
      {
        q: "¿Cómo pruebo a Sofi?",
        a: "En Agente › Sofi, «Probar» abre una conversación real con una persona de prueba, también con Sofi apagada: lo que hace con su sí se crea de verdad, marcado como prueba, y se borra con la prueba.",
        forms: ["como la pruebo", "probar a sofi", "como probar el agente"],
      },
      {
        q: "¿Cómo corrijo una respuesta de Sofi?",
        a: "Debajo de su mensaje, «En qué se basó» › «Corregir», o en Agente › Aprender, «Por revisar». Tu corrección queda como una lección y Sofi la usa cuando alguien la aprueba.",
        forms: ["por que sofi respondio mal", "sofi respondio mal", "sofi se equivoco", "corregir a sofi"],
      },
    ],
  },
  {
    id: "administrador",
    path: "/agent/administrador",
    title: "Argos",
    parent: "Agente",
    purpose:
      "Argos, tu agente administrador, mira cómo va la clínica. Su página es la lista de lo que puede hacer por su cuenta: recordar citas, avisar controles, retomar presupuestos u oportunidades o dejar tareas a tu equipo. Cada línea se prende o se apaga con su interruptor y dice quién lo hace: «Lo hace Argos» o «Le toca a una persona».",
    terms: [
      "argos",
      "administrador",
      "recordatorios",
      "mensajes automáticos",
      "automatizaciones",
      "avisos",
      "reglas",
      "seguimientos",
      "recomendaciones",
      "asesor",
      "enviar recordatorio",
      "recordatorio",
      "prender recordatorios",
      "recordatorio no llega",
    ],
    writePermission: "agent.write",
    faqs: [
      {
        q: "¿Dónde enciendo los recordatorios de cita?",
        a: "Una clínica nueva trae prendidos «Recordar la cita» (la línea «Una persona tiene una cita»), Argos y Sofi. Si apagaste alguno, para que salga enciende a Argos con el interruptor de arriba y a Sofi en su página: la página de Argos te avisa si falta alguno. El recordatorio es parte del servicio y llega a todos, salvo a quien se dio de baja.",
      },
      {
        q: "¿Puedo pedirle algo con mis palabras?",
        a: "Sí, con Argos encendido y si administras el agente. En Agente › Argos, escribe en «Dile qué quieres que haga» lo que quieres: prender, apagar o ajustar una línea, o que le ofrezca otra fecha a quien cancela su cita. Te lo deja como borrador con su flujo y una prueba con tus últimos 30 días; nada cambia hasta que lo prendas o lo guardes.",
      },
      {
        q: "¿Por qué Sofi no le escribió a una persona?",
        a: "En Agente › Argos, abre la línea y mira «Qué pasó, persona por persona»: dice el motivo (pidió no recibirlo, no tiene WhatsApp ni correo, o WhatsApp aún no aprueba el mensaje) y cómo habilitarlo. Además, sale como mucho un mensaje al día por persona y, al llegar al presupuesto del mes, se pausan los mensajes para recuperar pacientes.",
      },
      {
        q: "¿A qué hora se escriben los mensajes de Argos?",
        a: "Los envía Sofi dentro del «Horario de recontacto» de Agente, el horario decente para volver a contactar: el mismo para todo lo que sale solo.",
      },
    ],
  },
  {
    id: "finanzas",
    path: "/finance",
    title: "Finanzas",
    parent: "Gestión",
    purpose:
      "La caja y lo cobrado, por sede: Caja (el día, con lo que hay por cobrar ahora), Cobros (todos los tickets, con búsqueda y filtros), Deudas, Gastos y, para quien administra, Comisiones.",
    terms: [
      "caja",
      "cobros",
      "pagos",
      "ingresos",
      "gastos",
      "arqueo",
      "cierre de caja",
      "deudas",
      "cobranza",
      "a favor",
      "saldo",
      "aplicar lo que tiene a favor",
      "anular ticket",
      "devolver",
      "devolución",
      "reembolso",
      "cobrar",
      "cobro",
      "registrar pago",
      "registrar un cobro",
      "cobrar atención",
      "lo que me deben",
      "ticket",
      "gasto",
      "cuánto cobramos",
      "pago",
      "devolver",
      "anular",
      "adelanto",
      "cuotas",
      "movimientos",
      "movimientos de caja",
      "cuadrar caja",
      "pagó con",
      "me debe",
      "nos deben",
      "los que deben",
      "pagó la mitad",
      "pago con yape",
      "cobrar consulta",
      "otra moneda",
      "dólares",
      "cambio de hoy",
      "tipo de cambio",
      "vuelto",
      "venta de mostrador",
      "mostrador",
      "vender sin ficha",
    ],
    writePermission: "finance.write",
    faqs: [
      {
        q: "¿Por qué el saldo es menor que lo que debe?",
        a: "Porque descuenta lo que la persona tiene a favor (un adelanto o un cobro de más): «Debe: 100 · A favor: 100 · Falta pagar: 0». Si debe y cobras un adelanto sin «Para», el cobro te lo avisa y «Mejor, a lo que debe» lo cobra a su deuda; cada ticket dice cuánto le falta pagar y cuánto le queda a favor. Así se ve en su cuenta, en su Resumen, en el portal y en los avisos. Lo que se le devolvió de lo que tenía a favor sale en su cuenta, debajo del cobro de donde salió, con cuánto, cuándo y por qué. «Aplicar lo que tiene a favor» te dice el importe y la sede antes de hacerlo; al confirmar cancela la deuda y deja el movimiento registrado, sin dinero nuevo. Si no alcanza, te dice lo que falta.",
      },
      {
        q: "¿Cuánto le falta pagar de su tratamiento?",
        a: "En su página › Cobros, «Tratamiento aceptado» dice por cada presupuesto aceptado lo aceptado, lo que pagó y lo que falta, cada moneda en su renglón (soles y dólares no se suman). Lo que falta incluye lo que todavía no se cobra porque aún no se hace. Si además tiene algo a favor sin tratamiento, se dice debajo: se usa en su próximo cobro. Lo ven caja, la dueña y la administración.",
        forms: ["cuanto le falta pagar", "cuanto me falta en total", "total del tratamiento", "cuanto debe del tratamiento", "cuanto pago del presupuesto"],
      },
      {
        q: "¿Cómo cobro un adelanto para un tratamiento?",
        a: "En su página › Cobros, en «Tratamiento aceptado», «Cobrar un adelanto» abre el cobro con «Para» ya elegido; también puedes elegirlo al cobrar un adelanto. Ese dinero queda pagado en ese tratamiento: no queda suelto a favor ni se usa en otro cobro, y al hacerlo se cobra solo lo que falta. Se paga en la moneda del tratamiento. Con «Lo próximo que pague» queda a favor, como siempre. Lo que se cobra por sesión no se adelanta así: queda a favor y cancela la visita al cobrarla.",
        forms: ["adelanto para la corona", "adelanto para un tratamiento", "deja un adelanto", "pago a cuenta del tratamiento", "adelanto del presupuesto", "dejo plata para su tratamiento"],
      },
      {
        q: "¿Cómo dejo el alquiler o los sueldos de cada mes?",
        a: "En Finanzas › Gastos, en «Lo que se repite», toca «Anotar lo que se repite»: en qué se gasta, el tipo, lo de siempre, el día y cada cuánto (cada mes, cada 6 meses o cada año). Si ya se repite algo parecido, el cajón lo dice para no anotarlo dos veces: puedes cambiar ese o anotarlo igual. Anotar no paga: queda «por pagar» cada vez que toca, desde el primer mes cuyo día aún no pasó, y nunca se paga solo. Para pagarlo, «Pagar» abre el gasto ya lleno con el importe y el medio de siempre: si llegó otro importe, como pasa con la luz, lo cambias ahí. En su menú puedes marcar «No hubo este mes», cambiarlo o dejar de repetirlo: deja de repetirse desde el mes que viene, y lo vencido y lo de este mes siguen por pagar. Un sueldo puede llevar de quién es: se ve junto a su comisión, y lo ven, pagan y cambian solo quienes administran las comisiones; caja y los demás ven «Sueldos» en una sola fila, sin nombres, y el pago sale en Caja como «Pago de sueldo». Bajo «Gastado», la línea de lo que se repite dice cuánto cae en ese mes, lo pagado y lo que falta; en Reportes se llama igual.",
        forms: ["gasto fijo", "gastos fijos", "pago mensual", "alquiler cada mes", "sueldo de la recepcionista", "gasto que se repite", "gasto recurrente"],
      },
      {
        q: "¿Cómo registro un gasto?",
        a: "En Finanzas › Gastos, «Registrar gasto»: escribe en qué se gastó, el importe y el tipo, y elige con qué se pagó, con los mismos medios de Cobrar. Solo el efectivo sale de la caja: la caja dice cuánto queda o cuánto falta, con el botón para ingresarlo. Con Yape, tarjeta o transferencia puedes anotar el n.º de operación. El comprobante se elige de la lista del país (boleta, factura, recibo por honorarios, recibo de servicios públicos) con su número; con factura o recibo por honorarios, también a quién se pagó y su RUC, para tu contador. Si es una compra de Inventario, elígela en «¿Es el pago de una compra?»: así no se cuenta dos veces. Lo que se repite, como el alquiler o la luz, se anota en «Lo que se repite»; y si ya está en «Por pagar», se paga con «Pagar» en su fila, así deja de estar por pagar y no queda dos veces.",
        forms: ["registrar un gasto", "anotar un gasto", "donde anoto ese gasto", "donde anoto un gasto", "pague la luz", "gasto de la farmacia", "como anoto lo que pague"],
      },
      {
        q: "¿Cómo anoto una factura que pago después, como la del laboratorio?",
        a: "En Finanzas › Gastos, en «Por pagar», toca «Anotar una factura»: a quién se le debe, el comprobante con su número y su RUC, el importe, cuándo se emitió y, si quieres, cuándo vence y de qué paciente y tratamiento es. Anotarla no paga ni saca dinero de la caja: queda en «Por pagar» hasta que se pague. Para pagarla, «Pagar» en su fila abre el gasto ya lleno; puedes pagar una parte y lo que falta sigue por pagar. Si te equivocaste al anotarla, en su menú están «Corregir la factura» y «Anular la factura» (los dos, solo sin pagos). Si abres «Registrar gasto» y todavía no lo pagas, «Anotar la factura por pagar» te lleva ahí. Quien administra las comisiones ve en la cuenta de la paciente lo que costó el laboratorio junto a lo que pagó. Lo que se debe de facturas también sale en Reportes › Lo que debes.",
        forms: ["factura del laboratorio", "pagar a fin de mes", "factura por pagar", "le debo al laboratorio", "cuanto le debo al laboratorio", "anotar una factura", "cuentas por pagar"],
      },
      {
        q: "¿Cómo le paso los gastos del mes a mi contador?",
        a: "En Finanzas › Gastos, «Descargar el mes» baja la lista del mes y la sede que ves en un archivo de hoja de cálculo: la fecha del pago, en qué se gastó, el tipo, el comprobante con su código y su número, el proveedor y su RUC, con qué se pagó y el n.º de operación, el importe, la sede y si está vigente o anulado, con su motivo. Si buscas algo o eliges un tipo, el botón dice «Descargar lo que se ve» y baja solo eso. Lo anulado va con su motivo y sin sumar: la columna «Suma en el mes» da lo mismo que «Gastado». La fecha es la del pago, no la del comprobante. Quien no administra las comisiones ve los sueldos y las comisiones juntos, sin nombres, como en la lista.",
        forms: ["pasar los gastos al contador", "descargar los gastos", "gastos para el contador", "registro de compras", "lista de gastos del mes"],
      },
      {
        q: "¿Cómo corrijo un gasto mal anotado?",
        a: "Toca el gasto en la lista: se abre su detalle, con «Anular» y «Corregir». «Corregir» abre el mismo cajón con todo puesto; al guardar, el de antes queda anulado con lo que cambió (por ejemplo, de S/ 24.00 a S/ 42.00) y queda este, enlazado. En la lista se ve uno, con la marca «Corregido», y en su detalle, cada versión anterior con lo que cambió. Si salió de la caja, vuelve lo de antes y sale lo nuevo. Si la caja de ese día ya se cerró, lo corrige o lo anula administración: escribe el motivo y «Pedírselo a administración» se lo deja como tarea. El pago de una compra se corrige en su compra, y el de una comisión, en Comisiones.",
        forms: ["corregir un gasto", "me equivoque en el importe", "cambiar un gasto", "editar un gasto", "anote mal un gasto"],
      },
      {
        q: "¿En qué tipo va cada gasto?",
        a: "«Sueldos» es lo que se le paga al equipo, sin las comisiones; «Alquiler», el de la sede; «Laboratorio», coronas, prótesis y trabajos de laboratorio; «Materiales», insumos como algodón, guantes o resinas; «Servicios básicos», luz, agua, internet y teléfono; «Impuestos», el IGV de lo cobrado, la renta o los arbitrios; y «Otros», lo demás, como un taxi, útiles o limpieza. Al elegir el tipo, el cajón lo dice debajo.",
        forms: ["que tipo de gasto", "en que tipo va", "personal es mi gasto", "servicios es lo que vendo", "tipo de gasto"],
      },
      {
        q: "¿Por qué en Gastos sale «Pago de comisiones» sin decir a quién?",
        a: "Porque la comisión de cada profesional solo la ve quien administra las comisiones. Los demás ven en Gastos una sola fila por sede con el total pagado en comisiones ese mes: suma igual que antes, pero no dice a quién se pagó. Quien administra ve cada pago con «Ver el pago», que lo lleva a Comisiones; el pago de una comisión se anula allí, no en Gastos.",
        forms: ["pago de comisiones en gastos", "por que no veo a quien se pago la comision", "anular el gasto de una comision"],
      },
      {
        q: "¿Por qué el pago del impuesto de lo cobrado no suma en «Gastado»?",
        a: "Porque no es un gasto: ese impuesto (el IGV en el Perú) ya salió de lo cobrado, y la clínica solo lo entrega. Al registrarlo con el tipo «Impuestos» queda en la lista con la marca «No suma», y debajo de «Gastado» se dice cuánto fue. Así Gastos y Reportes dicen lo mismo del mes. Los otros impuestos (renta, municipales) sí son gastos y suman.",
        forms: ["el igv no suma en gastos", "por que gastos no cuenta el igv", "gastado no coincide con reportes", "pague el igv y no aparece en el total"],
      },
      {
        q: "¿Anulo el ticket o hago una devolución?",
        a: "«Anular ticket» es para un error al cobrar (otro medio, otro monto, otra persona): deshace la venta y el pago, los productos vuelven a la sede y lo atendido queda por cobrar; después cobras de nuevo y sale otro ticket. Se puede hasta el cierre de caja; después, administración. Si el paciente vuelve otro día, devuelve algo o pide su dinero, abre su ticket y usa «Devolver»: la venta queda, eliges qué devuelve y si vuelve a la sede, y le pagas en el momento o le queda a favor. La devolución tiene su número y se imprime y se envía como el ticket. Si la comisión de ese cobro ya se le pagó al profesional, el aviso de «Anular ticket» lo dice: no frena la anulación, y lo pagado queda por descontar de su próximo pago.",
      },
      {
        q: "¿Dónde busco un ticket de otro día?",
        a: "En Finanzas › Cobros: la tabla de todos los tickets, con lo que suma lo que ves. Un número busca en todas las fechas y el ticket se abre al lado.",
        forms: ["donde veo un ticket viejo", "buscar ticket", "buscar boleta"],
      },
      {
        q: "¿Cómo cobro una atención?",
        a: "En Finanzas › Caja, «Por cobrar ahora» trae lo atendido, o «Cobrar» para empezar; eliges el medio de pago y sale su ticket. El comprobante le llega en PDF por su chat o su correo, y queda en su portal.",
        forms: ["como cobro", "como le cobro a un paciente", "como registro un pago", "como registro un cobro"],
      },
      {
        q: "¿Cómo vendo algo a quien no es paciente?",
        a: "En Finanzas › Caja o Cobros, «Venta de mostrador»: buscas o escaneas lo que se vende, con su cantidad, y en «Para quién (opcional)» eliges «Buscar a la persona», «Solo su nombre» o «Sin nombre». Se paga entera, con uno o varios medios; en efectivo escribes lo que recibes y ves el vuelto. No abre una ficha ni entra en la cuenta de nadie, aunque la persona sea paciente: el ticket dice «Cliente» o «Venta de mostrador», el producto sale de la sede y el dinero entra en su caja. Se imprime, se devuelve o se anula como cualquier ticket; lo devuelto siempre se le paga, porque sin ficha no queda a favor.",
        forms: [
          "venta sin ficha",
          "vender sin ficha",
          "venta de mostrador",
          "vender a alguien que no es paciente",
          "vender un producto sin paciente",
          "vender lentes de sol",
          "cobrar a un cliente sin historia",
          "venta rapida",
        ],
      },
      {
        q: "¿Cómo cobro en otra moneda?",
        a: "Si la clínica también cobra en otra moneda, el cobro se abre en la moneda de lo que debe: lo que está en dólares se debe en dólares hasta que se paga. En «Paga con» eliges con qué paga y en «Tipo de cambio» llega el de hoy; si lo cambias ahí, vale solo para ese cobro y, si es muy distinto, te avisa. Escribes lo que te da y debajo ves cuánto cancela y lo que queda por cobrar. Si debe en las dos monedas, cada una lleva su ticket: al terminar, «Cobrar lo que falta» abre la otra.",
        forms: ["como cobro en dolares", "debe en dolares y paga en soles", "paga en soles lo que debe en dolares", "cobrar en dolares", "cobro cruzado", "como le cobro en dolares"],
      },
      {
        q: "¿Dónde cambio el tipo de cambio de hoy?",
        a: "En Finanzas › Caja, arriba: dice el «Tipo de cambio de hoy», quién lo puso y «Cambiar», si puedes cobrar o configurar la clínica. Es lo que se propone en los cobros que vienen; lo ya cobrado no cambia, porque cada cobro guarda el suyo.",
        forms: ["donde pongo el cambio de hoy", "como pongo el tipo de cambio", "donde cambio el tipo de cambio", "actualizar el tipo de cambio"],
      },
      {
        q: "¿Cómo doy el vuelto en otra moneda?",
        a: "Si paga en efectivo en la otra moneda y da un billete más grande, escribe el billete en «Recibes en efectivo» y elige en «Vuelto en» si lo das en esa moneda o en la del negocio. Antes de cobrar se lee lo que entra a cada caja y lo que sale de cada una: por S/ 300 a 3.75, un billete de USD 100 deja USD 100 en la caja de dólares y saca S/ 75 de la de soles. El ticket dice lo recibido y el vuelto, cada uno con su moneda.",
        forms: ["como doy vuelto en soles si paga en dolares", "vuelto en otra moneda", "paga con un billete en dolares"],
      },
      {
        q: "¿Cómo cierro la caja si cobro en dos monedas?",
        a: "Cada moneda tiene su caja: en Finanzas › Caja ves el efectivo de cada una y nunca se suman. En «Cerrar caja» eliges cuál cierras, cuentas solo esa moneda y la otra sigue abierta hasta que la cierres; te avisa si falta. El cierre muestra «Tipos de cambio usados en esta caja». Cambiar dólares por soles se anota como un retiro de una caja y un ingreso en la otra.",
        forms: ["como cierro la caja de dolares", "cerrar caja en dos monedas", "cierre de caja con dolares", "caja de dolares"],
      },
      {
        q: "¿Qué dice el ticket si pagó en otra moneda?",
        a: "Arriba, lo que canceló, en su moneda; abajo, con qué pagó y a qué cambio, cuánto por cada medio de pago, «Recibido» y «Vuelto». Si el cobro usó dos monedas, cada cifra lleva su símbolo. El papel y el comprobante dicen lo mismo.",
        forms: ["ticket en dolares", "que dice el comprobante si pago en dolares"],
      },
      {
        q: "¿Qué pasa si anulo o devuelvo un cobro en otra moneda?",
        a: "Sale lo que entró, en esa misma moneda y en proporción, sin cambio nuevo: el cambio de hoy no cuenta. Si pagó en soles lo que debía en dólares, se le devuelve en soles. Lo que tiene a favor en una moneda no se usa para la otra.",
        forms: ["devolver un pago en dolares", "anular un cobro en dolares"],
      },
      {
        q: "¿Cómo registro un gasto o pago una compra en dólares?",
        a: "En Finanzas › Gastos, con otra moneda en la clínica, eliges la «Moneda» del gasto y su «Tipo de cambio». Al pagar una compra en dólares puedes pagarla en soles: en «Lo que salió» escribes lo que salió, como en tu extracto, y el cambio se calcula solo. La caja que se toca es la de la moneda en que salió el dinero.",
        forms: ["gasto en dolares", "pagar una compra en dolares", "compra en dolares", "pago una compra en soles"],
      },
    ],
  },
  {
    id: "servicios",
    path: "/services",
    title: "Servicios y precios",
    parent: "Gestión",
    purpose:
      "Lo que ofrece tu clínica y cuánto cuesta. De ahí salen los precios que ve el equipo, los presupuestos y lo que Sofi puede decir.",
    terms: [
      "precios",
      "tarifario",
      "tarifas",
      "servicios y tarifas",
      "tratamientos",
      "prestaciones",
      "catálogo",
      "cuánto cuesta",
      "lista de precios",
      "deja en la pieza",
      "cómo dice el precio",
      "precio exacto",
      "solo con evaluación",
      "servicio",
      "servicios",
      "agregar servicio",
      "precio desde",
      "cambiar precio",
      "promociones",
      "promoción",
      "descuento",
      "oferta",
      "lo que se le explica al paciente",
    ],
    writePermission: "settings.write",
    faqs: [
      {
        q: "¿Cómo elijo qué precio dice Sofi?",
        a: "Cada servicio dice su precio de una de tres formas: «Precio exacto», «Desde» (como mínimo, y el final se define en la evaluación) o «Solo con evaluación» (no dice ningún número y ofrece la evaluación). Al agregar servicios de la biblioteca se pregunta una vez «¿Cómo dice Sofi estos precios?», con «Precio exacto» marcado; un servicio propio nace «Solo con evaluación». Para cambiar varios a la vez, márcalos en la lista y elige «Cómo dice el precio». Caja y presupuesto usan siempre la tarifa.",
      },
      {
        q: "¿Qué son las sesiones habituales de un servicio?",
        a: "Con cuántas sesiones suele hacerse, por ejemplo una corona en dos. Al indicarlo, el tratamiento nace en el plan con ese número, y en cada paciente se cambia al indicarlo o con «Planificar…». Lo de la biblioteca trae las que suele llevar y las cambias en el formulario del servicio; cambiarlas no toca lo ya indicado. Si se cobra por sesión, el presupuesto suma el precio de cada sesión prevista.",
        forms: ["sesiones habituales", "cuantas sesiones lleva un servicio", "sesiones por defecto de un tratamiento"],
      },
      {
        q: "¿Cómo pongo un precio en dólares?",
        a: "Primero activa la otra moneda en Datos de la clínica; después, el formulario del servicio trae «Moneda del precio». Al cambiarla escribes el precio de nuevo: no se convierte solo, y lo que ya se indicó o se presupuestó sigue con su moneda y su precio. Un servicio tiene un solo precio. Sofi lo dice en esa moneda y agrega, como aproximado, cuánto es hoy en tu moneda: nunca promete ese cambio para un pago futuro.",
        forms: ["precio en dolares", "servicio en dolares", "como cobro un servicio en dolares", "cobrar un servicio en dolares"],
      },
      {
        q: "¿Sofi manda la lista de precios?",
        a: "No. Responde el precio de los servicios por los que le preguntan, hasta tres distintos por conversación, y después ofrece una evaluación. Si la persona ya tiene un presupuesto, ese sí se lo reenvía.",
      },
      {
        q: "¿Qué es «Deja en la pieza»?",
        a: "Lo que el servicio deja dibujado en el odontograma al completarse: la resina, una restauración de resina; la corona, su corona; la exodoncia, una pieza ausente. Solo aplica a servicios por pieza o por superficies, y lo que va en las caras pide un servicio por superficies. Los de la biblioteca ya lo traen; en uno propio lo eliges al crearlo o editarlo. En clínicas de Perú se elige también el material o el tipo, con su sigla; la causa de una ausencia se deduce al completarla.",
      },
      {
        q: "¿Dónde creo una promoción?",
        a: "En Servicios y precios › Promociones. Con «Informar» encendido, Sofi ofrece la promoción vigente que aplica, con su precio, el ahorro y la fecha de fin.",
        forms: ["como hago una promocion", "crear promocion", "como pongo un descuento"],
      },
      {
        q: "¿Dónde escribo lo que se le explica al paciente de un servicio?",
        a: "En el formulario del servicio, en «Lo que se le explica al paciente». «Usar el texto sugerido» llena los campos con el de la biblioteca, y nada le llega a un paciente hasta que lo guardes.",
      },
    ],
  },
  {
    id: "comisiones",
    path: "/commissions",
    title: "Comisiones",
    menuLabel: "Mis honorarios",
    parent: "Gestión",
    purpose:
      "Lo que le corresponde a cada profesional por lo que atendió y ya se cobró, y el registro de su pago. Quien administra lo ve como pestaña de Finanzas: cada profesional con su liquidación del mes, que dice cuánto falta pagar, cómo se calcula y cada cobro por fecha. Lo que se lleva cada uno se fija en Configuración › Comisiones por profesional. Cada profesional ve lo suyo en «Mis honorarios».",
    terms: [
      "comisión",
      "porcentaje",
      "pago a profesionales",
      "honorarios",
      "mis honorarios",
      "recibo por honorarios",
      "liquidación",
      "mis comisiones",
      "cuánto le toca",
    ],
    faqs: [
      {
        q: "¿Cómo se calcula la comisión?",
        a: "Es el porcentaje de cada profesional (o la comisión distinta de un servicio) sobre lo que se cobró de lo que atendió, con el impuesto incluido: el precio que pagó el paciente. Cuenta el mes en que se cobró, no el de la atención, y lo atendido que aún no se cobra no comisiona todavía: «Mis honorarios» dice cuánto de lo atendido del mes falta cobrar, cada moneda aparte, y qué servicios son, con su fecha. Una venta suelta, sin atención, no es de ningún profesional. Va en la moneda de lo cobrado: lo que se cobra en dólares le da su comisión en dólares, y se le paga en dólares, aparte de lo de soles. La liquidación lo muestra en «Cómo se calcula», una fila por cada regla que sumadas dan lo que le corresponde, y cada cobro dice su fecha, si tuvo promoción y, cuando no es la general, la regla que usó.",
        forms: ["cómo se calcula la comisión", "sobre qué se paga la comisión", "comisión con IGV", "por qué no aparece una atención", "comisión en dólares"],
      },
      {
        q: "¿Cómo registro el pago de una comisión?",
        a: "Abre al profesional en el mes y elige «Registrar el pago»: los cobros de ese pago dejan de estar por pagar y queda en Gastos como pago de comisiones. Elige con qué se pagó, como en un gasto: solo el efectivo sale de la caja, para que el cierre cuadre, y con transferencia o Yape puedes anotar el n.º de operación; si la caja no alcanza, te dice qué hacer. Si te equivocas, «Anular pago» con su motivo lo deshace y devuelve el efectivo. «Imprimir la liquidación» la saca en papel como liquidación de honorarios, con todos los cobros por fecha, para que el profesional haga su recibo; si el mes aún no termina, dice hasta qué día. Si otros meses tienen cobros sin pagar, un aviso arriba de la lista lleva a cada uno.",
        forms: ["pagar comisión", "pagar al doctor", "liquidar comisiones", "anular pago de comisión", "imprimir liquidación"],
      },
      {
        q: "¿Qué pasa si se anula un cobro cuya comisión ya pagué?",
        a: "Lo que se pagó de más se descuenta del próximo pago de ese profesional en esa moneda, de este mes o de otro, sin dejarlo nunca en negativo. Si el descuento cubre todo, se registra el descuento sin gasto y se le avisa. Su fila dice cuánto queda «por descontar» y, si otro mes tiene cobros por pagar, de qué pago se descuenta: se descuenta solo, sin hacer nada. Si ya lo devolvió o ya no trabaja en la clínica, abre su detalle y, en «Por descontar», elige «Registrar que lo devolvió», con cómo lo devolvió (en efectivo entra a la caja como «Devolución de comisiones», sin su nombre; por transferencia o tarjeta no toca la caja), o «Darlo por saldado», con un motivo corto y sin mover dinero. Las dos dejan lo que debe en cero, también en «Mis honorarios» y en Reportes; queda quién y cuándo, se le avisa y se anulan con su motivo como un pago. Se guardan en el mes de los cobros anulados, desde el mes que lo registres: ahí, junto a «Ya pagado», se lee «Devolvió …» o «Se dio por saldado …», y en «Mis honorarios» va junto a sus pagos. Si se anula lo devuelto en efectivo con la caja aún abierta, en Caja queda tachado como anulado en Comisiones y deja de sumar; con la caja ya cerrada, sale de la de hoy como «Compensación por anulación».",
        forms: [
          "descuento de comisión",
          "devolución y comisión",
          "cobro anulado comisión",
          "el doctor devolvió la comisión",
          "perdonar lo que debe el doctor",
          "dar por saldada la comisión",
        ],
      },
      {
        q: "¿Quién ve las comisiones?",
        a: "Quien administra ve las de todos y las paga. Cada profesional ve solo lo suyo en «Mis honorarios», con sus pagos y descuentos; de lo atendido que aún no se cobra ve el servicio y la fecha, sin el paciente ni lo que debe. Caja no ve cuánto gana cada uno: en Gastos ve una sola fila por sede con el total pagado en comisiones.",
        forms: ["quién ve mis comisiones", "caja ve comisiones", "ver comisiones de otro doctor"],
      },
      {
        q: "¿Si cambio el porcentaje, cambia lo que ya se cobró?",
        a: "No. El porcentaje nuevo vale para lo que se atienda desde ese día; lo atendido antes conserva el que tenía, aunque se cobre después o en cuotas. Se cambia en Configuración › Comisiones por profesional, que siempre parte del porcentaje de hoy y dice desde cuándo vale y el anterior; en la liquidación, cada cobro con otro porcentaje lo dice, y al profesional se le avisa del cambio.",
        forms: ["cambiar porcentaje de comisión", "subir la comisión", "desde cuándo vale la comisión"],
      },
      {
        q: "¿Puedo pagar distinto por un servicio?",
        a: "Sí. En Configuración › Comisiones por profesional, en la tarjeta del profesional, «Comisión distinta para un servicio»: elige el servicio y si es otro porcentaje o un monto fijo por cada uno, en la moneda del precio del servicio. El monto fijo se gana entero aunque se cobre con descuento, y en proporción a lo pagado si se paga en partes: si el paciente pagó la mitad, la mitad. Nunca paga más de lo cobrado. Si el servicio se cobra por sesión, se gana en cada sesión que se cobre. Vale para lo que se atienda desde hoy (la primera de un servicio, sin porcentaje general, también para lo ya cobrado de él que aún no se paga), y «Quitar» lo devuelve a su porcentaje general. Si el servicio pasa a otra moneda, el monto deja de valer hasta que lo escribas de nuevo.",
        forms: ["comisión por servicio", "monto fijo por procedimiento", "comisión distinta por tratamiento", "porcentaje por procedimiento"],
      },
      {
        q: "¿Cómo le pongo la comisión a un doctor nuevo?",
        a: "En Configuración › Comisiones por profesional aparece apenas puede atender, con «Sin comisión decidida». Elige «Poner su porcentaje» y escribe el porcentaje de lo cobrado. Si por algún servicio se lleva otra cosa, usa «Comisión distinta para un servicio»: otro porcentaje o un monto fijo por cada uno. La primera comisión vale también para lo que ya se cobró de lo que atendió y aún no se paga; los cambios después valen desde ese día.",
        forms: ["comisión doctor nuevo", "dónde fijo la comisión", "dónde pongo el porcentaje"],
      },
      {
        q: "¿Y si un profesional no cobra comisión?",
        a: "Elige «No cobra comisión»: deja de aparecer en la lista para pagar de cada mes y no se te pide nada sobre él. Si tiene un sueldo fijo, se registra en Finanzas › Gastos como gasto que se repite. Si más adelante empieza a comisionar, le pones su porcentaje y vale desde ese día.",
        forms: ["doctor sin comisión", "solo tiene sueldo", "no comisiona"],
      },
      {
        q: "¿Cómo se reparte un tratamiento que hacen dos doctores?",
        a: "Desde el plan de tratamiento, con sus sesiones previstas: cada cobro se reparte en partes iguales, una por sesión prevista, y cada parte es de quien hizo esa sesión, el día que la hace. Lo cobrado por adelantado de un tratamiento se reparte igual. Lo cobrado de sesiones que aún no se hacen todavía no es de nadie: la lista del mes lo dice aparte, y lo de un tratamiento cancelado antes de terminar no es comisión de nadie. Cada línea dice qué sesión es y de cuántas. Un servicio registrado directo en la atención, sin plan, se cobra entero; si su servicio es de una sesión, su comisión es toda de quien lo registró, y si suele llevar varias, queda en curso con ellas y se reparte igual.",
        forms: ["comisión por sesión", "tratamiento compartido", "dos doctores un tratamiento", "repartir un tratamiento entre doctores"],
      },
    ],
    writePermission: "commissions.write",
  },
  {
    id: "inventario",
    path: "/inventory",
    title: "Inventario",
    parent: "Gestión",
    purpose:
      "Lo que hay en cada sede y lo que hay que hacer con ello: arriba lo que hace falta y lo que vence, con «Pedir» o «Dar de baja». Las compras al proveedor y lo que llega, los movimientos con quién y cuándo, y los proveedores con lo que se les debe. La sede se elige bajo el título.",
    terms: [
      "stock",
      "insumos",
      "materiales",
      "productos",
      "compras",
      "almacén",
      "existencias",
      "por vencer",
      "conteo",
      "contar lo que hay",
      "pegar mi lista",
      "pedir lo que falta",
      "orden de compra",
      "proveedores",
      "lotes",
      "dar de baja lo vencido",
      "traslado entre sedes",
      "vender producto",
      "vender",
      "agregar producto",
      "producto",
      "guantes",
      "descontar",
      "se acabó",
      "cuánto nos queda",
      "llegaron cajas",
      "resina",
      "anestesia",
    ],
    writePermission: ["inventory.write", "inventory.receive"],
    faqs: [
      {
        q: "¿Cómo cargo mis productos la primera vez?",
        a: "En Inventario › Productos, «Pegar mi lista»: copia de tu Excel o Google Sheets las columnas Nombre, Unidad, Hay y Mínimo y pégalas. Lo dudoso se marca en su fila (un nombre casi igual a otro, un número mal escrito) y lo demás entra como «Inventario inicial» en la sede elegida.",
      },
      {
        q: "¿Cómo cuento lo que hay a fin de mes?",
        a: "Con «Contar»: la lista se vuelve editable y escribes lo que hay de cada producto. odentIA calcula la diferencia y la guarda como un ajuste con el motivo «Conteo»; lo que no cuentas no cambia.",
      },
      {
        q: "¿Qué significa «se usaron sin haber»?",
        a: "Que se usó o se vendió más de lo que odentIA tenía registrado. La atención o el cobro no se bloquean: lo que faltó queda como faltante y la próxima compra que llega lo cubre primero.",
      },
      {
        q: "¿Cómo registro una compra que ya traje de la tienda?",
        a: "En Compras, «+ Compra» y elige «Ya la tengo»: queda registrada como llegada, con sus lotes, en un paso. Si la pagaste, se abre «Registrar pago» con el total puesto.",
      },
      {
        q: "¿Quién puede recibir lo que llega?",
        a: "Recepción ve el inventario sin precios, registra lo que llegó y el uso fuera de una atención. Pedir, contar, ajustar y corregir precios son del dueño y la administración.",
      },
      {
        q: "¿Cómo se descuentan los materiales de una atención?",
        a: "Solos, al firmarla: en Servicios y precios cada servicio dice qué usa cada vez («Materiales que usa») y sale de la sede de la atención. Arriba de la lista se sugieren los más hechos que aún no los tienen; las consultas no, porque casi no gastan. Si se usó otra cantidad, en la atención firmada, «Materiales usados» › «Corregir»; lo firmado no cambia.",
      },
      {
        q: "¿Cómo vendo un cepillo o un enjuague?",
        a: "Márcalo con «Se vende» y ponle su precio de venta. En Finanzas › «Cobrar», «Agregar producto» lo suma a la cuenta y lo descuenta de la sede al agregarlo; si lo quitas de la cuenta o anulas el ticket, vuelve. Si te lo devuelven otro día, «Devolver» en su ticket lo regresa a la sede si está en buen estado.",
      },
    ],
  },
  {
    id: "reportes",
    path: "/reports",
    title: "Reportes",
    parent: "Gestión",
    purpose:
      "Cómo va la clínica en un periodo, comparado con el anterior: el Resumen, Finanzas, Pacientes, Agenda y el Agente. Las cifras que tienen una lista detrás la abren al tocarlas, y cada lista y tabla se descarga. Arriba, «Pregúntale a Argos» responde con esas mismas cifras.",
    terms: [
      "estadísticas",
      "indicadores",
      "métricas",
      "informes",
      "gráficos",
      "cuántas citas",
      "ventas del mes",
      "inasistencias",
      "pacientes nuevos",
      "presupuestos aceptados",
      "resultado del mes",
      "cuánto queda",
      "espera en sala",
      "cuánto esperan",
      "preguntarle a argos",
      "meta del mes",
      "metas",
      "descargar una lista",
      "csv",
      "resumen del lunes",
      "correo semanal",
      "fijar",
      "ver reportes",
      "reporte",
      "cuántos pacientes nuevos",
      "cuánto cobramos este mes",
      "excel",
      "números del mes",
      "cuánto entró",
      "cuánto vendimos",
      "ventas",
      "comparado",
    ],
    faqs: [
      {
        q: "¿Qué le puedo preguntar a Argos en Reportes?",
        a: "Por lo que registra la clínica: lo cobrado, lo que deja, los gastos, las deudas, las comisiones, los pacientes nuevos, por dónde nos buscaron, los presupuestos aceptados, las inasistencias, la agenda ocupada y lo que hizo el agente, también por profesional, por sede o por mes. Responde al lado, con el periodo y la sede de arriba (o los que digas: «¿y en agosto?») y «Así lo calculé»; cada respuesta dice si es una «Cifra oficial», la misma cuenta de Reportes, o un «Cálculo de Argos». Si duda, te pregunta; si no tiene el dato, dice qué falta y lo más cercano. No responde preguntas clínicas ni hace nada: para que el agente actúe, se prende su línea. Lo prende quien administra el agente. El plan trae preguntas por mes: cuántas quedan y cómo sumar más está en Plan y pagos.",
      },
      {
        q: "¿Cómo fijo una respuesta en el Resumen?",
        a: "En la respuesta de Argos, toca «Fijar en Resumen». Queda al final del Resumen para todos los que ven Reportes, sigue el periodo y la sede de arriba y cualquiera la quita con «Quitar». Caben cuatro.",
      },
      {
        q: "¿Cómo pongo una meta?",
        a: "En el Resumen, con el mes en curso elegido y «Todas las sedes», toca «Poner meta» en Cobrado o en Pacientes nuevos. Es de toda la clínica, vale desde este mes y, si la cambias, los meses pasados conservan la que tenían. En el mes en curso, una raya marca cuánto del mes ya pasó: si la barra va por delante, vas bien.",
      },
      {
        q: "¿Cómo descargo una lista o una tabla de Reportes?",
        a: "Cada lista que se abre al lado y cada tabla (Por profesional, Comisiones, una respuesta de Argos) tiene «Descargar»: baja un archivo CSV que abre en Excel o Google Sheets, con las mismas filas y columnas, más el teléfono si puedes ver los datos de la persona.",
      },
      {
        q: "¿Cómo se ven los dólares en Reportes?",
        a: "Si la clínica cobra en otra moneda, lo que ya pasó (cobrado, gastos, lo que deja y comisiones) va en la moneda del negocio, con lo que valió el día que se cobró o se pagó: no se mueve aunque cambie el cambio de hoy. «Te deben» va por moneda, con un total aproximado al cambio de hoy, y quien debe en las dos cuenta como una persona. No incluye lo que ganes o pierdas al cambiar dólares: eso queda para tu contador.",
        forms: ["dolares en reportes", "reportes con dos monedas", "cuanto vale lo cobrado en dolares"],
      },
      {
        q: "¿En qué mes cuenta un gasto que anulo después?",
        a: "En ninguno: anular un gasto es decir que no ocurrió. Deja de contar en el mes de su fecha aunque lo anules meses después, y Gastos y Reportes dicen lo mismo de ese mes, también en «Lo que deja». Si salió del efectivo de una caja ya cerrada, ese efectivo vuelve a la caja del día en que lo anulas.",
        forms: ["gasto anulado en reportes", "anule un gasto del mes pasado", "por que cambio lo que deja de un mes pasado"],
      },
      {
        q: "¿Qué es el resumen del lunes?",
        a: "Un correo que te llega cada lunes a las 8:00, hora de la clínica, con cuatro cifras de la semana anterior, lo que cambió y lo que recomienda Argos. A quien crea la clínica le llega desde el primer lunes; cada otra persona que ve Reportes lo prende para sí al final del Resumen. Si la semana no tuvo movimientos, no se envía, y para dejar de recibirlo basta el enlace del propio correo.",
      },
      {
        q: "¿Qué es «Espera en sala»?",
        a: "Cuántos minutos pasan entre que se marca «Llegó» y empieza la atención, la mitad de las veces menos y la mitad más, por profesional. Solo cuenta lo que se mide: si nadie marca la llegada, dice «Sin datos».",
      },
      {
        q: "¿Qué es «Dónde se caen los pacientes»?",
        a: "En Reportes › Pacientes: las personas que nos buscaron por primera vez en el periodo (escribieron por cualquier canal, las registró recepción o se registraron en línea) y hasta dónde llegaron hasta hoy: agendaron (una cita sin cancelar, aunque no vinieran), vinieron (una cita atendida o una atención firmada), recibieron presupuesto, lo aceptaron (del todo o en parte) y, además, pagaron algo. Cada paso cuenta a quien llegó a él o a uno posterior, así que las cifras nunca suben de un paso al siguiente. Son siempre las mismas personas, aunque el paso ocurra después del periodo; agendar, recibir el presupuesto y aceptarlo son los mismos momentos de Oportunidades. Si alguien escribe por un paciente (una madre por su hijo), cuenta el paciente, una sola vez y con el canal de quien escribió; Spam y bloqueados no cuentan. «Aquí se caen más» marca el paso donde más se quedaron; toca cualquier paso para ver a esas personas.",
      },
    ],
  },
  {
    id: "organizacion",
    path: "/settings",
    title: "Datos de la clínica",
    parent: SETTINGS,
    purpose:
      "Los datos de tu clínica: el nombre comercial (el que ven tus pacientes), su logo y el color de su marca, la razón social, el documento fiscal, el país, la moneda, la zona horaria y el idioma, con los que se leen las fechas, los importes y los documentos, y la lista de diagnósticos (CIE-10 o CIE-11) en la que se eligen los diagnósticos.",
    terms: [
      "organización",
      "nombre de la clínica",
      "nombre comercial",
      "logo",
      "color de la marca",
      "colores de la clínica",
      "color",
      // «Sacar de una foto» (ADR 0162): quien no tiene el logo lo busca por su letrero.
      "letrero",
      "color del letrero",
      "foto del letrero",
      "ruc",
      "moneda",
      "zona horaria",
      "empresa",
      "razón social",
      "cie-10",
      "cie-11",
      "lista de diagnósticos",
      "códigos de diagnóstico",
      "impuestos",
      "igv",
      "iva",
      "cambiar nombre de la clínica",
      "segunda moneda",
      "cobrar en otra moneda",
    ],
    writePermission: "settings.write",
    faqs: [
      {
        q: "¿Qué nombre de la clínica ven mis pacientes?",
        a: "El nombre comercial, en todo: WhatsApp, «Su enlace», el portal, el registro, el chat de la web y los PDF. La razón social va solo en el comprobante y en los papeles legales. El nombre comercial es obligatorio y se cambia en «Datos de la clínica»; ahí mismo subes el logo, que ven al abrir su registro y su enlace.",
      },
      {
        q: "¿Puedo poner el color de mi clínica?",
        a: "Sí, en «Datos de la clínica» › «Color de la marca», debajo del logo. Primero salen los colores de tu logo, luego doce sugeridos; «Elegir otro color» abre la paleta o recibe el código de tu marca, y «Sacar de una foto» toma el color de una foto de tu letrero (tócala donde está tu color; la foto no se guarda). Elegir solo cambia la vista previa: se guarda con «Usar este color» y desde ese momento lo ven tu equipo en la app y tus pacientes en la página de sus citas, la reserva y el chat de tu web; en los documentos va en la línea bajo el logo o, sin logo, en el cuadro de sus iniciales. Cualquier color vale: los botones llevan letra blanca y, si tu color es fuerte como un naranja, uno apenas más oscuro para que se lea; si es claro, como un celeste, lo usan tal cual con letra oscura, y los enlaces van en un tono más oscuro; si se parece al rojo de los errores, te lo dice y puedes usarlo igual. Tu color va donde actúas: los botones principales, el menú en el que estás y lo que eliges; los nombres, las iniciales y los fondos quedan en negro y gris, para que la pantalla no se cargue. La invitación a tu equipo y el resumen del lunes también llevan tu color en el botón; los correos de tu cuenta, como el de la contraseña, siguen con el de la app. Los colores de error, listo y aviso no cambian, y las recetas, órdenes, descansos y consentimientos ya emitidos quedan como salieron; lo que se vuelve a imprimir, como un presupuesto o un comprobante, sale con el color de hoy, igual que el logo. «Volver al…» quita el tuyo y deja el color con el que viene la app. Lo cambia quien administra la clínica.",
      },
      {
        q: "¿Cómo saco el color de mi letrero?",
        forms: ["color de mi letrero", "el color de mi letrero", "color del letrero", "sacar el color de una foto", "foto del letrero", "tengo una foto del letrero"],
        a: "En «Datos de la clínica» › «Color de la marca», toca «Sacar de una foto» y elige la foto de tu letrero. Salen sus colores; también puedes tocar la foto donde está tu color. Se guarda con «Usar este color». La foto no se sube ni se guarda.",
      },
      {
        q: "¿Trabajo con la CIE-10 o con la CIE-11?",
        a: "Con la que elija la clínica en «Datos de la clínica» › «Lista de diagnósticos». Viene la que recomienda tu país (la CIE-10 en Perú, Chile, México o Argentina; la CIE-11 en Colombia). Si eliges otra, te dice qué implica en tu país. Desde ese día los diagnósticos nuevos se eligen en la lista nueva; lo registrado antes no se reescribe y una atención abierta conserva lo que ya tenía. Puedes volver atrás, y cada cambio queda en la actividad.",
      },
      {
        q: "¿Cómo elijo el diagnóstico de una atención?",
        a: "En tres pasos: lo que propone la atención, los más usados en tu clínica o el buscador de toda la lista, que no distingue tildes ni mayúsculas y muestra primero lo odontológico. Propone el odontograma (una caries en la 16 propone su código) y, en una sesión o un control, el diagnóstico del tratamiento que continúa. Nada entra solo: «Usar» lo registra con el tipo de la última vez o, si nunca se registró, te pide el tipo. «Presuntivo» basta para cerrar. Si la persona ya tenía ese diagnóstico, el sistema lo anota solo como «Ya diagnosticado antes».",
      },
      {
        q: "¿Cómo activo la otra moneda?",
        a: "En Datos de la clínica, en «También cobro en» eliges la otra moneda (son dos como máximo) y en «Tipo de cambio de hoy» escribes a cuánto está, en tu moneda por 1 de la otra. Si ya hay algo en esa moneda, te lo dice antes de guardar. Desde ahí puedes poner precios, cobrar, comprar y registrar gastos en ella; tus reportes y metas siguen en la «Moneda del negocio», y la comisión de lo cobrado en la otra moneda va en esa moneda. Si no la activas, todo sigue igual. Para dejar de cobrar en ella, antes cobra lo que se debe en esa moneda, usa o devuelve lo que tengan a favor, retira el efectivo de su caja, paga las comisiones en esa moneda y pasa sus servicios a la moneda del negocio: Datos de la clínica te dice qué falta.",
        forms: ["como activo otra moneda", "como activo los dolares", "quiero cobrar tambien en dolares", "activar segunda moneda", "activar dolares", "cobrar en dos monedas"],
      },
      {
        q: "¿Dónde configuro los impuestos?",
        a: "En Datos de la clínica, «Impuestos»: dice lo que vale y «Cambiar» ofrece las tasas del país u «Otra tasa…». El ticket separa subtotal e impuesto, y Reportes › Finanzas dice cuánto de lo cobrado es impuesto.",
        forms: ["igv", "iva", "impuestos"],
      },
    ],
  },
  {
    id: "sucursales",
    path: "/settings/branches",
    alsoAt: ["/branches"],
    title: "Sedes",
    parent: SETTINGS,
    purpose:
      "Las sedes de tu clínica, con su dirección, teléfono y zona horaria. Puedes tener más de una.",
    terms: [
      "sede",
      "sucursal",
      "sucursales",
      "local",
      "locales",
      "dirección",
      "otra sede",
      "más de una sede",
      "agregar sede",
      "abrir otra sede",
      "dirección",
      "consultorio",
      "local",
    ],
    writePermission: "settings.write",
    faqs: [
      {
        q: "¿Puedo tener más de una sede?",
        a: "Sí, las que necesites. Cada sede se agrega en Configuración › Sedes, con su dirección y su zona horaria.",
      },
    ],
  },
  {
    id: "equipo",
    path: "/settings/team",
    alsoAt: ["/members"],
    title: "Equipo",
    parent: SETTINGS,
    purpose:
      "Quién forma parte de tu clínica y qué puede ver o hacer cada persona según su rol. Desde ahí invitas a alguien nuevo.",
    terms: [
      "usuarios",
      "invitar",
      "roles",
      "permisos",
      "recepcionista",
      "odontólogo",
      "agregar a alguien",
      "accesos",
      "miembros",
      "profesional",
      "cambiar rol",
      "invitar usuario",
      "verificación en dos pasos",
      "dos pasos",
      "comparte su agenda",
      "quitar acceso",
      "invitación",
      "no le llegó la invitación",
      "no puede entrar",
      "usuario",
      "crear usuario",
      "no puede entrar a caja",
    ],
    writePermission: "settings.write",
    faqs: [
      {
        q: "¿Cómo invito a alguien a mi equipo?",
        a: "En Configuración › Equipo, pulsa «Invitar al equipo», escribe su correo y elige su rol. Le llega una invitación para crear su cuenta.",
      },
      {
        q: "¿Cómo sé qué días atiende cada persona del equipo?",
        a: "En Configuración › Equipo, la columna «Atiende» dice qué días atiende cada persona. Un profesional que aún no tiene horario dice «Sin horario». Un propietario o administrador atiende solo si le pones horario. Si alguien deja de atender, porque sale del equipo o cambia de rol, su horario se cierra y sus citas por venir quedan en la Agenda, marcadas para pasarlas a otra persona.",
      },
      {
        q: "¿Cómo pido la verificación en dos pasos al equipo?",
        a: "La activa cada persona en Mi perfil. Quien configura el equipo puede pedírsela a todos desde Configuración › Equipo. A quien cambió de teléfono y no puede entrar, «…» › «Restablecer verificación en dos pasos».",
        forms: ["verificacion en dos pasos", "dos factores", "doble factor"],
      },
      {
        q: "¿Qué significa «Comparte su agenda»?",
        a: "Que esa persona ve sus citas en su propio calendario, con «Mi calendario» de la Agenda. En «…», «Dejar de compartir su agenda» lo apaga, sin ver su enlace.",
      },
    ],
  },
  {
    id: "disponibilidad",
    path: "/settings/availability",
    title: "Horarios y ausencias",
    parent: SETTINGS,
    purpose:
      "El horario semanal y las ausencias de cada profesional, y de cada sede sus unidades dentales, sus feriados y cierres y lo que dura una cita regular. Sin un horario aquí, Sofi y el enlace de reserva no ofrecen citas de esa persona; el equipo puede reservar igual, con una advertencia.",
    terms: [
      "horarios",
      "disponibilidad",
      "horario de atención",
      "días de atención",
      "unidades dentales",
      "sillones",
      "turnos del doctor",
      "agenda del profesional",
      "ausencias",
      "vacaciones",
      "feriados",
      "cierres",
      "duración de la cita",
      "horario del profesional",
      "horario de un profesional",
      "vacaciones del profesional",
      "unidad dental",
      "agregar unidad dental",
      "horario",
      "feriado",
      "sillón",
      "no viene",
      "no atendemos",
      "a qué hora atiende",
      "qué días atiende",
      "agregar sala",
    ],
    writePermission: "settings.write",
    faqs: [
      {
        q: "¿Dónde configuro los horarios?",
        a: "En Configuración › Horarios y ausencias. Ahí defines, por profesional y sede, los días y las horas de atención.",
      },
      {
        q: "¿Por qué recepción o caja no aparecen en Horarios y ausencias?",
        a: "Porque no atienden pacientes: un horario aquí hace que esa persona se ofrezca para citas, también en Sofi y en el enlace de reserva. Solo llevan horario quienes pueden atender: los profesionales, los propietarios y los administradores.",
      },
    ],
  },
  {
    id: "proteccion-de-datos",
    path: "/settings/data-protection",
    title: "Protección de datos",
    parent: SETTINGS,
    purpose:
      "Qué datos guarda la clínica, para qué y quién más los toca: el registro de actividades de tratamiento que pide la ley de datos personales. Se arma solo con lo que la clínica usa y se descarga en PDF para la autoridad.",
    terms: [
      "protección de datos",
      "datos personales",
      "registro de actividades",
      "ley de datos",
      "encargados",
      "subencargados",
      "proveedores",
      "transferencia internacional",
      "autoridad de datos",
      "ANPD",
      "privacidad",
      "ley",
      "tratamos los datos",
      "quién recibe los datos",
    ],
    faqs: [
      {
        q: "¿Qué le entrego a la autoridad si me pide el registro de mis datos?",
        a: "En Configuración › Protección de datos, «Descargar para la autoridad» arma un PDF con lo que la clínica usa ese día.",
      },
      {
        q: "¿Por qué aparece un proveedor que no contraté?",
        a: "Porque odentIA lo usa por cuenta de la clínica: el servidor, el almacenamiento o el modelo de los agentes. Los que dependen de la clínica solo aparecen si conecta ese canal o enciende los agentes.",
      },
    ],
  },
  {
    id: "especialidades",
    path: "/settings/specialties",
    title: "Especialidades",
    parent: SETTINGS,
    purpose:
      "Las especialidades de tu clínica y quién atiende cada una. Nacen con las de la biblioteca y puedes renombrarlas. La agenda ofrece cada servicio solo a quien atiende su especialidad; la especialidad de un servicio se elige en Servicios y precios.",
    terms: [
      "ortodoncia",
      "endodoncia",
      "áreas",
      "tipos de tratamiento",
      "quién atiende",
      "especialista",
      "nadie atiende",
      "especialidad",
      "atiende especialidad",
      "pediatría",
      "periodoncia",
    ],
    writePermission: "settings.write",
    faqs: [
      {
        q: "¿A quién ofrece la agenda un servicio?",
        a: "A quien atiende su especialidad y tiene horario en esa sede: en la agenda, en el enlace de reserva y en lo que ofrece Sofi. Si nadie la atiende, se ofrece a cualquiera y esta pantalla lo avisa con «Elegir quién atiende». Es lo que se ofrece, no lo que se puede guardar: al reservar la sesión siguiente, quien atendió la anterior viene elegido aunque no esté en la especialidad, y «Nueva cita» lo dice.",
      },
      {
        q: "¿Dónde cambio la especialidad de un servicio?",
        a: "En Servicios y precios, al editar el servicio. Cada servicio tiene una sola especialidad. Aquí, el número de servicios de cada una te lleva a esa lista ya filtrada.",
      },
    ],
  },
  {
    id: "formularios",
    path: "/settings/forms",
    title: "Consentimientos",
    parent: SETTINGS,
    purpose:
      "Los consentimientos informados de tu clínica: vienen activos con un texto sugerido, y aquí se leen, se cambian sobre la misma hoja, se ve cómo quedan y se elige para qué servicios se pide cada uno. También se crean formularios propios, para preguntas que solo tu clínica hace.",
    terms: [
      "consentimiento informado",
      "anamnesis",
      "cuestionario",
      "plantillas",
      "firma del paciente",
      "documentos para firmar",
      "ficha propia",
      "mis preguntas",
      "formulario propio",
    ],
    writePermission: "settings.write",
    faqs: [
      {
        q: "¿Puedo usar un consentimiento sin revisarlo?",
        a: "Sí: los sugeridos vienen activos para que no empieces en papel. Son textos de partida, así que pide a un profesional de tu clínica que los lea, porque es lo que firma el paciente. Cada uno dice «Sin revisar» hasta que alguien lo marca o guarda un cambio.",
      },
      {
        q: "Si cambio el texto, ¿qué pasa con lo ya firmado?",
        a: "No cambia: cada consentimiento firmado conserva el texto que se firmó. Los nuevos usan el que guardaste. Apagar uno tampoco toca lo firmado: solo deja de ofrecerse.",
      },
      {
        q: "¿Para qué sirve «Se pide para»?",
        a: "Para que la atención proponga sola el consentimiento: al registrar o indicar uno de esos servicios aparece «Necesita consentimiento · Preparar», lleno con lo de la atención. Los sugeridos ya vienen unidos a los servicios de la biblioteca que les corresponden. Los servicios propios se eligen a mano.",
      },
      {
        q: "¿Las alergias que el paciente escribe en el cuestionario llegan a su ficha?",
        a: "Sí, si en la pregunta marcas «Son alergias: pasan a sus antecedentes». Cuando el profesional finaliza el cuestionario, cada alergia entra a Antecedentes como declarada, sin confirmar, y la receta avisa al escribir un medicamento que choca. No repite una alergia que ya está ni cambia lo que un profesional confirmó o descartó.",
      },
    ],
  },
  {
    id: "registro_pacientes",
    path: "/settings/patient-registration",
    title: "Registro de pacientes",
    parent: SETTINGS,
    purpose:
      "Qué se le pide a un paciente cuando se registra con un enlace, y el aviso de privacidad que acepta. Lo que marcas obligatorio no le deja enviar su registro sin responderlo; en recepción nunca impide registrar y aparece como «Faltan datos para la atención».",
    terms: [
      "formulario de registro",
      "enlace de registro",
      "aviso de privacidad",
      "datos que pido al paciente",
      "alta de paciente",
      "obligatorio",
      "opcional",
      "datos censales",
      "no preguntar",
      "qué datos le pido",
      "datos al registrarse",
      "obligatorio el documento",
    ],
    writePermission: "settings.write",
    faqs: [
      {
        q: "¿Puedo volver obligatorio el estado civil o la ocupación?",
        a: "No. El estado civil, el nivel educativo, la ocupación, cómo nos conoció y la procedencia solo pueden ser «Opcional» o «No preguntar»: nadie los usa para atender. Nombres y apellidos, fecha de nacimiento y un teléfono o correo se piden siempre.",
      },
    ],
  },
  {
    id: "acceso_pacientes",
    path: "/settings/patient-access",
    title: "Portal del paciente",
    parent: SETTINGS,
    purpose:
      "El portal donde el paciente ve lo suyo cuando quiera: sus citas, presupuestos, documentos y su cuenta. Una clínica nueva lo trae encendido: aquí se apaga o se enciende y se elige lo que puede ver toda persona con acceso; lo demás son valores fijos. El acceso de cada persona se da en la clínica, con su documento, y no se elige qué verá.",
    terms: [
      "portal",
      "acceso de pacientes",
      "que el paciente vea sus citas",
      "acceso del paciente",
      "código",
      "huella",
      "volver a entrar",
      "que vea sus pagos",
      "que no vea",
      "ver sus citas",
      "ver por internet",
      "su página personal",
    ],
    writePermission: "settings.write",
    faqs: [
      {
        q: "¿Cuánto dura el acceso?",
        a: "El acceso no vence: dura hasta que alguien pulse «Quitar acceso», que cierra todo. El enlace de recepción vale 3 días. La primera vez guarda su acceso en el teléfono y después entra con su huella o su cara; si su teléfono no puede guardarlo, lo recordamos 30 días.",
      },
      {
        q: "¿Necesito el portal para la cita o el presupuesto?",
        a: "No. Cada mensaje abre lo suyo en su enlace: su cita, sus datos por completar, el presupuesto que se le envió y el consentimiento por firmar. El portal es para lo privado, todo junto y cuando quiera.",
      },
    ],
  },
  {
    id: "medios-de-pago",
    path: "/settings/payment-methods",
    title: "Medios de pago y ticket",
    parent: SETTINGS,
    purpose:
      "Con qué puede pagar un paciente en tu clínica y cómo sale el ticket. Los medios que enciendas son los que ofrece caja al cobrar, en el orden que les des, y los que Sofi puede mencionar. Ahí también eliges el ancho del ticket, el tamaño de hoja del presupuesto, la frase al pie y las condiciones del presupuesto: sus días de vigencia, cómo se paga y qué pasa si el importe cambia.",
    terms: [
      "efectivo",
      "tarjeta",
      "transferencia",
      "billetera",
      "formas de pago",
      "cómo pagar",
      "métodos de pago",
      "ancho del ticket",
      "frase al pie",
      "pie del ticket",
      "tamaño de hoja",
      "impresora térmica",
      "medios de pago",
      "medio de pago",
      "yape",
      "plin",
      "agregar medio de pago",
      "tarjeta",
      "impreso en el ticket",
      "en el ticket salga",
      "frase del ticket",
    ],
    writePermission: "settings.write",
  },
  {
    id: "comisiones-de-cada-profesional",
    path: "/settings/commissions",
    title: "Comisiones por profesional",
    parent: SETTINGS,
    purpose:
      "Lo que se lleva cada profesional de lo cobrado por lo que atiende: su porcentaje, los servicios con una comisión distinta (otro porcentaje o un monto fijo por cada uno) o que no cobra comisión. Aparece cada persona del equipo que puede atender, aunque aún no haya atendido. Es un acuerdo con la persona: se fija al contratarla. La primera comisión vale también para lo ya cobrado que aún no se paga; un cambio después vale para lo que se atienda desde ese día. Lo de cada mes se liquida y se paga en Finanzas › Comisiones. Solo lo ve y lo cambia quien administra las comisiones.",
    terms: ["fijar comisión", "poner porcentaje", "no cobra comisión", "configurar comisiones"],
    writePermission: "commissions.write",
    faqs: [
      {
        q: "¿Puede comisionar solo por algunos servicios?",
        a: "Sí. Agrégale sus servicios con «Comisión por un servicio», sin ponerle porcentaje; si ya tenía uno, agrégalos y en «Cambiar» elige «Solo por sus servicios». Comisiona solo por esos y lo demás que atiende no comisiona. La primera comisión de un servicio, sin porcentaje general, vale también para lo ya cobrado de ese servicio que aún no se paga.",
        forms: ["comisión solo por servicio", "solo por procedimiento", "sin porcentaje general"],
      },
    ],
  },
  {
    id: "plan-y-pagos",
    path: "/settings/plan",
    alsoAt: ["/settings/plan/acciones"],
    title: "Plan y pagos",
    parent: SETTINGS,
    purpose:
      "Lo que la clínica paga a odentIA: el plan, lo que hicieron los agentes este mes y cada acción cobrada, el crédito y el presupuesto del mes, las preguntas a Argos y el almacenamiento, los cargos, el comprobante y los pagos. Solo lo ven propietario y administrador, y sigue abierto aunque la clínica esté en solo lectura.",
    terms: [
      "suscripción",
      "factura de odentIA",
      "pagar odentIA",
      "mi plan",
      "cargo",
      "comprobante",
      "presupuesto del mes",
      "tope de gasto",
      "crédito del mes",
      "preguntas a argos",
      "almacenamiento",
      "sumar solas",
      "cada acción",
      "pedir revisión",
      "solo lectura",
      "pago pendiente",
      "cuánto gastan los agentes",
      "gasto de los agentes",
      "cuánto gasta el agente",
      "cambiar de plan",
      "factura",
      "software",
      "cuánto pagamos",
      "cuánto estamos pagando",
      "pagando por este programa",
      "este programa",
    ],
    faqs: [
      {
        q: "¿Dónde pago la suscripción de odentIA?",
        a: "Quien es propietario o administrador abre Configuración › Plan y pagos, o el menú con el nombre de la clínica, arriba a la izquierda. Ahí consulta el plan y aporta un comprobante; subirlo no confirma el pago. Plan y pagos y Ayuda siguen disponibles aunque la clínica esté en solo lectura.",
      },
    ],
  },
  {
    id: "pipelines",
    path: "/settings/pipelines",
    title: "Etapas de venta",
    parent: SETTINGS,
    purpose:
      "Los cuatro pasos del tablero de oportunidades (Interesado, Evaluación agendada, Presupuesto enviado y Decidió) y cuándo llega sola la oportunidad a cada uno. Puedes cambiarles el nombre; no se añaden ni se quitan pasos, porque así la oportunidad avanza sola.",
    terms: [
      "etapas",
      "pasos",
      "embudo",
      "columnas del tablero",
      "fases de venta",
      "pipelines",
      "renombrar etapa",
      "nombre de una etapa",
      "cambiar nombre de etapa",
      "columnas",
      "nombre de las columnas",
      "pasos de venta",
    ],
    writePermission: "crm.write",
  },
  {
    // Conserva el identificador de «Canales»: sigue siendo donde se conecta por dónde te escriben.
    id: "canales",
    path: "/settings/integrations",
    title: "Integraciones",
    parent: SETTINGS,
    purpose:
      "Lo que tu clínica conecta una vez: WhatsApp, Instagram, Messenger y Telegram, el chat de tu sitio web, el correo de la clínica y el modelo del agente. Cada fila dice para qué sirve, con qué cuenta está y cómo va. Lo automático sale por WhatsApp y, si no se puede, por correo; Instagram, Messenger y Telegram solo responden a quien escribió primero.",
    terms: [
      "canales",
      "conectar un canal",
      "telegram",
      "instagram",
      "messenger",
      "integración",
      "correo",
      "email",
      "gmail",
      "outlook",
      "buzón",
      "conectar correo",
      "conectar instagram",
      "conectar messenger",
      "conectar telegram",
      "facebook",
      "vincular correo",
    ],
    writePermission: "settings.write",
  },
  {
    id: "whatsapp",
    path: "/settings/integrations/whatsapp",
    title: "WhatsApp",
    parent: INTEGRATIONS,
    purpose:
      "El número de WhatsApp de la clínica y los mensajes que WhatsApp deja enviar: aquí lo conectas, ves cuáles están aprobados y creas otro con «Nuevo mensaje». Es un solo número por clínica: para usar otro, primero se desconecta el que está. Si WhatsApp cuenta un aviso como promoción, lo marca «Meta lo considera promoción» y solo sale a quien aceptó novedades: cámbiale el texto. Las plantillas de tu cuenta con encabezado o con datos por nombre se ven, pero no se pueden enviar desde odentIA.",
    terms: [
      "conectar whatsapp",
      "whatsapp",
      "número de whatsapp",
      "mensajes aprobados",
      "plantillas de whatsapp",
      "plantilla",
      "rechazaron la plantilla",
      "número nuevo",
      "whatsapp no envía",
      "clave de whatsapp",
      "cambiar la clave",
    ],
    writePermission: "settings.write",
    faqs: [
      {
        q: "¿Por qué WhatsApp no envía?",
        a: "Si Meta ya no acepta la conexión, la fila de WhatsApp en Integraciones dice «Necesita atención» y la campana avisa a quien administra y a quien atiende las conversaciones. Si se conectó con Facebook, vuelve a conectar con el botón; si usa la app propia de la clínica en Meta, genera allí una clave nueva y pégala con «Cambiar la clave». Debajo de cada mensaje que no salió, la Bandeja dice el motivo.",
      },
    ],
  },
  {
    id: "chat_web",
    path: "/settings/integrations/webchat",
    title: "Chat web",
    parent: INTEGRATIONS,
    purpose:
      "El chat de tu sitio web: lo que escriben llega a la misma Bandeja y Sofi responde al momento. Se instala pegando una sola línea en tu sitio; cambiar el saludo o el color de tu marca (en «Datos de la clínica») no obliga a volver a pegarla. Responde en el primer sitio donde la pegas y en los que tú permites. Al lado puedes probarlo sin publicar: la prueba no se cobra ni cuenta.",
    terms: [
      "widget",
      "chat en mi página",
      "página web",
      "sitio web",
      "burbuja de chat",
      "instalar el chat",
      "línea del chat",
      "wordpress",
      "wix",
      "no disponible",
      "probar el chat",
      "código",
      "pegar el chat",
      "web",
    ],
    writePermission: "settings.write",
    faqs: [
      {
        q: "¿Cómo pongo el chat en mi sitio?",
        a: "En Configuración › Integraciones › Chat web, «Copiar código» y pega esa línea en tu sitio, antes de </body>. Si no lo manejas tú, «Enviar a quien hace mi web» copia un mensaje listo para mandárselo. El primer sitio donde carga queda registrado solo.",
      },
      {
        q: "¿Por qué en un sitio dice «No disponible»?",
        a: "El chat responde solo en el primer sitio donde se pegó y en los que permites: si aparece en otro, te llega un aviso y en «Dónde responde» decides «Permitir» o «Bloquear». También dice «No disponible» si el chat está desactivado.",
      },
      {
        q: "¿Qué pasa si la persona cierra la pestaña?",
        a: "Su conversación sigue en ese navegador 30 días. Si Sofi le pasa un tema al equipo, el chat le pide su WhatsApp o su correo para avisarle: tu respuesta le llega por ahí. Si no deja ninguno, en la Bandeja dice «Sin forma de avisarle».",
      },
      {
        q: "¿La prueba se cobra?",
        a: "No. La conversación de prueba lleva «Prueba» en la Bandeja, no se cobra, no crea a nadie en Pacientes y no cuenta en Reportes. Sofi responde de verdad, pero no reserva nada. Se borra con «Borrar esta prueba» o sola a los 7 días.",
      },
    ],
  },

  {
    id: "auditoria",
    path: "/settings/audit",
    title: "Actividad del equipo",
    parent: SETTINGS,
    purpose:
      "Quién hizo qué, cuándo y sobre qué en la clínica, dicho con palabras: una fila por acción, con la persona y, si lo hay, el ticket, la cita o el presupuesto, que se abren al tocarlos. Es una consulta: desde ahí no se cambia nada.",
    terms: [
      "auditoría",
      "historial de cambios",
      "quién cambió",
      "registro de actividad",
      "bitácora",
      "quién cambió este dato",
      "quién cambió un dato",
      "quién hizo",
      "quién borró",
      "averiguar quién",
      "quién fue",
      "cómo sé quién",
    ],
    faqs: [
      {
        q: "¿Por qué algunas filas dicen «El paciente o su contacto»?",
        a: "Porque lo hizo la propia persona: confirmó o cambió su cita, respondió un presupuesto o abrió un documento desde el portal o desde su enlace. Nunca queda a nombre de quien le envió el enlace.",
      },
      {
        q: "¿Por qué un cobro sale en una sola fila?",
        a: "Porque es una sola acción: al cobrar quedan registrados el pago, su aplicación a cada concepto, el ticket y el movimiento de caja, y la fila dice lo que se hizo («Emitió un ticket») con lo demás debajo, en «También». Lo mismo al anular. En «Sobre qué» van la persona y el ticket, la cita o el presupuesto, cada uno con su enlace. De una historia bloqueada no se dice el nombre.",
      },
    ],
  },
] as const

/**
 * Cada función recibe la guía del producto de la clínica (`productHelpTopics`;
 * latidIA tiene la suya, issue 229). Sin ella, la de odentIA.
 */
export function helpTopic(
  id: string,
  topics: readonly HelpTopic[] = HELP_TOPICS,
): HelpTopic | undefined {
  return topics.find((topic) => topic.id === id)
}

/** Cómo se llega a la pantalla, dicho como en el menú: «Configuración › Horarios y ausencias». */
export function helpTopicLabel(
  topic: HelpTopic,
  /** Quien solo ve lo suyo llega por su entrada del menú (`menuLabel`): se nombra como la ve. */
  options: { own?: boolean } = {},
): string {
  const title = options.own && topic.menuLabel ? topic.menuLabel : topic.title
  return topic.parent && topic.parent !== title ? `${topic.parent} › ${title}` : title
}

/** El tema de la pantalla donde está la persona: el de la ruta más larga que coincide. */
export function helpTopicForScreen(
  pathname: string,
  topics: readonly HelpTopic[] = HELP_TOPICS,
): HelpTopic | undefined {
  const clean = pathname.replace(/\/+$/, "") || "/"
  const under = (base: string) => clean === base || clean.startsWith(`${base}/`)
  return [...topics]
    .filter((topic) => under(topic.path) || (topic.alsoAt ?? []).some(under))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

/** Puntuación mínima para dar un tema por respuesta. Por debajo, Ariadna dice que no sabe. */
export const HELP_MATCH_SCORE = 40
/** La pregunta frecuente escrita tal cual, o una de sus formas. */
const EXACT_SCORE = 1000
/** Un tema que explica toda la pregunta: por debajo de una pregunta frecuente con las mismas palabras. */
const TOPIC_SCORE = 90
/** Una palabra que la guía no conoce pesa en contra: nombres y detalles, poco; una pregunta ajena, entera. */
const UNKNOWN_WORD_WEIGHT = 2
/** Cuánto suma cada palabra de una frase de búsqueda dicha tal cual. */
const LITERAL_WORD = 4
/** Una pregunta frecuente se usa como respuesta desde este parecido; si no, se responde con el tema. */
const FAQ_ANSWER_SCORE = 55

/**
 * Cuánto dice de un tema una palabra según dónde aparece: sola en el nombre de
 * la pantalla o en sus palabras de búsqueda, dentro de una frase de búsqueda, en
 * sus preguntas frecuentes, en lo que explica de la pantalla o solo dentro de
 * una respuesta.
 */
const STRENGTH = { term: 1, phrase: 0.9, question: 0.8, purpose: 0.5, answer: 0.3 } as const

export interface HelpMatch {
  topic: HelpTopic
  /** Pregunta frecuente que coincidió, si fue una; su respuesta es más precisa que el propósito. */
  faq: HelpFaq | null
  score: number
}

/** Lo que no dice qué busca la persona: da igual «dónde veo» que «cómo hago». */
const EMPTY_WORDS = new Set(
  `a abril agosto ahora ahorita al algo alguien blanqueamiento brackets calza calzas carillas corona coronas curacion curaciones diente dientes extraccion implante implantes limpieza limpiezas muela muelas profilaxis algun alguna algunas alguno algunos alla aqui asi aun ayer ayuda ayudame buenas bueno buenos cada colega como companera companero con contra cual cuales cuando cuanta cuantas cuanto cuantos da dan dar de debe deben debo del deja dejan dental dentales desde dia diciembre dias domingo domingos dos doy dice dicen dime donde el ella ellas ello ellos en encuentro enero entre era es esa esas ese eso esos esta estan estar estas este esto estos estoy favor febrero fue ha hace hacen hacer hacerlo hago han hara hay he hola hoy julio junio jueves la las le les lista lo los lunes luego manana martes marzo mas mayo me mes mi mia miercoles mio mis mucho muy necesito noviembre nada ni no nos nuestra nuestro o octubre otra otras otro otros para parte pasa pasar pasado paso pero poco poder pone poner pongo por porque puede pueden puedo pues que quien quienes quiere quieren quiero quisiera sabado sabados sabe saber sale salen salir se sea segun senor senora septiembre ser si sin sirve sirven sistema sobre solo son soy sr sra su sus tal tambien tan te tener tenemos tengo ti tiene tienen toca toda todas todo todos tu tus tuve tuvimos un una unas uno unos usa usar uso usted va van vas veo ver vez viernes y ya yo`.split(
    " ",
  ),
)

/**
 * La misma palabra dicha de otra forma: los verbos que cambian al conjugarse
 * («cierro», «muevo») y lo que la gente dice distinto a la pantalla («turno»,
 * «doctor», «boleta»). Se aplica igual a la pregunta y a la guía.
 */
const SAME_WORD: Readonly<Record<string, string>> = Object.fromEntries(
  (
    [
      ["cerrar", "cierro cierra cierre cierran"],
      ["mover", "muevo mueve reprogramar reprogramo reagendar reagendo postergar postergo"],
      ["devolver", "devuelvo devuelve devolucion devoluciones reembolso reembolsar"],
      ["encender", "enciendo enciende prendo prender prende prendida prendido activar activo activa actives"],
      ["probar", "pruebo prueba pruebas"],
      ["atender", "atiendo atiende atienda atienden"],
      ["responder", "respuesta respuestas contesto contestar contesta"],
      ["enviar", "mandar mando manda envio mandarle mandarlo"],
      ["eliminar", "borrar borro borra quitar quito"],
      ["agendar", "sacar saco separar separo reservar reservo reserva reservas"],
      ["cita", "turno turnos consulta consultas"],
      ["profesional", "profesionales doctor doctora doctores doctoras dr dra odontologo odontologa odontologos dentista dentistas medico medica medicos"],
      ["conversacion", "conversaciones chat chats"],
      ["ticket", "tickets boleta boletas recibo recibos"],
      ["telefono", "celular movil numero"],
      ["contrasena", "clave password"],
      ["whatsapp", "wsp wasap wassap whats"],
      ["instagram", "insta"],
      ["precio", "tarifa tarifas costo costos cuesta"],
      ["imagen", "radiografia radiografias rayos panoramica panoramicas placa placas tomografia tomografias"],
      ["paciente", "pacientes persona personas cliente clientes"],
      ["invitar", "invito"],
      ["enlace", "link links"],
      ["documento", "dni"],
      ["pago", "pagos plata dinero monto"],
      ["ventas", "vendimos vendido vendio"],
      ["cobrar", "cobro cobros facture facturar facturamos facturado"],
      ["descargar", "bajar bajo"],
      ["promocion", "promo promos oferta ofertas"],
      ["agente", "bot robot chatbot ia"],
      ["sede", "sucursal sucursales local locales"],
      ["horario", "hora horas horarios"],
      ["campana", "campanita"],
      ["inasistencia", "inasistencias faltaron falto"],
      ["correo", "email mail"],
      ["comision", "comisiones porcentaje"],
      // vistIA: «lentes» sería «lent», como «lento»; con «anteojos» no se confunde.
      ["anteojos", "lente lentes gafas"],
    ] as const
  ).flatMap(([word, others]) => others.split(" ").map((other) => [other, word] as const)),
)

/** Dicen qué se hace, no con qué: pesan poco. «Cambio el logo» es sobre el logo. */
const WEAK_WORDS = "abrir agregar agrego anotar anoto buscar busco cambiar cambio conectar conecto configurar configuro corregir corrijo crear creo editar edito empezar empiezo encontrar iniciar inicio modificar modifico nuevo registrar registro subir subo"

/** Raíz corta: «citas», «citar» y «cita» son la misma palabra; «tareas» y «áreas», no. */
function stemOf(word: string): string {
  if (word.length <= 3) return word
  // «bloquearlo», «pasarle»: el verbo sin lo que lleva pegado.
  const bare = word.replace(/(ar|er|ir)(l[aeo]s?|me|se|te)$/, "$1")
  let out = bare.length > 4 && bare.endsWith("s") ? bare.slice(0, -1) : bare
  const ending = /(iendo|ando|amos|emos|imos|ada|ado|ida|ido|an|ar|er|ir)$/.exec(out)?.[0]
  if (ending && out.length - ending.length >= 3) return out.slice(0, -ending.length)
  if (out.length > 3 && /[aeo]$/.test(out)) out = out.slice(0, -1)
  return out
}

/** Las palabras de un texto que dicen algo, ya como raíz y sin repetir. */
function wordsOf(text: string): string[] {
  const out = new Set<string>()
  for (const raw of normalizeForSearch(text).split(" ")) {
    const word = SAME_WORD[raw] ?? raw
    if (word.length >= 2 && !/^\d+$/.test(word) && !EMPTY_WORDS.has(word)) out.add(stemOf(word))
  }
  return [...out]
}

/** Cuántas palabras de la pregunta dicen algo: «¿Dónde veo a Ana?», una. */
export const helpWordCount = (text: string): number => wordsOf(text).length

/** Los permisos que dejan cambiar cosas en una pantalla: basta uno. */
export const helpWritePermissions = (topic: HelpTopic): readonly string[] =>
  typeof topic.writePermission === "string" ? [topic.writePermission] : (topic.writePermission ?? [])

/** A una letra de distancia: una que falta, sobra, cambia o dos cambiadas de lugar. */
function oneTypoAway(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

interface TopicEntry {
  topic: HelpTopic
  /** Cada palabra del tema con cuánto dice de él. */
  strength: ReadonlyMap<string, number>
  /** Las palabras de búsqueda como se escriben, para lo que se dijo tal cual. */
  phrases: ReadonlyArray<{ text: string; empty: boolean }>
  faqs: Array<{ faq: HelpFaq; words: readonly string[]; exact: ReadonlySet<string> }>
}

interface GuideEntry {
  topics: TopicEntry[]
  /** Pesa más lo que señala pocas pantallas: «deuda», una; «paciente», casi todas. */
  weight: (word: string) => number
  known: ReadonlySet<string>
}

const guideEntries = new WeakMap<readonly HelpTopic[], GuideEntry>()

function guideEntry(topics: readonly HelpTopic[]): GuideEntry {
  const cached = guideEntries.get(topics)
  if (cached) return cached
  const entries: TopicEntry[] = topics.map((topic) => {
    const strength = new Map<string, number>()
    const note = (text: string, value: number) => {
      for (const word of wordsOf(text)) strength.set(word, Math.max(strength.get(word) ?? 0, value))
    }
    note(topic.purpose, STRENGTH.purpose)
    for (const faq of topic.faqs ?? []) {
      note(faq.a, STRENGTH.answer)
      note(faq.q, STRENGTH.question)
    }
    for (const term of [topic.title, ...topic.terms]) note(term, wordsOf(term).length === 1 ? STRENGTH.term : STRENGTH.phrase)
    return {
      topic,
      strength,
      phrases: [topic.title, ...topic.terms].map((term) => ({ text: normalizeForSearch(term), empty: wordsOf(term).length === 0 })),
      faqs: (topic.faqs ?? []).map((faq) => ({
        faq,
        words: wordsOf(faq.q),
        exact: new Set([faq.q, ...(faq.forms ?? [])].map(normalizeForSearch)),
      })),
    }
  })
  const counts = new Map<string, number>()
  for (const entry of entries) for (const word of entry.strength.keys()) counts.set(word, (counts.get(word) ?? 0) + 1)
  const total = Math.max(entries.length, 1)
  const weak = new Set(WEAK_WORDS.split(" ").map(stemOf))
  const entry: GuideEntry = {
    topics: entries,
    known: new Set(counts.keys()),
    weight: (word) => {
      if (weak.has(word)) return 0.5
      const seen = counts.get(word)
      return seen ? 1 + Math.log2(total / seen) : UNKNOWN_WORD_WEIGHT
    },
  }
  guideEntries.set(topics, entry)
  return entry
}

/** Una palabra que la guía no conoce y está a una letra de una sola que sí: se escribió mal. */
function fixTypos(words: readonly string[], known: ReadonlySet<string>): string[] {
  return words.map((word) => {
    if (word.length < 5 || known.has(word)) return word
    const near = [...known].filter((candidate) => candidate.length >= 5 && oneTypoAway(word, candidate))
    return near.length === 1 ? (near[0] ?? word) : word
  })
}

/**
 * Los temas que responden a una pregunta, por palabras completas: una palabra
 * suelta dentro de otra no cuenta («ia» no está en «gracias»). Cada tema suma
 * lo que explica de la pregunta; pesa más lo que señala pocas pantallas y lo
 * que está en sus palabras de búsqueda. Hace falta al menos una palabra de sus
 * búsquedas o sus preguntas, y si nada alcanza, no hay respuesta. Sin modelo:
 * es barato, se puede probar y no inventa.
 */
export function matchHelpTopics(
  question: string,
  topics: readonly HelpTopic[] = HELP_TOPICS,
): HelpMatch[] {
  const asked = normalizeForSearch(question)
  if (!asked) return []
  const guide = guideEntry(topics)
  const words = fixTypos(wordsOf(question), guide.known)
  const set = new Set(words)
  const weightOf = (list: Iterable<string>) => [...list].reduce((sum, word) => sum + guide.weight(word), 0)
  const askedWeight = weightOf(words)
  const spaced = ` ${asked} `

  const matches: HelpMatch[] = []
  for (const entry of guide.topics) {
    let emptyPhrase = false
    let literal = 0
    for (const phrase of entry.phrases) {
      if (!spaced.includes(` ${phrase.text} `)) continue
      literal = Math.max(literal, phrase.text.split(" ").length)
      if (phrase.empty) emptyPhrase = true
    }
    const anchored = words.some((word) => (entry.strength.get(word) ?? 0) >= STRENGTH.question)
    const explained = words.reduce((sum, word) => sum + guide.weight(word) * (entry.strength.get(word) ?? 0), 0)
    let best: HelpMatch = {
      topic: entry.topic,
      faq: null,
      // Lo que dijo tal cual desempata: «Registro de pacientes» es esa pantalla, no la de Pacientes.
      score: emptyPhrase ? TOPIC_SCORE + literal : anchored && askedWeight > 0 ? (TOPIC_SCORE * explained) / askedWeight + Math.min(literal, 4) * LITERAL_WORD : 0,
    }
    let bestFaq = 0
    for (const item of entry.faqs) {
      if (item.exact.has(asked)) {
        best = { topic: entry.topic, faq: item.faq, score: EXACT_SCORE }
        bestFaq = EXACT_SCORE
        break
      }
      const shared = item.words.filter((word) => set.has(word))
      if (shared.length === 0 || askedWeight === 0) continue
      const recall = weightOf(shared) / askedWeight
      const precision = weightOf(shared) / weightOf(item.words)
      const score = (200 * recall * precision) / (recall + precision)
      if (score > bestFaq && score >= FAQ_ANSWER_SCORE) {
        bestFaq = score
        best = { ...best, faq: item.faq, score: Math.max(best.score, score) }
      }
    }
    matches.push(best)
  }
  // Una sola respuesta: dos pantallas para una pregunta confunden más de lo que ayudan.
  const first = matches.reduce<HelpMatch | null>((top, match) => (!top || match.score > top.score ? match : top), null)
  return first && first.score >= HELP_MATCH_SCORE ? [first] : []
}

const GREETINGS = new Set(["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches"])
const THANKS = new Set(["gracias", "muchas gracias", "mil gracias", "okay", "listo", "perfecto", "genial", "vale", "entendido", "ya entendi", "ya esta"])

/** Saludar o agradecer no es una pregunta: se responde sin buscar en la guía ni ofrecer enviarlo a soporte. */
export function helpSmallTalk(question: string): string | null {
  const asked = normalizeForSearch(question).replace(new RegExp(` ?${normalizeForSearch(AGENT_NAMES.ayuda)}$`), "")
  if (GREETINGS.has(asked)) return `Hola, soy ${AGENT_NAMES.ayuda}. Dime qué quieres hacer o qué no encuentras.`
  if (THANKS.has(asked)) return "De nada. Si necesitas algo más, aquí estoy."
  return null
}

/** Preguntas que la gente suele hacer en una pantalla, para ofrecerlas sin que escriba. */
export function helpSuggestions(
  pathname: string,
  topics: readonly HelpTopic[] = HELP_TOPICS,
): string[] {
  const topic = helpTopicForScreen(pathname, topics)
  const own = (topic?.faqs ?? []).map((faq) => faq.q)
  const general = [
    "¿Dónde configuro los horarios?",
    "¿Cómo invito a alguien a mi equipo?",
    "¿Cómo enciendo el agente?",
  ]
  return [...new Set([...own, ...general])].slice(0, 3)
}

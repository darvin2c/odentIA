import type { HelpMore } from "../help-guide.js"

/** La Agenda y lo que la configura: horarios, equipo, sedes, especialidades, datos de la clínica y actividad. */
export const AGENDA_EQUIPO: readonly HelpMore[] = [
  {
    topic: "agenda",
    faqs: [
      {
        id: "agenda-reprogramar",
        q: "¿Cómo reprogramo una cita?",
        a: "Abre la cita y pulsa «Reprogramar»: eliges el día y la hora, y con «Cambiar de profesional» también quién atiende; el botón de abajo dice a dónde la mueves. Conserva su servicio y no deja una cita cancelada. Solo aparece mientras la persona no ha llegado. En la vista «Agenda» también está en el «…» de la fila.",
        forms: ["como cambio la hora de una cita", "el paciente quiere su cita otro dia", "pasar la cita a otro profesional"],
      },
      {
        id: "agenda-buscar-cita",
        q: "¿Cómo busco la cita de un paciente?",
        a: "En la Agenda toca la lupa, «Buscar la cita de un paciente», y escribe su nombre, documento o teléfono, al menos dos letras. Salen sus citas con día, hora y profesional: toca una y se abre. Si dice «No tiene citas próximas», ahí mismo está «Reservar cita».",
        forms: ["cuando tiene cita un paciente", "no encuentro la cita de un paciente en la agenda", "buscar una cita por nombre"],
      },
      {
        id: "agenda-cancelar",
        q: "¿Cómo cancelo una cita?",
        a: "Abre la cita y pulsa «Cancelar cita»: eliges el motivo («Lo pidió el paciente», «Lo pidió la clínica» u «Otro motivo») y, si hace falta, dejas una nota. El hueco queda libre y el aviso trae «Reservar otro día». Solo se cancela una cita a la que la persona aún no llegó. Si solo quiere otro día, usa «Reprogramar»: no deja una cita cancelada.",
        forms: ["anular una cita", "el paciente ya no viene a su cita", "como elimino una cita"],
      },
      {
        id: "agenda-arrastrar",
        q: "¿Puedo arrastrar una cita para moverla?",
        a: "Sí. En la vista «Día», arrastra la cita a otra hora o a la columna de otro profesional, y estira su borde para que dure más o menos; en el teléfono, mantén el dedo sobre ella. Si cae fuera de horario, en una hora bloqueada o sobre otra cita, te dice por qué y confirmas con «Mover». El aviso trae «Deshacer» para devolverla a su sitio. Con teclado, Alt+Intro levanta la cita, las flechas la mueven e Intro la suelta.",
        forms: ["mover la cita con el mouse", "alargar una cita ya reservada", "mover una cita con el teclado"],
      },
      {
        id: "agenda-editar-detalles",
        q: "¿Cómo cambio el servicio de una cita?",
        a: "Abre la cita y pulsa «Editar detalles»: ahí cambias el servicio, la unidad dental y el motivo, y guardas con «Guardar cambios». La hora y el profesional se cambian con «Reprogramar».",
        forms: ["editar el motivo de la cita", "editar una cita", "cambiar de sala una cita"],
      },
      {
        id: "agenda-duracion",
        q: "¿Cómo hago una cita más larga?",
        a: "En «Nueva cita», al elegir la hora aparece al lado cuánto dura: tócalo y elige de 15 minutos a 2 horas, o estira el bloque. En una cita ya reservada, estira su borde en la vista «Día».",
        forms: ["cita de una hora", "cambiar la duracion de una cita", "reservar una cita de mas tiempo"],
      },
      {
        id: "agenda-filtrar-profesionales",
        q: "¿Cómo veo solo la agenda de un profesional?",
        a: "En la Agenda, el botón «Profesionales» deja marcar a quién quieres ver, a uno o a varios; «Ver a todos» quita el filtro. Si atiendes, la Agenda abre en tu columna: con «Ver a todos» ves al resto del equipo.",
        forms: ["filtrar la agenda por profesional", "solo veo mis citas y quiero ver las de todos", "ver la agenda de todo el equipo"],
      },
      {
        id: "agenda-por-unidad",
        q: "¿Cómo veo qué unidad dental está libre?",
        a: "En la vista «Día», abre «Profesionales» y elige la última opción, ver por unidad dental: cada columna es una unidad dental con sus citas. Arrastrar una cita a otra columna la cambia de unidad dental; para reservar desde un hueco, vuelve con «Ver por profesional».",
        forms: ["ver la agenda por sala", "que sala esta ocupada", "ver las citas por consultorio"],
      },
      {
        id: "agenda-vistas-fechas",
        q: "¿Cómo veo las citas de otro día?",
        a: "Con las flechas pasas al día anterior o al siguiente, «Hoy» te devuelve a hoy y tocar la fecha abre el calendario para ir a cualquier día. «Día» es la rejilla por horas, «Semana» muestra a todo el equipo con sus horas libres y «Agenda» lista las citas del día elegido y los siete siguientes.",
        forms: ["ir a otra fecha en la agenda", "que diferencia hay entre dia semana y agenda", "ver la agenda de manana"],
      },
      {
        id: "agenda-semana-huecos",
        q: "¿Cómo veo los huecos libres de la semana?",
        a: "En «Semana» hay una fila por profesional y cada día dice cuánto le queda libre. Toca un día para abrir «Nueva cita» con esa persona y ese día, o toca su nombre para ver su semana hora por hora; «Todo el equipo» te devuelve a la vista general.",
        forms: ["quien tiene sitio esta semana", "ver la semana de un profesional por horas", "horas libres de la semana"],
      },
      {
        id: "agenda-por-confirmar",
        q: "¿Cómo veo las citas que faltan confirmar?",
        a: "En la vista «Día», junto al total de citas, el número de las que están por confirmar te lleva a la lista de ese día. En la vista «Agenda» filtras por estado con las fichas de arriba, y cada fila trae su botón según cómo va («Confirmar cita», «Llegó», «Atender», «Reagendar») y un «…» con «Reprogramar», «No vino» y «Cancelar cita». «Quitar filtros» vuelve a mostrarlas todas.",
        forms: ["cuales citas no han confirmado", "filtrar las citas por estado", "ver solo las citas canceladas"],
      },
      {
        id: "agenda-confirmar-a-mano",
        q: "El paciente me confirmó por teléfono, ¿dónde lo pongo?",
        a: "Abre la cita y pulsa «Confirmar cita»: eliges «Confirmó por teléfono», «Confirmó en persona» o «Confirmó por mensaje», y queda registrado cómo confirmó. Está mientras la cita sigue por confirmar y no ha llegado su hora.",
        forms: ["confirmar una cita a mano", "marcar una cita como confirmada", "me confirmo en persona"],
      },
      {
        id: "agenda-otra-sede",
        q: "¿Cómo veo la agenda de otra sede?",
        a: "Toca el nombre de la sede, junto a la fecha de la Agenda (en el teléfono, bajo el título), y elige la otra: la Agenda muestra sus profesionales y sus citas. Con una sola sede no hay nada que elegir. El mismo selector está en Horarios y ausencias.",
        forms: ["cambiar de sede en la agenda", "citas de la otra sede", "ver los horarios de otra sede"],
      },
      {
        id: "agenda-avisos-cita",
        q: "¿Qué significa el aviso que sale en una cita?",
        a: "Es lo que hay que mirar de esa cita: está «Fuera de horario» de su profesional, quedó «Dentro de una ausencia», se solapa con otra cita del mismo profesional o de la misma unidad dental, o es de alguien que ya no atiende y hay que pasarla a otra persona. No se mueve sola: ábrela y usa «Reprogramar».",
        forms: ["cita marcada fuera de horario", "por que una cita dice dentro de una ausencia", "cita con solapamiento"],
      },
      {
        id: "agenda-ficha-desde-cita",
        q: "¿Cómo abro la ficha del paciente desde su cita?",
        a: "Abre la cita: abajo está «Abrir la ficha de…», con su nombre. Si le faltan datos para atenderse lo dice, con «Completar» al lado; si la cita salió de una conversación, «Ver la conversación» te lleva a ella; y si ya está en atención o atendida, quien ve la historia clínica tiene «Continuar la atención» o «Ver la atención».",
        forms: ["ir a la ficha del paciente desde la agenda", "le faltan datos al paciente de la cita", "ver la atencion desde la cita"],
      },
      {
        id: "agenda-mi-calendario-enlace",
        q: "¿Cómo creo o cambio el enlace de mi calendario?",
        a: "En la Agenda, «Mi calendario» › «Crear mi enlace» y luego «Añadir a Google Calendar» o «Añadir a Apple o Outlook». Trae tus citas de hoy a tres meses, y los cambios pueden tardar porque depende de tu calendario. Si lo compartiste por error o sale el aviso «Uso nuevo» y no fuiste tú, «Cambiar enlace» deja sin efecto el anterior; «Dejar de compartir» lo apaga.",
        forms: ["crear mi enlace del calendario", "alguien mas tiene el enlace de mi calendario", "dejar de compartir mi calendario"],
        needs: "clinical.write",
      },
      {
        id: "agenda-mas-horas",
        q: "¿Cómo doy una cita más temprano o más tarde de lo que muestra la agenda?",
        a: "Al pie de la vista «Día», «Ver de 6:00 a 22:00» muestra más horas que la jornada; «Ver solo la jornada» vuelve. Si el día sale vacío es que nadie atiende o la sede no atiende ese día: «Ir al…» te lleva al próximo día con atención.",
        forms: ["no veo las horas de la noche en la agenda", "la agenda sale vacia", "ver mas horas en la agenda"],
      },
    ],
  },
  {
    topic: "disponibilidad",
    faqs: [
      {
        id: "disponibilidad-turnos",
        q: "¿Cómo pongo que un profesional atiende mañana y tarde?",
        a: "En Configuración › Horarios y ausencias elige al profesional y, en su horario semanal, añade con «Turno» los tramos de cada día, por ejemplo uno de mañana y otro de tarde; la X quita un turno y un día sin turnos queda en «No atiende». Guarda con «Guardar horario»: vale desde hoy y el horario anterior se conserva para los reportes. Lo cambian el Propietario y el Administrador.",
        forms: ["horario partido", "quitar el sabado del horario de un profesional", "agregar un turno al horario"],
      },
      {
        id: "disponibilidad-ausencia",
        q: "¿Cómo registro las vacaciones de un profesional?",
        a: "En Configuración › Horarios y ausencias elige al profesional y pulsa «Nueva ausencia»: el motivo («Vacaciones», «Permiso» u «Otro») y las fechas; si son solo unas horas, desmarca «Todo el día». Se guarda con «Guardar ausencia». Si quedan citas dentro te lo dice, porque no se cancelan solas: «Ver y reprogramar» te lleva a moverlas. Para borrarla, «Quitar» en su fila.",
        forms: ["el profesional no viene un dia", "registrar un permiso de unas horas", "quitar una ausencia"],
      },
      {
        id: "disponibilidad-feriado",
        q: "¿Cómo pongo un feriado?",
        a: "En Configuración › Horarios y ausencias, «Nuevo feriado o cierre»: eliges el motivo («Feriado», «Cierre» u «Otro»), las fechas y, en «Qué se cierra», «Toda la sede» o una sola unidad dental. Vale para todos los profesionales de la sede; «Quitar» en su fila lo borra.",
        forms: ["cerrar la clinica un dia", "una sala esta en mantenimiento", "registrar un cierre de la sede"],
      },
      {
        id: "disponibilidad-unidades",
        q: "¿Cómo agrego una unidad dental?",
        a: "En Configuración › Horarios y ausencias, en la tarjeta de las unidades dentales, pulsa el botón de añadir y ponle nombre. En su «…» está «Renombrar» y «Desactivar»: desactivada no recibe citas nuevas, las que ya tenía siguen ahí y no se mueven solas, y vuelve con «Reactivar». Sin al menos una activa no se puede reservar.",
        forms: ["agregar una sala", "quitar una sala que ya no se usa", "cambiar el nombre de una sala"],
      },
      {
        id: "disponibilidad-duracion-regular",
        q: "¿Dónde cambio lo que dura una cita regular?",
        a: "En Configuración › Horarios y ausencias, «Duración de una cita regular»: elige de 15 minutos a 2 horas y se guarda al elegirla. Es lo que dura una cita sin servicio; con servicio manda su duración. Ahí mismo, «Horario de atención» muestra la suma de los horarios de quienes atienden, que es lo que Sofi dice cuando le preguntan.",
        forms: ["citas de 45 minutos por defecto", "que horario de atencion dice sofi", "duracion de la cita sin servicio"],
      },
    ],
  },
  {
    topic: "equipo",
    faqs: [
      {
        id: "equipo-quitar-cambiar-rol",
        q: "¿Cómo le quito el acceso a alguien que ya no trabaja aquí?",
        a: "En Configuración › Equipo, en el «…» de la persona, «Quitar del equipo»: deja de entrar a la clínica con su cuenta y lo que registró se conserva. Para cambiar lo que ve y hace, ahí mismo está la opción de cambiar su rol. Si atendía, su horario se cierra y sus citas por venir quedan en la Agenda, marcadas para pasarlas a otra persona; el aviso trae «Ver sus citas». No se hace sobre uno mismo ni sobre el único Propietario, y a un Propietario solo lo cambia otro Propietario.",
        forms: ["cambiar el rol de una persona", "sacar a alguien del equipo", "eliminar un usuario"],
      },
      {
        id: "equipo-roles",
        q: "¿Qué puede hacer cada rol?",
        a: "Propietario y Administrador pueden todo; solo el Propietario nombra o quita propietarios. Recepción registra pacientes y lleva la agenda, las conversaciones, las tareas, los contactos y oportunidades, sin historia clínica ni caja. El odontólogo ve pacientes, historia clínica, agenda, conversaciones, tareas y sus propias comisiones, sin caja. Caja ve a los pacientes y lleva la caja, sin historia clínica ni agenda, y Miembro solo ve las tareas. La descripción completa sale bajo «Rol» al invitar o al cambiar el rol.",
        forms: ["que puede hacer recepcion", "que roles hay", "diferencia entre propietario y administrador", "que ve el rol de caja"],
      },
      {
        id: "equipo-invitacion-pendiente",
        q: "No le llegó la invitación, ¿qué hago?",
        a: "En Configuración › Equipo, abajo, «Invitaciones pendientes» lista a quien aún no creó su cuenta. No se reenvía: en su «…» pulsa «Cancelar invitación», que deja sin efecto el enlace que recibió, e invítale de nuevo con «Invitar al equipo», revisando el correo.",
        forms: ["reenviar la invitacion", "me equivoque de correo al invitar", "cancelar una invitacion"],
      },
      {
        id: "equipo-colegiatura",
        q: "¿Dónde pongo el número de colegiatura de un profesional?",
        a: "En Configuración › Equipo, en su «…», «Perfil profesional» (en tu fila, «Mi perfil profesional»): título, colegio, número de colegiatura y registro de especialista, y se guarda con «Guardar perfil». El número es obligatorio para firmar el cierre de una atención. La columna «Colegiatura» dice «Sin registrar» a quien atiende y aún no lo tiene.",
        forms: ["registrar la colegiatura", "a quien le falta la colegiatura", "cambiar el titulo profesional"],
      },
      {
        id: "equipo-citas-por-mover",
        q: "¿Qué es «citas por mover» en Equipo?",
        a: "Sale en la columna «Atiende» de quien ya no atiende y aún tiene citas por venir: tócalo y la Agenda te las muestra para pasarlas a otra persona. Los días de esa columna y «Sin horario» abren el horario de la persona en Horarios y ausencias.",
        forms: ["citas por mover", "citas de alguien que ya no atiende", "pasar las citas de un profesional a otro"],
      },
      {
        id: "equipo-dos-pasos-todos",
        q: "¿Por qué no puedo pedir la verificación en dos pasos a todo el equipo?",
        a: "Porque primero tienes que tenerla activa tú: «Activarla en Mi perfil». Después, en Configuración › Equipo, enciende «Pedir verificación en dos pasos a todo el equipo» y confirma con «Pedirla desde ahora»; «Avisarles ahora por correo» les manda los pasos. A quien le falte se le pide en su próxima acción en la clínica, y la columna «Verificación en dos pasos» dice quién sigue «Sin activar». Se apaga con el mismo interruptor.",
        forms: ["obligar a todos a usar los dos pasos", "quien no tiene la verificacion en dos pasos", "no me deja pedir los dos pasos al equipo"],
      },
    ],
  },
  {
    topic: "sucursales",
    faqs: [
      {
        id: "sucursales-editar-desactivar",
        q: "¿Cómo cierro una sede?",
        a: "En Configuración › Sedes, en el «…» de la sede, «Desactivar»: deja de aparecer en la agenda y no se reservan citas en ella, pero sus citas, horarios y unidades dentales se conservan y vuelve con «Reactivar». Si es la única activa, la agenda y las reservas dejan de funcionar hasta que reactives una. «Editar» cambia su nombre, dirección, teléfono y zona horaria, y «Nueva sede» crea otra.",
        forms: ["desactivar una sede", "cambiar la direccion de una sede", "editar una sede"],
      },
      {
        id: "sucursales-enlace-llegar",
        q: "¿Dónde saco el enlace para llegar a la clínica?",
        a: "En Configuración › Sedes, en el «…» de la sede: «Cómo llegar» abre su ubicación en Google Maps y «Copiar el enlace para llegar» copia un enlace corto de tu clínica, para tus redes o tu firma de correo. Salen en las sedes activas que tienen dirección.",
        forms: ["link de ubicacion de la sede", "copiar el enlace de como llegar", "enlace del mapa de la sede"],
      },
      {
        id: "sucursales-almacenes",
        q: "¿Cómo agrego otro almacén a una sede?",
        a: "En Configuración › Sedes, «Editar» la sede: abajo está «Almacenes». Cada sede trae uno «Principal», adonde llegan las compras y de donde se descuentan las atenciones y las ventas; «Almacén» agrega otro, solo si hace falta, y en su «…» está «Renombrar» y «Desactivar». Lo ve quien lleva el inventario y entra a Configuración: el Propietario y el Administrador.",
        forms: ["tengo un deposito aparte", "crear un almacen", "renombrar un almacen"],
        needs: "inventory.write",
      },
    ],
  },
  {
    topic: "especialidades",
    faqs: [
      {
        id: "especialidades-quien-atiende",
        q: "¿Cómo digo qué profesional atiende una especialidad?",
        a: "En Configuración › Especialidades, «Editar» la especialidad y marca en «Quién atiende» a quienes la hacen: la agenda ofrecerá sus servicios solo a ellos, si tienen horario en esa sede. «Agregar especialidad» crea una nueva. Dentro de «Editar», «Archivar especialidad» la retira: sus servicios la conservan y la agenda los ofrece a cualquiera; vuelve con «Reactivar especialidad».",
        forms: ["agregar una especialidad", "quitar una especialidad que no usamos", "que profesional hace cada especialidad"],
      },
    ],
  },
  {
    topic: "organizacion",
    faqs: [
      {
        id: "organizacion-telefono-urgencias",
        q: "¿Qué número da Sofi si hay una urgencia?",
        a: "El que pongas en Datos de la clínica › «Identidad» › «Teléfono para urgencias»: Sofi lo da ante una urgencia junto con el número de emergencias del país. Si lo dejas vacío, solo da ese número o dice que vaya a la emergencia más cercana. Ahí mismo va la «Dirección fiscal».",
        forms: ["telefono de emergencias de la clinica", "donde pongo la direccion fiscal", "telefono para urgencias"],
      },
      {
        id: "organizacion-idioma",
        q: "¿Dónde cambio el idioma?",
        a: "No se elige: la app usa el español de tu país, que sale del «País» en Datos de la clínica.",
        forms: ["poner la app en ingles", "idioma de la clinica", "cambiar el idioma de la app"],
      },
    ],
  },
  {
    topic: "auditoria",
    faqs: [
      {
        id: "auditoria-filtrar-area",
        q: "¿Cómo filtro la actividad del equipo?",
        a: "En Configuración › Actividad del equipo, «Área» deja ver una sola área o «Todas las áreas», y al final de la lista «Ver actividad anterior» carga lo más antiguo. No se busca por persona ni por fecha. «Automático» es lo que no hizo una persona del equipo: lo deja el sistema, o alguien desde un enlace de la clínica. La ven el Propietario y el Administrador.",
        forms: ["ver solo la actividad de un area", "que significa automatico en la actividad", "quien puede ver la actividad del equipo"],
      },
    ],
  },
]

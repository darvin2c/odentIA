# 0131 · Filas alineadas y cada botón ahí mismo

Fecha: 2026-11-02 · Estado: aceptada · Precisa [0035](0035-la-ficha-en-cuatro-secciones.md) y [0126](0126-un-boton-una-accion.md).

## Problema

El Resumen ponía sus tarjetas en dos columnas: «Qué sigue» medía 416 px para 60 de contenido, y una tarjeta larga dejaba hasta 610 px en blanco a su lado. Y muchos botones de la ficha llevaban a otra pestaña, o solo cerraban el panel. Tres hacían algo peor: abrir `?cobrar=true` y «Cobrar» de la cabecera aplicaban el saldo a favor sin preguntar, y «Escribirle» pasadas las 24 horas le decía a la persona «respondió tu consulta» sin que hubiera preguntado nada.

## Decisión y motivo

- **Filas alineadas, nunca columnas sueltas.** Lo que puede crecer va solo en su fila: alergias y alertas, lo del producto, «Qué sigue», pendientes, notas y lo que recuerda Sofi. Solo Última atención y Próxima cita comparten fila, con cada dato en 2 líneas como máximo: lo demás se lee con «Ver» y «Ver la cita». El peor caso medido deja unos 125 px en blanco.
- **Lo que se abre va encima y al cerrar se sigue donde se estaba** (`WideSectionProvider`). Son las mismas secciones de la página, con su permiso y su traza, también en el Contexto de la Bandeja. La dirección `?tab=` sigue abriéndolas como página: hay enlaces guardados.
- **Aplicar saldo a favor siempre se confirma, con importe y sede** (`ApplyCreditDialog`). Abrir una dirección o pulsar «Cobrar» nunca ejecuta: mueve dinero y deja un ticket. El botón dice lo que hará: «Cobrar», «Cobrar un adelanto» o «Aplicar lo que tiene a favor».
- **«Nueva cita» elige qué trae, con casillas.** Vienen marcados los del primer servicio y otro servicio marca lo suyo, porque tres tratamientos distintos en una cita de 30 minutos no caben. Dos iguales son una casilla («× 2»): recepción no ve las piezas y elegir entre ellos sería a ciegas; lo que se hace de verdad se decide en la atención. La pantalla manda su lista, aunque quede vacía.
- **La cita que no dice qué trae une lo aceptado sin cita de su servicio.** Es la regla de Clío, y arregla a Sofi y al enlace sin tocarlos. La cita de un control manda su lista vacía: es para el control.
- **Desde la ficha se le empieza a hablar, no se responde** (`fromRecord`, lo decide el servidor). Pasadas las 24 horas de WhatsApp o si nunca escribió, mensajes aprobados. Solo se responde el único tema y de quien mira, como en la Bandeja (ADR 0122): el de otra persona no quita la caja y con varios nadie elige. Instagram o Messenger cerrados pasan a su WhatsApp. Bloqueada o archivada, lo dice y no hay caja. Inicio y la Bandeja responden lo que espera y siguen como estaban.
- **Una ficha archivada se lee, pero no ofrece trabajo nuevo**, con la regla de su cabecera en lo que se pinta debajo (`usePersonArchived`).

## Alternativas descartadas

- *Columnas independientes (masonry)*: las tarjetas no quedan alineadas entre sí y el ojo no sabe por dónde seguir. El dueño la descartó.
- *Estirar las tarjetas a la misma altura*: es lo que producía el blanco.
- *Todo en una columna, también Última atención y Próxima cita*: quita los 125 px del peor caso y alarga la página unos 120 px para todos los pacientes.
- *«Viene puesto, con Quitar» en «Nueva cita»*: marcarlo todo da citas demasiado cortas.
- *Usar el panel tal como está en «Escribirle»*: enviaría el aviso falso y recepción no podría escribir si otra persona lleva un tema.

## Consecuencias

- La página es unos 130 px más larga con un paciente normal y «Qué sigue» baja unos 230 px, porque va después de las alertas.
- Las citas ya reservadas no se unen solas: la regla vale desde que se crean.
- Una cita de Sofi o del enlace con un servicio trae todo lo aceptado de ese servicio aunque la persona venga por uno solo; en la atención se ve y se decide qué se hizo.
- Adjuntos, audio, elegir entre varios temas y «Registrar confirmación» siguen en la Bandeja, con «Ver toda la conversación».

## Referencias

`components/patient/wide-section.tsx`, `collect-flow.tsx`, `components/person/record-panel.tsx`, `createAppointment` (`acceptedOfService`), `getPersonPanel`, `getTreatmentCoordination`.

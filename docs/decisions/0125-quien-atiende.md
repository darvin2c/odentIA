# 0125 · Quién puede atender y quién atiende

Fecha: 2026-11-01 · Estado: aceptada · Precisa [0039](0039-un-solo-catalogo-de-especialidades.md) y [0118](0118-cada-numero-donde-se-resuelve.md)

## Problema

Cada parte decidía por su cuenta quién era «profesional»: cualquier miembro (menú de la agenda, Horarios y ausencias, Especialidades, responsable de un formulario, perfil profesional, y el servidor al guardar horario, cita o comisión), el permiso clínico (atención, derivación, Mi calendario), una lista de roles escrita a mano (Colegiatura, derivar), tener horario (agenda, Sofi, enlace, horario de la sede) o tener horario o alguna cita (Argos).

El resultado se veía en la clínica: caja y recepción salían en «No atienden este día» y se les podía reservar con un clic; con un horario, Sofi y el enlace las ofrecían a los pacientes y el horario de la sede crecía. Quien salía del equipo seguía ofreciéndose, y reservar con esa persona fallaba. Lo único que distinguía a alguien en pantalla era un «Dra.» escrito en su nombre.

## Decisión y motivo

- **Dos preguntas, una respuesta para cada una.**
  - **Puede atender:** sigue en la clínica y su rol escribe en la historia (`canAttend`, `ATTENDING_ROLES` de `permissions.ts`). Lo exige el servidor (`requireCanAttend`) al poner horario o ausencia, dar o reasignar una cita, adscribir a una especialidad, fijar una comisión, registrar la colegiatura y nombrar al responsable de un formulario.
  - **Atiende:** además tiene horario activo en esa sede. Es lo que leen la agenda, Sofi, el enlace y el horario de la sede.
- **Un horario activo siempre es de quien puede atender, y lo garantiza la base.** Un disparador sobre `member` cierra el horario de quien sale o cambia a un rol que no atiende, por cualquier vía: Equipo, irse por su cuenta o la administración. Así ninguna lectura repite la regla. Se cierra como un cambio de horario (ADR 0060): lo de antes queda para Reportes. La migración cierra lo que ya había.
- **Sus citas no se tocan.** Siguen en la Agenda, marcadas para pasarlas a otra persona, y Equipo las dice antes de confirmar. Se pueden confirmar o cancelar; moverlas exige elegir a quien atienda.
- **Quien dirige no atiende hasta que tiene horario.** Propietario y administrador pueden atender, pero un menú de la agenda no los ofrece sin horario y Equipo dice «No atiende». Quien atiende de oficio y no tiene horario dice «Sin horario», que es un pendiente.
- **Equipo lo dice a la vista**, en la columna «Atiende»: un rol por persona no dice que la dueña también atiende.

## Alternativas descartadas

- *Un interruptor «Atiende pacientes» en cada persona:* un dato más que mantener y que puede contradecir al horario, que ya lo dice.
- *Filtrar por rol en cada lectura de horarios:* son más de diez consultas, y la siguiente lo olvidaría. Además, el horario de quien ya no atiende seguiría contando en Reportes.
- *Cerrar el horario con avisos de Better Auth:* quedan fuera la administración y cualquier otra vía; un paquete de identidad tampoco debe conocer la agenda.
- *Un rol nuevo para quien dirige y atiende:* multiplica los roles por una diferencia que el horario ya resuelve.

## Consecuencias

- Beneficio: lo que ven los pacientes y el equipo sale de quien de verdad atiende, en los dos productos.
- Sacrificio: la lista de roles se repite en el disparador; `quien-atiende.test.ts` recorre todos los roles y falla si dejan de coincidir. Quien vuelve a poder atender empieza sin horario.
- Sacrificio: una recepción que abre antes que el primer profesional sigue sin cómo decirlo (0118). Si una clínica lo pide, se revisa con un horario propio de recepción.
- Revisar si una clínica necesita a alguien que atiende sin escribir en la historia, como una asistente con citas propias.

## Referencias

- `packages/auth/src/permissions.ts`, `packages/services/src/attending.ts`, migración `0034_quien_atiende.sql`, `packages/services/src/quien-atiende.test.ts`, `packages/clinic-app/src/routes/_org/settings.team.tsx`.

# 0026 · «Recordar la cita» viene prendida en toda clínica nueva

Fecha: 2026-10-15 · Estado: aceptada · Excepción acotada a [0015](0015-administrador-lineas-prendidas-o-apagadas.md) y [0023](0023-el-administrador-detecta-y-recepcion-habla.md)

## Problema

Las líneas del Administrador nacen apagadas: nada se prende sin una persona (`setLine` es la única operación que lo hace) y una semilla no activa reglas. Pero confirmar las citas es lo básico de una clínica y la mediana no va a buscar una línea en la página del Administrador para que el agente recuerde las citas. Mientras nadie la prende, las citas se quedan «Sin confirmar» y las inasistencias no bajan.

## Decisión y motivo

- Al crear una clínica (la primera vez que se guarda su perfil, en el alta), «Recordar la cita» queda prendida con `setLine`, a nombre de quien crea la clínica, y con un registro propio (`admin_line.default_on`) además del de la línea. Es la misma operación y la misma huella que si esa persona la hubiera prendido con el interruptor.
- Solo esa línea, solo en clínicas nuevas y solo si la línea no tiene ya un estado: nunca se toca una clínica existente ni una línea que alguien apagó.
- No cambia nada más: Recepción y el Administrador siguen apagados hasta que la clínica los encienda, la baja de cada persona se respeta (desde [0030](0030-lo-del-servicio-no-pide-permiso.md) los recordatorios no piden permiso previo) y lo que sale por WhatsApp espera a que sus mensajes estén aprobados. La línea prendida solo evita tener que buscarla.

El usuario lo aprobó el 15 de octubre (tablero 3 de la fase 2).

## Alternativas descartadas

- *Prenderla en todas las clínicas*: cambiaría lo que una clínica ya decidió y escribiría a personas sin que nadie de la clínica lo eligiera.
- *Recomendarla en Inicio*: ya existe y no basta; la clínica mediana no la prende.
- *Prenderla desde la semilla o una migración*: deja una línea prendida sin una persona que responda por ella.

## Consecuencias

- Una clínica nueva que enciende Recepción y el Administrador ya recuerda las citas, y el agente avisa al reservar, mover o cancelar (son parte de la misma línea, ver [0027](0027-escribirle-y-avisar-la-cita.md)).
- Sacrificio: una excepción a «nada se prende sin una persona» que hay que mantener explícita. Si otra línea pidiera lo mismo, se decide aparte; no se añade a `NEW_CLINIC_LINES` sin un ADR.

## Referencias

- `packages/services/src/automation.ts` (`turnOnNewClinicLines`, `NEW_CLINIC_LINES`), `apps/api/src/app.ts` (`PUT /org-profile` al crear el perfil).

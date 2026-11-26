-- Termina el programa Fundadores (ADR 0221): el alta es libre y el plan Fundadores queda como un plan
-- especial que asigna la administración. Se apaga «Mostrar en la web» en los planes por invitación
-- (los que tienen lugares), para que la web, Kairós y el correo de las guías muestren solo el plan de
-- lista. Las clínicas que ya están en esos planes no cambian.
UPDATE admin.saas_plan SET show_on_web = false, updated_at = now() WHERE seat_limit IS NOT NULL AND show_on_web;
--> statement-breakpoint
-- El código nuevo ya no lee cómo se abren las clínicas; se deja abierta en odentIA y latidIA para que
-- la API de antes, mientras se publica la nueva, tampoco pida invitación. vistIA no cambia aquí: la
-- API nueva ya no lee la política, y su web dice «Escríbenos» mientras no tenga plan de lista. La
-- tabla, la lista de espera y los lugares se borran en un cambio aparte, cuando este ya esté en
-- producción.
UPDATE admin.saas_signup_policy SET mode = 'abierta', medical_mode = 'abierta', updated_at = now();

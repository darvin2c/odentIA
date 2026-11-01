-- El botón se llama «No es representante» (ADR 0126): los pendientes que siguen abiertos lo dicen igual.
UPDATE task
SET reason = replace(reason, '«No es ella»', '«No es representante»')
WHERE kind = 'confirmar_representante' AND status = 'open' AND reason LIKE '%«No es ella»%';

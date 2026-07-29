# Gráficos dinámicos para fields

## Resumen

La idea encaja con la arquitectura actual sin WASM ni machinery genérica.
Usaremos las annotations de schema ya existentes, añadiremos un botón al
inspector y materializaremos únicamente la serie solicitada.

## Contrato Rust y trace

- Añadir el atributo estable con tres valores posibles:

```rust
#[traceevent(kind = "gauge")]
temperature: f64,

#[traceevent(kind = "counter")]
requests_total: u64,

#[traceevent(kind = "up_down_counter")]
in_flight: i64,
```

- Usar `kind` porque describe la semántica temporal del field, no su
  representación visual.
- Validar esos tres valores durante compilación y rechazar `kind` sobre el
  timestamp.
- Codificarlo como annotation de field con key `"kind"`; no cambia el layout
  del trace format.
- Permitir combinarlo con `unit`:

```rust
#[traceevent(unit = "bytes", kind = "gauge")]
resident_bytes: u64,
```

- El decoder expondrá por schema un mapa `field -> kind`, compartido por los
  eventos igual que `units`.
- Traces antiguos simplemente no tendrán esta metadata.

## Flujo del viewer nuevo

- Añadir un botón “Graph field” a fields cuyo valor actual sea numérico o cuyo
  schema declare un `kind` reconocido. La materialización final valida que
  exista una serie compatible.
- Considerar numéricos: `number`, `bigint` y strings decimales canónicos
  producidos por `u64`.
- Con un `kind` reconocido, crear el panel directamente.
- Sin metadata —o con metadata desconocida— abrir un modal centrado con:
  - Gauge, seleccionado por defecto.
  - Counter.
  - Up/down counter.
  - Cancel / Create, cierre con Escape y restauración de foco.
- Mantener en el store únicamente specs serializables: event name, field y
  kind. La unit y los datos materializados se resuelven desde el trace y no se
  duplican en el estado.
- Si ya existe un panel para la misma combinación, conservar el existente y
  mostrar un toast.
- Al cargar otro archivo o URL, cerrar los paneles dinámicos. Al cambiar
  Set/Clear Range sobre el mismo trace, conservarlos y reconstruir sus datos
  para el nuevo rango.

## Datos y rendering

- No ordenar ni mutar `customEvents`.
- Al crear o rematerializar un panel:
  1. Recorrer `customEvents` una vez.
  2. Extraer solamente el event name y field pedidos.
  3. Ordenar ese subconjunto por timestamp.
  4. Construir la serie una sola vez.

  Coste: `O(N + K log K)` y memoria `O(K)`.

- Semánticas:
  - Gauge: puntos con el valor original.
  - Counter: intervalos `[previous.timestamp, current.timestamp]` cuyo valor es
    `current - previous`. Una disminución introduce un gap y establece una
    nueva baseline.
  - Up/down counter: los mismos intervalos, conservando deltas negativos.
  - No dividir por tiempo ni añadir `/s`; el delta conserva la unit del field.
  - Valores inválidos/null rompen la continuidad. Timestamps iguales no
    producen un intervalo visible.
  - Calcular deltas enteros como `BigInt` antes de convertirlos a coordenadas
    JS.

- Implementar dos primitivas visuales pequeñas:
  - Point chart para gauge.
  - Step/area interval chart compartido por ambos counters.

- Añadir los panels debajo de los tracks fijos, usando el mismo gutter y mapeo
  temporal. No participan inicialmente en reorder, collapse, localStorage ni
  otros mecanismos de personalización; el bonus de URL sólo serializa sus
  specs.
- Cada panel muestra:
  - Título `EventName · field`.
  - Readout `avg · max` del viewport actual; promedio simple para puntos y
    ponderado por overlap para intervalos.
  - Tooltip con únicamente el field y su valor formateado con `unit`.
  - Botón de cierre.
- Hit testing usa los datums visibles ya ordenados.
- Al cerrar, eliminar el spec, el cache materializado, hits y tooltip activo;
  sin referencias vivas, arrays y DOM quedan disponibles para GC.
- Si no existen valores suficientes para la interpretación elegida, no crear
  un panel y mostrar un toast breve.

## Bonus: vistas compartibles por URL

- Sincronizar la lista ordenada de specs en un parámetro versionado
  `field-charts`. Su valor estructurado codifica event name, field y kind; no
  incluye datos, estadísticas ni unit.
- `field-charts` representa qué gráficos dinámicos están abiertos. No reemplaza
  `collapsed`, que continúa controlando la visibilidad de los tracks existentes.
- Al abrir un link, restaurar primero las specs y materializar sus series
  después de cargar el trace indicado por la URL.
- Crear o cerrar un panel actualiza la URL mediante el mecanismo de
  sincronización existente.
- Validar y deduplicar los parámetros recibidos. Ignorar entradas inválidas y
  mostrar un toast si una spec válida no encuentra datos compatibles.
- La carga inicial conserva las specs restauradas desde la URL. Reemplazar
  posteriormente el source limpia los paneles anteriores; Set/Clear Range los
  conserva.
- Los links de archivos locales continúan sin ser compartibles porque el
  destinatario no puede recuperar ese trace.

## Validación

- Rust: atributos válidos, combinación con `unit`, kind inválido y metadata
  sobre timestamp.
- Decoder/parser: propagación de `kind` y compatibilidad con traces sin
  metadata.
- Modelo: inputs desordenados, los tres kinds, reset de counter, deltas
  negativos, nulls, timestamps repetidos y `bigint`/`u64` string.
- UI: creación directa, modal fallback, readout visible, tooltip, deduplicación
  y cierre sin caches retenidos.
- URL: round trip de múltiples paneles y caracteres especiales, orden estable,
  deduplicación, cierre y restauración diferida hasta que cargue el trace.
- Ejecutar tests Rust enfocados, `npm run check:types`, `npm test` y
  `cargo build -p dial9-viewer`.
- No modificar ningún archivo del legacy viewer.

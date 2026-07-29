# Gráficos dinámicos para fields

## Alcance

- Implementar la feature únicamente en el viewer nuevo.
- Añadir metadata semántica a fields y permitir graficar cualquier field
  numérico desde el inspector.
- Materializar sólo los datos del gráfico solicitado.
- No introducir WASM, un engine genérico ni cambios de UI en el viewer legacy.

## Metadata Rust

Añadir `kind` como atributo estable de field:

```rust
#[traceevent(kind = "gauge")]
temperature: f64,

#[traceevent(kind = "counter")]
requests_total: u64,

#[traceevent(kind = "up_down_counter")]
in_flight: i64,
```

- Aceptar solamente `gauge`, `counter` y `up_down_counter`.
- Rechazar valores desconocidos y `kind` sobre el timestamp durante
  compilación.
- Codificarlo como annotation de field con key `"kind"` sin cambiar el layout
  del trace.
- Permitir combinarlo con `unit`:

```rust
#[traceevent(unit = "bytes", kind = "gauge")]
resident_bytes: u64,
```

- Mantener compatibilidad con traces sin esta metadata.

## Creación

- Mostrar “Graph field” cuando el valor seleccionado sea `number`, `bigint` o
  un string decimal canónico, o cuando el field tenga un `kind` reconocido.
- Si existe `kind`, crear el gráfico directamente.
- Si falta o es desconocido, mostrar un modal centrado con Gauge, Counter y
  Up/down counter; Gauge queda seleccionado por defecto.
- El modal tiene Cancel/Create, cierra con Escape y restaura el foco.
- Identificar un gráfico por `event name + field + kind`. Si ya existe, mantener
  el actual y mostrar un toast.
- Si no hay valores suficientes o compatibles, no crear el gráfico y mostrar
  un toast.

## Materialización

- Guardar en el store solamente `event name`, `field` y `kind`.
- No ordenar ni mutar `customEvents`.
- Para materializar:
  1. Filtrar el event name y field solicitados.
  2. Ordenar ese subconjunto por timestamp.
  3. Construir la serie una sola vez.

  Coste: `O(N + K log K)` y memoria `O(K)`.

- Gauge produce puntos con el valor original.
- Counter produce intervalos `[previous.timestamp, current.timestamp]` con
  valor `current - previous`. Una disminución introduce un gap y establece una
  nueva baseline.
- Up/down counter produce los mismos intervalos y conserva deltas negativos.
- No dividir por tiempo ni añadir `/s`; el delta conserva la unit del field.
- Valores inválidos o null rompen la continuidad. Timestamps iguales no
  producen un intervalo visible.
- Calcular deltas enteros como `BigInt` antes de convertirlos a coordenadas JS.

## Presentación

- Implementar un point chart para gauges y un step/area interval chart
  compartido por ambos counters.
- Colocar los gráficos debajo de los tracks fijos con el mismo gutter y mapeo
  temporal.
- No integrarlos inicialmente con reorder, collapse ni localStorage.
- Cada gráfico incluye:
  - Título `EventName · field`.
  - Readout `avg · max` del viewport: promedio simple para puntos y ponderado
    por overlap para intervalos.
  - Tooltip con el field y valor formateado con su `unit`.
  - Botón de cierre.
- Hacer hit testing sobre los datums visibles ya ordenados.
- Al cerrar, eliminar spec, datos materializados, hits y tooltip activo para no
  retener memoria.

## Lifecycle

- Reemplazar el source dentro de la sesión elimina los gráficos existentes.
- Set/Clear Range sobre el mismo source conserva las specs y rematerializa sus
  datos.

## Bonus: URL compartible

Representar cada gráfico con un parámetro repetible `field-chart` cuyo valor sea
`event,field,kind`:

```text
?trace=demo.d9&field-chart=ProcessResourceUsageEvent,user_cpu_ns,counter&field-chart=ProcessResourceUsageEvent,resident_bytes,gauge
```

- El orden de los parámetros determina el orden de los gráficos.
- Serializar solamente las specs, no datos, estadísticas ni units.
- Restaurar las specs después de cargar el trace de la URL.
- Crear o cerrar un gráfico actualiza la URL mediante la sincronización
  existente.
- Aceptar entradas con tres partes y un `kind` reconocido; ignorar las
  inválidas y deduplicar las restantes.
- `field-chart` no reemplaza `collapsed`, que controla los tracks existentes.

## Validación

- Rust: kinds válidos, combinación con `unit`, kind inválido y kind sobre
  timestamp.
- Trace/viewer: el `kind` llega al field correspondiente y los traces sin
  metadata mantienen su comportamiento.
- Modelo: input desordenado, los tres kinds, reset de counter, deltas negativos,
  nulls, timestamps repetidos y enteros BigInt-safe.
- UI: creación directa, modal fallback, readout, tooltip, deduplicación, cierre
  y liberación de datos.
- URL: múltiples `field-chart`, orden, deduplicación, cierre y restauración
  después de cargar el trace.
- Ejecutar tests Rust enfocados, `npm run check:types`, `npm test` y
  `cargo build -p dial9-viewer`.

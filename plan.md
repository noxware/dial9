# Extensiones WASM y vistas componibles

## Objetivo

Permitir que librerías y aplicaciones Rust incluyan cómputos y vistas completas
en un trace sin cambiar el viewer por cada vista nueva.
El modelo sigue la separación de Perfetto entre datasets tipados y renderers
reutilizables. [Perfetto UI plugins](https://perfetto.dev/docs/contributing/ui-plugins)

```text
D9TF descomprimido ─┬─→ parser normal del viewer
                    └─→ Worker por WASM → record batches columnares
                                           ↓
                               store scopeado por instancia
                                           ↓
                           paneles de componentes stackeables
```

- Core WebAssembly sin imports, WASI, DOM, red ni objetos JavaScript.
- Cómputo streaming sobre D9TF, sin materializar eventos como objetos JS.
- Componentes TypeScript reutilizables; terceros no reciben acceso a Canvas.
- Legacy viewer primero, sin perder funcionalidad de `upstream/main`.
- CPU exacto y dragón son las validaciones visibles; los paneles originales
  permanecen para compararlos.

## Contratos públicos

### Embedded files en D9TF

- Agregar un frame genérico `EmbeddedFile` (`0x07`): `name_len:u16`,
  `data_len:u32`, nombre UTF-8 y bytes.
- Los frames forman un preámbulo contiguo inmediatamente después del header.
- `SegmentWriter` difiere `ClockSyncEvent` hasta escribir el preámbulo y lo
  repite en cada segmento físico para que cualquiera pueda abrirse solo.
- API Rust:
  - `EmbeddedFile::borrowed(name, &'static [u8])`
  - `EmbeddedFile::owned(name, Vec<u8>)`
  - `RecorderBuilder::embedded_file(file)`
- El nombre es una etiqueta opaca, no una identidad global.
- El viewer autoejecuta los archivos `.wasm` del primer segmento de la carga
  lógica. Attachments de segmentos agregados posteriormente se ignoran en v1.

### SDK y ABI WASM

Nuevo crate `dial9-viewer-extension`, para `wasm32-unknown-unknown`:

```rust
pub trait Extension: Default {
    fn on_start(&mut self, output: &mut OutputSink) -> Result<()> {
        Ok(())
    }

    fn on_event(
        &mut self,
        event: Event<'_>,
        output: &mut OutputSink,
    ) -> Result<()> {
        Ok(())
    }

    fn finish(self, output: &mut OutputSink) -> Result<()> {
        Ok(())
    }
}
```

- `Event` y `Value` son vistas sin asignaciones sobre el decoder streaming D9TF.
  Exponen nombre, timestamp, fields, units, listas, mapas, strings, bytes y
  stacks.
- `OutputSink::emit(table: TableId, columns: Vec<Column>)` puede emitir durante
  el parse o al finalizar.
- `TableId` es el índice `u32` de la tabla en el manifest. Las columnas viajan
  en el orden declarado; no se transmiten nombres.
- Cada `Column` contiene los `Vec<T>` construidos por el usuario y su validity
  bitmap opcional; UTF-8 usa offsets + bytes. `emit` conserva esos buffers hasta
  el ack del host, sin copiarlos dentro del guest.
- El SDK deriva la cantidad de rows y valida que todas las columnas estén
  alineadas con el schema.
- Sólo habrá macros declarativas pequeñas para el manifest y los exports ABI;
  no proc macros, domain types generados ni serializers automáticos.
- ABI numérico versionado: reserva/push/resume de input, finish, next/ack de
  output, descriptors de columnas y error buffer.
- Un `push` puede pausarse cuando haya output listo para que el host lo drene y
  luego continuar.
- El módulo exporta memoria y las funciones ABI, y no importa capacidades del
  host.

### Manifest

El manifest es JSON estático en la custom section
`dial9.viewer.manifest`. Es la fuente de verdad para tablas, schemas, paneles y
componentes.

```rust
dial9_viewer_extension::manifest!(r#"
{
  "version": 1,
  "tables": [],
  "panels": []
}
"#);
```

`manifest!` compacta en compile time quitando únicamente whitespace JSON fuera
de strings, preserva strings y escapes exactamente, y coloca los bytes en la
custom section. El SDK no requiere `serde_json` para esto. El host extrae,
parsea y valida exactamente un manifest antes de instanciar el módulo.

Ejemplo orientativo:

```json
{
  "version": 1,
  "tables": [
    {
      "name": "cpu_intervals",
      "columns": [
        { "name": "start_ns", "type": "u64" },
        { "name": "end_ns", "type": "u64" },
        { "name": "cores", "type": "f64", "nullable": true },
        { "name": "percent", "type": "f64", "nullable": true }
      ]
    }
  ],
  "panels": [
    {
      "title": "CPU Usage",
      "components": [
        {
          "name": "interval-area/v1",
          "table": "cpu_intervals",
          "start": "start_ns",
          "end": "end_ns",
          "y": "cores"
        },
        {
          "name": "interval-line/v1",
          "table": "cpu_intervals",
          "start": "start_ns",
          "end": "end_ns",
          "y": "cores"
        },
        {
          "name": "tooltip/v1",
          "table": "cpu_intervals",
          "items": [
            { "label": "Start", "column": "start_ns", "unit": "ns" },
            { "label": "Cores", "column": "cores" }
          ]
        },
        {
          "name": "readout/v1",
          "table": "cpu_intervals",
          "items": [
            {
              "label": "avg",
              "column": "percent",
              "reduce": {
                "name": "time_weighted_mean",
                "start": "start_ns",
                "end": "end_ns"
              },
              "unit": "%"
            },
            {
              "label": "max",
              "column": "percent",
              "reduce": "max",
              "unit": "%"
            }
          ]
        }
      ]
    }
  ]
}
```

- `nullable` es `false` por defecto y se codifica con un validity bitmap
  separado.
- Un valor null en un canal geométrico requerido corta una línea o descarta el
  intervalo correspondiente, introduciendo un gap.
- Unidades conocidas como `ns` y `%` usan formatters del viewer. Una unidad
  desconocida se muestra como sufijo; sin unidad se muestra el valor sin
  formateo adicional.
- Tablas y paneles se scopean automáticamente por instancia. Componentes y
  paneles se identifican internamente por su posición; no requieren IDs
  públicos.

### Output columnar

- Stream binario liviano propio, no Arrow ni un output monolítico.
- El manifest define el schema; cada batch lleva el índice de tabla y debe
  coincidir exactamente en columnas, tipos, longitudes y nullability.
- Tipos iniciales: `f64`, `i64`, `u64`, `u32`, `u8` y UTF-8. UTF-8 se representa
  como offsets + bytes.
- El worker copia una columna desde linear memory y transfiere su
  `ArrayBuffer`; el guest libera sus `Vec` después del ack.
- El viewer conserva columnas chunked y decodifica UTF-8 bajo demanda.
- Los paneles se publican sólo cuando la extensión finaliza correctamente; un
  fallo descarta sus outputs parciales.

## Componentes

Componentes iniciales:

- Dibujo: `background/v1`, `interval-area/v1`, `interval-line/v1`, `line/v1`,
  `step-line/v1`, `polyline/v1` y `horizontal-line/v1`.
- Presentación: `tooltip/v1`, `swatch/v1` y `readout/v1`; pueden renderizar DOM,
  pero consumen las mismas tablas y hits.

Contrato común:

- El orden del array es el orden de dibujo. El hit test recorre las capas
  gráficas en orden inverso y gana el primer hit válido; cada renderer define
  contención o distancia dentro de su geometría.
- Un hit conserva tabla, row y mappings de canales del componente. Tooltip y
  readout hacen match por tabla y, opcionalmente, por mapping de canal; esto
  permite presentaciones independientes sin IDs de componentes.
- `background/v1` acepta un color literal o un scalar producido en una tabla.
- `polyline/v1` preserva el orden de rows, incluidos valores X repetidos o hacia
  atrás.
- Tooltip muestra items de la row alcanzada y omite valores null.
- Cada `swatch/v1` agrega junto al título un label y su muestra de línea, área o
  referencia. Puede incluir un scalar formateado; varios swatches se componen
  sin separadores.
- `readout/v1` vive a la derecha y une sus items con `·`. Admite sampling del
  hit/cursor y reducers sobre el viewport: `min`, `max`, `sum`, `count`, `mean`
  y `time_weighted_mean`.
- Paneles admiten ejes X temporales o lineales, múltiples escalas Y y dominios
  visibles o fijos que incluyan cero, constantes o scalars de otras tablas.
- Colores pueden ser literales o ramps basados en una columna y una escala.
  Guides y thresholds usan `horizontal-line/v1`; sus labels viven en
  `swatch/v1`, no encima de la línea dentro del canvas.
- Títulos, labels y valores se insertan como texto, nunca como HTML.
- Un nombre/version desconocido deshabilita sólo su panel, pero mantiene su
  shell visible con un error que identifica el componente faltante.

## Implementación

- Reutilizar selectivamente de `574-computed-fields-and-views-p8` el decoder
  incremental y las vistas `Event`/`Value`; reemplazar su worker compartido y
  output monolítico.
- Un Worker dedicado por módulo:
  - compila el módulo y extrae el manifest;
  - exige `WebAssembly.Module.imports(module).length === 0`;
  - instancia con `{}` y sin glue de `wasm-bindgen`;
  - valida pointers, lengths, UTF-8, descriptors, batches y referencias del
    manifest antes de entregarlos al main thread;
  - un trap o output inválido elimina sólo esa instancia.
- v1 garantiza aislamiento de capacidades, no cuotas de recursos. Límites de
  memoria, tiempo, cantidad de módulos y output se decidirán con mediciones
  reales.
- Fanout de los chunks D9TF descomprimidos al parser normal y a cada Worker. Un
  módulo decodifica una vez y puede producir múltiples tablas y paneles.
- Convertir `viewer.html` en entrada Vite manteniendo sus scripts legacy y
  añadir un adaptador TypeScript fino para lifecycle, fanout, paneles,
  viewport, tooltip y la llamada desde `renderAll()`.
- Un `.wasm` arrastrado crea una instancia nueva:
  - sin trace queda pendiente para la próxima carga;
  - con trace procesa el buffer descomprimido retenido;
  - se elimina al reemplazar esa carga lógica.
- Renderers indexan columnas por X, dibujan sólo la ventana visible y aplican
  coalescing/min-max por píxel cuando no altere la geometría requerida.

## Validación

### CPU — MUST

- Replicar exactamente la selección y el ordenamiento de samples del panel
  actual.
- Preservar gaps ante timestamps inválidos, deltas no positivos o counters
  decrecientes.
- Igualar intervals, deltas, cores, percentages, área, borde superior, escala,
  color ramp y capacity guide.
- Igualar el readout visible `avg/percent/max` y el tooltip `Window`,
  `CPU time`, `Cores`, `Total CPU`.
- Comparación visual lado a lado con el panel original.

### Dragón — SHOULD

- Usar como fixture las coordenadas de
  `574-computed-fields-and-views-p5`.
- Dibujar fondo, cuerpo verde y fuego mediante componentes gráficos separados.
- Preservar coordenadas repetidas y recorridos hacia atrás.
- Mostrar 💩 al alcanzar la cola y ❤️ al alcanzar la cabeza únicamente dentro
  del tooltip; ningún emoji forma parte del dibujo.

### Presentación y pruebas

- Tomar de `574-generalize-series-and-fields` la calidad visual de legends,
  tooltips, guides y thresholds: swatches junto al título y labels fuera del
  canvas para evitar superposiciones.
- Fixture de manifest para el layout y los reducers de queue depth, sin
  reemplazar su panel.
- Test de line y step-line superpuestos, orden Z y tooltips independientes.
- Tests del macro con espacios dentro de strings, escapes y Unicode, y
  extracción de la custom section del `.wasm` compilado.
- Tests de attachments partidos en cualquier byte boundary y repetidos por
  rotación; batches múltiples, gaps, nullability y UTF-8 lazy.
- Tests de imports, traps, pointers fuera de memoria, manifests/batches
  inválidos, múltiples módulos y drops antes/después del trace.
- Benchmark reproducible con los 250k eventos de `p8` y un trace generado
  grande: decode, cómputo, transferencia y memoria guest/host.
- CI compila la extensión de ejemplo para `wasm32-unknown-unknown` y ejecuta
  Rust, Vitest, build Vite y Playwright.
- Las suites actuales y una revisión visual verifican que el legacy viewer
  conserva toda la funcionalidad de `upstream/main`.

## Diferido

- Adaptador para el viewer nuevo.
- Callbacks WASM reactivos.
- Cuotas y policy estática de recursos WASM.
- Builders tipados, domain types y proc macros ergonómicas para batches.
- Activación manual o políticas alternativas para attachments de traces
  agregados después del primero.
- Hosts CLI/server-side.
- Reemplazo de queue depth y componentes especializados como heatmap, slices,
  spans y flamegraph.

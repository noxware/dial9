use serde::Serialize;
use std::collections::HashSet;
use std::fmt;
use std::mem::size_of;

const MAGIC: &[u8; 4] = b"D9VO";
const VERSION: u16 = 1;
/// Largest encoded view bundle accepted by the viewer-extension ABI.
pub const MAX_ENCODED_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const INITIAL_OUTPUT_CAPACITY_BYTES: usize = MAX_ENCODED_OUTPUT_BYTES / 4;

/// A complete custom-view result: named columnar tables plus panel recipes.
#[derive(Debug, Default)]
pub struct ViewBundle {
    panels: Vec<Panel>,
    tables: Vec<Table>,
}

impl ViewBundle {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn panel(mut self, panel: Panel) -> Self {
        self.panels.push(panel);
        self
    }

    pub fn table(mut self, table: Table) -> Self {
        self.tables.push(table);
        self
    }

    pub fn panels(&self) -> &[Panel] {
        &self.panels
    }

    pub fn tables(&self) -> &[Table] {
        &self.tables
    }

    /// Validate and encode the bundle, releasing source columns as they are copied.
    pub fn encode(self) -> Result<Vec<u8>, OutputError> {
        validate_bundle(&self)?;
        let manifest = serde_json::to_vec(&Manifest {
            version: VERSION,
            panels: &self.panels,
        })
        .map_err(|error| OutputError(error.to_string()))?;

        let encoded_len = validate_encoded_output_len(encoded_len(&manifest, &self.tables)?)?;
        let ViewBundle { panels, tables } = self;
        drop(panels);

        // Grow the output while consuming columns. Preallocating the complete
        // result here would keep every source column live beside that allocation.
        let mut out = Vec::with_capacity(
            encoded_len
                .min(INITIAL_OUTPUT_CAPACITY_BYTES)
                .max(16 + manifest.len()),
        );
        out.extend_from_slice(MAGIC);
        put_u16(&mut out, VERSION);
        put_u16(&mut out, 0);
        put_u32(&mut out, len_u32(manifest.len(), "manifest")?);
        put_u32(&mut out, len_u32(tables.len(), "table count")?);
        out.extend_from_slice(&manifest);

        for table in tables {
            put_string_u16(&mut out, &table.name, "table name")?;
            put_u32(&mut out, len_u32(table.rows, "row count")?);
            put_u16(
                &mut out,
                table
                    .columns
                    .len()
                    .try_into()
                    .map_err(|_| OutputError("column count exceeds u16::MAX".into()))?,
            );
            for column in table.columns {
                put_string_u16(&mut out, column.name(), "column name")?;
                out.push(column.kind() as u8);
                out.push(0);
                put_u16(&mut out, 0);
                let data_len_pos = out.len();
                put_u32(&mut out, 0);
                align(&mut out, column.alignment());
                let data_start = out.len();
                if data_start + column.encoded_data_len()? > out.capacity() {
                    out.reserve_exact(encoded_len - data_start);
                }
                column.encode_data(&mut out)?;
                let data_len = len_u32(out.len() - data_start, "column data")?;
                out[data_len_pos..data_len_pos + 4].copy_from_slice(&data_len.to_le_bytes());
            }
        }
        Ok(out)
    }
}

#[derive(Debug, Serialize)]
struct Manifest<'a> {
    version: u16,
    panels: &'a [Panel],
}

/// A named rectangular set of columns. Every column has exactly `rows` values.
#[derive(Debug)]
pub struct Table {
    name: String,
    rows: usize,
    columns: Vec<Column>,
}

impl Table {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            rows: 0,
            columns: Vec::new(),
        }
    }

    pub fn f64(mut self, name: impl Into<String>, values: Vec<f64>) -> Self {
        self.push_column(Column::F64 {
            name: name.into(),
            values,
        });
        self
    }

    pub fn u64(mut self, name: impl Into<String>, values: Vec<u64>) -> Self {
        self.push_column(Column::U64 {
            name: name.into(),
            values,
        });
        self
    }

    pub fn i64(mut self, name: impl Into<String>, values: Vec<i64>) -> Self {
        self.push_column(Column::I64 {
            name: name.into(),
            values,
        });
        self
    }

    pub fn u32(mut self, name: impl Into<String>, values: Vec<u32>) -> Self {
        self.push_column(Column::U32 {
            name: name.into(),
            values,
        });
        self
    }

    pub fn u8(mut self, name: impl Into<String>, values: Vec<u8>) -> Self {
        self.push_column(Column::U8 {
            name: name.into(),
            values,
        });
        self
    }

    pub fn string<S: Into<String>>(
        mut self,
        name: impl Into<String>,
        values: impl IntoIterator<Item = S>,
    ) -> Self {
        self.push_column(Column::Utf8 {
            name: name.into(),
            values: values.into_iter().map(Into::into).collect(),
        });
        self
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    fn push_column(&mut self, column: Column) {
        if self.columns.is_empty() {
            self.rows = column.len();
        }
        self.columns.push(column);
    }
}

#[derive(Debug)]
enum Column {
    F64 { name: String, values: Vec<f64> },
    U64 { name: String, values: Vec<u64> },
    I64 { name: String, values: Vec<i64> },
    U32 { name: String, values: Vec<u32> },
    U8 { name: String, values: Vec<u8> },
    Utf8 { name: String, values: Vec<String> },
}

#[repr(u8)]
enum ColumnKind {
    F64 = 1,
    U64 = 2,
    I64 = 3,
    U32 = 4,
    U8 = 5,
    Utf8 = 6,
}

impl Column {
    fn name(&self) -> &str {
        match self {
            Self::F64 { name, .. }
            | Self::U64 { name, .. }
            | Self::I64 { name, .. }
            | Self::U32 { name, .. }
            | Self::U8 { name, .. }
            | Self::Utf8 { name, .. } => name,
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::F64 { values, .. } => values.len(),
            Self::U64 { values, .. } => values.len(),
            Self::I64 { values, .. } => values.len(),
            Self::U32 { values, .. } => values.len(),
            Self::U8 { values, .. } => values.len(),
            Self::Utf8 { values, .. } => values.len(),
        }
    }

    fn kind(&self) -> ColumnKind {
        match self {
            Self::F64 { .. } => ColumnKind::F64,
            Self::U64 { .. } => ColumnKind::U64,
            Self::I64 { .. } => ColumnKind::I64,
            Self::U32 { .. } => ColumnKind::U32,
            Self::U8 { .. } => ColumnKind::U8,
            Self::Utf8 { .. } => ColumnKind::Utf8,
        }
    }

    fn alignment(&self) -> usize {
        match self {
            Self::F64 { .. } | Self::U64 { .. } | Self::I64 { .. } => 8,
            Self::U32 { .. } | Self::Utf8 { .. } => 4,
            Self::U8 { .. } => 1,
        }
    }

    fn encode_data(self, out: &mut Vec<u8>) -> Result<(), OutputError> {
        match self {
            Self::F64 { values, .. } => {
                for value in values {
                    out.extend_from_slice(&value.to_le_bytes());
                }
            }
            Self::U64 { values, .. } => {
                for value in values {
                    out.extend_from_slice(&value.to_le_bytes());
                }
            }
            Self::I64 { values, .. } => {
                for value in values {
                    out.extend_from_slice(&value.to_le_bytes());
                }
            }
            Self::U32 { values, .. } => {
                for value in values {
                    out.extend_from_slice(&value.to_le_bytes());
                }
            }
            Self::U8 { values, .. } => out.extend_from_slice(&values),
            Self::Utf8 { values, .. } => {
                let offsets_start = out.len();
                let offsets_len = values
                    .len()
                    .checked_add(1)
                    .and_then(|count| count.checked_mul(size_of::<u32>()))
                    .ok_or_else(|| OutputError("UTF-8 offsets exceed usize".into()))?;
                out.resize(
                    out.len()
                        .checked_add(offsets_len)
                        .ok_or_else(|| OutputError("UTF-8 offsets exceed usize".into()))?,
                    0,
                );
                let mut bytes_len = 0usize;
                for (index, value) in values.into_iter().enumerate() {
                    out.extend_from_slice(value.as_bytes());
                    bytes_len = bytes_len
                        .checked_add(value.len())
                        .ok_or_else(|| OutputError("UTF-8 column exceeds usize".into()))?;
                    let offset = len_u32(bytes_len, "UTF-8 column")?.to_le_bytes();
                    let start = offsets_start + (index + 1) * size_of::<u32>();
                    out[start..start + size_of::<u32>()].copy_from_slice(&offset);
                }
            }
        }
        Ok(())
    }
}

/// A custom time-aligned panel composed from ordered components.
#[derive(Debug, Serialize)]
pub struct Panel {
    pub id: String,
    pub title: String,
    pub height: u16,
    #[serde(default)]
    pub x: XAxis,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scales: Vec<Scale>,
    pub components: Vec<Component>,
}

impl Panel {
    pub fn new(id: impl Into<String>, title: impl Into<String>, height: u16) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            height,
            x: XAxis::Time,
            scales: vec![Scale::new("y")],
            components: Vec::new(),
        }
    }

    pub fn x_axis(mut self, x: XAxis) -> Self {
        self.x = x;
        self
    }

    pub fn scale(mut self, scale: Scale) -> Self {
        self.scales.push(scale);
        self
    }

    pub fn component(mut self, component: Component) -> Self {
        self.components.push(component);
        self
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum XAxis {
    #[default]
    Time,
    Linear {
        min: f64,
        max: f64,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scale {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default)]
    pub include_zero: bool,
}

impl Scale {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            min: None,
            max: None,
            include_zero: true,
        }
    }

    pub fn domain(mut self, min: f64, max: f64) -> Self {
        self.min = Some(min);
        self.max = Some(max);
        self
    }

    pub fn include_zero(mut self, include: bool) -> Self {
        self.include_zero = include;
        self
    }
}

/// Public renderer recipes. Their order inside a panel is their z-order.
#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Component {
    Background {
        id: String,
        input: String,
        color_column: String,
    },
    IntervalArea {
        id: String,
        input: String,
        scale: String,
        start_column: String,
        end_column: String,
        value_column: String,
        color: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        baseline: Option<f64>,
    },
    IntervalLine {
        id: String,
        input: String,
        scale: String,
        start_column: String,
        end_column: String,
        value_column: String,
        color: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line_width: Option<f64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dash: Vec<f64>,
    },
    Line {
        id: String,
        input: String,
        scale: String,
        x_column: String,
        value_column: String,
        color: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line_width: Option<f64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dash: Vec<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gap_column: Option<String>,
        #[serde(default)]
        sampling: Sampling,
    },
    StepLine {
        id: String,
        input: String,
        scale: String,
        x_column: String,
        value_column: String,
        color: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line_width: Option<f64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dash: Vec<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gap_column: Option<String>,
        #[serde(default)]
        sampling: Sampling,
    },
    /// An exact path through every input row, split only by `gap_column`.
    Polyline {
        id: String,
        input: String,
        scale: String,
        x_column: String,
        value_column: String,
        color: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line_width: Option<f64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dash: Vec<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gap_column: Option<String>,
    },
    HorizontalRule {
        id: String,
        input: String,
        scale: String,
        value_column: String,
        color: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line_width: Option<f64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dash: Vec<f64>,
    },
    Text {
        id: String,
        input: String,
        scale: String,
        x_column: String,
        value_column: String,
        text_column: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color_column: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        font: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        align: Option<String>,
    },
    Tooltip {
        id: String,
        target: String,
        strategy: TooltipStrategy,
        rows: Vec<DisplayField>,
    },
    Legend {
        id: String,
        #[serde(default)]
        position: LegendPosition,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        items: Vec<LegendStaticItem>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        at_cursor: Vec<LegendAtCursor>,
    },
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Sampling {
    #[default]
    Pixel,
    None,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TooltipStrategy {
    Interval,
    NearestPoint {
        #[serde(skip_serializing_if = "Option::is_none")]
        radius: Option<f64>,
    },
}

#[derive(Debug, Serialize)]
pub struct DisplayField {
    pub label: String,
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

impl DisplayField {
    pub fn new(label: impl Into<String>, field: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            field: field.into(),
            unit: None,
        }
    }

    pub fn unit(mut self, unit: impl Into<String>) -> Self {
        self.unit = Some(unit.into());
        self
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LegendPosition {
    TopLeft,
    #[default]
    TopRight,
}

#[derive(Debug, Serialize)]
pub struct LegendStaticItem {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl LegendStaticItem {
    pub fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            value: None,
            color: None,
        }
    }

    pub fn value(mut self, value: impl Into<String>) -> Self {
        self.value = Some(value.into());
        self
    }

    pub fn color(mut self, color: impl Into<String>) -> Self {
        self.color = Some(color.into());
        self
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegendAtCursor {
    pub input: String,
    pub x_column: String,
    pub value_column: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl LegendAtCursor {
    pub fn new(
        input: impl Into<String>,
        x_column: impl Into<String>,
        value_column: impl Into<String>,
        label: impl Into<String>,
    ) -> Self {
        Self {
            input: input.into(),
            x_column: x_column.into(),
            value_column: value_column.into(),
            label: label.into(),
            unit: None,
            color: None,
        }
    }

    pub fn unit(mut self, unit: impl Into<String>) -> Self {
        self.unit = Some(unit.into());
        self
    }

    pub fn color(mut self, color: impl Into<String>) -> Self {
        self.color = Some(color.into());
        self
    }
}

#[derive(Debug, Clone)]
pub struct OutputError(String);

impl fmt::Display for OutputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OutputError {}

fn validate_bundle(bundle: &ViewBundle) -> Result<(), OutputError> {
    let mut table_names = HashSet::new();
    for table in &bundle.tables {
        if table.name.is_empty() {
            return Err(OutputError("table name cannot be empty".into()));
        }
        if !table_names.insert(table.name.as_str()) {
            return Err(OutputError(format!("duplicate table {:?}", table.name)));
        }
        let mut column_names = HashSet::new();
        for column in &table.columns {
            if column.len() != table.rows {
                return Err(OutputError(format!(
                    "table {:?} column {:?} has {} rows, expected {}",
                    table.name,
                    column.name(),
                    column.len(),
                    table.rows
                )));
            }
            if !column_names.insert(column.name()) {
                return Err(OutputError(format!(
                    "table {:?} has duplicate column {:?}",
                    table.name,
                    column.name()
                )));
            }
        }
    }
    let mut panel_ids = HashSet::new();
    for panel in &bundle.panels {
        if !panel_ids.insert(panel.id.as_str()) {
            return Err(OutputError(format!("duplicate panel id {:?}", panel.id)));
        }
    }
    Ok(())
}

fn encoded_len(manifest: &[u8], tables: &[Table]) -> Result<usize, OutputError> {
    let mut len = 16usize
        .checked_add(manifest.len())
        .ok_or_else(|| OutputError("encoded output exceeds usize".into()))?;
    for table in tables {
        len = len
            .checked_add(2 + table.name.len() + 4 + 2)
            .ok_or_else(|| OutputError("encoded output exceeds usize".into()))?;
        for column in &table.columns {
            len = len
                .checked_add(2 + column.name().len() + 1 + 1 + 2 + 4)
                .ok_or_else(|| OutputError("encoded output exceeds usize".into()))?;
            let alignment = column.alignment();
            len = len
                .checked_add((alignment - len % alignment) % alignment)
                .ok_or_else(|| OutputError("encoded output exceeds usize".into()))?;
            len = len
                .checked_add(column.encoded_data_len()?)
                .ok_or_else(|| OutputError("encoded output exceeds usize".into()))?;
        }
    }
    Ok(len)
}

fn validate_encoded_output_len(encoded_len: usize) -> Result<usize, OutputError> {
    if encoded_len > MAX_ENCODED_OUTPUT_BYTES {
        return Err(OutputError(format!(
            "encoded output is {encoded_len} bytes; limit is {MAX_ENCODED_OUTPUT_BYTES}"
        )));
    }
    Ok(encoded_len)
}

impl Column {
    fn encoded_data_len(&self) -> Result<usize, OutputError> {
        let width = match self {
            Self::F64 { .. } | Self::U64 { .. } | Self::I64 { .. } => size_of::<u64>(),
            Self::U32 { .. } => size_of::<u32>(),
            Self::U8 { .. } => size_of::<u8>(),
            Self::Utf8 { values, .. } => {
                let offsets = values
                    .len()
                    .checked_add(1)
                    .and_then(|count| count.checked_mul(size_of::<u32>()))
                    .ok_or_else(|| OutputError("UTF-8 offsets exceed usize".into()))?;
                let bytes = values.iter().try_fold(0usize, |len, value| {
                    len.checked_add(value.len())
                        .ok_or_else(|| OutputError("UTF-8 column exceeds usize".into()))
                })?;
                return offsets
                    .checked_add(bytes)
                    .ok_or_else(|| OutputError("UTF-8 column exceeds usize".into()));
            }
        };
        self.len()
            .checked_mul(width)
            .ok_or_else(|| OutputError("column data exceeds usize".into()))
    }
}

fn align(out: &mut Vec<u8>, alignment: usize) {
    let padding = (alignment - out.len() % alignment) % alignment;
    out.resize(out.len() + padding, 0);
}

fn len_u32(value: usize, what: &str) -> Result<u32, OutputError> {
    value
        .try_into()
        .map_err(|_| OutputError(format!("{what} exceeds u32::MAX")))
}

fn put_string_u16(out: &mut Vec<u8>, value: &str, what: &str) -> Result<(), OutputError> {
    let len: u16 = value
        .len()
        .try_into()
        .map_err(|_| OutputError(format!("{what} exceeds u16::MAX")))?;
    put_u16(out, len);
    out.extend_from_slice(value.as_bytes());
    Ok(())
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_columnar_and_aligned() {
        let bundle = ViewBundle::new()
            .table(
                Table::new("points")
                    .f64("x", vec![1.0, 2.0])
                    .u64("ns", vec![3, 4])
                    .string("label", ["a", "hello"]),
            )
            .panel(Panel::new("p", "Panel", 80).component(Component::Line {
                id: "line".into(),
                input: "points".into(),
                scale: "y".into(),
                x_column: "x".into(),
                value_column: "x".into(),
                color: "#fff".into(),
                line_width: None,
                dash: vec![],
                gap_column: None,
                sampling: Sampling::Pixel,
            }));
        let encoded = bundle.encode().unwrap();
        assert_eq!(&encoded[..4], b"D9VO");
        assert!(
            encoded
                .windows(8)
                .any(|bytes| bytes == 1.0f64.to_le_bytes())
        );
        let text = String::from_utf8_lossy(&encoded);
        assert!(text.contains("\"kind\":\"line\""));
        assert!(text.contains("\"sampling\":\"pixel\""));
        assert!(text.contains("hello"));
    }

    #[test]
    fn mismatched_columns_are_rejected() {
        let error = ViewBundle::new()
            .table(Table::new("bad").u8("a", vec![1, 2]).u8("b", vec![1]))
            .encode()
            .unwrap_err();
        assert!(error.to_string().contains("expected 2"));
    }

    #[test]
    fn polyline_serializes_as_an_exact_unsampled_path() {
        let component = Component::Polyline {
            id: "outline".into(),
            input: "points".into(),
            scale: "y".into(),
            x_column: "x".into(),
            value_column: "value".into(),
            color: "#00ff00".into(),
            line_width: Some(2.0),
            dash: vec![4.0, 2.0],
            gap_column: Some("gap".into()),
        };

        assert_eq!(
            serde_json::to_value(component).unwrap(),
            serde_json::json!({
                "kind": "polyline",
                "id": "outline",
                "input": "points",
                "scale": "y",
                "xColumn": "x",
                "valueColumn": "value",
                "color": "#00ff00",
                "lineWidth": 2.0,
                "dash": [4.0, 2.0],
                "gapColumn": "gap",
            })
        );
    }

    #[test]
    fn oversized_output_is_rejected_before_encoding() {
        let error = validate_encoded_output_len(MAX_ENCODED_OUTPUT_BYTES + 1).unwrap_err();
        assert!(error.to_string().contains("limit"));
    }
}

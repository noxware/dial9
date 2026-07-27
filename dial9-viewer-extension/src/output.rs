use std::collections::VecDeque;
use std::fmt;
#[cfg(target_arch = "wasm32")]
use std::mem::size_of;

/// Positional table identifier from the manifest's `tables` array.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TableId(u32);

impl TableId {
    pub const fn new(index: u32) -> Self {
        Self(index)
    }

    pub const fn index(self) -> u32 {
        self.0
    }
}

/// One owned output column.
///
/// The optional validity bitmap is LSB-first: bit `i` is one when row `i` is
/// present. Without a bitmap every row is present. UTF-8 stores `rows + 1`
/// offsets into one byte buffer.
#[derive(Debug)]
pub enum Column {
    F64 {
        values: Vec<f64>,
        validity: Option<Vec<u8>>,
    },
    I64 {
        values: Vec<i64>,
        validity: Option<Vec<u8>>,
    },
    U64 {
        values: Vec<u64>,
        validity: Option<Vec<u8>>,
    },
    U32 {
        values: Vec<u32>,
        validity: Option<Vec<u8>>,
    },
    U8 {
        values: Vec<u8>,
        validity: Option<Vec<u8>>,
    },
    Utf8 {
        offsets: Vec<u32>,
        data: Vec<u8>,
        validity: Option<Vec<u8>>,
    },
}

impl Column {
    fn row_count(&self) -> Result<usize, OutputError> {
        match self {
            Self::F64 { values, .. } => Ok(values.len()),
            Self::I64 { values, .. } => Ok(values.len()),
            Self::U64 { values, .. } => Ok(values.len()),
            Self::U32 { values, .. } => Ok(values.len()),
            Self::U8 { values, .. } => Ok(values.len()),
            Self::Utf8 { offsets, data, .. } => {
                let Some(rows) = offsets.len().checked_sub(1) else {
                    return Err(OutputError::new(
                        "UTF-8 column offsets must contain an initial zero",
                    ));
                };
                if offsets.first() != Some(&0) {
                    return Err(OutputError::new("UTF-8 column offsets must start at zero"));
                }
                let data_len = u32::try_from(data.len())
                    .map_err(|_| OutputError::new("UTF-8 data exceeds u32::MAX bytes"))?;
                if offsets.last() != Some(&data_len) {
                    return Err(OutputError::new(
                        "UTF-8 final offset must equal the data length",
                    ));
                }
                if offsets.windows(2).any(|pair| pair[0] > pair[1]) {
                    return Err(OutputError::new(
                        "UTF-8 column offsets must be nondecreasing",
                    ));
                }
                let text = std::str::from_utf8(data)
                    .map_err(|_| OutputError::new("UTF-8 column contains invalid UTF-8"))?;
                if offsets
                    .iter()
                    .any(|offset| !text.is_char_boundary(*offset as usize))
                {
                    return Err(OutputError::new(
                        "UTF-8 column offset is not a character boundary",
                    ));
                }
                Ok(rows)
            }
        }
    }

    fn validity(&self) -> Option<&[u8]> {
        match self {
            Self::F64 { validity, .. }
            | Self::I64 { validity, .. }
            | Self::U64 { validity, .. }
            | Self::U32 { validity, .. }
            | Self::U8 { validity, .. }
            | Self::Utf8 { validity, .. } => validity.as_deref(),
        }
    }

    #[cfg(target_arch = "wasm32")]
    fn kind(&self) -> ColumnKind {
        match self {
            Self::F64 { .. } => ColumnKind::F64,
            Self::I64 { .. } => ColumnKind::I64,
            Self::U64 { .. } => ColumnKind::U64,
            Self::U32 { .. } => ColumnKind::U32,
            Self::U8 { .. } => ColumnKind::U8,
            Self::Utf8 { .. } => ColumnKind::Utf8,
        }
    }

    #[cfg(target_arch = "wasm32")]
    fn descriptor(&self, out: &mut Vec<u8>) -> Result<(), OutputError> {
        let (values_ptr, values_len, offsets_ptr, offsets_len) = match self {
            Self::F64 { values, .. } => numeric_descriptor(values)?,
            Self::I64 { values, .. } => numeric_descriptor(values)?,
            Self::U64 { values, .. } => numeric_descriptor(values)?,
            Self::U32 { values, .. } => numeric_descriptor(values)?,
            Self::U8 { values, .. } => numeric_descriptor(values)?,
            Self::Utf8 { offsets, data, .. } => (
                pointer(data)?,
                byte_len::<u8>(data.len())?,
                pointer(offsets)?,
                byte_len::<u32>(offsets.len())?,
            ),
        };
        let validity = self.validity().unwrap_or_default();
        put_u32(out, self.kind() as u32);
        put_u32(out, u32::from(!validity.is_empty()));
        put_u32(out, values_ptr);
        put_u32(out, values_len);
        put_u32(out, offsets_ptr);
        put_u32(out, offsets_len);
        put_u32(out, pointer(validity)?);
        put_u32(out, byte_len::<u8>(validity.len())?);
        Ok(())
    }
}

#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg(target_arch = "wasm32")]
pub(crate) enum ColumnKind {
    F64 = 1,
    I64 = 2,
    U64 = 3,
    U32 = 4,
    U8 = 5,
    Utf8 = 6,
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct Batch {
    pub(crate) table: TableId,
    pub(crate) rows: u32,
    pub(crate) columns: Vec<Column>,
}

impl Batch {
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn descriptor(&self) -> Result<Vec<u8>, OutputError> {
        let mut descriptor = Vec::with_capacity(16 + self.columns.len() * 32);
        put_u32(&mut descriptor, self.table.index());
        put_u32(&mut descriptor, self.rows);
        put_u32(
            &mut descriptor,
            u32::try_from(self.columns.len())
                .map_err(|_| OutputError::new("column count exceeds u32::MAX"))?,
        );
        put_u32(&mut descriptor, 0);
        for column in &self.columns {
            column.descriptor(&mut descriptor)?;
        }
        Ok(descriptor)
    }
}

/// Borrowed output channel passed to extension hooks.
///
/// `emit` takes ownership of every `Vec`. The guest keeps those allocations
/// alive until the host acknowledges the batch; no second guest-side copy is
/// made.
pub struct OutputSink<'a> {
    pub(crate) batches: &'a mut VecDeque<Batch>,
}

impl<'a> OutputSink<'a> {
    #[cfg(any(test, target_arch = "wasm32"))]
    pub(crate) fn new(batches: &'a mut VecDeque<Batch>) -> Self {
        Self { batches }
    }

    /// Queue one rectangular record batch.
    pub fn emit(&mut self, table: TableId, columns: Vec<Column>) -> Result<(), OutputError> {
        let Some(first) = columns.first() else {
            return Err(OutputError::new("a record batch needs at least one column"));
        };
        let rows = first.row_count()?;
        let rows_u32 =
            u32::try_from(rows).map_err(|_| OutputError::new("row count exceeds u32::MAX"))?;
        for (index, column) in columns.iter().enumerate() {
            if column.row_count()? != rows {
                return Err(OutputError::new(format!(
                    "column {index} has a different row count",
                )));
            }
            validate_validity(column.validity(), rows, index)?;
        }
        self.batches.push_back(Batch {
            table,
            rows: rows_u32,
            columns,
        });
        Ok(())
    }
}

fn validate_validity(
    validity: Option<&[u8]>,
    rows: usize,
    column: usize,
) -> Result<(), OutputError> {
    let Some(validity) = validity else {
        return Ok(());
    };
    let expected = rows
        .checked_add(7)
        .ok_or_else(|| OutputError::new("validity length overflow"))?
        / 8;
    if validity.len() != expected {
        return Err(OutputError::new(format!(
            "column {column} validity bitmap has {} bytes; expected {expected}",
            validity.len(),
        )));
    }
    if let Some(&last) = validity.last() {
        let used = rows % 8;
        if used != 0 && last & !((1_u8 << used) - 1) != 0 {
            return Err(OutputError::new(format!(
                "column {column} validity bitmap sets bits beyond its rows",
            )));
        }
    }
    Ok(())
}

/// Error in a guest-produced record batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputError(String);

impl OutputError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for OutputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for OutputError {}

#[cfg(target_arch = "wasm32")]
fn numeric_descriptor<T>(values: &[T]) -> Result<(u32, u32, u32, u32), OutputError> {
    Ok((pointer(values)?, byte_len::<T>(values.len())?, 0, 0))
}

#[cfg(target_arch = "wasm32")]
fn pointer<T>(values: &[T]) -> Result<u32, OutputError> {
    u32::try_from(values.as_ptr() as usize)
        .map_err(|_| OutputError::new("column pointer exceeds wasm32 address space"))
}

#[cfg(target_arch = "wasm32")]
fn byte_len<T>(len: usize) -> Result<u32, OutputError> {
    len.checked_mul(size_of::<T>())
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| OutputError::new("column byte length exceeds u32::MAX"))
}

#[cfg(target_arch = "wasm32")]
fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emit_accepts_aligned_columns_and_validity() {
        let mut batches = VecDeque::new();
        OutputSink::new(&mut batches)
            .emit(
                TableId::new(3),
                vec![
                    Column::U64 {
                        values: vec![10, 20, 30],
                        validity: None,
                    },
                    Column::F64 {
                        values: vec![1.0, 2.0, 3.0],
                        validity: Some(vec![0b0000_0101]),
                    },
                ],
            )
            .unwrap();
        let batch = batches.front().unwrap();
        assert_eq!(batch.table, TableId::new(3));
        assert_eq!(batch.rows, 3);
    }

    #[test]
    fn emit_rejects_misaligned_columns() {
        let mut batches = VecDeque::new();
        let error = OutputSink::new(&mut batches)
            .emit(
                TableId::new(0),
                vec![
                    Column::U64 {
                        values: vec![1],
                        validity: None,
                    },
                    Column::U8 {
                        values: vec![1, 2],
                        validity: None,
                    },
                ],
            )
            .unwrap_err();
        assert!(error.to_string().contains("different row count"));
    }

    #[test]
    fn utf8_offsets_and_validity_are_checked() {
        let mut batches = VecDeque::new();
        OutputSink::new(&mut batches)
            .emit(
                TableId::new(0),
                vec![Column::Utf8 {
                    offsets: vec![0, 4, 6],
                    data: "🔥ok".as_bytes().to_vec(),
                    validity: Some(vec![0b0000_0011]),
                }],
            )
            .unwrap();

        let error = OutputSink::new(&mut batches)
            .emit(
                TableId::new(0),
                vec![Column::Utf8 {
                    offsets: vec![0, 1, 4],
                    data: "🔥".as_bytes().to_vec(),
                    validity: None,
                }],
            )
            .unwrap_err();
        assert!(error.to_string().contains("character boundary"));
    }
}

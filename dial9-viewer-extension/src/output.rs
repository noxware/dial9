use crate::runtime::{ExtensionError, Result};
use std::collections::VecDeque;
use std::mem::size_of;

#[cfg(target_arch = "wasm32")]
pub(crate) const OUTPUT_DESCRIPTOR_VERSION: u32 = 1;
#[cfg(target_arch = "wasm32")]
pub(crate) const OUTPUT_HEADER_WORDS: usize = 4;
#[cfg(target_arch = "wasm32")]
pub(crate) const OUTPUT_COLUMN_WORDS: usize = 8;
#[cfg(target_arch = "wasm32")]
const COLUMN_FLAG_VALIDITY: u32 = 1;

/// Zero-based table position in the extension manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct TableId(u32);

impl TableId {
    pub const fn new(index: u32) -> Self {
        Self(index)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

/// One owned output column.
///
/// A validity bitmap uses one bit per row, least-significant bit first, where
/// `1` means valid and `0` means null.
#[derive(Debug)]
#[non_exhaustive]
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
    /// UTF-8 bytes plus `rows + 1` monotonically increasing byte offsets.
    Utf8 {
        offsets: Vec<u32>,
        bytes: Vec<u8>,
        validity: Option<Vec<u8>>,
    },
}

impl Column {
    fn validate(&self) -> Result<usize> {
        let rows = match self {
            Self::F64 { values, .. } => {
                validate_buffer_len::<f64>(values.len(), "f64 column")?;
                values.len()
            }
            Self::I64 { values, .. } => {
                validate_buffer_len::<i64>(values.len(), "i64 column")?;
                values.len()
            }
            Self::U64 { values, .. } => {
                validate_buffer_len::<u64>(values.len(), "u64 column")?;
                values.len()
            }
            Self::U32 { values, .. } => {
                validate_buffer_len::<u32>(values.len(), "u32 column")?;
                values.len()
            }
            Self::U8 { values, .. } => {
                validate_buffer_len::<u8>(values.len(), "u8 column")?;
                values.len()
            }
            Self::Utf8 { offsets, bytes, .. } => {
                validate_utf8(offsets, bytes)?;
                offsets.len() - 1
            }
        };
        u32::try_from(rows)
            .map_err(|_| ExtensionError::new("column row count exceeds u32::MAX"))?;

        if let Some(validity) = self.validity() {
            let expected = rows.div_ceil(8);
            if validity.len() != expected {
                return Err(ExtensionError::new(format!(
                    "validity bitmap has {} bytes; {rows} rows require {expected}",
                    validity.len()
                )));
            }
            u32::try_from(validity.len())
                .map_err(|_| ExtensionError::new("validity bitmap exceeds u32::MAX bytes"))?;
        }
        Ok(rows)
    }

    fn validity(&self) -> Option<&Vec<u8>> {
        match self {
            Self::F64 { validity, .. }
            | Self::I64 { validity, .. }
            | Self::U64 { validity, .. }
            | Self::U32 { validity, .. }
            | Self::U8 { validity, .. }
            | Self::Utf8 { validity, .. } => validity.as_ref(),
        }
    }

    #[cfg(target_arch = "wasm32")]
    fn descriptor(&self, output: &mut Vec<u32>) {
        let (kind, primary, auxiliary) = match self {
            Self::F64 { values, .. } => (ColumnKind::F64, slice_parts(values), (0, 0)),
            Self::I64 { values, .. } => (ColumnKind::I64, slice_parts(values), (0, 0)),
            Self::U64 { values, .. } => (ColumnKind::U64, slice_parts(values), (0, 0)),
            Self::U32 { values, .. } => (ColumnKind::U32, slice_parts(values), (0, 0)),
            Self::U8 { values, .. } => (ColumnKind::U8, slice_parts(values), (0, 0)),
            Self::Utf8 { offsets, bytes, .. } => {
                (ColumnKind::Utf8, slice_parts(bytes), slice_parts(offsets))
            }
        };
        let validity = self
            .validity()
            .map_or((0, 0), |validity| slice_parts(validity));
        let flags = if self.validity().is_some() {
            COLUMN_FLAG_VALIDITY
        } else {
            0
        };
        output.extend_from_slice(&[
            kind as u32,
            flags,
            primary.0,
            primary.1,
            auxiliary.0,
            auxiliary.1,
            validity.0,
            validity.1,
        ]);
    }
}

#[derive(Debug)]
#[cfg(target_arch = "wasm32")]
#[repr(u32)]
enum ColumnKind {
    F64 = 1,
    I64 = 2,
    U64 = 3,
    U32 = 4,
    U8 = 5,
    Utf8 = 6,
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) struct RecordBatch {
    table: TableId,
    rows: u32,
    columns: Vec<Column>,
}

impl RecordBatch {
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn descriptor(&self) -> Vec<u32> {
        let mut descriptor =
            Vec::with_capacity(OUTPUT_HEADER_WORDS + self.columns.len() * OUTPUT_COLUMN_WORDS);
        descriptor.extend_from_slice(&[
            OUTPUT_DESCRIPTOR_VERSION,
            self.table.get(),
            self.rows,
            self.columns.len() as u32,
        ]);
        for column in &self.columns {
            column.descriptor(&mut descriptor);
        }
        descriptor
    }
}

/// Output queue passed to extension lifecycle methods.
pub struct OutputSink {
    batches: VecDeque<RecordBatch>,
}

impl OutputSink {
    #[cfg(any(test, target_arch = "wasm32"))]
    pub(crate) fn new() -> Self {
        Self {
            batches: VecDeque::new(),
        }
    }

    /// Emit one rectangular batch. Columns remain owned by the runtime until
    /// the host acknowledges the batch.
    pub fn emit(&mut self, table: TableId, columns: Vec<Column>) -> Result<()> {
        let Some(first) = columns.first() else {
            return Err(ExtensionError::new(
                "an output batch must contain at least one column",
            ));
        };
        u32::try_from(columns.len())
            .map_err(|_| ExtensionError::new("column count exceeds u32::MAX"))?;
        let rows = first.validate()?;
        for (index, column) in columns.iter().enumerate().skip(1) {
            let actual = column.validate()?;
            if actual != rows {
                return Err(ExtensionError::new(format!(
                    "column {index} has {actual} rows; expected {rows}"
                )));
            }
        }
        self.batches.push_back(RecordBatch {
            table,
            rows: rows as u32,
            columns,
        });
        Ok(())
    }

    #[cfg(target_arch = "wasm32")]
    pub(crate) fn front(&self) -> Option<&RecordBatch> {
        self.batches.front()
    }

    #[cfg(target_arch = "wasm32")]
    pub(crate) fn pop_front(&mut self) -> Option<RecordBatch> {
        self.batches.pop_front()
    }

    #[cfg(any(test, target_arch = "wasm32"))]
    pub(crate) fn clear(&mut self) {
        self.batches.clear();
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.batches.len()
    }
}

fn validate_buffer_len<T>(values: usize, name: &str) -> Result<()> {
    let bytes = values
        .checked_mul(size_of::<T>())
        .ok_or_else(|| ExtensionError::new(format!("{name} byte length overflows usize")))?;
    u32::try_from(bytes)
        .map_err(|_| ExtensionError::new(format!("{name} exceeds u32::MAX bytes")))?;
    Ok(())
}

fn validate_utf8(offsets: &[u32], bytes: &[u8]) -> Result<()> {
    let Some((&first, rest)) = offsets.split_first() else {
        return Err(ExtensionError::new(
            "UTF-8 columns require at least the initial zero offset",
        ));
    };
    if first != 0 {
        return Err(ExtensionError::new(
            "UTF-8 column offsets must begin at zero",
        ));
    }
    u32::try_from(bytes.len())
        .map_err(|_| ExtensionError::new("UTF-8 column exceeds u32::MAX bytes"))?;
    validate_buffer_len::<u32>(offsets.len(), "UTF-8 offsets")?;

    let mut start = first;
    for &end in rest {
        if end < start || end as usize > bytes.len() {
            return Err(ExtensionError::new(
                "UTF-8 column offsets must be monotonic and within the byte buffer",
            ));
        }
        std::str::from_utf8(&bytes[start as usize..end as usize])
            .map_err(|_| ExtensionError::new("UTF-8 column contains an invalid string"))?;
        start = end;
    }
    if start as usize != bytes.len() {
        return Err(ExtensionError::new(
            "the final UTF-8 offset must equal the byte buffer length",
        ));
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn slice_parts<T>(values: &[T]) -> (u32, u32) {
    if values.is_empty() {
        return (0, 0);
    }
    (
        values.as_ptr() as usize as u32,
        (std::mem::size_of_val(values)) as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_rectangular_nullable_batches() {
        let mut output = OutputSink::new();
        output
            .emit(
                TableId::new(2),
                vec![
                    Column::U64 {
                        values: vec![1, 2, 3],
                        validity: None,
                    },
                    Column::F64 {
                        values: vec![1.0, 2.0, 3.0],
                        validity: Some(vec![0b0000_0101]),
                    },
                ],
            )
            .unwrap();
        assert_eq!(output.len(), 1);
    }

    #[test]
    fn rejects_misaligned_columns_and_validity() {
        let mut output = OutputSink::new();
        let error = output
            .emit(
                TableId::new(0),
                vec![
                    Column::U8 {
                        values: vec![1, 2],
                        validity: None,
                    },
                    Column::U8 {
                        values: vec![3],
                        validity: None,
                    },
                ],
            )
            .unwrap_err();
        assert!(error.to_string().contains("expected 2"));

        let error = output
            .emit(
                TableId::new(0),
                vec![Column::U8 {
                    values: vec![1],
                    validity: Some(vec![]),
                }],
            )
            .unwrap_err();
        assert!(error.to_string().contains("require 1"));
    }

    #[test]
    fn validates_utf8_offsets_and_each_string() {
        let mut output = OutputSink::new();
        output
            .emit(
                TableId::new(0),
                vec![Column::Utf8 {
                    offsets: vec![0, 2, 6],
                    bytes: "hi🔥".as_bytes().to_vec(),
                    validity: None,
                }],
            )
            .unwrap();

        let error = output
            .emit(
                TableId::new(0),
                vec![Column::Utf8 {
                    offsets: vec![0, 3],
                    bytes: "🔥".as_bytes().to_vec(),
                    validity: None,
                }],
            )
            .unwrap_err();
        assert!(error.to_string().contains("invalid string"));
    }
}

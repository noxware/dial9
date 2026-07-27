use dial9_trace_format::decoder::RawEvent;
use dial9_trace_format::types::{FieldValueRef, StackFrameIter};

/// Allocation-free view of one event decoded from the trace stream.
///
/// Names, values, strings, and inline containers are borrowed and are valid
/// only during the corresponding [`crate::Extension::on_event`] call.
pub struct Event<'a, 'f> {
    raw: RawEvent<'a, 'f>,
}

impl<'a, 'f> Event<'a, 'f> {
    #[cfg(any(test, target_arch = "wasm32"))]
    pub(crate) fn new(raw: RawEvent<'a, 'f>) -> Self {
        Self { raw }
    }

    /// Event name from the on-wire schema.
    pub fn name(&self) -> &str {
        self.raw.name
    }

    /// Absolute monotonic timestamp, when the event schema has one.
    pub fn timestamp_ns(&self) -> Option<u64> {
        self.raw.timestamp_ns
    }

    /// Look up a field by its on-wire schema name.
    pub fn field(&self, name: &str) -> Option<Value<'_, 'a>> {
        let index = self
            .raw
            .schema
            .fields()
            .iter()
            .position(|field| field.name() == name)?;
        Some(Value {
            raw: self.raw.fields.get(index)?,
            event: &self.raw,
        })
    }

    /// Unit annotation for a named field, if present.
    pub fn field_unit(&self, name: &str) -> Option<&str> {
        let index = self
            .raw
            .schema
            .fields()
            .iter()
            .position(|field| field.name() == name)?;
        unit_at(&self.raw, index)
    }

    /// Fields in on-wire schema order.
    pub fn fields(&self) -> impl ExactSizeIterator<Item = Field<'_, 'a>> + '_ {
        self.raw
            .schema
            .fields()
            .iter()
            .zip(self.raw.fields.iter())
            .enumerate()
            .map(|(index, (field, raw))| Field {
                name: field.name(),
                unit: unit_at(&self.raw, index),
                value: Value {
                    raw,
                    event: &self.raw,
                },
            })
    }
}

fn unit_at<'a>(event: &'a RawEvent<'_, '_>, index: usize) -> Option<&'a str> {
    event
        .schema
        .annotations()
        .iter()
        .find(|annotation| {
            annotation.field_index() as usize == index
                && matches!(annotation.key(), "unit" | "metrique.unit")
        })
        .map(|annotation| annotation.value())
}

/// A named event field and its optional display unit.
#[derive(Clone, Copy)]
pub struct Field<'e, 'a> {
    name: &'e str,
    unit: Option<&'e str>,
    value: Value<'e, 'a>,
}

impl<'e, 'a> Field<'e, 'a> {
    pub fn name(self) -> &'e str {
        self.name
    }

    pub fn unit(self) -> Option<&'e str> {
        self.unit
    }

    pub fn value(self) -> Value<'e, 'a> {
        self.value
    }
}

/// Borrowed event-field value with pooled values resolved lazily.
#[derive(Clone, Copy)]
pub struct Value<'e, 'a> {
    raw: &'e FieldValueRef<'a>,
    event: &'e RawEvent<'a, 'e>,
}

impl<'e, 'a: 'e> Value<'e, 'a> {
    pub fn as_u64(self) -> Option<u64> {
        match self.raw {
            FieldValueRef::Varint(value) => Some(*value),
            FieldValueRef::I64(value) => (*value).try_into().ok(),
            _ => None,
        }
    }

    pub fn as_i64(self) -> Option<i64> {
        match self.raw {
            FieldValueRef::I64(value) => Some(*value),
            FieldValueRef::Varint(value) => (*value).try_into().ok(),
            _ => None,
        }
    }

    pub fn as_f64(self) -> Option<f64> {
        match self.raw {
            FieldValueRef::F64(value) => Some(*value),
            FieldValueRef::I64(value) => Some(*value as f64),
            FieldValueRef::Varint(value) => Some(*value as f64),
            _ => None,
        }
    }

    pub fn as_bool(self) -> Option<bool> {
        match self.raw {
            FieldValueRef::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_str(self) -> Option<&'e str> {
        match self.raw {
            FieldValueRef::String(value) => Some(value),
            FieldValueRef::PooledString(id) => self.event.string_pool.get(*id),
            _ => None,
        }
    }

    pub fn as_bytes(self) -> Option<&'a [u8]> {
        match self.raw {
            FieldValueRef::Bytes(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_stack_frames(self) -> Option<StackFrames<'e, 'a>> {
        match self.raw {
            FieldValueRef::StackFrames(frames) => {
                Some(StackFrames(StackFramesInner::Inline(frames.iter())))
            }
            FieldValueRef::PooledStackFrames(id) => self
                .event
                .stack_pool
                .get(*id)
                .map(|frames| StackFrames(StackFramesInner::Pooled(frames.iter()))),
            _ => None,
        }
    }

    pub fn as_string_map(self) -> Option<impl ExactSizeIterator<Item = (&'a str, &'a str)> + 'a> {
        match self.raw {
            FieldValueRef::StringMap(values) => Some(values.iter()),
            _ => None,
        }
    }

    pub fn as_list(self) -> Option<impl Iterator<Item = Value<'e, 'a>> + 'e> {
        match self.raw {
            FieldValueRef::List(values) => Some(values.iter().map(move |raw| Value {
                raw,
                event: self.event,
            })),
            _ => None,
        }
    }

    pub fn as_map(self) -> Option<impl Iterator<Item = (Value<'e, 'a>, Value<'e, 'a>)> + 'e> {
        match self.raw {
            FieldValueRef::Map(values) => Some(values.iter().map(move |(key, value)| {
                (
                    Value {
                        raw: key,
                        event: self.event,
                    },
                    Value {
                        raw: value,
                        event: self.event,
                    },
                )
            })),
            _ => None,
        }
    }

    pub fn is_null(self) -> bool {
        matches!(self.raw, FieldValueRef::None)
    }

    /// Stable descriptive name for diagnostics.
    pub fn kind(self) -> &'static str {
        match self.raw {
            FieldValueRef::I64(_) => "i64",
            FieldValueRef::F64(_) => "f64",
            FieldValueRef::Bool(_) => "bool",
            FieldValueRef::String(_) => "string",
            FieldValueRef::Bytes(_) => "bytes",
            FieldValueRef::PooledString(_) => "pooled-string",
            FieldValueRef::StackFrames(_) => "stack-frames",
            FieldValueRef::PooledStackFrames(_) => "pooled-stack-frames",
            FieldValueRef::Varint(_) => "varint",
            FieldValueRef::StringMap(_) => "string-map",
            FieldValueRef::List(_) => "list",
            FieldValueRef::Map(_) => "map",
            FieldValueRef::None => "null",
            _ => "unknown",
        }
    }
}

/// Iterator over inline or pooled stack-frame addresses.
pub struct StackFrames<'e, 'a>(StackFramesInner<'e, 'a>);

enum StackFramesInner<'e, 'a> {
    Inline(StackFrameIter<'a>),
    Pooled(std::slice::Iter<'e, u64>),
}

impl Iterator for StackFrames<'_, '_> {
    type Item = u64;

    fn next(&mut self) -> Option<Self::Item> {
        match &mut self.0 {
            StackFramesInner::Inline(frames) => frames.next(),
            StackFramesInner::Pooled(frames) => frames.next().copied(),
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        match &self.0 {
            StackFramesInner::Inline(frames) => frames.size_hint(),
            StackFramesInner::Pooled(frames) => frames.size_hint(),
        }
    }
}

impl ExactSizeIterator for StackFrames<'_, '_> {}

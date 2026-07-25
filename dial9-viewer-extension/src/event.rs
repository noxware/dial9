use dial9_trace_format::decoder::RawEvent;
use dial9_trace_format::types::{FieldValueRef, StackFrameIter};

/// Allocation-free view of one decoded trace event.
///
/// Names, fields, and values are valid only for the `on_event` call receiving
/// this value.
pub struct Event<'data, 'event> {
    raw: RawEvent<'data, 'event>,
}

impl<'data, 'event> Event<'data, 'event> {
    #[cfg(any(test, target_arch = "wasm32"))]
    pub(crate) fn new(raw: RawEvent<'data, 'event>) -> Self {
        Self { raw }
    }

    /// Event schema name.
    pub fn name(&self) -> &str {
        self.raw.name
    }

    /// Absolute monotonic timestamp from the event header, when present.
    pub fn timestamp_ns(&self) -> Option<u64> {
        self.raw.timestamp_ns
    }

    /// Look up a field by its schema name.
    pub fn field(&self, name: &str) -> Option<Value<'_, 'data>> {
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

    /// Field unit declared by either the current `unit` annotation or the
    /// legacy `metrique.unit` annotation.
    pub fn field_unit(&self, name: &str) -> Option<&str> {
        let index = self
            .raw
            .schema
            .fields()
            .iter()
            .position(|field| field.name() == name)?;
        self.raw
            .schema
            .annotations()
            .iter()
            .find(|annotation| {
                usize::from(annotation.field_index()) == index
                    && matches!(annotation.key(), "unit" | "metrique.unit")
            })
            .map(|annotation| annotation.value())
    }

    /// Iterate fields in on-wire schema order.
    pub fn fields(&self) -> impl ExactSizeIterator<Item = (&str, Value<'_, 'data>)> + '_ {
        self.raw
            .schema
            .fields()
            .iter()
            .zip(self.raw.fields.iter())
            .map(|(field, raw)| {
                (
                    field.name(),
                    Value {
                        raw,
                        event: &self.raw,
                    },
                )
            })
    }
}

/// One event field with pooled values resolved lazily.
#[derive(Clone, Copy)]
pub struct Value<'event, 'data> {
    raw: &'event FieldValueRef<'data>,
    event: &'event RawEvent<'data, 'event>,
}

impl<'event, 'data: 'event> Value<'event, 'data> {
    pub fn as_u64(self) -> Option<u64> {
        match self.raw {
            FieldValueRef::Varint(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_i64(self) -> Option<i64> {
        match self.raw {
            FieldValueRef::I64(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_f64(self) -> Option<f64> {
        match self.raw {
            FieldValueRef::F64(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_bool(self) -> Option<bool> {
        match self.raw {
            FieldValueRef::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_str(self) -> Option<&'event str> {
        match self.raw {
            FieldValueRef::String(value) => Some(value),
            FieldValueRef::PooledString(id) => self.event.string_pool.get(*id),
            _ => None,
        }
    }

    pub fn as_bytes(self) -> Option<&'data [u8]> {
        match self.raw {
            FieldValueRef::Bytes(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_stack_frames(self) -> Option<StackFrames<'event, 'data>> {
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

    pub fn as_string_map(
        self,
    ) -> Option<impl ExactSizeIterator<Item = (&'data str, &'data str)> + 'data> {
        match self.raw {
            FieldValueRef::StringMap(values) => Some(values.iter()),
            _ => None,
        }
    }

    pub fn as_list(self) -> Option<impl Iterator<Item = Value<'event, 'data>> + 'event> {
        match self.raw {
            FieldValueRef::List(values) => Some(values.iter().map(move |raw| Value {
                raw,
                event: self.event,
            })),
            _ => None,
        }
    }

    pub fn as_map(
        self,
    ) -> Option<impl Iterator<Item = (Value<'event, 'data>, Value<'event, 'data>)> + 'event> {
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
}

/// Iterator over inline or pooled stack-frame addresses.
pub struct StackFrames<'event, 'data>(StackFramesInner<'event, 'data>);

enum StackFramesInner<'event, 'data> {
    Inline(StackFrameIter<'data>),
    Pooled(std::slice::Iter<'event, u64>),
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

#[cfg(test)]
mod tests {
    use super::*;
    use dial9_trace_format::decoder::Decoder;
    use dial9_trace_format::encoder::{Encoder, Schema};
    use dial9_trace_format::schema::{FieldAnnotation, FieldDef, SchemaEntry};
    use dial9_trace_format::types::{FieldType, FieldValue};

    #[test]
    fn exposes_all_value_families_and_units_without_owning_them() {
        let mut encoder = Encoder::new();
        let pooled_string = encoder.intern_string("pooled").unwrap();
        let pooled_stack = encoder.intern_stack_frames(&[0x30, 0x40]).unwrap();
        let fields = vec![
            FieldDef::new("signed", FieldType::I64),
            FieldDef::new("float", FieldType::F64),
            FieldDef::new("flag", FieldType::Bool),
            FieldDef::new("bytes", FieldType::Bytes),
            FieldDef::new("stack", FieldType::StackFrames),
            FieldDef::new("pooled_stack", FieldType::PooledStackFrames),
            FieldDef::new("pooled_string", FieldType::PooledString),
            FieldDef::new("string_map", FieldType::StringMap),
            FieldDef::new("list", FieldType::DynamicList),
            FieldDef::new("map", FieldType::DynamicMap),
            FieldDef::new("absent", FieldType::OptionalString),
        ];
        let schema = Schema::from_entry(SchemaEntry::with_annotations(
            "Everything",
            true,
            fields,
            [FieldAnnotation::new(1, "unit", "cores")],
        ));
        encoder.register_existing(&schema).unwrap();
        encoder
            .write_event(
                &schema,
                &[
                    FieldValue::Varint(1_000),
                    FieldValue::I64(-7),
                    FieldValue::F64(1.5),
                    FieldValue::Bool(true),
                    FieldValue::Bytes(vec![1, 2]),
                    FieldValue::StackFrames(vec![0x10, 0x20].into()),
                    FieldValue::PooledStackFrames(pooled_stack),
                    FieldValue::PooledString(pooled_string),
                    FieldValue::StringMap(vec![(b"k".to_vec(), b"v".to_vec())]),
                    FieldValue::List(vec![
                        FieldValue::Varint(7),
                        FieldValue::String("nested".into()),
                    ]),
                    FieldValue::Map(vec![(
                        FieldValue::String("key".into()),
                        FieldValue::Bool(true),
                    )]),
                    FieldValue::None,
                ],
            )
            .unwrap();

        let data = encoder.finish();
        let mut decoder = Decoder::new(&data).unwrap();
        decoder
            .for_each_event(|raw| {
                let event = Event::new(raw);
                assert_eq!(event.name(), "Everything");
                assert_eq!(event.timestamp_ns(), Some(1_000));
                assert_eq!(event.fields().len(), 11);
                assert_eq!(event.field_unit("float"), Some("cores"));
                assert_eq!(event.field("signed").unwrap().as_i64(), Some(-7));
                assert_eq!(event.field("float").unwrap().as_f64(), Some(1.5));
                assert_eq!(event.field("flag").unwrap().as_bool(), Some(true));
                assert_eq!(
                    event.field("bytes").unwrap().as_bytes(),
                    Some([1, 2].as_slice())
                );
                assert_eq!(
                    event
                        .field("stack")
                        .unwrap()
                        .as_stack_frames()
                        .unwrap()
                        .collect::<Vec<_>>(),
                    [0x10, 0x20]
                );
                assert_eq!(
                    event
                        .field("pooled_stack")
                        .unwrap()
                        .as_stack_frames()
                        .unwrap()
                        .collect::<Vec<_>>(),
                    [0x30, 0x40]
                );
                assert_eq!(
                    event.field("pooled_string").unwrap().as_str(),
                    Some("pooled")
                );
                assert_eq!(
                    event
                        .field("string_map")
                        .unwrap()
                        .as_string_map()
                        .unwrap()
                        .collect::<Vec<_>>(),
                    [("k", "v")]
                );

                let mut list = event.field("list").unwrap().as_list().unwrap();
                assert_eq!(list.next().unwrap().as_u64(), Some(7));
                assert_eq!(list.next().unwrap().as_str(), Some("nested"));
                assert!(list.next().is_none());

                let mut map = event.field("map").unwrap().as_map().unwrap();
                let (key, value) = map.next().unwrap();
                assert_eq!(key.as_str(), Some("key"));
                assert_eq!(value.as_bool(), Some(true));
                assert!(map.next().is_none());
                assert!(event.field("absent").unwrap().is_null());
            })
            .unwrap();
    }
}

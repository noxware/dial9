use dial9_trace_format::decoder::RawEvent;
use dial9_trace_format::types::{FieldValueRef, StackFrameIter};

/// A normalized, allocation-free view of one decoded trace event.
///
/// Event names and field names come from the trace's on-wire schema. Values
/// borrow the current input chunk and are valid only during `on_event`.
pub struct Event<'a, 'f> {
    raw: RawEvent<'a, 'f>,
}

impl<'a, 'f> Event<'a, 'f> {
    #[cfg(any(test, target_arch = "wasm32"))]
    pub(crate) fn new(raw: RawEvent<'a, 'f>) -> Self {
        Self { raw }
    }

    pub fn name(&self) -> &str {
        self.raw.name
    }

    pub fn timestamp_ns(&self) -> Option<u64> {
        self.raw.timestamp_ns
    }

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

    /// Iterate over field names and values in on-wire schema order.
    pub fn fields(&self) -> impl ExactSizeIterator<Item = (&str, Value<'_, 'a>)> + '_ {
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

/// One event field, with pooled strings and stack frames resolved lazily.
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

    pub fn is_none(self) -> bool {
        matches!(self.raw, FieldValueRef::None)
    }

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
            FieldValueRef::None => "none",
            _ => "unknown",
        }
    }
}

/// Allocation-free iterator over inline or pooled stack-frame addresses.
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

#[cfg(test)]
mod tests {
    use super::*;
    use dial9_trace_format::encoder::Encoder;
    use dial9_trace_format::schema::FieldDef;
    use dial9_trace_format::types::{FieldType, FieldValue};

    #[test]
    fn fields_and_all_value_families_are_exposed_without_owning_them() {
        let mut encoder = Encoder::new();
        let pooled_string = encoder.intern_string("pooled").unwrap();
        let pooled_stack = encoder.intern_stack_frames(&[0x30, 0x40]).unwrap();
        let schema = encoder
            .register_schema(
                "Everything",
                vec![
                    FieldDef::new("bytes", FieldType::Bytes),
                    FieldDef::new("stack", FieldType::StackFrames),
                    FieldDef::new("pooled_stack", FieldType::PooledStackFrames),
                    FieldDef::new("pooled_string", FieldType::PooledString),
                    FieldDef::new("string_map", FieldType::StringMap),
                    FieldDef::new("list", FieldType::DynamicList),
                    FieldDef::new("map", FieldType::DynamicMap),
                    FieldDef::new("absent", FieldType::OptionalString),
                ],
            )
            .unwrap();
        encoder
            .write_event(
                &schema,
                &[
                    FieldValue::Varint(1),
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
        let mut decoder = dial9_trace_format::decoder::Decoder::new(&data).unwrap();
        decoder
            .for_each_event(|raw| {
                let event = Event::new(raw);
                assert_eq!(event.fields().len(), 8);
                assert_eq!(
                    event.fields().map(|(name, _)| name).collect::<Vec<_>>(),
                    [
                        "bytes",
                        "stack",
                        "pooled_stack",
                        "pooled_string",
                        "string_map",
                        "list",
                        "map",
                        "absent",
                    ]
                );
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

                let absent = event.field("absent").unwrap();
                assert!(absent.is_none());
                assert_eq!(absent.kind(), "none");
            })
            .unwrap();
    }
}

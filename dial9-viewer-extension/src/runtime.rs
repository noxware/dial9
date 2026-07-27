use crate::Event;
#[cfg(any(test, target_arch = "wasm32"))]
use crate::output::Batch;
use crate::output::OutputSink;
#[cfg(any(test, target_arch = "wasm32"))]
use dial9_trace_format::decoder::{StreamingDecoder, TryForEachError};
#[cfg(target_arch = "wasm32")]
use std::cell::UnsafeCell;
#[cfg(any(test, target_arch = "wasm32"))]
use std::collections::VecDeque;
use std::fmt;

pub const ABI_VERSION: u32 = 1;

/// User computation hosted by the viewer.
///
/// Hooks run in input order. `finish` is only an end-of-input hook; output may
/// be emitted from any hook.
pub trait Extension: Default + 'static {
    fn on_start(&mut self, _output: &mut OutputSink<'_>) -> Result<(), ExtensionError> {
        Ok(())
    }

    fn on_event(
        &mut self,
        _event: Event<'_, '_>,
        _output: &mut OutputSink<'_>,
    ) -> Result<(), ExtensionError> {
        Ok(())
    }

    fn finish(self, _output: &mut OutputSink<'_>) -> Result<(), ExtensionError> {
        Ok(())
    }
}

/// Fatal error reported by an extension hook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionError(String);

impl ExtensionError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ExtensionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ExtensionError {}

impl From<crate::OutputError> for ExtensionError {
    fn from(error: crate::OutputError) -> Self {
        Self(error.to_string())
    }
}

#[cfg(any(test, target_arch = "wasm32"))]
struct Runtime<E> {
    decoder: StreamingDecoder,
    extension: Option<E>,
    input: Vec<u8>,
    batches: VecDeque<Batch>,
    descriptor: Vec<u8>,
    error: Vec<u8>,
    started: bool,
    failed: bool,
    finished: bool,
}

#[cfg(any(test, target_arch = "wasm32"))]
impl<E: Extension> Runtime<E> {
    fn new() -> Self {
        Self {
            decoder: StreamingDecoder::new(),
            extension: Some(E::default()),
            input: Vec::new(),
            batches: VecDeque::new(),
            descriptor: Vec::new(),
            error: Vec::new(),
            started: false,
            failed: false,
            finished: false,
        }
    }

    #[cfg_attr(test, allow(dead_code))]
    fn input_alloc(&mut self, len: u32) -> u32 {
        if self.failed || self.finished {
            return 0;
        }
        self.input.resize(len as usize, 0);
        self.input.as_mut_ptr() as usize as u32
    }

    fn ensure_started(&mut self) -> Result<(), ExtensionError> {
        if self.started {
            return Ok(());
        }
        let extension = self.extension.as_mut().expect("extension before finish");
        let mut output = OutputSink::new(&mut self.batches);
        extension.on_start(&mut output)?;
        self.started = true;
        Ok(())
    }

    fn push(&mut self, len: u32) -> i32 {
        if self.failed || self.finished {
            return 1;
        }
        let len = len as usize;
        if len > self.input.len() {
            self.fail("dial9_push length exceeds allocated input");
            return 1;
        }
        if let Err(error) = self.ensure_started() {
            self.fail(error.to_string());
            return 1;
        }

        let Self {
            decoder,
            extension,
            input,
            batches,
            ..
        } = self;
        let extension = extension.as_mut().expect("extension before finish");
        let result = decoder.push(&input[..len], |raw| {
            extension.on_event(Event::new(raw), &mut OutputSink::new(batches))
        });
        match result {
            Ok(()) => 0,
            Err(TryForEachError::Decode(error)) => {
                self.fail(error.to_string());
                1
            }
            Err(TryForEachError::User(error)) => {
                self.fail(error.to_string());
                1
            }
        }
    }

    fn finish(&mut self) -> i32 {
        if self.failed || self.finished {
            return 1;
        }
        if let Err(error) = self.ensure_started() {
            self.fail(error.to_string());
            return 1;
        }
        if let Err(error) = self.decoder.finish() {
            self.fail(error.to_string());
            return 1;
        }
        let extension = self.extension.take().expect("extension before finish");
        if let Err(error) = extension.finish(&mut OutputSink::new(&mut self.batches)) {
            self.fail(error.to_string());
            return 1;
        }
        self.finished = true;
        0
    }

    #[cfg(target_arch = "wasm32")]
    fn output_next(&mut self) -> u32 {
        if self.failed || self.batches.is_empty() {
            return 0;
        }
        if self.descriptor.is_empty() {
            match self.batches.front().expect("checked nonempty").descriptor() {
                Ok(descriptor) => self.descriptor = descriptor,
                Err(error) => {
                    self.fail(error.to_string());
                    return 0;
                }
            }
        }
        self.descriptor.as_ptr() as usize as u32
    }

    #[cfg(target_arch = "wasm32")]
    fn output_descriptor_len(&self) -> u32 {
        self.descriptor.len().try_into().unwrap_or(u32::MAX)
    }

    #[cfg_attr(test, allow(dead_code))]
    fn output_ack(&mut self) -> i32 {
        if self.failed || self.descriptor.is_empty() || self.batches.pop_front().is_none() {
            return 1;
        }
        self.descriptor.clear();
        0
    }

    fn fail(&mut self, message: impl Into<String>) {
        self.error = message.into().into_bytes();
        self.batches.clear();
        self.descriptor.clear();
        self.failed = true;
    }
}

/// Single-threaded global used by the exported non-reentrant ABI.
#[cfg(target_arch = "wasm32")]
pub struct GlobalRuntime<E>(UnsafeCell<Option<Runtime<E>>>);

#[cfg(target_arch = "wasm32")]
unsafe impl<E> Sync for GlobalRuntime<E> {}

#[cfg(target_arch = "wasm32")]
impl<E: Extension> GlobalRuntime<E> {
    pub const fn new() -> Self {
        Self(UnsafeCell::new(None))
    }

    fn runtime(&self) -> &mut Runtime<E> {
        // SAFETY: core Wasm is single-threaded, the host invokes one export at
        // a time, and no reference escapes an ABI call.
        let slot = unsafe { &mut *self.0.get() };
        slot.get_or_insert_with(Runtime::new)
    }

    pub fn input_alloc(&self, len: u32) -> u32 {
        self.runtime().input_alloc(len)
    }

    pub fn push(&self, len: u32) -> i32 {
        self.runtime().push(len)
    }

    pub fn finish(&self) -> i32 {
        self.runtime().finish()
    }

    pub fn output_next(&self) -> u32 {
        self.runtime().output_next()
    }

    pub fn output_descriptor_len(&self) -> u32 {
        self.runtime().output_descriptor_len()
    }

    pub fn output_ack(&self) -> i32 {
        self.runtime().output_ack()
    }

    pub fn error_ptr(&self) -> u32 {
        self.runtime().error.as_ptr() as usize as u32
    }

    pub fn error_len(&self) -> u32 {
        self.runtime().error.len().try_into().unwrap_or(u32::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Column, TableId};
    use dial9_trace_format::encoder::Encoder;
    use dial9_trace_format::schema::FieldDef;
    use dial9_trace_format::types::{FieldType, FieldValue};

    #[derive(Default)]
    struct Echo {
        values: Vec<u64>,
    }

    impl Extension for Echo {
        fn on_event(
            &mut self,
            event: Event<'_, '_>,
            output: &mut OutputSink<'_>,
        ) -> Result<(), ExtensionError> {
            if event.name() == "Value" {
                self.values
                    .push(event.field("value").unwrap().as_u64().unwrap());
            }
            if self.values.len() == 2 {
                output.emit(
                    TableId::new(0),
                    vec![Column::U64 {
                        values: std::mem::take(&mut self.values),
                        validity: None,
                    }],
                )?;
            }
            Ok(())
        }
    }

    #[test]
    fn runtime_decodes_chunks_and_queues_incremental_batches() {
        let mut encoder = Encoder::new();
        let schema = encoder
            .register_schema("Value", vec![FieldDef::new("value", FieldType::Varint)])
            .unwrap();
        for value in 1..=4 {
            encoder
                .write_event(
                    &schema,
                    &[FieldValue::Varint(value), FieldValue::Varint(value)],
                )
                .unwrap();
        }
        let bytes = encoder.finish();
        let mut runtime = Runtime::<Echo>::new();
        for chunk in bytes.chunks(3) {
            runtime.input.resize(chunk.len(), 0);
            runtime.input.copy_from_slice(chunk);
            assert_eq!(runtime.push(chunk.len() as u32), 0);
        }
        assert_eq!(runtime.batches.len(), 2);
        assert_eq!(runtime.finish(), 0);
    }
}

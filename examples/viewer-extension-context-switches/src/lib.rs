use dial9_viewer_extension::{Event, Extension, ExtensionError, OutputSink};

const BATCH_ROWS: usize = 1_024;

dial9_viewer_extension::include_manifest!("viewer-extension.json");

#[derive(Clone, Copy)]
struct Sample {
    timestamp_ns: u64,
    voluntary: u64,
    involuntary: u64,
}

#[derive(Default)]
pub struct ContextSwitchExtension {
    previous: Option<Sample>,
    batch: tables::context_switches::Batch,
}

impl Extension for ContextSwitchExtension {
    fn on_event(
        &mut self,
        event: Event<'_, '_>,
        output: &mut OutputSink,
    ) -> Result<(), ExtensionError> {
        if event.name() != "ProcessResourceUsageEvent" {
            return Ok(());
        }

        let Some(current) = sample(&event) else {
            return Ok(());
        };

        if let Some(previous) = self.previous
            && let Some(row) = context_switch_interval(previous, current)
        {
            self.batch.push(row)?;
        }
        self.previous = Some(current);

        if self.batch.len() >= BATCH_ROWS {
            self.batch.emit(output)?;
        }
        Ok(())
    }

    fn finish(mut self, output: &mut OutputSink) -> Result<(), ExtensionError> {
        self.batch.emit(output)?;
        Ok(())
    }
}

fn sample(event: &Event<'_, '_>) -> Option<Sample> {
    Some(Sample {
        timestamp_ns: event.timestamp_ns()?,
        voluntary: event.field("voluntary_context_switches")?.as_u64()?,
        involuntary: event.field("involuntary_context_switches")?.as_u64()?,
    })
}

fn context_switch_interval(
    previous: Sample,
    current: Sample,
) -> Option<tables::context_switches::Row> {
    current
        .timestamp_ns
        .checked_sub(previous.timestamp_ns)
        .filter(|elapsed| *elapsed > 0)?;

    Some(tables::context_switches::Row {
        start_ns: previous.timestamp_ns,
        end_ns: current.timestamp_ns,
        voluntary: current.voluntary.checked_sub(previous.voluntary)?,
        involuntary: current.involuntary.checked_sub(previous.involuntary)?,
    })
}

dial9_viewer_extension::export_extension!(ContextSwitchExtension);

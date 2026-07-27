use dial9_perf_self_profile::ProcessResourceUsageEvent;
use dial9_trace_format::TraceEvent;
use dial9_trace_format::encoder::Encoder;
use std::env;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;

const USAGE_PERIOD_NS: u64 = 250_000_000;
const FIRST_USAGE_NS: u64 = 1_000_000_000;

#[derive(TraceEvent)]
#[traceevent(wire_slot)]
struct SegmentMetadataEvent {
    #[traceevent(timestamp)]
    timestamp_ns: u64,
    entries: Vec<(String, String)>,
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn parse_rows(value: &OsStr) -> io::Result<u64> {
    value
        .to_str()
        .ok_or_else(|| invalid_input("row count must be UTF-8"))?
        .parse()
        .map_err(|error| invalid_input(format!("invalid row count: {error}")))
}

fn main() -> io::Result<()> {
    let mut args = env::args_os().skip(1);
    let output = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| invalid_input("usage: make_trace <trace.bin> [rows]"))?;
    let rows = args
        .next()
        .as_deref()
        .map(parse_rows)
        .transpose()?
        .unwrap_or(250_000);
    if args.next().is_some() {
        return Err(invalid_input("usage: make_trace <trace.bin> [rows]"));
    }

    let writer = BufWriter::new(File::create(&output)?);
    let mut encoder = Encoder::new_to(writer)?;
    encoder.write(&SegmentMetadataEvent {
        timestamp_ns: 0,
        entries: vec![("process.available_parallelism".into(), "11".into())],
    })?;

    let mut user_cpu_ns = 0_u64;
    let mut system_cpu_ns = 0_u64;
    let mut voluntary_context_switches = 0_u64;
    let mut involuntary_context_switches = 0_u64;
    for row in 0..rows {
        let timestamp_ns = row
            .checked_mul(USAGE_PERIOD_NS)
            .and_then(|offset| FIRST_USAGE_NS.checked_add(offset))
            .ok_or_else(|| invalid_input("row count overflows generated timestamps"))?;
        user_cpu_ns = user_cpu_ns
            .checked_add(80_000_000 + (row % 8) * 10_000_000)
            .ok_or_else(|| invalid_input("row count overflows user CPU time"))?;
        system_cpu_ns = system_cpu_ns
            .checked_add(20_000_000 + (row % 5) * 5_000_000)
            .ok_or_else(|| invalid_input("row count overflows system CPU time"))?;
        voluntary_context_switches = voluntary_context_switches
            .checked_add(3 + row % 7)
            .ok_or_else(|| invalid_input("row count overflows voluntary context switches"))?;
        involuntary_context_switches = involuntary_context_switches
            .checked_add(1 + row % 3)
            .ok_or_else(|| invalid_input("row count overflows involuntary context switches"))?;

        encoder.write(&ProcessResourceUsageEvent {
            timestamp_ns,
            user_cpu_ns,
            system_cpu_ns,
            max_rss_bytes: 64 * 1024 * 1024,
            minor_faults: row * 2,
            major_faults: 0,
            block_input_ops: 0,
            block_output_ops: 0,
            voluntary_context_switches,
            involuntary_context_switches,
        })?;
    }

    let mut writer = encoder.into_inner();
    writer.flush()?;
    eprintln!(
        "wrote {rows} ProcessResourceUsageEvent rows to {}",
        output.display()
    );
    Ok(())
}

//! Trace aggregation building blocks: decode CPU samples and write Parquet.
//!
//! The demand-driven aggregation flow folds raw trace segments into Parquet
//! part-files on demand, decoding samples ([`decode`]) and encoding them
//! ([`parquet_writer`]). [`aggregate`] is the kit of parts (fold one file, read
//! folded part-files, key algebra); [`refine`] is the orchestration layer over
//! it (list → scope → cap → fold → coverage) shared by every demand-driven
//! endpoint.

pub mod aggregate;
pub(crate) mod decode;
pub(crate) mod parquet_writer;
pub(crate) mod refine;

/// Narrow harness for the external Criterion benchmark target.
#[doc(hidden)]
pub fn benchmark_decode_samples(data: &[u8], source_key: &str) -> anyhow::Result<()> {
    decode::decode_samples(data, source_key).map(drop)
}

/// Parquet parts produced by the telemetry integration-test harness.
#[doc(hidden)]
pub struct TelemetryTestParquetParts {
    pub samples: Vec<u8>,
    pub stacks: Vec<u8>,
    pub spans: Vec<u8>,
    pub task_dumps: Vec<u8>,
}

/// Exercise the aggregate decoder and Parquet writers without storage or HTTP.
#[doc(hidden)]
pub fn telemetry_test_decode_parquet(
    data: &[u8],
    source_key: &str,
) -> anyhow::Result<TelemetryTestParquetParts> {
    let parts = aggregate::decode_and_encode(data, source_key)?;
    Ok(TelemetryTestParquetParts {
        samples: parts.samples_buf,
        stacks: parts.dict_buf,
        spans: parts.spans_buf,
        task_dumps: parts.task_dumps_buf,
    })
}

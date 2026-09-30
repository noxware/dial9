//! Time-weighted CPU/async analysis for one task in one recording.

use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode};
use axum_extra::extract::Query;
use futures::StreamExt;
use serde::{Deserialize, Serialize};

use super::{AppState, credentials::MaybeCreds, fold_stream};
use crate::ingest::{
    aggregate::{self, Scope},
    refine::{self, FoldOutcome, RefineOpts},
    task_profile::{self, analysis},
};

#[derive(Deserialize)]
pub(crate) struct Params {
    task_id: u64,
    recording_id: Option<String>,
    start_ns: u64,
    end_ns: u64,
    service: Option<String>,
    #[serde(default)]
    host: Vec<String>,
    max_files: Option<usize>,
    bucket: Option<String>,
    prefix: Option<String>,
    aws_region: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct Response {
    #[serde(flatten)]
    profile: analysis::Response,
    files_matched: usize,
    files_folded: usize,
}

fn failure(error: anyhow::Error) -> (StatusCode, String) {
    fold_stream::rate_limited_warn("task flamegraph failed", &error);
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

pub(crate) async fn get_task_flamegraph(
    State(state): State<AppState>,
    creds: MaybeCreds,
    Query(params): Query<Params>,
) -> Result<Json<Response>, (StatusCode, String)> {
    if params.start_ns >= params.end_ns || params.end_ns > i64::MAX as u64 {
        return Err((
            StatusCode::BAD_REQUEST,
            "start_ns and end_ns must define a positive wall-clock range".into(),
        ));
    }
    let agg = state
        .agg_context_for(
            params.bucket.as_deref(),
            params.prefix.as_deref(),
            params.aws_region.as_deref(),
            creds,
        )
        .await?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "task flamegraph requires aggregation".into(),
            )
        })?;
    let agg = Arc::new(agg);
    // Include the following segment to close a wait/poll across rotation.
    let scope = Scope {
        // Local files need not follow the date-partitioned object-key layout.
        start_ns: (!agg.source_is_local).then_some(params.start_ns as i64),
        end_ns: (!agg.source_is_local).then_some(
            (params.end_ns as i64)
                .saturating_add(agg.segment_duration_secs.saturating_mul(1_000_000_000)),
        ),
        service: params.service.clone(),
        hosts: params.host.clone(),
    };
    let resolved = refine::resolve(
        &agg,
        &scope,
        RefineOpts {
            max_files: params.max_files,
        },
    )
    .await
    .ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            "no source files match this scope".into(),
        )
    })?;
    let mut keys = resolved.folded_matching_full_keys();
    let folds = refine::fold_stream(
        Arc::clone(&agg),
        state.fold_limits.clone(),
        resolved.unfolded_capped(),
    );
    futures::pin_mut!(folds);
    while let Some(outcome) = folds.next().await {
        match outcome {
            FoldOutcome::Folded(file) => keys.push(file.full_key),
            FoldOutcome::Failed { raw_key, error } => {
                return Err(failure(anyhow::anyhow!("fold {raw_key}: {error}")));
            }
        }
    }
    keys.sort();
    keys.dedup();
    let files_folded = keys.len();
    let files_matched = resolved.files_matched;
    if files_folded < files_matched {
        // A file-sampled aggregate cannot safely bridge a task's missing polls.
        return Ok(Json(Response {
            files_matched,
            files_folded,
            profile: analysis::Response {
                unit: "nanoseconds",
                task_id: params.task_id.to_string(),
                recording_id: params.recording_id,
                start_ns: params.start_ns,
                end_ns: params.end_ns,
                unavailable_reason: Some("incomplete_segments"),
                ..Default::default()
            },
        }));
    }
    let mut segments = Vec::new();
    for key in keys {
        let part = aggregate::task_profile_part_key(&agg.output_prefix, &key);
        let bytes = agg
            .output
            .get_object(&agg.output_bucket, &part)
            .await
            .map_err(|e| failure(e.into()))?;
        let segment = tokio::task::spawn_blocking(move || task_profile::read(bytes.into()))
            .await
            .map_err(|e| failure(e.into()))?
            .map_err(failure)?;
        segments.push(segment);
    }
    let profile = tokio::task::spawn_blocking(move || {
        analysis::analyze(
            &segments,
            analysis::Request {
                task_id: params.task_id,
                recording_id: params.recording_id.as_deref(),
                start_ns: params.start_ns,
                end_ns: params.end_ns,
            },
        )
    })
    .await
    .map_err(|e| failure(e.into()))?;
    Ok(Json(Response {
        profile,
        files_matched,
        files_folded,
    }))
}

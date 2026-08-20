//! Private discovery for versioned and historical source-key layouts.

use std::collections::{BTreeMap, BTreeSet};

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::storage::{StorageBackend, StorageError};

const DISCOVERY_CONCURRENCY: usize = 16;
const HINT_VERSION: u8 = 1;
const HINT_TTL_SECS: i64 = 5 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LayoutSet {
    Historical,
    Version1,
    Both,
}

impl LayoutSet {
    pub(crate) fn historical(self) -> bool {
        matches!(self, Self::Historical | Self::Both)
    }

    pub(crate) fn version1(self) -> bool {
        matches!(self, Self::Version1 | Self::Both)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DayLayout {
    pub(crate) date: String,
    pub(crate) from: i64,
    pub(crate) to: i64,
    pub(crate) layout: LayoutSet,
}

#[derive(Debug, Default)]
pub(crate) struct Version1Services {
    dates_by_service: BTreeMap<String, BTreeSet<String>>,
}

impl Version1Services {
    pub(crate) fn services(&self) -> impl Iterator<Item = &String> {
        self.dates_by_service.keys()
    }

    pub(crate) fn dates_for(&self, service: &str) -> Option<&BTreeSet<String>> {
        self.dates_by_service.get(service)
    }

    pub(crate) fn services_on(&self, date: &str) -> impl Iterator<Item = &String> {
        self.dates_by_service
            .iter()
            .filter_map(move |(service, dates)| dates.contains(date).then_some(service))
    }

    fn record(&mut self, service: String, date: String) {
        self.dates_by_service
            .entry(service)
            .or_default()
            .insert(date);
    }

    #[cfg(test)]
    pub(crate) fn with_service_on(mut self, service: &str, date: &str) -> Self {
        self.record(service.to_string(), date.to_string());
        self
    }
}

pub(crate) struct ResolvedServiceLayouts {
    pub(crate) days: Vec<DayLayout>,
}

#[derive(Debug, Serialize, Deserialize)]
struct LayoutHint {
    v: u8,
    bucket: String,
    base: String,
    service: String,
    first_day: String,
    last_day: String,
    first_v1_day: Option<String>,
    expires_at: i64,
}

pub(crate) async fn discover_version1_services(
    backend: &dyn StorageBackend,
    bucket: &str,
    base: &str,
    from: i64,
    to: i64,
) -> Result<Version1Services, StorageError> {
    let days = day_layouts(from, to, LayoutSet::Version1)?;
    let results = futures::stream::iter(days)
        .map(|day| async move {
            let root = version1_day_root(base, &day.date);
            let children = backend.list_prefixes(bucket, &root).await?;
            Ok::<_, StorageError>((day.date, root, children))
        })
        .buffer_unordered(DISCOVERY_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    let mut services = Version1Services::default();
    for result in results {
        let (date, root, children) = result?;
        for child in children {
            let Some(encoded) = child
                .strip_prefix(&root)
                .and_then(|value| value.strip_suffix('/'))
                .filter(|value| !value.contains('/'))
                .and_then(|value| value.strip_prefix("service="))
            else {
                continue;
            };
            if let Some(service) = crate::segment_object_key_codec::hive_unescape(encoded) {
                services.record(service, date.clone());
            }
        }
    }
    Ok(services)
}

pub(crate) async fn resolve_service_layouts(
    backend: &dyn StorageBackend,
    bucket: &str,
    base: &str,
    from: i64,
    to: i64,
    service: &str,
    hint: Option<&str>,
) -> Result<ResolvedServiceLayouts, StorageError> {
    let days = day_layouts(from, to, LayoutSet::Historical)?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    if let Some(hint) = hint
        && let Some(first_v1_day) = decode_hint(hint, bucket, base, service, &days, now)
    {
        return Ok(ResolvedServiceLayouts {
            days: classify_days(days, first_v1_day.as_deref()),
        });
    }

    let discovery = discover_version1_services(backend, bucket, base, from, to).await?;
    let first_v1_day = discovery
        .dates_for(service)
        .and_then(|dates| dates.first().cloned());
    Ok(ResolvedServiceLayouts {
        days: classify_days(days, first_v1_day.as_deref()),
    })
}

pub(crate) fn hint_for_service(
    bucket: &str,
    base: &str,
    service: &str,
    days: &[DayLayout],
    version1_dates: Option<&BTreeSet<String>>,
) -> String {
    let first_v1_day = version1_dates.and_then(BTreeSet::first).map(String::as_str);
    encode_hint(
        bucket,
        base,
        service,
        days,
        first_v1_day,
        OffsetDateTime::now_utc().unix_timestamp(),
    )
}

pub(crate) fn day_layouts(
    from: i64,
    to: i64,
    layout: LayoutSet,
) -> Result<Vec<DayLayout>, StorageError> {
    let mut days = Vec::new();
    let mut day_start = from.div_euclid(86_400) * 86_400;
    while day_start <= to {
        let timestamp = OffsetDateTime::from_unix_timestamp(day_start)
            .map_err(|error| StorageError::Other(format!("timestamp out of range: {error}")))?;
        let date = format!(
            "{:04}-{:02}-{:02}",
            timestamp.year(),
            u8::from(timestamp.month()),
            timestamp.day()
        );
        days.push(DayLayout {
            date,
            from: from.max(day_start),
            to: to.min(day_start.saturating_add(86_399)),
            layout,
        });
        let Some(next) = day_start.checked_add(86_400) else {
            break;
        };
        day_start = next;
    }
    Ok(days)
}

pub(crate) fn version1_day_root(base: &str, date: &str) -> String {
    join_prefix(base, &format!("version=1/date={date}/"))
}

fn classify_days(mut days: Vec<DayLayout>, first_v1_day: Option<&str>) -> Vec<DayLayout> {
    for day in &mut days {
        day.layout = match first_v1_day {
            None => LayoutSet::Historical,
            Some(first) if day.date.as_str() < first => LayoutSet::Historical,
            Some(first) if day.date == first => LayoutSet::Both,
            Some(_) => LayoutSet::Version1,
        };
    }
    days
}

fn encode_hint(
    bucket: &str,
    base: &str,
    service: &str,
    days: &[DayLayout],
    first_v1_day: Option<&str>,
    now: i64,
) -> String {
    let first_day = days.first().map(|day| day.date.clone()).unwrap_or_default();
    let last_day = days.last().map(|day| day.date.clone()).unwrap_or_default();
    serde_json::to_string(&LayoutHint {
        v: HINT_VERSION,
        bucket: bucket.to_string(),
        base: base.to_string(),
        service: service.to_string(),
        first_day,
        last_day,
        first_v1_day: first_v1_day.map(str::to_string),
        expires_at: now.saturating_add(HINT_TTL_SECS),
    })
    .expect("layout hint contains only serializable fields")
}

fn decode_hint(
    encoded: &str,
    bucket: &str,
    base: &str,
    service: &str,
    days: &[DayLayout],
    now: i64,
) -> Option<Option<String>> {
    let hint: LayoutHint = serde_json::from_str(encoded).ok()?;
    let first = days.first()?.date.as_str();
    let last = days.last()?.date.as_str();
    if hint.v != HINT_VERSION
        || hint.bucket != bucket
        || hint.base != base
        || hint.service != service
        || hint.expires_at < now
        || hint.first_day.as_str() > first
        || hint.last_day.as_str() < last
        || hint
            .first_v1_day
            .as_deref()
            .is_some_and(|date| !days.iter().any(|day| day.date == date))
    {
        return None;
    }
    Some(hint.first_v1_day)
}

fn join_prefix(base: &str, tail: &str) -> String {
    if base.is_empty() {
        tail.to_string()
    } else {
        format!("{}/{}", base.trim_end_matches('/'), tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_only_the_first_versioned_day_as_crossover() {
        let days = day_layouts(1_787_270_400, 1_787_529_599, LayoutSet::Historical).unwrap();
        let layouts = classify_days(days, Some("2026-08-22"));
        assert_eq!(
            layouts
                .iter()
                .map(|day| (day.date.as_str(), day.layout))
                .collect::<Vec<_>>(),
            vec![
                ("2026-08-21", LayoutSet::Historical),
                ("2026-08-22", LayoutSet::Both),
                ("2026-08-23", LayoutSet::Version1),
            ]
        );
    }

    #[test]
    fn hints_are_scoped_expiring_and_range_checked() {
        let days = day_layouts(1_787_270_400, 1_787_443_199, LayoutSet::Historical).unwrap();
        let hint = encode_hint(
            "trace-bucket",
            "traces",
            "api",
            &days,
            Some("2026-08-22"),
            100,
        );
        assert_eq!(
            decode_hint(&hint, "trace-bucket", "traces", "api", &days, 100),
            Some(Some("2026-08-22".to_string()))
        );
        assert_eq!(
            decode_hint(&hint, "other-bucket", "traces", "api", &days, 100),
            None
        );
        assert_eq!(
            decode_hint(&hint, "trace-bucket", "other", "api", &days, 100),
            None
        );
        assert_eq!(
            decode_hint(&hint, "trace-bucket", "traces", "api", &days, 401),
            None
        );

        let wider = day_layouts(1_787_184_000, 1_787_443_199, LayoutSet::Historical).unwrap();
        assert_eq!(
            decode_hint(&hint, "trace-bucket", "traces", "api", &wider, 100),
            None
        );
    }

    #[test]
    fn root_layout_has_no_leading_slash() {
        assert_eq!(
            version1_day_root("", "2026-08-22"),
            "version=1/date=2026-08-22/"
        );
    }
}

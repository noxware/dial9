//! Dial9 segment object key layout and Hive path escaping.

/// The recognized segment object key layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SegmentObjectKeyLayout {
    /// `date=…/time=…/service=…/instance=…/boot=…/{epoch}-{index}.bin[.gz]`.
    Hive,
    /// Historical layout with a boot-id directory.
    PositionalWithBoot,
    /// Historical layout without a boot-id directory.
    PositionalWithoutBoot,
    /// No supported directory layout was recognized.
    Unknown,
}

/// Semantic fields recovered from a segment object key.
///
/// Hive fields are optional independently: malformed escaping invalidates that
/// field without hiding the filename or other valid fields.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ParsedSegmentObjectKey {
    pub layout: SegmentObjectKeyLayout,
    pub prefix: Option<String>,
    pub date: Option<String>,
    pub time: Option<String>,
    pub service: Option<String>,
    pub instance: Option<String>,
    pub boot_id: Option<String>,
    pub filename: String,
    pub epoch_secs: Option<i64>,
    pub segment_index: Option<u32>,
}

/// Escape a Hive partition-path value using Hive's canonical ASCII table.
///
/// This intentionally preserves empty strings instead of substituting Hive's
/// SQL null-partition sentinel: dial9 values are ordinary strings, not nullable
/// table cells.
pub fn hive_escape(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";

    let mut escaped = String::with_capacity(value.len());
    for c in value.chars() {
        if c.is_ascii() && needs_hive_escape(c as u8) {
            let byte = c as u8;
            escaped.push('%');
            escaped.push(HEX[(byte >> 4) as usize] as char);
            escaped.push(HEX[(byte & 0x0f) as usize] as char);
        } else {
            escaped.push(c);
        }
    }
    escaped
}

/// Decode one layer of `%HH` escaping from a Hive partition-path value.
///
/// Malformed escapes and escaped bytes that are not valid UTF-8 return `None`.
pub fn hive_unescape(value: &str) -> Option<String> {
    if !value.as_bytes().contains(&b'%') {
        return Some(value.to_string());
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            decoded.push(bytes[i]);
            i += 1;
            continue;
        }
        let high = hex_value(*bytes.get(i + 1)?)?;
        let low = hex_value(*bytes.get(i + 2)?)?;
        decoded.push((high << 4) | low);
        i += 3;
    }
    String::from_utf8(decoded).ok()
}

/// Parse a dial9 segment object key, including historical layouts.
pub fn parse_segment_object_key(key: &str) -> ParsedSegmentObjectKey {
    let path = strip_s3(key);
    let parts: Vec<&str> = path.split('/').collect();
    let filename = parts.last().copied().unwrap_or_default().to_string();
    let (epoch_secs, segment_index) = parse_filename(&filename)
        .map(|(epoch, index)| (Some(epoch), Some(index)))
        .unwrap_or((None, None));

    if parts.len() >= 6 {
        let start = parts.len() - 6;
        if let (Some(date), Some(time), Some(service), Some(instance), Some(boot_id)) = (
            partition_value(parts[start], "date"),
            partition_value(parts[start + 1], "time"),
            partition_value(parts[start + 2], "service"),
            partition_value(parts[start + 3], "instance"),
            partition_value(parts[start + 4], "boot"),
        ) {
            return ParsedSegmentObjectKey {
                layout: SegmentObjectKeyLayout::Hive,
                prefix: Some(parts[..start].join("/")),
                date: date.filter(|value| is_date(value)),
                time: time.filter(|value| is_time(value)),
                service,
                instance,
                boot_id,
                filename,
                epoch_secs,
                segment_index,
            };
        }

        if is_date(parts[start]) && is_time(parts[start + 1]) {
            return ParsedSegmentObjectKey {
                layout: SegmentObjectKeyLayout::PositionalWithBoot,
                prefix: Some(parts[..start].join("/")),
                date: Some(parts[start].to_string()),
                time: Some(parts[start + 1].to_string()),
                service: Some(parts[start + 2].to_string()),
                instance: Some(parts[start + 3].to_string()),
                boot_id: Some(parts[start + 4].to_string()),
                filename,
                epoch_secs,
                segment_index,
            };
        }
    }

    if parts.len() >= 5 {
        let start = parts.len() - 5;
        if is_date(parts[start]) && is_time(parts[start + 1]) {
            return ParsedSegmentObjectKey {
                layout: SegmentObjectKeyLayout::PositionalWithoutBoot,
                prefix: Some(parts[..start].join("/")),
                date: Some(parts[start].to_string()),
                time: Some(parts[start + 1].to_string()),
                service: Some(parts[start + 2].to_string()),
                instance: Some(parts[start + 3].to_string()),
                boot_id: None,
                filename,
                epoch_secs,
                segment_index,
            };
        }
    }

    ParsedSegmentObjectKey {
        layout: SegmentObjectKeyLayout::Unknown,
        prefix: None,
        date: None,
        time: None,
        service: None,
        instance: None,
        boot_id: None,
        filename,
        epoch_secs,
        segment_index,
    }
}

fn strip_s3(key: &str) -> &str {
    if let Some(rest) = key.strip_prefix("s3://") {
        rest.split_once('/').map_or(rest, |(_, path)| path)
    } else {
        key
    }
}

fn partition_value(segment: &str, name: &str) -> Option<Option<String>> {
    segment
        .strip_prefix(name)
        .and_then(|value| value.strip_prefix('='))
        .map(hive_unescape)
}

fn parse_filename(filename: &str) -> Option<(i64, u32)> {
    let stem = filename
        .strip_suffix(".bin.gz")
        .or_else(|| filename.strip_suffix(".bin"))?;
    let (epoch, index) = stem.split_once('-')?;
    if index.contains('-') {
        return None;
    }
    Some((epoch.parse().ok()?, index.parse().ok()?))
}

fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..].iter().all(u8::is_ascii_digit)
}

fn is_time(value: &str) -> bool {
    value.len() == 4 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn needs_hive_escape(byte: u8) -> bool {
    byte < b' '
        || byte == 0x7f
        || matches!(
            byte,
            b'"' | b'#'
                | b'%'
                | b'\''
                | b'*'
                | b'/'
                | b':'
                | b'='
                | b'?'
                | b'\\'
                | b'{'
                | b'['
                | b']'
                | b'^'
        )
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hive_escape_uses_the_complete_ascii_table() {
        let mut input: String = (0..=31).map(char::from).collect();
        input.push_str("\u{7f}\"#%'*/:=?\\{[]^");

        let escaped = hive_escape(&input);
        let expected_controls: String = (0..=31).map(|byte| format!("%{byte:02X}")).collect();
        assert_eq!(
            escaped,
            format!("{expected_controls}%7F%22%23%25%27%2A%2F%3A%3D%3F%5C%7B%5B%5D%5E")
        );
        assert_eq!(hive_unescape(&escaped).as_deref(), Some(input.as_str()));
    }

    #[test]
    fn hive_escape_round_trips_unicode_and_reserved_characters() {
        let value = "payments/api%=é";
        assert_eq!(hive_escape(value), "payments%2Fapi%25%3Dé");
        assert_eq!(hive_unescape(&hive_escape(value)).as_deref(), Some(value));
        assert_eq!(hive_unescape("caf%C3%A9").as_deref(), Some("café"));
    }

    #[test]
    fn hive_unescape_rejects_malformed_or_non_utf8_escapes() {
        for value in ["%", "%2", "%GG", "%FF"] {
            assert_eq!(hive_unescape(value), None, "{value:?}");
        }
    }

    #[test]
    fn parses_hive_layout_from_the_right() {
        let parsed = parse_segment_object_key(
            "company/date=archive/%25/date=2026-08-14/time=1937/service=payments%2Fapi/instance=us-east-1%2Fi-0abc123/boot=abcd-4242/1786736220-3.bin.gz",
        );
        assert_eq!(parsed.layout, SegmentObjectKeyLayout::Hive);
        assert_eq!(parsed.prefix.as_deref(), Some("company/date=archive/%25"));
        assert_eq!(parsed.date.as_deref(), Some("2026-08-14"));
        assert_eq!(parsed.time.as_deref(), Some("1937"));
        assert_eq!(parsed.service.as_deref(), Some("payments/api"));
        assert_eq!(parsed.instance.as_deref(), Some("us-east-1/i-0abc123"));
        assert_eq!(parsed.boot_id.as_deref(), Some("abcd-4242"));
        assert_eq!(parsed.epoch_secs, Some(1_786_736_220));
        assert_eq!(parsed.segment_index, Some(3));
    }

    #[test]
    fn malformed_hive_field_does_not_hide_other_fields() {
        let parsed = parse_segment_object_key(
            "date=2026-08-14/time=1937/service=bad%2/instance=host%2Fone/boot=boot/1786736220-3.bin.gz",
        );
        assert_eq!(parsed.layout, SegmentObjectKeyLayout::Hive);
        assert_eq!(parsed.service, None);
        assert_eq!(parsed.instance.as_deref(), Some("host/one"));
        assert_eq!(parsed.boot_id.as_deref(), Some("boot"));
        assert_eq!(parsed.epoch_secs, Some(1_786_736_220));
    }

    #[test]
    fn parses_both_historical_layouts() {
        let current = parse_segment_object_key(
            "traces/2026-04-09/1910/service/host/boot/1744224000-3.bin.gz",
        );
        assert_eq!(current.layout, SegmentObjectKeyLayout::PositionalWithBoot);
        assert_eq!(current.prefix.as_deref(), Some("traces"));
        assert_eq!(current.service.as_deref(), Some("service"));
        assert_eq!(current.instance.as_deref(), Some("host"));
        assert_eq!(current.boot_id.as_deref(), Some("boot"));

        let legacy =
            parse_segment_object_key("traces/2026-04-09/1910/service/host/1744224000-3.bin.gz");
        assert_eq!(legacy.layout, SegmentObjectKeyLayout::PositionalWithoutBoot);
        assert_eq!(legacy.boot_id, None);
    }

    #[test]
    fn unknown_layout_keeps_filename_metadata() {
        let parsed = parse_segment_object_key("custom/path/1744224000-3.bin.gz");
        assert_eq!(parsed.layout, SegmentObjectKeyLayout::Unknown);
        assert_eq!(parsed.filename, "1744224000-3.bin.gz");
        assert_eq!(parsed.epoch_secs, Some(1_744_224_000));
        assert_eq!(parsed.segment_index, Some(3));
    }
}

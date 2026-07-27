pub const fn compacted_json_len(input: &str) -> usize {
    let bytes = input.as_bytes();
    let mut index = 0;
    let mut len = 0;
    let mut in_string = false;
    let mut escaped = false;

    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            len += 1;
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
        } else if byte == b'"' {
            in_string = true;
            len += 1;
        } else if !matches!(byte, b' ' | b'\t' | b'\n' | b'\r') {
            len += 1;
        }
        index += 1;
    }
    len
}

pub const fn compact_json<const N: usize>(input: &str) -> [u8; N] {
    let bytes = input.as_bytes();
    let mut output = [0; N];
    let mut input_index = 0;
    let mut output_index = 0;
    let mut in_string = false;
    let mut escaped = false;

    while input_index < bytes.len() {
        let byte = bytes[input_index];
        let keep = if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            true
        } else if byte == b'"' {
            in_string = true;
            true
        } else {
            !matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
        };

        if keep {
            output[output_index] = byte;
            output_index += 1;
        }
        input_index += 1;
    }
    assert!(output_index == N);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_json_whitespace_outside_strings() {
        const INPUT: &str = r#"
            {
              "text": " spaces \t and \"escapes\" stay ",
              "unicode": "🔥",
              "value": 1
            }
        "#;
        const LEN: usize = compacted_json_len(INPUT);
        const OUTPUT: [u8; LEN] = compact_json::<LEN>(INPUT);

        assert_eq!(
            std::str::from_utf8(&OUTPUT).unwrap(),
            r#"{"text":" spaces \t and \"escapes\" stay ","unicode":"🔥","value":1}"#
        );
    }
}

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FormatResponse {
    valid: bool,
    formatted: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    path: String,
    operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffResponse {
    valid: bool,
    pretty_left: String,
    pretty_right: String,
    error_left: Option<String>,
    error_right: Option<String>,
    changes: Vec<Change>,
    diff_object: String,
    left_highlights: BTreeMap<usize, String>,
    right_highlights: BTreeMap<usize, String>,
}

#[derive(Debug, Clone)]
struct RenderedLine {
    text: String,
    paths: Vec<String>,
}

fn parse_error(error: &serde_json::Error) -> String {
    if error.line() > 0 {
        format!(
            "{} (line {}, column {})",
            error,
            error.line(),
            error.column()
        )
    } else {
        error.to_string()
    }
}

fn is_simple_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) if first == '_' || first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn child_path(parent: &str, key: &str) -> String {
    if is_simple_key(key) {
        format!("{parent}.{key}")
    } else {
        let encoded = serde_json::to_string(key).unwrap_or_else(|_| format!("\"{key}\""));
        format!("{parent}[{encoded}]")
    }
}

fn value_literal(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn render_value(value: &Value, path: &str, depth: usize) -> Vec<RenderedLine> {
    let indent = "  ".repeat(depth);
    match value {
        Value::Object(object) => {
            let mut lines = vec![RenderedLine {
                text: format!("{indent}{{"),
                paths: vec![path.to_string()],
            }];

            let total = object.len();
            for (index, (key, child)) in object.iter().enumerate() {
                let next_path = child_path(path, key);
                let mut child_lines = render_value(child, &next_path, depth + 1);
                let child_indent = "  ".repeat(depth + 1);
                let first_content = child_lines[0]
                    .text
                    .strip_prefix(&child_indent)
                    .unwrap_or(&child_lines[0].text)
                    .to_string();
                let encoded_key =
                    serde_json::to_string(key).unwrap_or_else(|_| format!("\"{key}\""));
                child_lines[0].text = format!("{child_indent}{encoded_key}: {first_content}");
                if !child_lines[0].paths.contains(&next_path) {
                    child_lines[0].paths.push(next_path);
                }
                if index + 1 < total {
                    if let Some(last) = child_lines.last_mut() {
                        last.text.push(',');
                    }
                }
                lines.extend(child_lines);
            }

            lines.push(RenderedLine {
                text: format!("{indent}}}"),
                paths: vec![path.to_string()],
            });
            lines
        }
        Value::Array(array) => {
            let mut lines = vec![RenderedLine {
                text: format!("{indent}["),
                paths: vec![path.to_string()],
            }];

            for (index, child) in array.iter().enumerate() {
                let next_path = format!("{path}[{index}]");
                let mut child_lines = render_value(child, &next_path, depth + 1);
                if index + 1 < array.len() {
                    if let Some(last) = child_lines.last_mut() {
                        last.text.push(',');
                    }
                }
                lines.extend(child_lines);
            }

            lines.push(RenderedLine {
                text: format!("{indent}]"),
                paths: vec![path.to_string()],
            });
            lines
        }
        _ => vec![RenderedLine {
            text: format!("{indent}{}", value_literal(value)),
            paths: vec![path.to_string()],
        }],
    }
}

fn render_pretty(value: &Value) -> (String, BTreeMap<String, Vec<usize>>) {
    let lines = render_value(value, "$", 0);
    let mut line_map: BTreeMap<String, Vec<usize>> = BTreeMap::new();

    for (index, line) in lines.iter().enumerate() {
        for path in &line.paths {
            line_map.entry(path.clone()).or_default().push(index + 1);
        }
    }

    let text = lines
        .into_iter()
        .map(|line| line.text)
        .collect::<Vec<_>>()
        .join("\n");
    (text, line_map)
}

fn compare_values(left: &Value, right: &Value, path: &str, changes: &mut Vec<Change>) {
    if left == right {
        return;
    }

    match (left, right) {
        (Value::Object(left_object), Value::Object(right_object)) => {
            let keys: BTreeSet<&String> = left_object.keys().chain(right_object.keys()).collect();
            for key in keys {
                let next_path = child_path(path, key);
                match (left_object.get(key), right_object.get(key)) {
                    (Some(before), Some(after)) => {
                        compare_values(before, after, &next_path, changes);
                    }
                    (Some(before), None) => changes.push(Change {
                        path: next_path,
                        operation: "removed".to_string(),
                        before: Some(before.clone()),
                        after: None,
                    }),
                    (None, Some(after)) => changes.push(Change {
                        path: next_path,
                        operation: "added".to_string(),
                        before: None,
                        after: Some(after.clone()),
                    }),
                    (None, None) => {}
                }
            }
        }
        (Value::Array(left_array), Value::Array(right_array)) => {
            let max_length = left_array.len().max(right_array.len());
            for index in 0..max_length {
                let next_path = format!("{path}[{index}]");
                match (left_array.get(index), right_array.get(index)) {
                    (Some(before), Some(after)) => {
                        compare_values(before, after, &next_path, changes);
                    }
                    (Some(before), None) => changes.push(Change {
                        path: next_path,
                        operation: "removed".to_string(),
                        before: Some(before.clone()),
                        after: None,
                    }),
                    (None, Some(after)) => changes.push(Change {
                        path: next_path,
                        operation: "added".to_string(),
                        before: None,
                        after: Some(after.clone()),
                    }),
                    (None, None) => {}
                }
            }
        }
        _ => changes.push(Change {
            path: path.to_string(),
            operation: "changed".to_string(),
            before: Some(left.clone()),
            after: Some(right.clone()),
        }),
    }
}

fn mark_lines(
    line_map: &BTreeMap<String, Vec<usize>>,
    highlights: &mut BTreeMap<usize, String>,
    path: &str,
    style: &str,
) {
    if let Some(lines) = line_map.get(path) {
        for line in lines {
            highlights.insert(*line, style.to_string());
        }
    }
}

fn make_diff_object(changes: &[Change]) -> String {
    let mut counts = Map::new();
    for operation in ["added", "removed", "changed"] {
        let count = changes
            .iter()
            .filter(|change| change.operation == operation)
            .count();
        counts.insert(operation.to_string(), json!(count));
    }

    let object = json!({
        "equal": changes.is_empty(),
        "summary": {
            "total": changes.len(),
            "added": counts.get("added").cloned().unwrap_or(json!(0)),
            "removed": counts.get("removed").cloned().unwrap_or(json!(0)),
            "changed": counts.get("changed").cloned().unwrap_or(json!(0))
        },
        "changes": changes
    });

    serde_json::to_string_pretty(&object).unwrap_or_else(|_| "{}".to_string())
}

#[tauri::command]
fn format_json(input: String) -> FormatResponse {
    if input.trim().is_empty() {
        return FormatResponse {
            valid: false,
            formatted: String::new(),
            error: Some("Paste JSON or drop a .json file here".to_string()),
        };
    }

    match serde_json::from_str::<Value>(&input) {
        Ok(value) => {
            let (formatted, _) = render_pretty(&value);
            FormatResponse {
                valid: true,
                formatted,
                error: None,
            }
        }
        Err(error) => FormatResponse {
            valid: false,
            formatted: input,
            error: Some(parse_error(&error)),
        },
    }
}

#[tauri::command]
fn diff_json(left: String, right: String) -> DiffResponse {
    let left_value = serde_json::from_str::<Value>(&left);
    let right_value = serde_json::from_str::<Value>(&right);

    let error_left = left_value.as_ref().err().map(parse_error);
    let error_right = right_value.as_ref().err().map(parse_error);

    if error_left.is_some() || error_right.is_some() {
        return DiffResponse {
            valid: false,
            pretty_left: left,
            pretty_right: right,
            error_left,
            error_right,
            changes: Vec::new(),
            diff_object: String::new(),
            left_highlights: BTreeMap::new(),
            right_highlights: BTreeMap::new(),
        };
    }

    let left_value = left_value.expect("validated left JSON");
    let right_value = right_value.expect("validated right JSON");
    let (pretty_left, left_line_map) = render_pretty(&left_value);
    let (pretty_right, right_line_map) = render_pretty(&right_value);
    let mut changes = Vec::new();
    compare_values(&left_value, &right_value, "$", &mut changes);

    let mut left_highlights = BTreeMap::new();
    let mut right_highlights = BTreeMap::new();
    for change in &changes {
        match change.operation.as_str() {
            "added" => mark_lines(
                &right_line_map,
                &mut right_highlights,
                &change.path,
                "added",
            ),
            "removed" => mark_lines(
                &left_line_map,
                &mut left_highlights,
                &change.path,
                "removed",
            ),
            _ => {
                mark_lines(
                    &left_line_map,
                    &mut left_highlights,
                    &change.path,
                    "changed-before",
                );
                mark_lines(
                    &right_line_map,
                    &mut right_highlights,
                    &change.path,
                    "changed-after",
                );
            }
        }
    }

    let diff_object = make_diff_object(&changes);
    DiffResponse {
        valid: true,
        pretty_left,
        pretty_right,
        error_left: None,
        error_right: None,
        changes,
        diff_object,
        left_highlights,
        right_highlights,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![format_json, diff_json])
        .run(tauri::generate_context!())
        .expect("error while running JSON Diff");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_maps_nested_json() {
        let response = format_json(r#"{"user":{"name":"Ada"},"active":true}"#.to_string());
        assert!(response.valid);
        assert!(response.formatted.contains("\"name\": \"Ada\""));
    }

    #[test]
    fn formats_large_json_document() {
        let items: Vec<Value> = (0..300)
            .map(|index| {
                serde_json::json!({
                    "id": index,
                    "name": format!("Product {index}"),
                    "enabled": index % 2 == 0,
                    "price": index as f64 + 0.5,
                    "tags": ["json", "catalog", "test"]
                })
            })
            .collect();
        let input = serde_json::to_string(&serde_json::json!({
            "catalogKey": "catalog_g",
            "items": items
        }))
        .expect("large fixture should serialize");

        let response = format_json(input);

        assert!(response.valid);
        assert!(response.formatted.lines().count() > 3_000);
        assert!(response.formatted.contains("\"catalogKey\": \"catalog_g\""));
        assert!(response.formatted.contains("\"name\": \"Product 299\""));
    }

    #[test]
    fn detects_semantic_changes() {
        let response = diff_json(
            r#"{"age":29,"tags":["rust"]}"#.to_string(),
            r#"{"age":30,"tags":["rust","tauri"],"active":true}"#.to_string(),
        );
        assert!(response.valid);
        assert_eq!(response.changes.len(), 3);
        assert!(response.changes.iter().any(|change| change.path == "$.age"));
        assert!(response
            .changes
            .iter()
            .any(|change| change.path == "$.active"));
        assert!(!response.left_highlights.is_empty());
        assert!(!response.right_highlights.is_empty());
    }

    #[test]
    fn ignores_object_key_order() {
        let response = diff_json(
            r#"{"a":1,"b":2}"#.to_string(),
            r#"{"b":2,"a":1}"#.to_string(),
        );
        assert!(response.valid);
        assert!(response.changes.is_empty());
    }
}

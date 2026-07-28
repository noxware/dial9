//! Compile-time table bindings for `dial9-viewer-extension`.
//!
//! Users invoke the re-exported `dial9_viewer_extension::include_manifest!`
//! wrapper rather than depending on this crate directly.

use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::{format_ident, quote};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use syn::parse::{Parse, ParseStream};
use syn::{Ident, LitStr, Path, Token, parse_macro_input};

struct IncludeManifest {
    sdk: Path,
    path: LitStr,
}

impl Parse for IncludeManifest {
    fn parse(input: ParseStream<'_>) -> syn::Result<Self> {
        let sdk = input.parse()?;
        input.parse::<Token![,]>()?;
        let path = input.parse()?;
        if !input.is_empty() {
            return Err(input.error("unexpected tokens after manifest path"));
        }
        Ok(Self { sdk, path })
    }
}

/// Generate typed table bindings from a manifest read by the SDK wrapper.
#[proc_macro]
pub fn include_manifest(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as IncludeManifest);
    match expand_include_manifest(input) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.into_compile_error().into(),
    }
}

fn expand_include_manifest(input: IncludeManifest) -> syn::Result<TokenStream2> {
    let relative = PathBuf::from(input.path.value());
    if relative.is_absolute() {
        return Err(syn::Error::new(
            input.path.span(),
            "manifest path must be relative to CARGO_MANIFEST_DIR",
        ));
    }
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR").ok_or_else(|| {
        syn::Error::new(
            input.path.span(),
            "CARGO_MANIFEST_DIR is unavailable while expanding manifest",
        )
    })?;
    let source_path = PathBuf::from(manifest_dir).join(&relative);
    let source = std::fs::read_to_string(&source_path).map_err(|error| {
        syn::Error::new(
            input.path.span(),
            format!("failed to read manifest {}: {error}", source_path.display()),
        )
    })?;
    generate(&input.sdk, &input.path, &source)
}

#[derive(Clone, Copy)]
enum ColumnKind {
    F64,
    I64,
    U64,
    U32,
    U8,
    Utf8,
}

impl ColumnKind {
    fn parse(value: &str, span: Span, path: &str) -> syn::Result<Self> {
        match value {
            "f64" => Ok(Self::F64),
            "i64" => Ok(Self::I64),
            "u64" => Ok(Self::U64),
            "u32" => Ok(Self::U32),
            "u8" => Ok(Self::U8),
            "utf8" => Ok(Self::Utf8),
            _ => Err(schema_error(
                span,
                path,
                format!("unsupported column type {value:?}"),
            )),
        }
    }

    fn rust_type(self) -> TokenStream2 {
        match self {
            Self::F64 => quote!(f64),
            Self::I64 => quote!(i64),
            Self::U64 => quote!(u64),
            Self::U32 => quote!(u32),
            Self::U8 => quote!(u8),
            Self::Utf8 => quote!(str),
        }
    }

    fn column_variant(self) -> Ident {
        Ident::new(
            match self {
                Self::F64 => "F64",
                Self::I64 => "I64",
                Self::U64 => "U64",
                Self::U32 => "U32",
                Self::U8 => "U8",
                Self::Utf8 => "Utf8",
            },
            Span::call_site(),
        )
    }
}

struct ManifestColumn {
    name: String,
    ident: Ident,
    kind: ColumnKind,
    nullable: bool,
}

struct ManifestTable {
    index: u32,
    name: String,
    ident: Ident,
    columns: Vec<ManifestColumn>,
}

fn generate(sdk: &Path, path: &LitStr, source: &str) -> syn::Result<TokenStream2> {
    let json: Value = serde_json::from_str(source).map_err(|error| {
        syn::Error::new(path.span(), format!("manifest is not valid JSON: {error}"))
    })?;
    let tables = parse_tables(&json, path.span())?;
    let table_modules = tables
        .iter()
        .map(|table| generate_table(sdk, table))
        .collect::<Vec<_>>();

    Ok(quote! {
        #sdk::manifest!(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/",
            #path
        )));

        /// Typed output tables generated from the viewer extension manifest.
        #[allow(missing_docs, non_snake_case)]
        pub mod tables {
            #(#table_modules)*
        }
    })
}

fn parse_tables(json: &Value, span: Span) -> syn::Result<Vec<ManifestTable>> {
    let root = json
        .as_object()
        .ok_or_else(|| schema_error(span, "manifest", "must be an object"))?;
    if root.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(schema_error(span, "manifest.version", "must be 1"));
    }
    let raw_tables = root
        .get("tables")
        .and_then(Value::as_array)
        .ok_or_else(|| schema_error(span, "manifest.tables", "must be an array"))?;
    let mut table_names = HashSet::new();
    let mut tables = Vec::with_capacity(raw_tables.len());

    for (table_index, raw_table) in raw_tables.iter().enumerate() {
        let path = format!("manifest.tables[{table_index}]");
        let table = raw_table
            .as_object()
            .ok_or_else(|| schema_error(span, &path, "must be an object"))?;
        let name = table
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| schema_error(span, format!("{path}.name"), "must be a string"))?;
        if !table_names.insert(name.to_owned()) {
            return Err(schema_error(
                span,
                format!("{path}.name"),
                format!("duplicate table name {name:?}"),
            ));
        }
        let ident = rust_ident(name, span, &format!("{path}.name"))?;
        let raw_columns = table
            .get("columns")
            .and_then(Value::as_array)
            .ok_or_else(|| schema_error(span, format!("{path}.columns"), "must be an array"))?;
        if raw_columns.is_empty() {
            return Err(schema_error(
                span,
                format!("{path}.columns"),
                "must not be empty",
            ));
        }
        let mut column_names = HashSet::new();
        let mut columns = Vec::with_capacity(raw_columns.len());
        for (column_index, raw_column) in raw_columns.iter().enumerate() {
            let column_path = format!("{path}.columns[{column_index}]");
            let column = raw_column
                .as_object()
                .ok_or_else(|| schema_error(span, &column_path, "must be an object"))?;
            let name = column.get("name").and_then(Value::as_str).ok_or_else(|| {
                schema_error(span, format!("{column_path}.name"), "must be a string")
            })?;
            if !column_names.insert(name.to_owned()) {
                return Err(schema_error(
                    span,
                    format!("{column_path}.name"),
                    format!("duplicate column name {name:?}"),
                ));
            }
            let ident = rust_ident(name, span, &format!("{column_path}.name"))?;
            let kind_name = column.get("type").and_then(Value::as_str).ok_or_else(|| {
                schema_error(span, format!("{column_path}.type"), "must be a string")
            })?;
            let kind = ColumnKind::parse(kind_name, span, &format!("{column_path}.type"))?;
            let nullable = match column.get("nullable") {
                None => false,
                Some(Value::Bool(nullable)) => *nullable,
                Some(_) => {
                    return Err(schema_error(
                        span,
                        format!("{column_path}.nullable"),
                        "must be a boolean",
                    ));
                }
            };
            columns.push(ManifestColumn {
                name: name.to_owned(),
                ident,
                kind,
                nullable,
            });
        }
        let index = u32::try_from(table_index)
            .map_err(|_| schema_error(span, &path, "table index exceeds u32::MAX"))?;
        tables.push(ManifestTable {
            index,
            name: name.to_owned(),
            ident,
            columns,
        });
    }
    Ok(tables)
}

fn rust_ident(name: &str, span: Span, path: &str) -> syn::Result<Ident> {
    if let Ok(ident) = syn::parse_str(name) {
        return Ok(ident);
    }
    if is_raw_identifier(name) {
        return Ok(Ident::new_raw(name, span));
    }
    Err(schema_error(
        span,
        path,
        format!("{name:?} must be a valid Rust identifier"),
    ))
}

fn is_raw_identifier(name: &str) -> bool {
    matches!(
        name,
        "as" | "async"
            | "await"
            | "become"
            | "box"
            | "break"
            | "const"
            | "continue"
            | "do"
            | "dyn"
            | "else"
            | "enum"
            | "extern"
            | "false"
            | "final"
            | "fn"
            | "for"
            | "gen"
            | "if"
            | "impl"
            | "in"
            | "let"
            | "loop"
            | "macro"
            | "match"
            | "mod"
            | "move"
            | "mut"
            | "override"
            | "priv"
            | "pub"
            | "ref"
            | "return"
            | "static"
            | "struct"
            | "trait"
            | "true"
            | "try"
            | "type"
            | "typeof"
            | "union"
            | "unsafe"
            | "unsized"
            | "use"
            | "virtual"
            | "where"
            | "while"
            | "yield"
    )
}

fn schema_error(span: Span, path: impl AsRef<str>, message: impl AsRef<str>) -> syn::Error {
    syn::Error::new(span, format!("{} {}", path.as_ref(), message.as_ref()))
}

fn generate_table(sdk: &Path, table: &ManifestTable) -> TokenStream2 {
    let table_ident = &table.ident;
    let table_name = &table.name;
    let table_index = table.index;
    let has_utf8 = table
        .columns
        .iter()
        .any(|column| matches!(column.kind, ColumnKind::Utf8));
    let has_nullable = table.columns.iter().any(|column| column.nullable);

    let row_lifetime = has_utf8.then(|| quote!(<'a>));
    let row_use_lifetime = has_utf8.then(|| quote!(<'_>));
    let row_fields = table.columns.iter().map(|column| {
        let ident = &column.ident;
        let ty = if matches!(column.kind, ColumnKind::Utf8) {
            quote!(&'a str)
        } else {
            column.kind.rust_type()
        };
        if column.nullable {
            quote!(pub #ident: ::core::option::Option<#ty>)
        } else {
            quote!(pub #ident: #ty)
        }
    });

    let mut batch_fields = Vec::new();
    let mut init_prelude = Vec::new();
    let mut batch_initializers = Vec::new();
    let mut push_preflight = Vec::new();
    let mut push_columns = Vec::new();
    let mut emit_columns = Vec::new();

    for (column_index, column) in table.columns.iter().enumerate() {
        let row_field = &column.ident;
        let values = format_ident!("column_{column_index}_values");
        let validity = format_ident!("column_{column_index}_validity");
        let offsets = format_ident!("column_{column_index}_offsets");
        let data = format_ident!("column_{column_index}_data");
        let bytes = format_ident!("column_{column_index}_bytes");
        let end = format_ident!("column_{column_index}_end");
        let present = format_ident!("column_{column_index}_present");
        let variant = column.kind.column_variant();
        let column_name = &column.name;

        if matches!(column.kind, ColumnKind::Utf8) {
            batch_fields.push(quote! {
                #offsets: ::std::vec::Vec<u32>,
                #data: ::std::vec::Vec<u8>
            });
            init_prelude.push(quote! {
                let mut #offsets = ::std::vec::Vec::with_capacity(
                    capacity.saturating_add(1)
                );
                #offsets.push(0);
            });
            batch_initializers.push(quote!(#offsets));
            batch_initializers.push(quote!(#data: ::std::vec::Vec::new()));

            if column.nullable {
                batch_fields.push(quote!(#validity: ::std::vec::Vec<u8>));
                batch_initializers.push(quote! {
                    #validity: ::std::vec::Vec::with_capacity(capacity.div_ceil(8))
                });
                push_preflight.push(quote! {
                    let #bytes = row.#row_field.map(str::as_bytes);
                    let #end = self.#data
                        .len()
                        .checked_add(#bytes.map_or(0, |bytes| bytes.len()))
                        .and_then(|len| u32::try_from(len).ok())
                        .ok_or_else(|| #sdk::OutputError::new(concat!(
                            "table ",
                            #table_name,
                            " column ",
                            #column_name,
                            " exceeds u32::MAX UTF-8 bytes"
                        )))?;
                });
                push_columns.push(quote! {
                    let #present = #bytes.is_some();
                    if let ::core::option::Option::Some(bytes) = #bytes {
                        self.#data.extend_from_slice(bytes);
                    }
                    self.#offsets.push(#end);
                    push_validity(&mut self.#validity, self.rows, #present);
                });
            } else {
                push_preflight.push(quote! {
                    let #bytes = row.#row_field.as_bytes();
                    let #end = self.#data
                        .len()
                        .checked_add(#bytes.len())
                        .and_then(|len| u32::try_from(len).ok())
                        .ok_or_else(|| #sdk::OutputError::new(concat!(
                            "table ",
                            #table_name,
                            " column ",
                            #column_name,
                            " exceeds u32::MAX UTF-8 bytes"
                        )))?;
                });
                push_columns.push(quote! {
                    self.#data.extend_from_slice(#bytes);
                    self.#offsets.push(#end);
                });
            }

            let validity_value = if column.nullable {
                quote!(::core::option::Option::Some(::core::mem::take(
                    &mut self.#validity
                )))
            } else {
                quote!(::core::option::Option::None)
            };
            emit_columns.push(quote! {
                #sdk::Column::#variant {
                    offsets: ::core::mem::replace(
                        &mut self.#offsets,
                        ::std::vec![0],
                    ),
                    data: ::core::mem::take(&mut self.#data),
                    validity: #validity_value,
                }
            });
            continue;
        }

        let ty = column.kind.rust_type();
        batch_fields.push(quote!(#values: ::std::vec::Vec<#ty>));
        batch_initializers.push(quote! {
            #values: ::std::vec::Vec::with_capacity(capacity)
        });
        if column.nullable {
            batch_fields.push(quote!(#validity: ::std::vec::Vec<u8>));
            batch_initializers.push(quote! {
                #validity: ::std::vec::Vec::with_capacity(capacity.div_ceil(8))
            });
            push_columns.push(quote! {
                let #present = row.#row_field.is_some();
                self.#values.push(row.#row_field.unwrap_or_default());
                push_validity(&mut self.#validity, self.rows, #present);
            });
        } else {
            push_columns.push(quote!(self.#values.push(row.#row_field);));
        }
        let validity_value = if column.nullable {
            quote!(::core::option::Option::Some(::core::mem::take(
                &mut self.#validity
            )))
        } else {
            quote!(::core::option::Option::None)
        };
        emit_columns.push(quote! {
            #sdk::Column::#variant {
                values: ::core::mem::take(&mut self.#values),
                validity: #validity_value,
            }
        });
    }

    let validity_helper = has_nullable.then(|| {
        quote! {
            fn push_validity(validity: &mut ::std::vec::Vec<u8>, row: usize, present: bool) {
                if row % 8 == 0 {
                    validity.push(0);
                }
                if present {
                    let last = validity
                        .last_mut()
                        .expect("validity byte was added for this row");
                    *last |= 1 << (row % 8);
                }
            }
        }
    });

    quote! {
        #[doc = concat!("Bindings for the manifest table `", #table_name, "`.")]
        pub mod #table_ident {
            /// Positional identifier used by the viewer extension ABI.
            pub const ID: #sdk::TableId = #sdk::TableId::new(#table_index);

            /// One row accepted by this table's generated batch.
            #[derive(Debug, Clone, Copy, PartialEq)]
            pub struct Row #row_lifetime {
                #(#row_fields,)*
            }

            /// Typed column buffers for this manifest table.
            #[derive(Debug)]
            pub struct Batch {
                rows: usize,
                #(#batch_fields,)*
            }

            impl Batch {
                pub fn new() -> Self {
                    Self::with_capacity(0)
                }

                pub fn with_capacity(capacity: usize) -> Self {
                    #(#init_prelude)*
                    Self {
                        rows: 0,
                        #(#batch_initializers,)*
                    }
                }

                pub fn len(&self) -> usize {
                    self.rows
                }

                pub fn is_empty(&self) -> bool {
                    self.rows == 0
                }

                pub fn push(
                    &mut self,
                    row: Row #row_use_lifetime,
                ) -> ::core::result::Result<(), #sdk::OutputError> {
                    if self.rows == u32::MAX as usize {
                        return ::core::result::Result::Err(
                            #sdk::OutputError::new(concat!(
                                "table ",
                                #table_name,
                                " exceeds u32::MAX rows"
                            ))
                        );
                    }
                    #(#push_preflight)*
                    #(#push_columns)*
                    self.rows += 1;
                    ::core::result::Result::Ok(())
                }

                pub fn emit(
                    &mut self,
                    output: &mut #sdk::OutputSink<'_>,
                ) -> ::core::result::Result<(), #sdk::OutputError> {
                    if self.is_empty() {
                        return ::core::result::Result::Ok(());
                    }
                    let columns = ::std::vec![
                        #(#emit_columns,)*
                    ];
                    self.rows = 0;
                    output.emit(ID, columns)
                }
            }

            impl ::core::default::Default for Batch {
                fn default() -> Self {
                    Self::new()
                }
            }

            #validity_helper
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quote::quote;

    #[test]
    fn generates_typed_rows_and_batches_for_every_column_shape() {
        let source = r#"
        {
          "version": 1,
          "tables": [{
            "name": "samples",
            "columns": [
              { "name": "timestamp_ns", "type": "u64" },
              { "name": "value", "type": "f64", "nullable": true },
              { "name": "label", "type": "utf8" },
              { "name": "note", "type": "utf8", "nullable": true },
              { "name": "type", "type": "u8" }
            ]
          }],
          "panels": []
        }
        "#;
        let tokens = generate(
            &syn::parse2(quote!(::dial9_viewer_extension)).unwrap(),
            &LitStr::new("manifest.json", Span::call_site()),
            source,
        )
        .unwrap();
        syn::parse2::<syn::File>(tokens.clone()).unwrap();
        let expanded = tokens.to_string();
        assert!(expanded.contains("pub mod samples"));
        assert!(expanded.contains("pub timestamp_ns : u64"));
        assert!(expanded.contains("pub value : :: core :: option :: Option < f64 >"));
        assert!(expanded.contains("pub label : & 'a str"));
        assert!(expanded.contains("pub note : :: core :: option :: Option < & 'a str >"));
        assert!(expanded.contains("pub r#type : u8"));
        assert!(expanded.contains("Column :: Utf8"));
    }

    #[test]
    fn rejects_names_that_cannot_be_rust_bindings() {
        let error = generate(
            &syn::parse2(quote!(::dial9_viewer_extension)).unwrap(),
            &LitStr::new("manifest.json", Span::call_site()),
            r#"{
              "version": 1,
              "tables": [{
                "name": "not-a-module",
                "columns": [{ "name": "value", "type": "u8" }]
              }],
              "panels": []
            }"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("valid Rust identifier"));
    }
}

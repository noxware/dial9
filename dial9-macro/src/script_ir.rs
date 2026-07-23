use proc_macro2::TokenStream;
use quote::quote;
use syn::parse::{Parse, ParseStream};
use syn::spanned::Spanned;
use syn::{
    Block, Expr, ExprAssign, ExprBreak, ExprCall, ExprContinue, ExprForLoop, ExprIf, ExprLit,
    ExprPath, ExprUnary, Lit, Local, Pat, PatIdent, Path, Stmt, UnOp,
};

pub(crate) struct Script {
    statements: Vec<Stmt>,
}

impl Parse for Script {
    fn parse(input: ParseStream<'_>) -> syn::Result<Self> {
        Ok(Self {
            statements: Block::parse_within(input)?,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SExpr {
    Atom(String),
    List(Vec<SExpr>),
}

impl SExpr {
    fn atom(value: impl Into<String>) -> Self {
        Self::Atom(value.into())
    }

    fn invoke(operation: impl Into<String>, arguments: Vec<Self>) -> Self {
        let operation = Self::atom(operation);
        if arguments.is_empty() {
            operation
        } else {
            Self::List(std::iter::once(operation).chain(arguments).collect())
        }
    }

    fn into_tokens(self) -> TokenStream {
        match self {
            Self::Atom(value) => quote! {
                ::dial9::script::SExpr::Atom(::std::string::String::from(#value))
            },
            Self::List(values) => {
                let values = values.into_iter().map(Self::into_tokens);
                quote! {
                    ::dial9::script::SExpr::List(::std::vec![#(#values),*])
                }
            }
        }
    }
}

pub(crate) fn expand(script: Script) -> syn::Result<TokenStream> {
    lower_body(&script.statements, proc_macro2::Span::call_site()).map(SExpr::into_tokens)
}

fn lower_body(statements: &[Stmt], span: proc_macro2::Span) -> syn::Result<SExpr> {
    let expressions = statements
        .iter()
        .map(lower_statement)
        .collect::<syn::Result<Vec<_>>>()?;

    match expressions.len() {
        0 => Err(syn::Error::new(span, "Script IR blocks cannot be empty")),
        1 => Ok(expressions.into_iter().next().expect("length checked")),
        _ => Ok(SExpr::List(expressions)),
    }
}

fn lower_statement(statement: &Stmt) -> syn::Result<SExpr> {
    match statement {
        Stmt::Local(local) => lower_local(local),
        Stmt::Expr(expression, _) => lower_expression(expression),
        Stmt::Item(item) => Err(syn::Error::new_spanned(
            item,
            "items are not supported in Dial9 scripts",
        )),
        Stmt::Macro(statement_macro) => Err(syn::Error::new_spanned(
            statement_macro,
            "macros are not supported in Dial9 scripts",
        )),
    }
}

fn lower_local(local: &Local) -> syn::Result<SExpr> {
    let name = binding_name(&local.pat, "let bindings must use a single identifier")?;
    let initializer = local.init.as_ref().ok_or_else(|| {
        syn::Error::new_spanned(local, "Dial9 script bindings require an initializer")
    })?;

    if let Some((_, diverge)) = &initializer.diverge {
        return Err(syn::Error::new_spanned(
            diverge,
            "let-else is not supported in Dial9 scripts",
        ));
    }

    Ok(SExpr::invoke(
        "var.let",
        vec![SExpr::atom(name), lower_value(&initializer.expr)?],
    ))
}

fn lower_expression(expression: &Expr) -> syn::Result<SExpr> {
    match expression {
        Expr::Assign(assign) => lower_assignment(assign),
        Expr::Break(expr_break) => lower_break(expr_break),
        Expr::Continue(expr_continue) => lower_continue(expr_continue),
        Expr::ForLoop(for_loop) => lower_for_loop(for_loop),
        Expr::If(expr_if) => lower_if(expr_if),
        Expr::Paren(paren) => lower_expression(&paren.expr),
        Expr::Group(group) => lower_expression(&group.expr),
        _ => lower_value(expression),
    }
}

fn lower_value(expression: &Expr) -> syn::Result<SExpr> {
    match expression {
        Expr::Call(call) => lower_call(call),
        Expr::Lit(literal) => lower_literal(literal),
        Expr::Path(path) => lower_path_value(path),
        Expr::Unary(unary) => lower_unary_literal(unary),
        Expr::Paren(paren) => lower_value(&paren.expr),
        Expr::Group(group) => lower_value(&group.expr),
        Expr::Assign(_)
        | Expr::Block(_)
        | Expr::Break(_)
        | Expr::Continue(_)
        | Expr::ForLoop(_)
        | Expr::If(_) => Err(syn::Error::new_spanned(
            expression,
            "this Script IR construct does not produce a value",
        )),
        _ => Err(syn::Error::new_spanned(
            expression,
            "unsupported Rust expression in Dial9 script",
        )),
    }
}

fn lower_call(call: &ExprCall) -> syn::Result<SExpr> {
    let Expr::Path(function) = call.func.as_ref() else {
        return Err(syn::Error::new_spanned(
            &call.func,
            "Dial9 script invokes must use a function path",
        ));
    };
    let operation = operation_name(function)?;
    let arguments = call
        .args
        .iter()
        .map(lower_value)
        .collect::<syn::Result<Vec<_>>>()?;

    Ok(SExpr::invoke(operation, arguments))
}

fn lower_path_value(path: &ExprPath) -> syn::Result<SExpr> {
    let segments = path_segments(path)?;
    match segments.as_slice() {
        [name] if name == "null" => Ok(SExpr::atom("null.const")),
        [name] => Ok(SExpr::invoke("var.get", vec![SExpr::atom(name)])),
        _ => Ok(SExpr::atom(segments.join("."))),
    }
}

fn lower_literal(expression: &ExprLit) -> syn::Result<SExpr> {
    match &expression.lit {
        Lit::Bool(value) => Ok(SExpr::atom(if value.value {
            "bool.true"
        } else {
            "bool.false"
        })),
        Lit::Float(value) => {
            reject_suffix(value.suffix(), value)?;
            Ok(SExpr::invoke(
                "float.const",
                vec![SExpr::atom(normalize_number(value.to_string()))],
            ))
        }
        Lit::Int(value) => {
            reject_suffix(value.suffix(), value)?;
            let value = value.to_string();
            if value.starts_with("0x") || value.starts_with("0o") || value.starts_with("0b") {
                return Err(syn::Error::new_spanned(
                    expression,
                    "integer literals must use decimal notation",
                ));
            }
            Ok(SExpr::invoke(
                "integer.const",
                vec![SExpr::atom(normalize_number(value))],
            ))
        }
        Lit::Str(value) => Ok(SExpr::invoke(
            "string.const",
            vec![SExpr::atom(value.value())],
        )),
        _ => Err(syn::Error::new_spanned(
            expression,
            "only bool, float, integer, and string literals are supported",
        )),
    }
}

fn lower_unary_literal(unary: &ExprUnary) -> syn::Result<SExpr> {
    if !matches!(unary.op, UnOp::Neg(_)) {
        return Err(syn::Error::new_spanned(
            unary,
            "Rust operators are not supported; use a typed Script IR invoke",
        ));
    }

    let Expr::Lit(literal) = unary.expr.as_ref() else {
        return Err(syn::Error::new_spanned(
            unary,
            "negation is only supported as part of a numeric literal",
        ));
    };

    let (operation, value) = match &literal.lit {
        Lit::Float(value) => {
            reject_suffix(value.suffix(), value)?;
            ("float.const", normalize_number(value.to_string()))
        }
        Lit::Int(value) => {
            reject_suffix(value.suffix(), value)?;
            let value = value.to_string();
            if value.starts_with("0x") || value.starts_with("0o") || value.starts_with("0b") {
                return Err(syn::Error::new_spanned(
                    unary,
                    "integer literals must use decimal notation",
                ));
            }
            ("integer.const", normalize_number(value))
        }
        _ => {
            return Err(syn::Error::new_spanned(
                unary,
                "negation is only supported as part of a numeric literal",
            ));
        }
    };

    Ok(SExpr::invoke(
        operation,
        vec![SExpr::atom(format!("-{value}"))],
    ))
}

fn reject_suffix(suffix: &str, value: impl quote::ToTokens) -> syn::Result<()> {
    if suffix.is_empty() {
        Ok(())
    } else {
        Err(syn::Error::new_spanned(
            value,
            "Rust numeric suffixes are not part of Dial9 Script IR",
        ))
    }
}

fn normalize_number(value: String) -> String {
    value.replace('_', "")
}

fn lower_assignment(assign: &ExprAssign) -> syn::Result<SExpr> {
    let Expr::Path(target) = assign.left.as_ref() else {
        return Err(syn::Error::new_spanned(
            &assign.left,
            "assignment targets must be a single variable",
        ));
    };
    let name = single_identifier(target, "assignment targets must be a single variable")?;

    Ok(SExpr::invoke(
        "var.set",
        vec![SExpr::atom(name), lower_value(&assign.right)?],
    ))
}

fn lower_if(expr_if: &ExprIf) -> syn::Result<SExpr> {
    let mut arguments = vec![
        lower_value(&expr_if.cond)?,
        lower_body(&expr_if.then_branch.stmts, expr_if.then_branch.span())?,
    ];
    lower_else_branch(expr_if.else_branch.as_ref(), &mut arguments)?;
    Ok(SExpr::invoke("case", arguments))
}

fn lower_else_branch(
    branch: Option<&(syn::token::Else, Box<Expr>)>,
    arguments: &mut Vec<SExpr>,
) -> syn::Result<()> {
    let Some((_, expression)) = branch else {
        return Ok(());
    };

    match expression.as_ref() {
        Expr::If(expr_if) => {
            arguments.push(lower_value(&expr_if.cond)?);
            arguments.push(lower_body(
                &expr_if.then_branch.stmts,
                expr_if.then_branch.span(),
            )?);
            lower_else_branch(expr_if.else_branch.as_ref(), arguments)
        }
        Expr::Block(block) => {
            arguments.push(SExpr::atom("bool.true"));
            arguments.push(lower_body(&block.block.stmts, block.block.span())?);
            Ok(())
        }
        _ => Err(syn::Error::new_spanned(
            expression,
            "else branches must contain a block or another if",
        )),
    }
}

fn lower_for_loop(for_loop: &ExprForLoop) -> syn::Result<SExpr> {
    if let Some(label) = &for_loop.label {
        return Err(syn::Error::new_spanned(
            label,
            "loop labels are not supported in Dial9 scripts",
        ));
    }
    let (item, index) = loop_bindings(&for_loop.pat)?;

    Ok(SExpr::invoke(
        "for_each",
        vec![
            SExpr::atom(item),
            SExpr::atom(index),
            lower_value(&for_loop.expr)?,
            lower_body(&for_loop.body.stmts, for_loop.body.span())?,
        ],
    ))
}

fn loop_bindings(pattern: &Pat) -> syn::Result<(String, String)> {
    let Pat::Tuple(tuple) = pattern else {
        return Err(syn::Error::new_spanned(
            pattern,
            "for loops must bind `(item, index)`",
        ));
    };
    if tuple.elems.len() != 2 {
        return Err(syn::Error::new_spanned(
            pattern,
            "for loops must bind exactly `(item, index)`",
        ));
    }

    let item = binding_name(&tuple.elems[0], "the item binding must be an identifier")?;
    let index = binding_name(&tuple.elems[1], "the index binding must be an identifier")?;
    Ok((item, index))
}

fn lower_break(expr_break: &ExprBreak) -> syn::Result<SExpr> {
    if expr_break.label.is_some() || expr_break.expr.is_some() {
        return Err(syn::Error::new_spanned(
            expr_break,
            "loop.break does not accept a label or value",
        ));
    }
    Ok(SExpr::atom("loop.break"))
}

fn lower_continue(expr_continue: &ExprContinue) -> syn::Result<SExpr> {
    if expr_continue.label.is_some() {
        return Err(syn::Error::new_spanned(
            expr_continue,
            "loop.continue does not accept a label",
        ));
    }
    Ok(SExpr::atom("loop.continue"))
}

fn binding_name(pattern: &Pat, message: &str) -> syn::Result<String> {
    let Pat::Ident(PatIdent {
        by_ref: None,
        ident,
        subpat: None,
        ..
    }) = pattern
    else {
        return Err(syn::Error::new_spanned(pattern, message));
    };
    variable_name(ident.to_string(), pattern)
}

fn single_identifier(path: &ExprPath, message: &str) -> syn::Result<String> {
    let segments = path_segments(path)?;
    match segments.as_slice() {
        [name] => variable_name(name.clone(), path),
        _ => Err(syn::Error::new_spanned(path, message)),
    }
}

fn variable_name(name: String, span: impl quote::ToTokens) -> syn::Result<String> {
    if name == "null" {
        Err(syn::Error::new_spanned(
            span,
            "`null` is a reserved Dial9 script literal",
        ))
    } else {
        Ok(name)
    }
}

fn operation_name(path: &ExprPath) -> syn::Result<String> {
    Ok(path_segments(path)?.join("."))
}

fn path_segments(path: &ExprPath) -> syn::Result<Vec<String>> {
    if path.qself.is_some() {
        return Err(syn::Error::new_spanned(
            path,
            "qualified Rust paths are not supported in Dial9 scripts",
        ));
    }
    path_components(&path.path)
}

fn path_components(path: &Path) -> syn::Result<Vec<String>> {
    if path.leading_colon.is_some() {
        return Err(syn::Error::new_spanned(
            path,
            "absolute Rust paths are not supported in Dial9 scripts",
        ));
    }
    path.segments
        .iter()
        .map(|segment| {
            if !matches!(segment.arguments, syn::PathArguments::None) {
                return Err(syn::Error::new_spanned(
                    segment,
                    "generic arguments are not supported in Dial9 script invokes",
                ));
            }
            Ok(segment.ident.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use quote::quote;

    fn lower(input: TokenStream) -> syn::Result<SExpr> {
        let script: Script = syn::parse2(input)?;
        lower_body(&script.statements, proc_macro2::Span::call_site())
    }

    #[test]
    fn rejects_rust_binary_operators() {
        let error = lower(quote! { left + right }).expect_err("operator should be rejected");
        assert!(error.to_string().contains("unsupported Rust expression"));
    }

    #[test]
    fn rejects_empty_blocks() {
        let error = lower(quote! {}).expect_err("empty block should be rejected");
        assert!(error.to_string().contains("cannot be empty"));
    }

    #[test]
    fn rejects_control_flow_in_value_position() {
        let error = lower(quote! {
            let value = if bool::is(candidate) { do_something(); };
        })
        .expect_err("control flow should not produce a value");
        assert!(error.to_string().contains("does not produce a value"));
    }

    #[test]
    fn rejects_null_as_a_binding_name() {
        let error = lower(quote! { let null = 1; }).expect_err("null should be reserved");
        assert!(error.to_string().contains("reserved"));
    }
}

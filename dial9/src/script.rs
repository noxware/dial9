/// A Dial9 Script IR S-expression.
///
/// Atoms represent both zero-argument invokes and literal payloads. Lists
/// represent invokes with arguments or blocks where the surrounding operation
/// expects a body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SExpr {
    Atom(String),
    List(Vec<SExpr>),
}

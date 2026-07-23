use dial9::script::SExpr;

fn atom(value: &str) -> SExpr {
    SExpr::Atom(value.to_owned())
}

fn list(values: impl IntoIterator<Item = SExpr>) -> SExpr {
    SExpr::List(values.into_iter().collect())
}

#[test]
fn translates_literals_variables_and_invokes() {
    let actual = dial9::script! {
        let count = 1_000;
        let ratio = -1.5;
        let label = "CPU";
        let missing = null;
        let cpu_time = computed::cpu_time;
        count = integer::add(count, 2);
        diagnostic::warn(string::from(label));
        map::new();
    };

    assert_eq!(
        actual,
        list([
            list([
                atom("var.let"),
                atom("count"),
                list([atom("integer.const"), atom("1000")])
            ]),
            list([
                atom("var.let"),
                atom("ratio"),
                list([atom("float.const"), atom("-1.5")])
            ]),
            list([
                atom("var.let"),
                atom("label"),
                list([atom("string.const"), atom("CPU")])
            ]),
            list([atom("var.let"), atom("missing"), atom("null.const")]),
            list([atom("var.let"), atom("cpu_time"), atom("computed.cpu_time")]),
            list([
                atom("var.set"),
                atom("count"),
                list([
                    atom("integer.add"),
                    list([atom("var.get"), atom("count")]),
                    list([atom("integer.const"), atom("2")]),
                ]),
            ]),
            list([
                atom("diagnostic.warn"),
                list([atom("string.from"), list([atom("var.get"), atom("label")]),]),
            ]),
            atom("map.new"),
        ])
    );
}

#[test]
fn preserves_canonical_single_invoke_representation() {
    assert_eq!(dial9::script! { map::new() }, atom("map.new"));

    let actual = dial9::script! {
        integer::add(
            map::get(event, "user_cpu_ns"),
            map::get(event, "system_cpu_ns"),
        )
    };

    assert_eq!(
        actual,
        list([
            atom("integer.add"),
            list([
                atom("map.get"),
                list([atom("var.get"), atom("event")]),
                list([atom("string.const"), atom("user_cpu_ns")]),
            ]),
            list([
                atom("map.get"),
                list([atom("var.get"), atom("event")]),
                list([atom("string.const"), atom("system_cpu_ns")]),
            ]),
        ])
    );
}

#[test]
fn translates_case_and_for_each_control_flow() {
    let actual = dial9::script! {
        for (event, index) in dial9::events {
            let copy = event;
            if null::is(event) {
                continue;
            } else if cmp::gte(index, integer::zero) {
                consume(event, true);
            } else {
                break;
            }
        }
    };

    assert_eq!(
        actual,
        list([
            atom("for_each"),
            atom("event"),
            atom("index"),
            atom("dial9.events"),
            list([
                list([
                    atom("var.let"),
                    atom("copy"),
                    list([atom("var.get"), atom("event")]),
                ]),
                list([
                    atom("case"),
                    list([atom("null.is"), list([atom("var.get"), atom("event")]),]),
                    atom("loop.continue"),
                    list([
                        atom("cmp.gte"),
                        list([atom("var.get"), atom("index")]),
                        atom("integer.zero"),
                    ]),
                    list([
                        atom("consume"),
                        list([atom("var.get"), atom("event")]),
                        atom("bool.true"),
                    ]),
                    atom("bool.true"),
                    atom("loop.break"),
                ]),
            ]),
        ])
    );
}

//! Deterministic representative selection for one capture's sibling callchains.

use super::{Frame, Stack};

#[derive(Debug)]
pub(crate) struct Selection {
    pub stack: Vec<String>,
    pub alternatives: Vec<Stack>,
}

fn application_frame(frame: &Frame) -> bool {
    let Some(file) = frame.file.as_deref() else {
        return false;
    };
    !file.is_empty()
        && ![
            "/rustc/",
            "/rustlib/",
            "library/",
            "/registry/src/",
            "/git/checkouts/",
        ]
        .iter()
        .any(|part| file.contains(part))
        && ![
            "std::",
            "core::",
            "alloc::",
            "tokio::",
            "tokio_util::",
            "dial9",
            "<tokio::",
            "<dial9",
        ]
        .iter()
        .any(|prefix| frame.name.starts_with(prefix))
}

fn timeout(frame: &Frame) -> bool {
    frame.name.contains("tokio::time::timeout::Timeout")
}

fn shutdown(frame: &Frame) -> bool {
    frame.name.contains("hyper_util::server::graceful::")
        || frame
            .name
            .contains("tokio_util::sync::cancellation_token::")
}

fn secondary(branch: &[Frame], siblings: &[Stack]) -> bool {
    for (index, frame) in branch.iter().enumerate() {
        let deadline = timeout(frame)
            && branch[index + 1..]
                .iter()
                .any(|f| f.name.contains("tokio::time::sleep::Sleep"));
        let cancellation = shutdown(frame)
            && branch[index + 1..].iter().any(|f| {
                f.name.contains("tokio::sync::notify::")
                    || f.name.contains("WaitForCancellationFuture")
            });
        if !(deadline || cancellation) {
            continue;
        }
        // The wrapper must also surround the work branch. A standalone Sleep
        // or Notify, including a user select! branch, is never secondary.
        if siblings.iter().any(|other| {
            other.len() > index + 1
                && other[..=index] == branch[..=index]
                && !other[index + 1..].iter().any(|f| {
                    if deadline {
                        f.name.contains("tokio::time::sleep::Sleep")
                    } else {
                        f.name.contains("tokio::sync::notify::")
                            || f.name.contains("WaitForCancellationFuture")
                    }
                })
        }) {
            return true;
        }
    }
    false
}

pub(crate) fn select(stacks: impl IntoIterator<Item = Stack>) -> Selection {
    let mut alternatives: Vec<_> = stacks
        .into_iter()
        .filter(|stack| !stack.is_empty())
        .collect();
    alternatives.sort();
    alternatives.dedup();
    let mut common = alternatives.first().map_or(0, |stack| stack.len());
    for stack in alternatives.iter().skip(1) {
        common = alternatives[0][..common]
            .iter()
            .zip(stack.iter())
            .take_while(|(a, b)| a == b)
            .count();
    }
    let mut candidates: Vec<_> = alternatives
        .iter()
        .filter(|stack| !secondary(stack, &alternatives))
        .collect();
    if candidates.is_empty() {
        candidates.extend(alternatives.iter());
    }
    let winner = if candidates.len() == 1 {
        Some(candidates[0])
    } else {
        let scores: Vec<_> = candidates
            .iter()
            .map(|stack| {
                stack[common..]
                    .iter()
                    .filter(|frame| application_frame(frame))
                    .count()
            })
            .collect();
        scores.iter().max().and_then(|max| {
            let mut winners = candidates
                .iter()
                .zip(&scores)
                .filter(|(_, score)| score == &max);
            let winner = winners.next()?.0;
            winners.next().is_none().then_some(*winner)
        })
    };
    let stack = match winner {
        Some(winner) => winner.iter().map(|frame| frame.name.clone()).collect(),
        None => {
            let mut stack: Vec<_> = alternatives
                .first()
                .into_iter()
                .flat_map(|first| first[..common].iter().map(|frame| frame.name.clone()))
                .collect();
            let mut labels: Vec<_> = candidates
                .iter()
                .filter_map(|branch| branch.last())
                .map(|frame| frame.name.as_str())
                .collect();
            labels.sort_unstable();
            labels.dedup();
            stack.push(format!(
                "[awaiting any of {}] {}",
                candidates.len(),
                labels.join(" | ")
            ));
            stack
        }
    };
    Selection {
        stack,
        alternatives,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stack(names: &[&str]) -> Stack {
        names
            .iter()
            .map(|name| Frame {
                name: name.to_string(),
                file: None,
            })
            .collect::<Vec<_>>()
            .into()
    }

    #[test]
    fn deduplicates_siblings_and_is_independent_of_callback_order() {
        let a = stack(&["root", "tokio::sync::notify::Notified"]);
        let b = stack(&["root", "tokio::time::sleep::Sleep"]);
        let first = select([a.clone(), b.clone(), a.clone()]);
        let second = select([b, a]);
        assert_eq!(first.stack, second.stack);
        assert_eq!(first.alternatives.len(), 2);
        assert!(first.stack[1].starts_with("[awaiting any of 2]"));
    }

    #[test]
    fn timeout_demotes_only_its_own_deadline() {
        let sleep = stack(&[
            "root",
            "tokio::time::timeout::Timeout::poll",
            "tokio::time::sleep::Sleep::poll",
        ]);
        let work = stack(&["root", "tokio::time::timeout::Timeout::poll", "operation"]);
        assert_eq!(
            select([sleep.clone(), work]).stack.last().unwrap(),
            "operation"
        );
        let unrelated = stack(&["root", "another operation"]);
        assert!(
            select([sleep, unrelated])
                .stack
                .last()
                .unwrap()
                .starts_with("[awaiting any of 2]")
        );
    }

    #[test]
    fn graceful_shutdown_is_secondary_to_work_under_the_same_wrapper() {
        let shutdown = stack(&[
            "root",
            "hyper_util::server::graceful::Watcher::watch",
            "tokio::sync::notify::Notified",
        ]);
        let work = stack(&[
            "root",
            "hyper_util::server::graceful::Watcher::watch",
            "connection",
        ]);
        assert_eq!(select([shutdown, work]).stack.last().unwrap(), "connection");
    }

    #[test]
    fn application_ownership_requires_source_provenance() {
        let application: Stack = vec![Frame {
            name: "service::request".into(),
            file: Some("src/main.rs".into()),
        }]
        .into();
        let dependency: Stack = vec![Frame {
            name: "client::request".into(),
            file: Some("/home/build/.cargo/registry/src/client/src/lib.rs".into()),
        }]
        .into();
        assert_eq!(
            select([dependency, application]).stack,
            ["service::request"]
        );
        assert!(
            select([stack(&["unknown::a"]), stack(&["unknown::b"])]).stack[0]
                .starts_with("[awaiting any of 2]")
        );
    }
}

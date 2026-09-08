#![cfg(tokio_unstable)]

//! A worker index is a budget identity, not an exclusive sampler-ownership token.

use std::future::{Future, pending, poll_fn};
use std::sync::mpsc;
use std::task::Poll;
use std::thread;
use std::time::Duration;

#[test]
fn pending_after_block_in_place_can_overlap_the_replacement_worker() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .build()
        .unwrap();
    let ((before, after), replacement) = runtime.block_on(async {
        tokio::spawn(async {
            let before = (tokio::runtime::worker_index(), thread::current().id());
            let (started_tx, started_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let replacement = tokio::spawn(async move {
                let identity = (tokio::runtime::worker_index(), thread::current().id());
                started_tx.send(()).unwrap();
                // Deliberately retain the core in this poll until the original
                // thread reaches the post-Pending sampling decision below.
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                identity
            });
            let mut inner = Box::pin(async move {
                tokio::task::block_in_place(|| {
                    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    assert_eq!(tokio::runtime::worker_index(), None);
                });
                pending::<()>().await;
            });
            let after = poll_fn(|cx| {
                assert!(inner.as_mut().poll(cx).is_pending());
                // Exactly where TaskDumped consults its sampler: outside the
                // blocking closure, after the normal inner poll is Pending.
                let identity = (tokio::runtime::worker_index(), thread::current().id());
                release_tx.send(()).unwrap();
                Poll::Ready(identity)
            })
            .await;
            ((before, after), replacement.await.unwrap())
        })
        .await
        .unwrap()
    });
    assert_eq!(
        before, after,
        "the original thread retains its worker index"
    );
    assert_eq!(after.0, Some(0));
    assert_eq!(
        after.0, replacement.0,
        "both threads report the same worker"
    );
    assert_ne!(
        after.1, replacement.1,
        "the polls execute on different threads"
    );
}

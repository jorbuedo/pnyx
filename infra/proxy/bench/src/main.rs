//! Measures the floor: what a Rust token-injecting proxy costs per connection.
//!
//! Shape matched to how this would actually be deployed — behind a Cloudflare Tunnel, so
//! cloudflared terminates TLS and this listens plaintext on localhost, exactly like the
//! sponsor host and the indexer box. Each accepted connection is relayed to the upstream
//! with `tokio::io::copy_bidirectional`, which is what a WebSocket passthrough is after the
//! 101: two streams and no parsing. That makes this the honest per-connection memory floor
//! for a long-lived subscription, which is the proxy's dominant cost.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let listen = args.get(1).cloned().unwrap_or_else(|| "127.0.0.1:19000".into());
    let upstream = args.get(2).cloned().unwrap_or_else(|| "127.0.0.1:19001".into());
    let live = Arc::new(AtomicU64::new(0));

    let l = TcpListener::bind(&listen).await.expect("bind");
    eprintln!("proxy {listen} -> {upstream}");
    {
        let live = live.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                eprintln!("live={}", live.load(Ordering::Relaxed));
            }
        });
    }
    loop {
        let Ok((mut inbound, _)) = l.accept().await else { continue };
        let up = upstream.clone();
        let live = live.clone();
        tokio::spawn(async move {
            live.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut outbound) = TcpStream::connect(&up).await {
                // A real proxy rewrites the request head here to add the credential: read
                // until CRLFCRLF, splice the header, write it on. That is a few hundred
                // bytes of work once per connection and does not change the steady state.
                let _ = copy_bidirectional(&mut inbound, &mut outbound).await;
            }
            live.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

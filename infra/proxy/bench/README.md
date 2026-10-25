# Proxy sizing bench

Measures the per-connection and per-request floor for a Rust token-injecting proxy. Numbers and what
they mean: [`../README.md`](../README.md).

```bash
cargo build --release
bun upstream.ts &                                  # echo upstream, :19001
./target/release/proxy-bench 127.0.0.1:19000 127.0.0.1:19001 &
bun load.ts 20000                                 # hold N connections, 120 B frame every 2 s
bun rate.ts 64 6                                  # fresh-connection throughput
ps -o rss=,%cpu= -p <proxy pid>
```

⚠️ **Re-run this on the box you are actually choosing.** The recorded figures are x86_64; the Pi is
aarch64 and the Mac is arm64, and per-connection memory is allocator- and page-size-sensitive.

⚠️ Raise `ulimit -n` before the 20k run. The relay does no TLS on purpose — `cloudflared`
terminates it in every deployment we run, so adding rustls here would measure a cost the real
topology does not pay.

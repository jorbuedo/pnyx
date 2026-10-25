// Opens N long-lived connections through the proxy and keeps them alive with a small
// periodic frame, which is what an indexer subscription looks like once it is up.
const N = Number(process.argv[2] ?? 1000)
const socks: any[] = []
let connected = 0
const frame = new Uint8Array(120) // a progress frame is small; UTXO frames are bigger and bursty
for (let i = 0; i < N; i++) {
  try {
    const s = await Bun.connect({
      hostname: '127.0.0.1',
      port: 19000,
      socket: {
        data() {},
        open() {
          connected++
        },
        close() {},
        error() {},
      },
    })
    socks.push(s)
  } catch (e) {
    console.error(`stopped at ${i}: ${e}`)
    break
  }
}
console.error(`opened ${socks.length} (connected=${connected})`)
const tick = setInterval(() => {
  for (const s of socks) {
    try {
      s.write(frame)
    } catch {}
  }
}, 2000)
process.on('SIGTERM', () => {
  clearInterval(tick)
  for (const s of socks) s.end()
  process.exit(0)
})
setInterval(() => {}, 1 << 30)

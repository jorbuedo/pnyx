// Short-lived request/response pairs: connect, write a 400B head-sized frame, read the
// echo, close. This is the HTTP axis — connection setup plus a small round trip, which is
// where a proxy that parses and rewrites the request head does its work.
const CONC = Number(process.argv[2] ?? 64),
  SECS = Number(process.argv[3] ?? 6)
const payload = new Uint8Array(400)
let done = 0,
  errs = 0
const until = Date.now() + SECS * 1000
const worker = async () => {
  while (Date.now() < until) {
    try {
      await new Promise<void>((res, rej) => {
        Bun.connect({
          hostname: '127.0.0.1',
          port: 19000,
          socket: {
            open(s) {
              s.write(payload)
            },
            data(s) {
              s.end()
              done++
              res()
            },
            error() {
              errs++
              rej(new Error('e'))
            },
            close() {},
          },
        }).catch(rej)
      })
    } catch {
      /* counted in errs */
    }
  }
}
await Promise.all(Array.from({length: CONC}, worker))
console.log(JSON.stringify({done, errs, secs: SECS, rps: Math.round(done / SECS)}))

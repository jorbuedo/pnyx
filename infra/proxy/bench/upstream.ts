Bun.listen({
  hostname: '127.0.0.1',
  port: 19001,
  socket: {
    data(s, d) {
      s.write(d)
    },
    open() {},
    close() {},
    error() {},
  },
})
console.error('upstream on 19001')
setInterval(() => {}, 1 << 30)

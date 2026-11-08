const fs = require('node:fs')
const http = require('node:http')
const { mode } = JSON.parse(fs.readFileSync(process.env.ANUBIS_BROKER_CONFIG, 'utf8'))
if (mode === 'exit') process.exit(1)
if (mode !== 'timeout') {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/jobs')) {
      process.disconnect()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(mode === 'bad-json' ? 'not JSON' : JSON.stringify({ ready: true }))
  })
  server.listen(0, '127.0.0.1', () => {
    process.send({
      type: 'broker.ready',
      connection: { host: '127.0.0.1', port: server.address().port, token: mode === 'bad-ready' ? 'invalid' : 'a'.repeat(64) }
    })
  })
  process.on('message', message => {
    if (message.type === 'broker.stop') {
      server.close(() => process.disconnect())
    }
  })
  process.on('disconnect', () => { server.close(); process.exit(0) })
} else {
  setInterval(() => {}, 1000)
}

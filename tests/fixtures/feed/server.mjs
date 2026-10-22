// The issuer network edge: real SSH/SFTP, synthetic files and ephemeral signing keys.
import { createHash, generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'

export async function issuerServer(files = new Map()) {
  const makeKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }).toString()
  const hostKey = makeKey(), privateKey = makeKey(), parsed = ssh2.utils.parseKey(privateKey)
  const hostBlob = ssh2.utils.parseKey(hostKey).getPublicSSH(), requests = [], connections = new Set(), control = { beforeRead: null }
  const server = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    connections.add(client); client.on('close', () => connections.delete(client)); client.on('error', () => {})
    client.on('authentication', ctx => {
      requests.push({ operation: 'authenticate', username: ctx.username })
      if (ctx.method !== 'publickey' || ctx.username !== 'synthetic-coaster-900' || !ctx.key.data.equals(parsed.getPublicSSH())) return ctx.reject()
      if (ctx.signature && !parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject()
      ctx.accept()
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('sftp', acceptSftp => {
        const sftp = acceptSftp(), handles = new Map(); let next = 0
        const handle = value => { const key = Buffer.from(String(++next)); handles.set(key.toString(), value); return key }
        sftp.on('OPENDIR', (id, path) => { requests.push({ operation: 'opendir', path }); path === '/synthetic-coaster-901' ? sftp.handle(id, handle({ directory: true, sent: false })) : sftp.status(id, 2) })
        sftp.on('READDIR', (id, key) => {
          const held = handles.get(key.toString()); if (!held || held.sent) return sftp.status(id, 1)
          held.sent = true
          sftp.name(id, [...files].map(([filename, bytes]) => ({ filename, longname: filename, attrs: { size: Buffer.byteLength(bytes), mode: 0o100600, uid: 0, gid: 0, atime: 0, mtime: 0 } })))
        })
        sftp.on('OPEN', (id, path, flags) => { requests.push({ operation: 'open', path, flags }); const name = path.slice(path.lastIndexOf('/') + 1); if (flags !== 1 || !files.has(name)) return sftp.status(id, 3); sftp.handle(id, handle({ name })) })
        sftp.on('READ', async (id, key, offset, length) => {
          const held = handles.get(key.toString()); if (!held?.name) return sftp.status(id, 9)
          requests.push({ operation: 'read', name: held.name })
          await control.beforeRead?.(held.name)
          const bytes = Buffer.from(files.get(held.name)); offset >= bytes.length ? sftp.status(id, 1) : sftp.data(id, bytes.subarray(offset, offset + length))
        })
        sftp.on('CLOSE', (id, key) => { handles.delete(key.toString()); sftp.status(id, 0) })
        for (const op of ['WRITE', 'REMOVE', 'RENAME', 'MKDIR', 'RMDIR', 'SETSTAT', 'FSETSTAT']) sftp.on(op, id => { requests.push({ operation: op }); sftp.status(id, 3) })
      })
    }))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { files, requests, control, credentials: { host: '127.0.0.1', port: server.address().port, username: 'synthetic-coaster-900', privateKey, hostKeyFingerprint: 'SHA256:' + createHash('sha256').update(hostBlob).digest('base64').replace(/=+$/, ''), directory: '/synthetic-coaster-901' }, async close() { for (const client of connections) client.end(); await new Promise(resolve => server.close(resolve)) } }
}

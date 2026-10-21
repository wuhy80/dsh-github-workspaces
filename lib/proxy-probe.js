/**
 * 本地代理探测。
 *
 * 插件自己不做代理，只认「本地有一个端口」。判定分两段，避免把普通 Web 服务
 * 误报成代理（第一版就踩过：8080 上的开发服务器被标成了 http 代理）：
 *
 * 1. 连上后发 SOCKS5 greeting（05 01 00）：回 0x05 → 确定是 socks5；
 * 2. 否则再开一条连接发 `CONNECT github.com:443`：只有返回 200 才算 http 代理，
 *    返回 4xx/5xx（普通 Web 服务）直接丢弃。
 *
 * 只连 127.0.0.1。
 */

import net from 'node:net'

/** 常见客户端默认端口：Clash / V2Ray / SS / Privoxy / Squid 等。 */
export const DEFAULT_PORTS = [7890, 7891, 7897, 1080, 10808, 10809, 8889, 8080, 8118, 3128, 20171]

/** 单端口连接超时。 */
const CONNECT_TIMEOUT = 400
/** 握手回包超时。 */
const HANDSHAKE_TIMEOUT = 600

/**
 * 第一段：连上并试 SOCKS5 握手。
 * @param {number} port - 本地端口。
 * @returns {Promise<{port: number, kind: 'socks5'|'http-or-other'} | null>} 端口关闭返回 null。
 */
export function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* 已经关了 */
      }
      resolve(value)
    }

    socket.setTimeout(CONNECT_TIMEOUT, () => finish(null))
    socket.once('error', () => finish(null))

    socket.once('connect', () => {
      socket.removeAllListeners('timeout')
      // SOCKS5：VER=5, NMETHODS=1, METHOD=0（无需认证）
      socket.write(Buffer.from([0x05, 0x01, 0x00]))
      socket.setTimeout(HANDSHAKE_TIMEOUT, () => finish({ port, kind: 'http-or-other' }))
      socket.once('data', (buf) => {
        if (buf.length >= 2 && buf[0] === 0x05) finish({ port, kind: 'socks5' })
        else finish({ port, kind: 'http-or-other' })
      })
    })
  })
}

/**
 * 第二段：用 CONNECT 验证它到底是不是 HTTP 代理。
 * @param {number} port - 本地端口。
 * @returns {Promise<boolean>} 只有 200 才为真。
 */
export function probeHttpConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* 已经关了 */
      }
      resolve(value)
    }

    socket.setTimeout(CONNECT_TIMEOUT, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => {
      socket.removeAllListeners('timeout')
      socket.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nProxy-Connection: keep-alive\r\n\r\n')
      socket.setTimeout(HANDSHAKE_TIMEOUT, () => finish(false))
      socket.once('data', (buf) => {
        const first = buf.toString('latin1').split('\r\n')[0] ?? ''
        finish(/^HTTP\/1\.[01] 200/.test(first))
      })
    })
  })
}

/**
 * 并发探测一批端口，只返回确认可用的代理。
 * @param {number[]} [ports] - 端口列表，默认 {@link DEFAULT_PORTS}。
 * @returns {Promise<Array<{port: number, kind: 'socks5'|'http', scheme: 'socks5'|'http'}>>}
 */
export async function probeLocalProxies(ports = DEFAULT_PORTS) {
  const stage1 = await Promise.all(ports.map((port) => probePort(port)))
  const candidates = []
  await Promise.all(stage1.filter((item) => item !== null).map(async (item) => {
    if (item.kind === 'socks5') {
      candidates.push({ port: item.port, kind: 'socks5', scheme: 'socks5' })
      return
    }
    // 只是「像 HTTP 服务」，再用 CONNECT 确认：普通 Web 服务会 400/404，被丢弃
    if (await probeHttpConnect(item.port)) {
      candidates.push({ port: item.port, kind: 'http', scheme: 'http' })
    }
  }))
  return candidates.sort((a, b) => a.port - b.port)
}

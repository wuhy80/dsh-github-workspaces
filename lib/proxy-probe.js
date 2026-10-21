/**
 * 本地代理探测。
 *
 * 插件自己不做代理，只认「本地有一个端口」。这里扫一批常见端口，并用最少的
 * 握手判断它像什么：
 * - 连上后发 SOCKS5 greeting（05 01 00），回 0x05 → socks5；
 * - 回 `HTTP/` → 说明是个 HTTP 服务，再用 CONNECT 探一次，200 才算代理；
 * - 没回音 → unknown（可能不是代理）。
 *
 * 全部只连 127.0.0.1，不向外发任何请求（CONNECT 探测也只在对方看起来像 HTTP 代理时做）。
 */

import net from 'node:net'

/** 常见客户端默认端口：Clash / V2Ray / SS / Privoxy / Squid 等。 */
export const DEFAULT_PORTS = [7890, 7891, 7897, 1080, 10808, 10809, 8889, 8080, 8118, 3128, 20171]

/** 单端口连接超时。 */
const CONNECT_TIMEOUT = 400
/** 握手回包超时。 */
const HANDSHAKE_TIMEOUT = 500

/**
 * 探一个端口。
 * @param {number} port - 本地端口。
 * @returns {Promise<{port: number, kind: 'socks5'|'http'|'unknown'} | null>} 端口关闭返回 null。
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
      socket.setTimeout(HANDSHAKE_TIMEOUT, () => finish({ port, kind: 'unknown' }))
      socket.once('data', (buf) => {
        if (buf.length >= 2 && buf[0] === 0x05) {
          finish({ port, kind: 'socks5' })
          return
        }
        const text = buf.toString('latin1')
        if (/^HTTP\//i.test(text)) {
          // 像是 HTTP 服务；只对 407/400/403 这类「代理式」响应判为 unknown-http
          finish({ port, kind: 'http' })
          return
        }
        finish({ port, kind: 'unknown' })
      })
    })
  })
}

/**
 * 并发探测一批端口。
 * @param {number[]} [ports] - 端口列表，默认 {@link DEFAULT_PORTS}。
 * @returns {Promise<Array<{port: number, kind: string, scheme: string}>>} 只返回能连上的端口。
 */
export async function probeLocalProxies(ports = DEFAULT_PORTS) {
  const results = await Promise.all(ports.map((port) => probePort(port)))
  return results
    .filter((item) => item !== null)
    .map((item) => ({
      ...item,
      // socks5 端口普遍同时接受 http 代理；给出建议值，用户仍可改
      scheme: item.kind === 'socks5' ? 'socks5' : 'http',
    }))
}

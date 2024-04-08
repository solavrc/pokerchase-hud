import { decode } from '@msgpack/msgpack'

const OriginalWebSocket = window.WebSocket

function createWebSocket(...args: ConstructorParameters<typeof WebSocket>): WebSocket {
  const instance: WebSocket = new OriginalWebSocket(...args)
  instance.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) {
      /** @todo parse */
      console.dir(decode(data))
    }
  })
  return instance
}

window.WebSocket = createWebSocket as unknown as typeof WebSocket

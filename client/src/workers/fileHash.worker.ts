import { createSHA256 } from 'hash-wasm'

type HashWorkerRequest = {
  id: string
  file: File
}

const READ_CHUNK_SIZE = 4 * 1024 * 1024

self.onmessage = async (event: MessageEvent<HashWorkerRequest>) => {
  const { id, file } = event.data
  try {
    const hasher = await createSHA256()
    for (let offset = 0; offset < file.size; offset += READ_CHUNK_SIZE) {
      const slice = file.slice(offset, offset + READ_CHUNK_SIZE)
      const buf = await slice.arrayBuffer()
      hasher.update(new Uint8Array(buf))
    }
    self.postMessage({ id, ok: true, hash: hasher.digest('hex') })
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err as Error).message ?? err) })
  }
}

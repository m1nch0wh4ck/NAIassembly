export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await crypto.subtle.digest('SHA-256', buf as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** GUI batch collision naming: base.ext, base-1.ext, base-2.ext, ... */
export function uniqueName(base: string, ext: string, exists: (name: string) => boolean): string {
  const plain = `${base}${ext}`
  if (!exists(plain)) return plain
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}${ext}`
    if (!exists(candidate)) return candidate
  }
}

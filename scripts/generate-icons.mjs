import { mkdirSync, writeFileSync } from 'node:fs'
import { png } from './png.mjs'
mkdirSync('public', { recursive: true })
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  const pixels = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = x / size, ny = y / size
    let color = [22, 77, 60]
    if ((nx - .5) ** 2 + (ny - .66) ** 2 < .2 ** 2) color = [239, 232, 187]
    if (nx > .48 && nx < .515 && ny > .22 && ny < .62) color = [255, 255, 249]
    if (nx >= .515 && nx < .75 && ny > .22 && ny < .38 - (nx - .515) * .55) color = [229, 174, 68]
    if ((nx - .45) ** 2 + (ny - .66) ** 2 < .049 ** 2) color = [255, 255, 255]
    const i = (y * size + x) * 3
    for (let c = 0; c < 3; c++) pixels[i + c] = color[c]
  }
  writeFileSync(`public/${name}`, png(size, size, pixels))
}

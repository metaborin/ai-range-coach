import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import jpeg from 'jpeg-js'
const bundled = join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'ffmpeg-1011', 'ffmpeg-win64.exe')
const encoder = process.env.TEST_FFMPEG_PATH || (existsSync(bundled) ? bundled : 'ffmpeg')
mkdirSync('tests/fixtures', { recursive: true })
const width = 320, height = 180, frames = 120, fps = 24
const pixels = Buffer.alloc(width * height * 3 * frames)
const colors = [[210, 40, 35], [40, 180, 75], [30, 70, 220], [220, 160, 30], [170, 40, 180]]
for (let frame = 0; frame < frames; frame++) {
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = (x - (frame * 2 + 20) % width) ** 2 + (y - 90) ** 2 < 18 ** 2 ? [245, 245, 235] : colors[Math.floor(frame / fps)]
    const index = (frame * width * height + y * width + x) * 3
    for (let c = 0; c < 3; c++) pixels[index + c] = color[c]
  }
}
const images = []
for (let frame = 0; frame < frames; frame++) {
  const rgba = Buffer.alloc(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = pixels[(frame * width * height + p) * 3 + c]
    rgba[p * 4 + 3] = 255
  }
  images.push(jpeg.encode({ width, height, data: rgba }, 85).data)
}
const result = spawnSync(encoder, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0', '-an', '-c:v', 'libvpx', '-b:v', '180k', 'tests/fixtures/synthetic.webm'], { input: Buffer.concat(images), windowsHide: true })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(result.stderr.toString())
console.log('Generated synthetic.webm: 5 seconds, 320×180, 24 fps, VP8; entirely generated colors and moving circle.')

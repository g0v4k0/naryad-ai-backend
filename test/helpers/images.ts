import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

/** Synthetic "equipment" photo: background, body, highlight. Different seeds give different scenes. */
export async function scene(seed: number, opts: { width?: number; height?: number } = {}) {
  const w = opts.width ?? 640, h = opts.height ?? 480;
  const rnd = (n: number) => Math.abs(Math.sin(seed * 9301 + n * 49297)) % 1;
  const shapes = Array.from({ length: 6 }, (_, i) => {
    const x = Math.round(rnd(i) * w * 0.7), y = Math.round(rnd(i + 10) * h * 0.7);
    const cw = Math.round(60 + rnd(i + 20) * w * 0.3), ch = Math.round(40 + rnd(i + 30) * h * 0.3);
    const c = Math.round(rnd(i + 40) * 255);
    return `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" fill="rgb(${c},${255 - c},${(c * 3) % 255})"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" x2="${rnd(50)}" y1="0" y2="1"><stop offset="0" stop-color="#${Math.round(rnd(60) * 0xffffff).toString(16).padStart(6, "0")}"/><stop offset="1" stop-color="#202020"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${shapes}<circle cx="${Math.round(rnd(70) * w)}" cy="${Math.round(rnd(80) * h)}" r="${Math.round(30 + rnd(90) * 80)}" fill="#eee"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

export async function saveUpload(name: string, buffer: Buffer) {
  await mkdir("uploads", { recursive: true });
  await writeFile(`uploads/${name}`, buffer);
  return `/uploads/${name}`;
}

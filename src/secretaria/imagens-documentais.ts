import { BadRequestException } from '@nestjs/common';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { imageSize } from 'image-size';

const limiteImagem = 2 * 1024 * 1024;
export const limitePixelsDocumento = 32_000_000;
export function tipoImagemDocumental(bytes: Buffer) {
  try {
    if (bytes.length > limiteImagem) throw new Error();
    const { type, width, height } = imageSize(bytes);
    if (!type || !['png', 'jpg', 'webp'].includes(type) || width * height > 16000000) throw new Error();
    return { mime: `image/${type === 'jpg' ? 'jpeg' : type}`, pixels: width * height };
  } catch {
    throw new BadRequestException('Imagem inválida. Use PNG, JPEG ou WebP de até 2 MB e 16 megapixels.');
  }
}

export function decodificarImagemDocumental(bytes: Buffer) {
  const { mime, pixels } = tipoImagemDocumental(bytes);
  return { uri: `data:${mime};base64,${bytes.toString('base64')}`, pixels };
}

export function imagemDocumental(bytes: Buffer) { return decodificarImagemDocumental(bytes).uri; }

export async function logoDocumental(url: string | null): Promise<string | undefined> {
  const nome = url?.match(/^\/uploads\/church-logos\/([a-f0-9-]{36}\.(?:png|jpe?g|webp))$/i)?.[1];
  if (!nome) return;
  const pasta = resolve('uploads', 'church-logos');
  let arquivo;
  try {
    if (await realpath(pasta) !== resolve(await realpath('uploads'), 'church-logos')) return;
    arquivo = await open(join(pasta, nome), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await arquivo.stat();
    if (!stat.isFile() || stat.size > limiteImagem) return;
    return imagemDocumental(await arquivo.readFile());
  } catch (erro) {
    if (erro instanceof BadRequestException || (erro as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw erro;
  } finally {
    await arquivo?.close();
  }
}

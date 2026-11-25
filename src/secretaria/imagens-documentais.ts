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

export async function conferirCargaDeImagem(total: { bytes: number; pixels: number }, tamanho: number, usos: number, ler: () => Promise<Buffer>) {
  total.bytes += tamanho * usos;
  if (tamanho > limiteImagem || total.bytes > 2 * limiteImagem) throw new BadRequestException('Imagens de até 2 MB cada e 4 MB no total.');
  total.pixels += tipoImagemDocumental(await ler()).pixels * usos;
  if (total.pixels > limitePixelsDocumento) throw new BadRequestException('As imagens do documento devem somar até 32 megapixels.');
}

export function decodificarImagemDocumental(bytes: Buffer) {
  const { mime, pixels } = tipoImagemDocumental(bytes);
  return { uri: `data:${mime};base64,${bytes.toString('base64')}`, pixels };
}

export function imagemDocumental(bytes: Buffer) { return decodificarImagemDocumental(bytes).uri; }

export async function bytesLogoDocumental(url: string | null): Promise<Buffer | undefined> {
  const nome = url?.match(/^\/uploads\/church-logos\/([a-f0-9-]{36}\.(?:png|jpe?g|webp))$/i)?.[1];
  if (!nome) return;
  const pasta = resolve('uploads', 'church-logos');
  let arquivo;
  try {
    if (await realpath(pasta) !== resolve(await realpath('uploads'), 'church-logos')) return;
    arquivo = await open(join(pasta, nome), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await arquivo.stat();
    if (!stat.isFile() || stat.size > limiteImagem) return;
    const bytes = await arquivo.readFile();
    tipoImagemDocumental(bytes);
    return bytes;
  } catch (erro) {
    if (erro instanceof BadRequestException || (erro as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw erro;
  } finally {
    await arquivo?.close();
  }
}

export async function logoDocumental(url: string | null): Promise<string | undefined> {
  const bytes = await bytesLogoDocumental(url);
  return bytes && imagemDocumental(bytes);
}

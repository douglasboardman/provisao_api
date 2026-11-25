import { ConflictException } from '@nestjs/common';

export function editorPaginaHabilitado(contexto: string) {
  const lista = process.env.SECRETARIA_EDITOR_PAGINA_CONTEXTOS;
  if (lista === undefined) return process.env.NODE_ENV !== 'production';
  return lista.trim() === '*' || lista.split(',').some(id => id.trim().toLowerCase() === contexto.toLowerCase());
}

export function exigirEditorPagina(contexto: string) {
  if (!editorPaginaHabilitado(contexto)) throw new ConflictException('O editor de página está pausado para novas criações neste contexto. Atualize e selecione um modelo no formato anterior.');
}

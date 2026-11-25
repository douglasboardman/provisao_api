export const camposNumeracao = ['numero_documento', 'numero_documento_por_extenso'] as const;

export function ehCampoNumeracao(origem: string | undefined) {
  return origem === 'numero_documento' || origem === 'numero_documento_por_extenso';
}

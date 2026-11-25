import { estados_brasil, type local_reuniao } from '@prisma/client';
import { z } from 'zod';

export const camposEndereco = ['endereco_logradouro', 'endereco_numero', 'endereco_complemento', 'endereco_bairro', 'endereco_cep', 'endereco_cidade', 'endereco_uf', 'endereco_extenso', 'endereco_declarativo'] as const;
const estados: Record<estados_brasil, string> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso',
  MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
  PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul',
  RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};
const opcional = (max: number) => z.string().trim().max(max).default('');
export const localSchema = z.strictObject({
  descritivo: z.string().trim().min(1).max(255),
  endereco_logradouro: opcional(255), endereco_numero: opcional(30), endereco_complemento: opcional(120),
  endereco_bairro: opcional(120), endereco_cidade: opcional(120),
  endereco_cep: z.string().trim().regex(/^(?:\d{5}-?\d{3})?$/, 'CEP inválido.')
    .transform(v => v.replace(/^(\d{5})-?(\d{3})$/, '$1-$2')).default(''),
  endereco_uf: z.union([z.enum(estados_brasil), z.literal('')]).default(''),
  extenso_personalizado: opcional(1500), declarativo_personalizado: opcional(1500),
});

export function retratoLocal(local: local_reuniao) {
  const { descritivo, endereco_logradouro, endereco_numero, endereco_complemento, endereco_bairro,
    endereco_cep, endereco_cidade, endereco_uf } = local;
  const bairro = endereco_bairro && 'Bairro ' + endereco_bairro;
  const cep = endereco_cep && 'CEP ' + endereco_cep;
  const rua = [endereco_logradouro, endereco_numero, endereco_complemento].filter(Boolean).join(', ');
  const municipio = [endereco_cidade, endereco_uf].filter(Boolean).join('/');
  const regiao = [bairro, cep, municipio].filter(Boolean).join(', ');
  const endereco_extenso = local.extenso_personalizado || [rua, regiao].filter(Boolean).join(' - ');
  const estado = estados[endereco_uf as estados_brasil];
  const lugar = [endereco_cidade, estado].filter(Boolean).join(', ');
  const prefixo = /^(rua|avenida|alameda|estrada|rodovia|travessa|praça)\b/i.test(endereco_logradouro) ? 'sito à ' : 'sito em ';
  const endereco_declarativo = local.declarativo_personalizado || [
    endereco_logradouro && prefixo + endereco_logradouro, endereco_numero && 'número ' + endereco_numero,
    endereco_complemento, bairro, cep, lugar && 'em ' + lugar,
  ].filter(Boolean).join(', ');
  return { descritivo, endereco_logradouro, endereco_numero, endereco_complemento, endereco_bairro,
    endereco_cep, endereco_cidade, endereco_uf, endereco_extenso, endereco_declarativo };
}

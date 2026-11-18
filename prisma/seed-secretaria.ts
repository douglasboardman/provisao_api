import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { configuracaoSchema } from '../src/secretaria/secretaria.dto';

const modelos = [
  { finalidade: 'ATA_REUNIAO', nome: 'Ata de reunião (modelo inicial)', tipo: 'ATA', perfil: 'ATA_PADRAO' },
  { finalidade: 'TERMO_ABERTURA', nome: 'Termo de abertura (modelo inicial)', tipo: 'OUTRO', perfil: 'TERMO' },
  { finalidade: 'TERMO_ENCERRAMENTO', nome: 'Termo de encerramento (modelo inicial)', tipo: 'OUTRO', perfil: 'TERMO' },
  { finalidade: 'CORRESPONDENCIA', nome: 'Correspondência (modelo inicial)', tipo: 'OUTRO', perfil: 'CORRESPONDENCIA' },
] as const;

function idModelo(contexto: string, finalidade: string) {
  const bytes = createHash('sha256').update(`provisao:modelos-iniciais:${contexto}:${finalidade}`).digest();
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  return bytes
    .subarray(0, 16)
    .toString('hex')
    .replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
}

export function seedSecretaria(prisma: PrismaClient, igrejaId: string, contextoId: string, operadorId: string) {
  return prisma.$transaction(async (tx) => {
    const contexto = await tx.contexto_secretaria.findFirstOrThrow({
      where: { id: contextoId, igreja_id: igrejaId },
      include: { orgao: true },
    });
    await tx.usuarios.findFirstOrThrow({
      where: { id: operadorId, igreja_id: igrejaId, ativo: true, perfil: 'ADMINISTRADOR' },
    });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'seed-secretaria:' + contexto.id}, 0))`;
    const resultado: Record<string, string> = {};
    for (const { finalidade, nome, tipo, perfil } of modelos) {
      const id = idModelo(contexto.id, finalidade);
      const anterior = await tx.modelo_documento.findUnique({
        where: { id_igreja_id_contexto_id: { id, igreja_id: igrejaId, contexto_id: contextoId } },
        select: { versoes: { where: { numero: 1 }, select: { id: true } } },
      });
      if (anterior) {
        if (!anterior.versoes[0]) throw new Error('Modelo inicial sem versão de origem.');
        resultado[finalidade] = anterior.versoes[0].id;
        continue;
      }
      const configuracao = configuracaoSchema.parse({
        contexto: contexto.tipo,
        tipos_orgao: contexto.orgao ? [contexto.orgao.tipo] : [],
        constituicoes: contexto.orgao ? [contexto.orgao.constituicao] : [],
        perfil,
        motivador: 'OPCIONAL',
        resolucoes: tipo === 'ATA' ? 'OPCIONAL' : 'NAO_PERMITE',
        registro_em_livro: tipo === 'ATA' ? 'OPCIONAL' : 'NAO_PERMITE',
        campos_obrigatorios: [],
        papeis_obrigatorios: [],
        cargos_obrigatorios: [],
      });
      const criado = await tx.modelo_documento.create({
        data: {
          id,
          igreja_id: igrejaId,
          contexto_id: contextoId,
          nome,
          versoes: { create: { numero: 1, tipo, finalidade, configuracao } },
        },
        select: { versoes: { select: { id: true } } },
      });
      await tx.logs_atividades.create({
        data: {
          igreja_id: igrejaId,
          usuario_id: operadorId,
          acao: 'CRIACAO',
          tabela_afetada: 'modelo_documento',
          registro_id: id,
          dados_novos: { origem: 'CATALOGO_INICIAL', finalidade, versao: 1 },
        },
      });
      resultado[finalidade] = criado.versoes[0].id;
    }
    return resultado;
  });
}

if (require.main === module) {
  const [igreja, contexto, operador] = process.argv.slice(2);
  if (!igreja || !contexto || !operador || process.argv.length !== 5) {
    process.stderr.write('Uso: npm run seed:secretaria -- <igreja> <contexto> <administrador ativo>\n');
    process.exitCode = 1;
  } else {
    const prisma = new PrismaClient();
    seedSecretaria(prisma, igreja, contexto, operador)
      .then((resultado) => process.stdout.write(JSON.stringify(resultado) + '\n'))
      .catch(() => {
        process.stderr.write('Falha ao instalar o catálogo. Confira o banco, o contexto e o administrador.\n');
        process.exitCode = 1;
      })
      .finally(() => prisma.$disconnect());
  }
}

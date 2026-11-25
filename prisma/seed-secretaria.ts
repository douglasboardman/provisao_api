import { opcoesAtuacao } from '../src/secretaria/atuacao-modelo.service';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { configuracaoSchema, definicaoCampo } from '../src/secretaria/secretaria.dto';

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
    const opcoes = await opcoesAtuacao(tx, contexto);
    const secretarios = opcoes.filter(p => ['SECRETARIO','PRIMEIRO_SECRETARIO'].includes(p.codigo)).map(p => p.id);
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
      const codigos = tipo === 'ATA' ? ['LOCAL_REUNIAO', 'PAUTA_REUNIAO', 'REGISTRO'] : finalidade === 'CORRESPONDENCIA' ? ['ASSUNTO', 'MENSAGEM'] :
        finalidade === 'TERMO_ABERTURA' ? ['NUMERO_LIVRO', 'TITULAR_LIVRO', 'CAPACIDADE_FOLHAS_LIVRO', 'NOME_SECRETARIO_LIVRO'] : [];
      const campos = await tx.campo_secretaria.findMany({ where: { igreja_id: igrejaId, ativo: true, codigo: { in: codigos } }, include: { mapeamento: { select: { cadastro: true, propriedade: true, transformacao: true } } } });
      const espaco = { superior: 0, inferior: 0 };
      const composicao = {
        versao_formato: 1, pagina: {
          papel: 'A4', orientacao: 'retrato', fonte: 'Noto Serif', tamanho_pt: 12,
          margens_cm: { superior: 2, inferior: 2, esquerda: 2, direita: 2 },
          espacamento_cm: { cabecalho: espaco, corpo: espaco, rodape: espaco },
        }, notas: {}, cabecalho: [], rodape: [], corpo: codigos.flatMap(codigo => {
          const campo = campos.find(c => c.codigo === codigo);
          return campo ? [{ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [...(finalidade === 'TERMO_ABERTURA' ? [{ tipo: 'texto', texto: campo.nome + ': ' }] : []), { tipo: 'campo', campo_id: campo.id, apresentacao: codigo === 'PAUTA_REUNIAO' ? 'lista_numerada' : campo.multiplo ? 'em_linha' : 'individual' }] }] : [];
        }),
      };
      const ataAssembleia = contexto.tipo === 'ASSEMBLEIA_GERAL' && tipo === 'ATA';
      const criar = ataAssembleia ? ['SECRETARIO_MESA'] : secretarios.length ? secretarios :
        opcoes.filter(p => ['PRESIDENTE','PRESIDENCIA_CONSELHO','LIDER'].includes(p.codigo)).map(p => p.id);
      if (!criar.length) throw new Error('Cadastre a secretaria ou presidência do órgão antes de instalar os modelos.');
      const configuracao = configuracaoSchema.parse({
        atuacao: { criar, preparar: ataAssembleia ? secretarios : [], assinar: ataAssembleia ? ['SECRETARIO_MESA','PRESIDENTE_MESA'] : [] },
        composicao_padrao: composicao,
        definicoes: Object.fromEntries(campos.map(({ id, nome, tipo, multiplo, origem, mapeamento }) => [id, { ...definicaoCampo.parse({ nome, tipo, multiplo, origem }), mapeamento }])),
        contexto: contexto.tipo,
        tipos_orgao: contexto.tipo === 'ORGAO' && contexto.orgao ? [contexto.orgao.tipo] : [],
        constituicoes: contexto.tipo === 'ORGAO' && contexto.orgao ? [contexto.orgao.constituicao] : [],
        perfil,
        motivador: 'OPCIONAL',
        resolucoes: tipo === 'ATA' ? 'OPCIONAL' : 'NAO_PERMITE',
        registro_em_livro: tipo === 'ATA' ? 'OPCIONAL' : 'NAO_PERMITE',
        campos_obrigatorios: [],
        papeis_obrigatorios: finalidade === 'TERMO_ABERTURA' ? ['SECRETARIO'] : [],
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

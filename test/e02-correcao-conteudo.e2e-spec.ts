import { RevisaoEleitoralService } from '../src/oficiais/revisao-eleitoral.service';
import { CorrecaoMembresiaService } from '../src/oficiais/correcao-membresia.service';
import { OrdenacaoMembresiaService } from '../src/oficiais/ordenacao-membresia.service';
import { InsercaoRetroativaService } from '../src/oficiais/insercao-retroativa.service';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AcessoSensivelService } from '../src/oficiais/acesso-sensivel.service';
import { CorrecaoConteudoService } from '../src/oficiais/correcao-conteudo.service';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', outra = 'e0000000-0000-4000-8000-000000000002', admin = 'e1000000-0000-4000-8000-000000000001';
integration('E02: correção de conteúdo de membresia', () => {
  const p = new PrismaService(), acesso = new AcessoSensivelService(p), service = new CorrecaoConteudoService(p);
  const pessoa = randomUUID(), usuario = randomUUID(), evento = randomUUID(), oficial = randomUUID(), mandato = randomUUID();
  const regrasCriadas: string[] = [], valoresCriados: string[] = [];
  const proposta = { evento_id: evento, tipo_evento: 'ADMISSAO' as const, rol: 'NAO_COMUNGANTES' as const, motivacao_evento: 'PROFISSAO_DE_FE' as const };
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await p.$connect();
    for (const [nome, destino] of [['Motivações de Admissão', 'PROFISSAO_DE_FE'], ['Rols de Admissão', 'NAO_COMUNGANTES'], ['Rols de Admissão', 'COMUNGANTES']]) {
      let regra = await p.regras_relacao_enum.findUnique({ where: { modulo_nome: { modulo: 'membresia', nome } } });
      if (!regra) { regra = await p.regras_relacao_enum.create({ data: { modulo: 'membresia', nome, tipo_regra: 'FILTRO', enum_classificador: 'membresia_tipo_evento', enum_classificado: nome.startsWith('Rols') ? 'membresia_rol' : 'membresia_motivacao_evento' } }); regrasCriadas.push(regra.id); }
      if (!await p.relacao_enum_valores.findFirst({ where: { regra_id: regra.id, valor_classificador: 'ADMISSAO', valor_classificado: destino } })) valoresCriados.push((await p.relacao_enum_valores.create({ data: { regra_id: regra.id, valor_classificador: 'ADMISSAO', valor_classificado: destino } })).id);
    }
    await p.usuarios.create({ data: { id: usuario, igreja_id: igreja, nome_usuario: 'Secretário sintético', email_login: `${usuario}@example.invalid`, senha_hash: 'sem-senha', perfil: 'SECRETARIO', ativo: true } });
    await p.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Pessoa sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await p.eventos_membresia.create({ data: { id: evento, igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2024-01-01') } });
    await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'DEMISSAO', rol: 'EXCLUIDOS', motivacao_evento: 'EXCLUSAO_A_PEDIDO', data_evento: new Date('2025-01-01') } });
    await p.oficial.create({ data: { id: oficial, igreja_id: igreja, pessoa_id: pessoa, tipo: 'DIACONO' } });
    await p.mandato_oficial.create({ data: { id: mandato, igreja_id: igreja, oficial_id: oficial, data_eleicao: new Date('2026-01-01'), data_posse: new Date('2026-01-01'), termino_previsto: new Date('2030-12-31'), autoridade: 'Conselho', evidencia: 'Livro', avaliacao_eleicao: {} } });
    await acesso.conceder(igreja, admin, { usuario_id: usuario, pode_consultar: true, pode_registrar: true, fundamento: 'Autorização sintética' });
  });
  afterAll(async () => {
    await p.relacao_enum_valores.deleteMany({ where: { id: { in: valoresCriados } } }); await p.regras_relacao_enum.deleteMany({ where: { id: { in: regrasCriadas } } });
    await p.logs_atividades.deleteMany({ where: { usuario_id: usuario } }); await p.correcao_conteudo_membresia.deleteMany({ where: { pessoa_id: pessoa } });
    await p.acesso_eventos_sensiveis.deleteMany({ where: { usuario_id: usuario } }); await p.mandato_oficial.deleteMany({ where: { id: mandato } }); await p.oficial.deleteMany({ where: { id: oficial } });
    await p.eventos_membresia.deleteMany({ where: { pessoa_id: pessoa } }); await p.pessoas.deleteMany({ where: { id: pessoa } }); await p.usuarios.deleteMany({ where: { id: usuario } }); await p.$disconnect();
  });
  it('valida prévia, isolamento, integridade e repetição concorrente', async () => {
    await expect(service.previa(outra, usuario, pessoa, proposta)).rejects.toThrow();
    await expect(p.eventos_membresia.update({ where: { id: evento }, data: { rol_origem: 'NAO_COMUNGANTES' } })).rejects.toThrow('exige conferência');
    const previa = await service.previa(igreja, usuario, pessoa, proposta); expect(previa.bloqueada).toBe(false);
    const dados = { ...proposta, hash_previa: previa.hash, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true as const };
    await expect(p.$transaction(async tx => {
      const f = await tx.correcao_conteudo_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa, evento_id: evento, dados_anteriores: previa.dados_anteriores, dados_novos: previa.dados_novos, impacto: {}, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), criado_por_id: usuario } });
      await tx.$queryRaw`SELECT set_config('provisao.correcao_conteudo_id', ${f.id}, true)`;
      await tx.eventos_membresia.update({ where: { id: evento }, data: { ...previa.dados_novos, observacoes: 'Não autorizado' } });
    })).rejects.toThrow('exige conferência');
    await p.eventos_membresia.update({ where: { id: evento }, data: { observacoes: 'Atualizado' } });
    await expect(service.aplicar(igreja, usuario, pessoa, dados)).rejects.toThrow('nova prévia');
    dados.hash_previa = (await service.previa(igreja, usuario, pessoa, proposta)).hash;
    const [a, b] = await Promise.all([service.aplicar(igreja, usuario, pessoa, dados), service.aplicar(igreja, usuario, pessoa, dados)]);
    expect(a.id).toBe(b.id); expect(await service.listar(igreja, usuario, pessoa)).toHaveLength(1);
    expect((await p.eventos_membresia.findUniqueOrThrow({ where: { id: evento } })).rol).toBe('NAO_COMUNGANTES');
    await expect(service.aplicar(igreja, usuario, pessoa, { ...dados, evidencia: 'Outra' })).rejects.toThrow('Chave');
  });
  it('bloqueia a correção de ato usado por conferência eleitoral', async () => {
    const politica = await p.politica_eleicao_oficial.create({ data: { igreja_id: igreja, versao: randomUUID(), fonte: 'Livro', autoridade: 'Conselho', idade_minima: 18, aniversario_bissexto: 'DIA_28_FEVEREIRO', vigente_desde: new Date('2020-01-01'), criado_por_id: usuario } });
    await p.conferencia_eleicao_oficial.create({ data: { igreja_id: igreja, pessoa_id: pessoa, politica_id: politica.id, data_eleicao: new Date('2024-06-01'), data_recepcao: new Date('2020-01-01'), evidencia_recepcao: 'Livro', capacidade_confirmada: true, evidencia_capacidade: 'Livro', resultado: {}, criado_por_id: usuario } });
    try {
      const nova = { ...proposta, rol: 'COMUNGANTES' as const }, previa = await service.previa(igreja, usuario, pessoa, nova);
      expect(previa.bloqueada).toBe(true); expect(previa.conferencias[0].evento_corrigido_utilizado).toBe(true);
      await expect(service.aplicar(igreja, usuario, pessoa, { ...nova, hash_previa: previa.hash, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true })).rejects.toThrow('revisão');
      const revisao = new RevisaoEleitoralService(p, new CorrecaoMembresiaService(p), service, new OrdenacaoMembresiaService(p), new InsercaoRetroativaService(p));
      const decisao = await revisao.registrar(igreja, usuario, pessoa, { operacao: 'CONTEUDO', proposta: nova, hash_previa: previa.hash, autoridade: 'Concílio', evidencia: 'Ata', justificativa: 'Autorizada', idempotencia: randomUUID(), ciente: true });
      await service.aplicar(igreja, usuario, pessoa, { ...nova, hash_previa: previa.hash, decisao_id: decisao.id, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true });
      expect(await p.revisao_eleitoral_item.count({ where: { decisao_id: decisao.id, conferencia_id: { not: null } } })).toBe(1);

    } finally { await p.revisao_eleitoral_item.deleteMany({ where: { decisao: { pessoa_id: pessoa } } }); await p.decisao_revisao_eleitoral.deleteMany({ where: { pessoa_id: pessoa } }); await p.conferencia_eleicao_oficial.deleteMany({ where: { pessoa_id: pessoa } }); await p.politica_eleicao_oficial.delete({ where: { id: politica.id } }); }
  });
  it('corrige tipo e motivação quando regras e continuidade permitem', async () => {
    const recursos: string[] = [], valores: string[] = [];
    for (const [nome, classificador, classificado, tipo] of [['Motivações de Demissão', 'DEMISSAO', 'EXCLUSAO_A_PEDIDO', 'FILTRO'], ['Rol de Destino por Motivação de Demissão', 'EXCLUSAO_A_PEDIDO', 'EXCLUIDOS', 'MAPEAMENTO']] as const) {
      let regra = await p.regras_relacao_enum.findUnique({ where: { modulo_nome: { modulo: 'membresia', nome } } });
      if (!regra) { regra = await p.regras_relacao_enum.create({ data: { modulo: 'membresia', nome, tipo_regra: tipo, enum_classificador: 'membresia_tipo_evento', enum_classificado: 'membresia_rol' } }); recursos.push(regra.id); }
      if (!await p.relacao_enum_valores.findFirst({ where: { regra_id: regra.id, valor_classificador: classificador, valor_classificado: classificado } })) valores.push((await p.relacao_enum_valores.create({ data: { regra_id: regra.id, valor_classificador: classificador, valor_classificado: classificado } })).id);
    }
    try {
      const nova = { evento_id: evento, tipo_evento: 'DEMISSAO' as const, rol: 'EXCLUIDOS' as const, motivacao_evento: 'EXCLUSAO_A_PEDIDO' as const };
      const previa = await service.previa(igreja, usuario, pessoa, nova); expect(previa.bloqueada).toBe(false);
      await service.aplicar(igreja, usuario, pessoa, { ...nova, hash_previa: previa.hash, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true });
      expect(await p.eventos_membresia.findUniqueOrThrow({ where: { id: evento } })).toMatchObject({ tipo_evento: 'DEMISSAO', rol: 'EXCLUIDOS', motivacao_evento: 'EXCLUSAO_A_PEDIDO' });
    } finally { await p.relacao_enum_valores.deleteMany({ where: { id: { in: valores } } }); await p.regras_relacao_enum.deleteMany({ where: { id: { in: recursos } } }); }
  });

});

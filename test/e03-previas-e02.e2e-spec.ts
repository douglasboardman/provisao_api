import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AcessoSensivelService } from '../src/oficiais/acesso-sensivel.service';
import { CorrecaoMembresiaService } from '../src/oficiais/correcao-membresia.service';
import { CorrecaoConteudoService } from '../src/oficiais/correcao-conteudo.service';
import { InsercaoRetroativaService } from '../src/oficiais/insercao-retroativa.service';
import { OrdenacaoMembresiaService } from '../src/oficiais/ordenacao-membresia.service';
import { DecisaoRevisaoOrgaoService } from '../src/orgaos/decisao-revisao-orgao.service';
import { atoAnterior, hashAto } from '../src/orgaos/idempotencia';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', outra = 'e0000000-0000-4000-8000-000000000002', admin = 'e1000000-0000-4000-8000-000000000001';

integration('E03: vínculos nas prévias da E02', () => {
  const p = new PrismaService(), acesso = new AcessoSensivelService(p), data = new CorrecaoMembresiaService(p), conteudo = new CorrecaoConteudoService(p), insercao = new InsercaoRetroativaService(p), ordem = new OrdenacaoMembresiaService(p);
  const decisoes = new DecisaoRevisaoOrgaoService(p, data, conteudo, insercao, ordem);
  const pessoa = randomUUID(), usuario = randomUUID(), evento = randomUUID(), orgao = randomUUID(), membro = randomUUID(), oficial = randomUUID();
  const flagAnterior = process.env.FEATURE_ORGAOS, regrasCriadas: string[] = [], valoresCriados: string[] = [];
  let acessoId = '';
  const explicacao = { justificativa: 'Conferência', autoridade: 'Conselho', evidencia: 'Registro', idempotencia: randomUUID(), ciente: true as const };
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await p.$connect();
    for (const [nome, destino] of [['Motivações de Admissão', 'PROFISSAO_DE_FE'], ['Motivações de Admissão', 'BATISMO_NA_INFANCIA'], ['Rols de Admissão', 'COMUNGANTES'], ['Rols de Admissão', 'NAO_COMUNGANTES']]) {
      let regra = await p.regras_relacao_enum.findUnique({ where: { modulo_nome: { modulo: 'membresia', nome } } });
      if (!regra) { regra = await p.regras_relacao_enum.create({ data: { modulo: 'membresia', nome, tipo_regra: 'FILTRO', enum_classificador: 'membresia_tipo_evento', enum_classificado: nome.startsWith('Rols') ? 'membresia_rol' : 'membresia_motivacao_evento' } }); regrasCriadas.push(regra.id); }
      if (!await p.relacao_enum_valores.findFirst({ where: { regra_id: regra.id, valor_classificador: 'ADMISSAO', valor_classificado: destino } })) valoresCriados.push((await p.relacao_enum_valores.create({ data: { regra_id: regra.id, valor_classificador: 'ADMISSAO', valor_classificado: destino } })).id);
    }
    await p.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Pessoa sintética', data_nascimento: new Date('1980-01-01'), sexo: 'FEMININO' } });
    await p.oficial.create({ data: { id: oficial, igreja_id: igreja, pessoa_id: pessoa, tipo: 'DIACONO' } });
    await p.usuarios.create({ data: { id: usuario, igreja_id: igreja, nome_usuario: 'Secretária sintética', email_login: `${usuario}@example.invalid`, senha_hash: 'inutilizavel', perfil: 'COMUM' } });
    acessoId = (await acesso.conceder(igreja, admin, { usuario_id: usuario, pode_consultar: true, pode_registrar: true, fundamento: 'Teste' })).id;
    await p.eventos_membresia.create({ data: { id: evento, igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2020-01-01') } });
    await p.orgao_interno.create({ data: { id: orgao, igreja_id: igreja, tipo: 'UNIDADE_MINISTERIAL', constituicao: 'DESIGNACAO', nome: 'Unidade sintética', finalidade: 'Teste', data_criacao: new Date('2020-01-01'), criador_id: usuario, instituidor_id: pessoa, evidencia_instituicao: 'Teste' } });
  });
  afterAll(async () => {
    if (flagAnterior === undefined) delete process.env.FEATURE_ORGAOS; else process.env.FEATURE_ORGAOS = flagAnterior;
    await p.logs_atividades.deleteMany({ where: { OR: [{ usuario_id: usuario }, { registro_id: acessoId }] } });
    await p.decisao_revisao_orgao.deleteMany({ where: { pessoa_id: pessoa } });
    await p.membro_orgao.deleteMany({ where: { orgao_id: orgao } });
    await p.orgao_interno.deleteMany({ where: { id: orgao } });
    await p.acesso_eventos_sensiveis.deleteMany({ where: { id: acessoId } });
    await p.eventos_membresia.deleteMany({ where: { id: evento } });
    await p.oficial.deleteMany({ where: { id: oficial } });
    await p.usuarios.deleteMany({ where: { id: usuario } });
    await p.pessoas.deleteMany({ where: { id: pessoa } });
    await p.relacao_enum_valores.deleteMany({ where: { id: { in: valoresCriados } } });
    await p.regras_relacao_enum.deleteMany({ where: { id: { in: regrasCriadas } } });
    await p.$disconnect();
  });
  it('mostra o bloqueio nas quatro prévias e rejeita confirmação e prévia obsoleta', async () => {
    const propostaData = { evento_id: evento, nova_data: '2020-01-02' };
    delete process.env.FEATURE_ORGAOS;
    const antiga = await data.previa(igreja, usuario, pessoa, propostaData, true);
    expect(antiga.bloqueio_orgao).toBeUndefined();
    process.env.FEATURE_ORGAOS = 'true';
    expect((await data.previa(igreja, usuario, pessoa, propostaData, true)).hash).toBe(antiga.hash);
    await p.membro_orgao.create({ data: { id: membro, igreja_id: igreja, orgao_id: orgao, pessoa_id: pessoa, inicio: new Date('2025-01-01') } });
    delete process.env.FEATURE_ORGAOS;
    expect((await data.previa(igreja, usuario, pessoa, propostaData, true)).hash).toBe(antiga.hash);
    await expect(data.aplicar(igreja, usuario, pessoa, { ...propostaData, ...explicacao, hash_previa: antiga.hash }, true)).rejects.toThrow();
    expect(await p.correcao_data_membresia.count({ where: { evento_id: evento } })).toBe(0);
    process.env.FEATURE_ORGAOS = 'true';
    await expect(data.aplicar(igreja, usuario, pessoa, { ...propostaData, ...explicacao, hash_previa: antiga.hash }, true)).rejects.toThrow('nova prévia');
    const atual = await data.previa(igreja, usuario, pessoa, propostaData, true);
    expect(atual.bloqueio_orgao).toMatchObject({ bloqueia: true, participacoes: 1, ocupacoes: 0, rol_preservado: 1, rol_alterado: 0, rol_indeterminado: 0 });
    expect(atual.bloqueio_orgao?.detalhes).toMatchObject([{ id: membro, orgao: 'Unidade sintética', tipo: 'PARTICIPACAO', comparacao_rol: 'PRESERVADO' }]);
    await expect(data.aplicar(igreja, usuario, pessoa, { ...propostaData, ...explicacao, hash_previa: atual.hash }, true)).rejects.toThrow('revisão dos vínculos de órgão');
    const chaveDecisao = randomUUID();
    const decisao = { operacao: 'DATA' as const, resultado: 'FAVORAVEL' as const, proposta: propostaData, hash_previa: atual.hash, autoridade: 'Conselho declarado', evidencia: 'Ata externa', justificativa: 'Conferência documental', idempotencia: chaveDecisao, ciente: true as const };
    await expect(decisoes.registrar(igreja, usuario, pessoa, { ...decisao, hash_previa: antiga.hash })).rejects.toThrow('nova prévia');
    await expect(decisoes.registrar(outra, usuario, pessoa, decisao)).rejects.toThrow();
    await expect(decisoes.registrar(igreja, usuario, pessoa, { ...decisao, anotacoes_vinculos: [{ tipo: 'PARTICIPACAO', id: randomUUID(), observacao: 'Fora da prévia' }] })).rejects.toThrow('vínculos distintos');
    await expect(decisoes.registrar(igreja, usuario, pessoa, { ...decisao, anotacoes_vinculos: [{ tipo: 'PARTICIPACAO', id: membro, observacao: 'Primeira' }, { tipo: 'PARTICIPACAO', id: membro, observacao: 'Duplicada' }] })).rejects.toThrow('vínculos distintos');
    const anotada = { ...decisao, anotacoes_vinculos: [{ tipo: 'PARTICIPACAO' as const, id: membro, observacao: 'Conferência documental', encaminhamento: 'REVISAR' as const }] };
    await expect(decisoes.registrar(igreja, usuario, pessoa, { ...anotada, idempotencia: randomUUID(), anotacoes_vinculos: [{ tipo: 'PARTICIPACAO', id: membro, observacao: 'Teste', encaminhamento: 'APROVADO' as never }] })).rejects.toThrow('Decisão inválida');
    const anotadaChave = randomUUID();
    const anotadaRegistro = await decisoes.registrar(igreja, usuario, pessoa, { ...anotada, idempotencia: anotadaChave });
    expect(await decisoes.registrar(igreja, usuario, pessoa, { ...anotada, idempotencia: anotadaChave })).toEqual(anotadaRegistro);
    await expect(decisoes.registrar(igreja, usuario, pessoa, { ...anotada, idempotencia: anotadaChave, anotacoes_vinculos: [{ tipo: 'PARTICIPACAO', id: membro, observacao: 'Texto alterado' }] })).rejects.toThrow('Chave');
    expect((await decisoes.listar(igreja, usuario, pessoa)).itens.find(i => i.id === anotadaRegistro.id)?.anotacoes_vinculos).toEqual(anotada.anotacoes_vinculos);
    const [primeira, repetida] = await Promise.all([decisoes.registrar(igreja, usuario, pessoa, decisao), decisoes.registrar(igreja, usuario, pessoa, decisao)]);
    expect(repetida).toEqual(primeira);
    await expect(decisoes.registrar(igreja, usuario, pessoa, { ...decisao, evidencia: 'Outra ata' })).rejects.toThrow('Chave');
    await expect(p.$transaction(tx => atoAnterior(tx, { igreja, usuario, idempotencia: chaveDecisao, tipo: 'DESIGNACAO', hash: 'x' }, 'nova_id'))).rejects.toThrow('Chave');
    const registros = await decisoes.listar(igreja, usuario, pessoa);
    expect(registros.itens).toHaveLength(2);
    expect(registros.itens.find(i => i.id === primeira.id)).toMatchObject({ resultado: 'FAVORAVEL', autoridade: 'Conselho declarado', evidencia: 'Ata externa' });
    expect(registros.itens.find(i => i.id === primeira.id)?.impacto).toMatchObject({ resumo_encaminhamentos: { total: 1, preservar: 0, revisar: 0, indeterminado: 0, sem_encaminhamento: 1 } });
    expect(registros.itens.find(i => i.id === anotadaRegistro.id)?.impacto).toMatchObject({ resumo_encaminhamentos: { total: 1, preservar: 0, revisar: 1, indeterminado: 0, sem_encaminhamento: 0 } });
    const chaveConcorrente = randomUUID();
    const concorrentes = await Promise.allSettled([
      decisoes.registrar(igreja, usuario, pessoa, { ...decisao, idempotencia: chaveConcorrente, evidencia: 'Ata A' }),
      decisoes.registrar(igreja, usuario, pessoa, { ...decisao, idempotencia: chaveConcorrente, evidencia: 'Ata B' }),
    ]);
    expect(concorrentes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(concorrentes.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((concorrentes.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.message).toContain('Chave');
    expect(await p.decisao_revisao_orgao.count({ where: { igreja_id: igreja, idempotencia: chaveConcorrente } })).toBe(1);
    const calcularOriginal = data.calcularParaOrgaos.bind(data);
    const espionagem = jest.spyOn(data, 'calcularParaOrgaos').mockImplementationOnce(async (...args) => {
      await p.orgao_interno.update({ where: { id: orgao }, data: { nome: 'Nome alterado simultaneamente' } });
      return calcularOriginal(...args);
    });
    try {
      const consistente = await decisoes.registrar(igreja, usuario, pessoa, { ...decisao, idempotencia: randomUUID() });
      const salva = await p.decisao_revisao_orgao.findUniqueOrThrow({ where: { id: consistente.id } });
      expect(salva.impacto).toMatchObject({ bloqueio_orgao: { detalhes: [{ id: membro, orgao: 'Unidade sintética' }] } });
      expect((await p.orgao_interno.findUniqueOrThrow({ where: { id: orgao } })).nome).toBe('Nome alterado simultaneamente');
    } finally {
      espionagem.mockRestore();
      await p.orgao_interno.update({ where: { id: orgao }, data: { nome: 'Unidade sintética' } });
    }
    const { resultado: _resultado, idempotencia: _chave, ...dadosLegados } = decisao;
    const chaveLegada = randomUUID();
    const legado = await p.decisao_revisao_orgao.create({ data: { igreja_id: igreja, pessoa_id: pessoa, criado_por_id: usuario, operacao: dadosLegados.operacao, proposta: propostaData, hash_previa: atual.hash, hash_requisicao: hashAto({ operacao: 'DECISAO_REVISAO_ORGAO', pessoa, dados: dadosLegados }), impacto: JSON.parse(JSON.stringify(atual)), autoridade: dadosLegados.autoridade, evidencia: dadosLegados.evidencia, justificativa: dadosLegados.justificativa, idempotencia: chaveLegada } });
    expect(await decisoes.registrar(igreja, usuario, pessoa, { ...dadosLegados, idempotencia: chaveLegada })).toEqual({ id: legado.id });
    await expect(decisoes.registrar(igreja, usuario, pessoa, { ...dadosLegados, idempotencia: randomUUID() })).rejects.toThrow('resultado declarado');
    await expect(decisoes.registrar(igreja, usuario, pessoa, { ...dadosLegados, resultado: 'FAVORAVEL', idempotencia: chaveLegada })).rejects.toThrow('Chave');
    expect((await decisoes.listar(igreja, usuario, pessoa)).itens.find(i => i.id === legado.id)?.resultado).toBeNull();
    await expect(p.decisao_revisao_orgao.update({ where: { id: legado.id }, data: { resultado: 'INVALIDO' } })).rejects.toThrow();
    expect((await decisoes.registrar(igreja, usuario, pessoa, { ...decisao, resultado: 'DESFAVORAVEL', idempotencia: randomUUID() })).id).toBeTruthy();
    const previaOficial = await data.previa(igreja, usuario, oficial, propostaData);
    const decisaoOficial = { ...decisao, oficial_id: oficial, hash_previa: previaOficial.hash, idempotencia: randomUUID() };
    expect((await decisoes.registrar(igreja, usuario, pessoa, decisaoOficial)).id).toBeTruthy();
    await expect(decisoes.registrar(igreja, usuario, pessoa, { ...decisaoOficial, oficial_id: randomUUID(), idempotencia: randomUUID() })).rejects.toThrow('Oficial não encontrado');
    await expect(decisoes.listar(outra, usuario, pessoa)).rejects.toThrow();
    await expect(data.aplicar(igreja, usuario, pessoa, { ...propostaData, ...explicacao, hash_previa: atual.hash }, true)).rejects.toThrow('revisão dos vínculos de órgão');
    await p.acesso_eventos_sensiveis.update({ where: { id: acessoId }, data: { revogado_em: new Date(), revogado_por_id: admin, motivo_revogacao: 'Teste' } });
    await expect(decisoes.registrar(igreja, usuario, pessoa, decisao)).rejects.toThrow('concessão');
    await expect(decisoes.listar(igreja, usuario, pessoa)).rejects.toThrow('concessão');
    await p.acesso_eventos_sensiveis.update({ where: { id: acessoId }, data: { revogado_em: null, revogado_por_id: null, motivo_revogacao: null } });
    const propostaConteudo = { evento_id: evento, tipo_evento: 'ADMISSAO' as const, rol: 'NAO_COMUNGANTES' as const, motivacao_evento: 'PROFISSAO_DE_FE' as const };
    const previaConteudo = await conteudo.previa(igreja, usuario, pessoa, propostaConteudo);
    expect(previaConteudo.bloqueio_orgao).toMatchObject({ bloqueia: true, rol_alterado: 1 });
    expect((await decisoes.consultarVinculos(igreja, usuario, pessoa, { operacao: 'CONTEUDO', proposta: propostaConteudo, hash_previa: previaConteudo.hash, pagina: 0 })).total).toBe(1);
    expect((await decisoes.registrar(igreja, usuario, pessoa, { ...decisao, operacao: 'CONTEUDO', proposta: propostaConteudo, hash_previa: previaConteudo.hash, idempotencia: randomUUID() })).id).toBeTruthy();
    await expect(conteudo.aplicar(igreja, usuario, pessoa, { ...propostaConteudo, ...explicacao, hash_previa: previaConteudo.hash })).rejects.toThrow('revisão dos vínculos de órgão');
    const semMudancaRol = await conteudo.previa(igreja, usuario, pessoa, { ...propostaConteudo, rol: 'COMUNGANTES', motivacao_evento: 'BATISMO_NA_INFANCIA' });
    expect(semMudancaRol.bloqueio_orgao).toBeUndefined();
    const propostaInsercao = { data_evento: '2019-01-01', tipo_evento: 'ADMISSAO' as const, rol: 'COMUNGANTES' as const, motivacao_evento: 'PROFISSAO_DE_FE' as const, igreja_origem: null, igreja_destino: null, observacoes: null };
    const previaInsercao = await insercao.previa(igreja, usuario, pessoa, propostaInsercao);
    expect(previaInsercao.bloqueio_orgao?.bloqueia).toBe(true);
    expect((await decisoes.consultarVinculos(igreja, usuario, pessoa, { operacao: 'INSERCAO', proposta: propostaInsercao, hash_previa: previaInsercao.hash, pagina: 0 })).total).toBe(1);
    expect((await decisoes.registrar(igreja, usuario, pessoa, { ...decisao, operacao: 'INSERCAO', proposta: propostaInsercao, hash_previa: previaInsercao.hash, idempotencia: randomUUID() })).id).toBeTruthy();
    await expect(insercao.aplicar(igreja, usuario, pessoa, { ...propostaInsercao, ...explicacao, hash_previa: previaInsercao.hash })).rejects.toThrow('revisão dos vínculos de órgão');
    const propostaOrdem = { data_evento: '2020-01-01', itens: [{ evento_id: evento, ordem: 1 }] };
    const previaOrdem = await ordem.previa(igreja, usuario, pessoa, propostaOrdem, true);
    expect(previaOrdem.bloqueio_orgao?.bloqueia).toBe(true);
    expect((await decisoes.consultarVinculos(igreja, usuario, pessoa, { operacao: 'ORDEM', proposta: propostaOrdem, hash_previa: previaOrdem.hash, pagina: 0 })).total).toBe(1);
    expect((await decisoes.registrar(igreja, usuario, pessoa, { ...decisao, operacao: 'ORDEM', proposta: propostaOrdem, hash_previa: previaOrdem.hash, idempotencia: randomUUID() })).id).toBeTruthy();
    await expect(ordem.aplicar(igreja, usuario, pessoa, { ...propostaOrdem, ...explicacao, hash_previa: previaOrdem.hash }, true)).rejects.toThrow('revisão dos vínculos de órgão');
    await expect(ordem.ordenarUnico(igreja, usuario, evento, { ...explicacao, ordem: 1 })).rejects.toThrow('revisão dos vínculos de órgão');
    const mesmoDia = await p.membro_orgao.create({ data: { igreja_id: igreja, orgao_id: orgao, pessoa_id: pessoa, inicio: new Date('2020-01-01'), fim: new Date('2021-01-01'), fim_ordem: 1 } });
    const previaMesmoDia = await data.previa(igreja, usuario, pessoa, propostaData, true);
    expect(previaMesmoDia.bloqueio_orgao).toMatchObject({ participacoes: 2, rol_preservado: 1, rol_indeterminado: 1 });
    await p.membro_orgao.delete({ where: { id: mesmoDia.id } });
    const extras = Array.from({ length: 100 }, (_, i) => ({ igreja_id: igreja, orgao_id: orgao, pessoa_id: pessoa, inicio: new Date(Date.UTC(2021, 0, i * 2 + 1)), fim: new Date(Date.UTC(2021, 0, i * 2 + 2)), fim_ordem: 1 }));
    await p.membro_orgao.createMany({ data: extras });
    const extensa = await data.previa(igreja, usuario, pessoa, propostaData, true);
    expect(extensa.bloqueio_orgao?.detalhes_limitados).toBe(true);
    const consulta = { operacao: 'DATA' as const, proposta: propostaData, hash_previa: extensa.hash, pagina: 0 };
    const pagina = await decisoes.consultarVinculos(igreja, usuario, pessoa, consulta);
    expect(pagina).toMatchObject({ total: 101, pagina: 0, proxima_pagina: 1 });
    expect(pagina.itens).toHaveLength(100);
    const seguinte = await decisoes.consultarVinculos(igreja, usuario, pessoa, { ...consulta, pagina: 1, hash_detalhes: pagina.hash_detalhes });
    expect(seguinte).toMatchObject({ total: 101, pagina: 1, proxima_pagina: null });
    expect(seguinte.itens).toHaveLength(1);
    expect(new Set([...pagina.itens, ...seguinte.itens].map(v => v.id)).size).toBe(101);
    const anotacaoAdicional = { tipo: 'PARTICIPACAO' as const, id: seguinte.itens[0].id, observacao: 'Conferência da página adicional', encaminhamento: 'INDETERMINADO' as const };
    const anotacoesExtensas = [anotacaoAdicional, { tipo: 'PARTICIPACAO' as const, id: pagina.itens[0].id, observacao: 'Parecer', encaminhamento: 'PRESERVAR' as const }, { tipo: 'PARTICIPACAO' as const, id: pagina.itens[1].id, observacao: 'Pendente', encaminhamento: 'REVISAR' as const }, { tipo: 'PARTICIPACAO' as const, id: pagina.itens[2].id, observacao: 'Sem parecer' }];
    const decisaoExtensa = { ...decisao, hash_previa: extensa.hash, idempotencia: randomUUID(), anotacoes_vinculos: anotacoesExtensas };
    await expect(decisoes.registrar(igreja, usuario, pessoa, decisaoExtensa)).rejects.toThrow('consulte novamente');
    await expect(decisoes.registrar(igreja, usuario, pessoa, { ...decisaoExtensa, hash_detalhes: 'a'.repeat(64) })).rejects.toThrow('consulte novamente');
    const decisaoSalva = await decisoes.registrar(igreja, usuario, pessoa, { ...decisaoExtensa, hash_detalhes: pagina.hash_detalhes });
    const retrato = await p.decisao_revisao_orgao.findUniqueOrThrow({ where: { id: decisaoSalva.id } });
    expect(retrato.anotacoes_vinculos).toEqual(anotacoesExtensas);
    expect(retrato.impacto).toMatchObject({ resumo_encaminhamentos: { total: 101, preservar: 1, revisar: 1, indeterminado: 1, sem_encaminhamento: 98 }, hash_detalhes_anotados: pagina.hash_detalhes });
    expect(retrato.impacto).toHaveProperty('vinculos_anotados', expect.arrayContaining([expect.objectContaining({ id: anotacaoAdicional.id, orgao: 'Unidade sintética', tipo: 'PARTICIPACAO' })]));
    expect(await decisoes.registrar(igreja, usuario, pessoa, { ...decisaoExtensa, hash_detalhes: pagina.hash_detalhes })).toEqual(decisaoSalva);
    const outraDecisao = await decisoes.registrar(igreja, usuario, pessoa, { ...decisao, resultado: 'DESFAVORAVEL', hash_previa: extensa.hash, idempotencia: randomUUID(), anotacoes_vinculos: [
      { tipo: 'PARTICIPACAO', id: pagina.itens[0].id, observacao: 'Conclusão distinta', encaminhamento: 'REVISAR' },
      { tipo: 'PARTICIPACAO', id: pagina.itens[3].id, observacao: 'Confirmado', encaminhamento: 'PRESERVAR' },
      { tipo: 'PARTICIPACAO', id: pagina.itens[1].id, observacao: 'Mesmo encaminhamento', encaminhamento: 'REVISAR' },
    ] });
    const pedido = { operacao: 'DATA' as const, proposta: propostaData, hash_previa: extensa.hash, decisoes: [decisaoSalva.id, outraDecisao.id] };
    const consolidada = await decisoes.consolidar(igreja, usuario, pessoa, pedido);
    expect(consolidada.totais).toEqual({ total: 101, preservar: 1, revisar: 1, indeterminado: 1, sem_encaminhamento: 97, divergentes: 1 });
    expect(consolidada.resultados).toEqual({ favoravel: 1, desfavoravel: 1, nao_informado: 0 });
    expect(consolidada.divergencias).toMatchObject([{ id: pagina.itens[0].id, encaminhamentos: ['PRESERVAR', 'REVISAR'] }]);
    await expect(decisoes.consolidar(igreja, usuario, pessoa, { ...pedido, decisoes: [outraDecisao.id, outraDecisao.id] })).rejects.toThrow('inválida');
    await expect(decisoes.consolidar(igreja, usuario, pessoa, { ...pedido, decisoes: [randomUUID()] })).rejects.toThrow('ausente');
    await expect(decisoes.consolidar(outra, usuario, pessoa, pedido)).rejects.toThrow();
    await expect(decisoes.consolidar(igreja, usuario, pessoa, { ...pedido, hash_previa: antiga.hash })).rejects.toThrow('nova prévia');
    const lote1 = await decisoes.registrar(igreja, usuario, pessoa, { ...decisao, hash_previa: extensa.hash, idempotencia: randomUUID(), anotacoes_vinculos: pagina.itens.map(v => ({ tipo: v.tipo, id: v.id, observacao: 'Conferido', encaminhamento: 'PRESERVAR' as const })) });
    const lote2 = await decisoes.registrar(igreja, usuario, pessoa, { ...decisao, hash_previa: extensa.hash, hash_detalhes: pagina.hash_detalhes, idempotencia: randomUUID(), anotacoes_vinculos: seguinte.itens.map(v => ({ tipo: v.tipo, id: v.id, observacao: 'Conferido', encaminhamento: 'PRESERVAR' as const })) });
    expect((await decisoes.consolidar(igreja, usuario, pessoa, { ...pedido, decisoes: [lote1.id, lote2.id] })).totais).toEqual({ total: 101, preservar: 101, revisar: 0, indeterminado: 0, sem_encaminhamento: 0, divergentes: 0 });
    const lote3 = await decisoes.registrar(igreja, usuario, pessoa, { ...decisao, hash_previa: extensa.hash, idempotencia: randomUUID(), anotacoes_vinculos: pagina.itens.map(v => ({ tipo: v.tipo, id: v.id, observacao: 'Rever', encaminhamento: 'REVISAR' as const })) });
    const lote4 = await decisoes.registrar(igreja, usuario, pessoa, { ...decisao, hash_previa: extensa.hash, hash_detalhes: pagina.hash_detalhes, idempotencia: randomUUID(), anotacoes_vinculos: seguinte.itens.map(v => ({ tipo: v.tipo, id: v.id, observacao: 'Rever', encaminhamento: 'REVISAR' as const })) });
    const pedidoDivergente = { ...pedido, decisoes: [lote1.id, lote2.id, lote3.id, lote4.id] };
    const primeiraPagina = await decisoes.consolidar(igreja, usuario, pessoa, pedidoDivergente);
    expect(primeiraPagina).toMatchObject({ totais: { divergentes: 101 }, pagina: 0, proxima_pagina: 1, divergencias_limitadas: true });
    expect(primeiraPagina.divergencias).toHaveLength(100);
    const ultimaPagina = await decisoes.consolidar(igreja, usuario, pessoa, { ...pedidoDivergente, decisoes: [...pedidoDivergente.decisoes].reverse(), pagina: 1, hash_conferencia: primeiraPagina.hash_conferencia });
    expect(ultimaPagina).toMatchObject({ pagina: 1, proxima_pagina: null, divergencias_limitadas: false });
    expect(ultimaPagina.divergencias).toHaveLength(1);
    expect(new Set([...primeiraPagina.divergencias, ...ultimaPagina.divergencias].map(d => d.id)).size).toBe(101);
    await expect(decisoes.consolidar(igreja, usuario, pessoa, { ...pedidoDivergente, pagina: 1 })).rejects.toThrow('primeira página');
    await expect(decisoes.consolidar(igreja, usuario, pessoa, { ...pedidoDivergente, decisoes: [lote1.id, lote2.id], pagina: 1, hash_conferencia: primeiraPagina.hash_conferencia })).rejects.toThrow('conferência mudou');
    await expect(decisoes.consolidar(igreja, usuario, pessoa, { ...pedidoDivergente, pagina: 2, hash_conferencia: primeiraPagina.hash_conferencia })).rejects.toThrow('inválida');
    await p.decisao_revisao_orgao.update({ where: { id: lote3.id }, data: { resultado: 'DESFAVORAVEL' } });
    await expect(decisoes.consolidar(igreja, usuario, pessoa, { ...pedidoDivergente, pagina: 1, hash_conferencia: primeiraPagina.hash_conferencia })).rejects.toThrow('conferência mudou');
    await p.decisao_revisao_orgao.update({ where: { id: lote3.id }, data: { resultado: 'FAVORAVEL' } });



    await expect(data.aplicar(igreja, usuario, pessoa, { ...propostaData, ...explicacao, hash_previa: extensa.hash }, true)).rejects.toThrow('revisão dos vínculos de órgão');
    await expect(decisoes.consultarVinculos(igreja, usuario, pessoa, { ...consulta, pagina: 1 })).rejects.toThrow('primeira página');
    await expect(decisoes.consultarVinculos(igreja, usuario, pessoa, { ...consulta, pagina: 1, hash_detalhes: 'a'.repeat(64) })).rejects.toThrow('mudaram');
    await expect(decisoes.consultarVinculos(outra, usuario, pessoa, consulta)).rejects.toThrow();
    await p.membro_orgao.delete({ where: { id: seguinte.itens[0].id } });
    await expect(decisoes.consolidar(igreja, usuario, pessoa, pedido)).rejects.toThrow('nova prévia');
    await expect(decisoes.consultarVinculos(igreja, usuario, pessoa, { ...consulta, pagina: 1, hash_detalhes: pagina.hash_detalhes })).rejects.toThrow('nova prévia');
    await expect(data.previa(outra, usuario, pessoa, propostaData, true)).rejects.toThrow();
    expect((await p.eventos_membresia.findUniqueOrThrow({ where: { id: evento } })).data_evento.toISOString().slice(0, 10)).toBe('2020-01-01');
  });
});

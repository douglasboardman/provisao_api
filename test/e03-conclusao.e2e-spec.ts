import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionService } from '../src/auth/session.service';
import { AcessoSensivelService } from '../src/oficiais/acesso-sensivel.service';
import { CorrecaoMembresiaService } from '../src/oficiais/correcao-membresia.service';
import { CorrecaoConteudoService } from '../src/oficiais/correcao-conteudo.service';
import { InsercaoRetroativaService } from '../src/oficiais/insercao-retroativa.service';
import { OrdenacaoMembresiaService } from '../src/oficiais/ordenacao-membresia.service';
import { DecisaoRevisaoOrgaoService } from '../src/orgaos/decisao-revisao-orgao.service';
import { ParticipacaoService } from '../src/orgaos/participacao.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', outra = 'e0000000-0000-4000-8000-000000000002';
const admin = 'e1000000-0000-4000-8000-000000000001', adminOutra = 'e1000000-0000-4000-8000-000000000002';
const civil = (s: string) => new Date(`${s}T00:00:00Z`);
const evidencia = { autoridade: 'Órgão competente sintético', evidencia: 'Ato de teste' };

integration('E03: conclusão funcional', () => {
  let app: INestApplication, p: PrismaService, cookie: string, cookieAdmin: string, cookieOutra: string;
  let competencia = '';
  const gestor = randomUUID(), pessoaGestor = randomUUID(), unidade = randomUUID(), conselho = randomUUID();
  const pessoas = Array.from({ length: 4 }, () => randomUUID()), eventos = pessoas.map(() => randomUUID()), membros = pessoas.map(() => randomUUID());
  const anteriores = ['FEATURE_GOVERNANCA', 'FEATURE_ORGAOS', 'FEATURE_ORGAOS_GESTAO'].map(k => process.env[k]);
  const regras: string[] = [], valores: string[] = [];
  const hoje = new Date().toISOString().slice(0, 10);
  const patch = (path: string, sessao: string) => request(app.getHttpServer()).patch(path).set('Cookie', sessao).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
  const post = (path: string, sessao: string) => request(app.getHttpServer()).post(path).set('Cookie', sessao).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1');
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige E00 descartável.');
    for (const key of ['FEATURE_GOVERNANCA', 'FEATURE_ORGAOS', 'FEATURE_ORGAOS_GESTAO']) process.env[key] = 'true';
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(); await app.init(); p = app.get(PrismaService);
    for (const id of [pessoaGestor, ...pessoas]) await p.pessoas.create({ data: { id, igreja_id: igreja, nome_completo: 'Pessoa original', sexo: 'FEMININO', data_nascimento: civil('1980-01-01') } });
    await p.usuarios.create({ data: { id: gestor, igreja_id: igreja, pessoa_id: pessoaGestor, perfil: 'GESTOR', nome_usuario: 'Gestora original', email_login: `${gestor}@example.invalid`, senha_hash: 'inutilizavel', ativo: true } });
    for (const [id, tipo, constituicao] of [[unidade, 'UNIDADE_MINISTERIAL', 'DESIGNACAO'], [conselho, 'CONSELHO', 'OFICIAL']] as const) await p.orgao_interno.create({ data: { id, igreja_id: igreja, tipo, constituicao, nome: 'Órgão original', finalidade: 'Teste', data_criacao: civil('2020-01-01'), criador_id: admin, instituidor_id: pessoaGestor, evidencia_instituicao: 'Teste' } });
    for (const [i, pessoa] of pessoas.entries()) {
      await p.eventos_membresia.create({ data: { id: eventos[i], igreja_id: igreja, pessoa_id: pessoa, data_evento: civil('2020-01-01'), tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE' } });
      await p.membro_orgao.create({ data: { id: membros[i], igreja_id: igreja, orgao_id: unidade, pessoa_id: pessoa, inicio: civil('2025-01-01') } });
    }
    for (const [nome, destino] of [['Motivações de Admissão', 'PROFISSAO_DE_FE'], ['Motivações de Admissão', 'BATISMO_NA_INFANCIA'], ['Rols de Admissão', 'COMUNGANTES'], ['Rols de Admissão', 'NAO_COMUNGANTES']]) {
      let regra = await p.regras_relacao_enum.findUnique({ where: { modulo_nome: { modulo: 'membresia', nome } } });
      if (!regra) { regra = await p.regras_relacao_enum.create({ data: { modulo: 'membresia', nome, tipo_regra: 'FILTRO', enum_classificador: 'membresia_tipo_evento', enum_classificado: nome.startsWith('Rols') ? 'membresia_rol' : 'membresia_motivacao_evento' } }); regras.push(regra.id); }
      if (!await p.relacao_enum_valores.findFirst({ where: { regra_id: regra.id, valor_classificador: 'ADMISSAO', valor_classificado: destino } })) valores.push((await p.relacao_enum_valores.create({ data: { regra_id: regra.id, valor_classificador: 'ADMISSAO', valor_classificado: destino } })).id);
    }
    await app.get(AcessoSensivelService).conceder(igreja, admin, { usuario_id: gestor, pode_consultar: true, pode_registrar: true, fundamento: 'Teste E03' });
    cookie = `provisao_session=${await app.get(SessionService).create(gestor, igreja, 0)}`;
    const a = await p.usuarios.findUniqueOrThrow({ where: { id: admin } }), b = await p.usuarios.findUniqueOrThrow({ where: { id: adminOutra } });
    cookieAdmin = `provisao_session=${await app.get(SessionService).create(admin, igreja, a.auth_version)}`;
    cookieOutra = `provisao_session=${await app.get(SessionService).create(adminOutra, outra, b.auth_version)}`;
  });
  afterAll(async () => {
    for (const [i, key] of ['FEATURE_GOVERNANCA', 'FEATURE_ORGAOS', 'FEATURE_ORGAOS_GESTAO'].entries()) { if (anteriores[i] === undefined) delete process.env[key]; else process.env[key] = anteriores[i]; }
    if (!p) return;
    const orgaos = [unidade, conselho], alvos = [pessoaGestor, ...pessoas];
    const atos = await p.ato_orgao.findMany({ where: { orgao_id: { in: orgaos } }, select: { id: true } });
    await p.logs_atividades.deleteMany({ where: { OR: [{ usuario_id: gestor }, { registro_id: { in: [...orgaos, ...atos.map(a => a.id)] } }] } });
    await p.item_ordenacao_membresia.deleteMany({ where: { pessoa_id: { in: pessoas } } });
    await p.ordenacao_membresia.deleteMany({ where: { pessoa_id: { in: pessoas } } });
    await p.correcao_data_membresia.deleteMany({ where: { evento_id: { in: eventos } } });
    await p.correcao_conteudo_membresia.deleteMany({ where: { pessoa_id: { in: pessoas } } });
    await p.insercao_retroativa_membresia.deleteMany({ where: { pessoa_id: { in: pessoas } } });
    await p.decisao_revisao_orgao.deleteMany({ where: { pessoa_id: { in: pessoas } } });
    await p.ato_orgao.deleteMany({ where: { orgao_id: { in: orgaos } } });
    await p.conducao_reuniao_orgao.deleteMany({ where: { orgao_id: { in: orgaos } } });
    await p.membro_orgao.deleteMany({ where: { orgao_id: { in: orgaos } } });
    await p.ocupacao_cargo.deleteMany({ where: { orgao_id: { in: orgaos } } });
    await p.cargo_orgao.deleteMany({ where: { orgao_id: { in: orgaos } } });
    await p.orgao_interno.deleteMany({ where: { id: { in: orgaos } } });
    await p.competencia_unidades.deleteMany({ where: { usuario_id: gestor } });
    await p.acesso_eventos_sensiveis.deleteMany({ where: { usuario_id: gestor } });
    await p.usuarios.deleteMany({ where: { id: gestor } });
    await p.eventos_membresia.deleteMany({ where: { pessoa_id: { in: alvos } } });
    await p.pessoas.deleteMany({ where: { id: { in: alvos } } });
    await p.relacao_enum_valores.deleteMany({ where: { id: { in: valores } } });
    await p.regras_relacao_enum.deleteMany({ where: { id: { in: regras } } });
    await app.close();
  });
  it('mantém cadastro por competência e congela a identificação histórica', async () => {
    const dados = { nome: 'Órgão atualizado', sigla: 'AT', finalidade: 'Finalidade atual', ...evidencia, idempotencia: randomUUID() };
    await patch(`/orgaos/gestao/${unidade}/cadastro`, cookieAdmin).send(dados).expect(403);
    await patch(`/orgaos/gestao/${unidade}/cadastro`, cookie).send(dados).expect(403);
    competencia = (await p.competencia_unidades.create({ data: { igreja_id: igreja, usuario_id: gestor, pessoa_id: pessoaGestor, registrado_por: admin, inicio: civil('2020-01-01'), autoridade: 'Teste', evidencia: 'Teste' } })).id;
    await patch(`/orgaos/gestao/${unidade}/cadastro`, cookieOutra).send(dados).expect(404);
    await request(app.getHttpServer()).patch(`/orgaos/gestao/${unidade}/cadastro`).set('Cookie', cookie).send(dados).expect(403);
    const salvo = await patch(`/orgaos/gestao/${unidade}/cadastro`, cookie).send(dados).expect(200);
    expect((await patch(`/orgaos/gestao/${unidade}/cadastro`, cookie).send(dados).expect(200)).body).toEqual(salvo.body);
    await p.usuarios.update({ where: { id: gestor }, data: { nome_usuario: 'Gestora renomeada' } });
    const lista = await request(app.getHttpServer()).get(`/orgaos/${unidade}/atos`).set('Cookie', cookie).expect(200);
    expect(lista.body.itens[0].operador.nome_usuario).toBe('Gestora original');
    const ato = await request(app.getHttpServer()).get(`/orgaos/${unidade}/atos/${salvo.body.ato_id}`).set('Cookie', cookie).expect(200);
    expect(ato.body.detalhes.anterior.nome).toBe('Órgão original');
    await request(app.getHttpServer()).get(`/orgaos/${conselho}/atos/${salvo.body.ato_id}`).set('Cookie', cookie).expect(404);
    await request(app.getHttpServer()).get(`/orgaos/${unidade}/atos/${salvo.body.ato_id}`).set('Cookie', cookieOutra).expect(404);
    await p.pessoas.update({ where: { id: pessoas[0] }, data: { nome_completo: 'Pessoa renomeada' } });
    const detalhe = await request(app.getHttpServer()).get(`/orgaos/${unidade}?data=${hoje}`).set('Cookie', cookie).expect(200);
    expect(detalhe.body.participacoes.find(m => m.id === membros[0]).pessoa.nome_completo).toBe('Pessoa original');
  });
  it('registra convidado local de outra igreja e não lhe concede presidência ou gestão', async () => {
    const dados = { pessoa_id: pessoaGestor, referencia: 'Reunião externa 01', data_reuniao: hoje, motivo: 'Ausência do pastor', modalidade: 'CONVIDADO', fundamento: 'Convite do órgão competente', limites_pauta: 'Somente pauta autorizada', ratificacao_pendente: true, ...evidencia, idempotencia: randomUUID() };
    const rota = `/orgaos/gestao/${conselho}/conducoes-reuniao`;
    const salvo = await post(rota, cookieAdmin).send(dados).expect(201);
    expect((await post(rota, cookieAdmin).send(dados).expect(201)).body).toEqual(salvo.body);
    await post(rota, cookieAdmin).send({ ...dados, modalidade: 'MEMBRO_CONSELHO', referencia: 'Outra reunião', idempotencia: randomUUID() }).expect(400);
    await post(rota, cookieOutra).send({ ...dados, idempotencia: randomUUID() }).expect(404);
    const cargo = await p.cargo_orgao.create({ data: { igreja_id: igreja, orgao_id: unidade, nome: 'Líder', codigo: 'LIDER' } });
    await post(`/orgaos/gestao/${unidade}/cargos/${cargo.id}/designacoes`, cookie).send({ pessoa_id: pessoas[0], data_efeito: hoje, ordem_efeito: 1, evidencia: 'Teste', idempotencia: randomUUID() }).expect(403);
    expect(await p.presidencia_conselho.count({ where: { oficial: { pessoa_id: pessoaGestor } } })).toBe(0);
    expect((await p.ato_orgao.findUniqueOrThrow({ where: { id: salvo.body.ato_id } })).detalhes).toMatchObject({ limites_pauta: dados.limites_pauta, ratificacao_pendente: true });
  });
  it('ordena saída e reinclusão no mesmo dia sem sobreposição', async () => {
    const service = app.get(ParticipacaoService), dados = { pessoa_id: pessoas[0], data_efeito: hoje, evidencia: 'Teste', idempotencia: randomUUID() };
    const saiu = await service.alterar(igreja, gestor, unidade, 'SAIDA', dados);
    const novo = await service.alterar(igreja, gestor, unidade, 'INCLUSAO', { ...dados, idempotencia: randomUUID() });
    const a = await p.membro_orgao.findUniqueOrThrow({ where: { id: saiu.membro_id } }), b = await p.membro_orgao.findUniqueOrThrow({ where: { id: novo.membro_id } });
    expect(b.inicio_ordem).toBeGreaterThan(a.fim_ordem!);
    expect(await p.membro_orgao.count({ where: { orgao_id: unidade, pessoa_id: pessoas[0], fim: null } })).toBe(1);
  });
  it.each(['DATA', 'CONTEUDO', 'INSERCAO', 'ORDEM'] as const)('aplica %s com revisão integral na mesma transação e protege repetição e competência', async operacao => {
    const indice = ['DATA', 'CONTEUDO', 'INSERCAO', 'ORDEM'].indexOf(operacao), pessoa = pessoas[indice], evento = eventos[indice];
    const data = app.get(CorrecaoMembresiaService), conteudo = app.get(CorrecaoConteudoService), insercao = app.get(InsercaoRetroativaService), ordem = app.get(OrdenacaoMembresiaService), decisoes = app.get(DecisaoRevisaoOrgaoService);
    const propostaData = { evento_id: evento, nova_data: '2020-01-02' };
    const propostaConteudo = { evento_id: evento, tipo_evento: 'ADMISSAO' as const, rol: 'NAO_COMUNGANTES' as const, motivacao_evento: 'BATISMO_NA_INFANCIA' as const };
    const propostaInsercao = { data_evento: '2019-01-01', tipo_evento: 'ADMISSAO' as const, rol: 'COMUNGANTES' as const, motivacao_evento: 'PROFISSAO_DE_FE' as const, igreja_origem: null, igreja_destino: null, observacoes: null };
    const propostaOrdem = { data_evento: '2020-01-01', itens: [{ evento_id: evento, ordem: 1 }] };
    const proposta = operacao === 'DATA' ? propostaData : operacao === 'CONTEUDO' ? propostaConteudo : operacao === 'INSERCAO' ? propostaInsercao : propostaOrdem;
    if (operacao === 'INSERCAO') await p.membro_orgao.createMany({ data: Array.from({ length: 101 }, (_, i) => ({ igreja_id: igreja, orgao_id: unidade, pessoa_id: pessoa, inicio: new Date(Date.UTC(2021, 0, i * 2 + 1)), fim: new Date(Date.UTC(2021, 0, i * 2 + 2)), fim_ordem: 1 })) });
    const previa = operacao === 'DATA' ? await data.previa(igreja, gestor, pessoa, propostaData, true) : operacao === 'CONTEUDO' ? await conteudo.previa(igreja, gestor, pessoa, propostaConteudo) : operacao === 'INSERCAO' ? await insercao.previa(igreja, gestor, pessoa, propostaInsercao) : await ordem.previa(igreja, gestor, pessoa, propostaOrdem, true);
    const detalhes = await decisoes.consultarVinculos(igreja, gestor, pessoa, { operacao, proposta, hash_previa: previa.hash, pagina: 0 });
    const todosDetalhes = [...detalhes.itens];
    if (detalhes.proxima_pagina !== null) todosDetalhes.push(...(await decisoes.consultarVinculos(igreja, gestor, pessoa, { operacao, proposta, hash_previa: previa.hash, pagina: detalhes.proxima_pagina, hash_detalhes: detalhes.hash_detalhes })).itens);
    const base = { operacao, proposta, hash_previa: previa.hash, resultado: 'FAVORAVEL' as const, ...evidencia, justificativa: 'Revisão institucional', ciente: true as const };
    const parcial = await decisoes.registrar(igreja, gestor, pessoa, { ...base, idempotencia: randomUUID() });
    const negativo = await decisoes.registrar(igreja, gestor, pessoa, { ...base, resultado: 'DESFAVORAVEL', idempotencia: randomUUID() });
    const decisao = await decisoes.registrar(igreja, gestor, pessoa, { ...base, hash_detalhes: detalhes.hash_detalhes, anotacoes_vinculos: detalhes.itens.map(v => ({ tipo: v.tipo, id: v.id, observacao: 'Preservação institucional fundamentada do ato anterior', encaminhamento: 'PRESERVAR' as const })), idempotencia: randomUUID() });
    const decisoesCompletas = [decisao.id];
    if (todosDetalhes.length > 100) decisoesCompletas.push((await decisoes.registrar(igreja, gestor, pessoa, { ...base, hash_detalhes: detalhes.hash_detalhes, anotacoes_vinculos: todosDetalhes.slice(100).map(v => ({ tipo: v.tipo, id: v.id, observacao: 'Revisão dos vínculos adicionais', encaminhamento: 'PRESERVAR' as const })), idempotencia: randomUUID() })).id);
    const aplicacao = { ...evidencia, justificativa: 'Correção conferida', ciente: true as const, hash_previa: previa.hash, idempotencia: randomUUID() };
    const aplicar = (ids: string[]) => operacao === 'DATA' ? data.aplicar(igreja, gestor, pessoa, { ...propostaData, ...aplicacao, decisoes_orgao: ids }, true) : operacao === 'CONTEUDO' ? conteudo.aplicar(igreja, gestor, pessoa, { ...propostaConteudo, ...aplicacao, decisoes_orgao: ids }) : operacao === 'INSERCAO' ? insercao.aplicar(igreja, gestor, pessoa, { ...propostaInsercao, ...aplicacao, decisoes_orgao: ids }) : ordem.aplicar(igreja, gestor, pessoa, { ...propostaOrdem, ...aplicacao, decisoes_orgao: ids }, true);
    await expect(aplicar([parcial.id])).rejects.toThrow('todos os vínculos');
    await expect(aplicar([negativo.id])).rejects.toThrow('contrária');
    process.env.FEATURE_ORGAOS_GESTAO = 'false';
    await expect(aplicar(decisoesCompletas)).rejects.toThrow('Gestão de órgãos indisponível');
    process.env.FEATURE_ORGAOS_GESTAO = 'true';
    await p.competencia_unidades.update({ where: { id: competencia }, data: { fim: civil(hoje) } });
    await expect(aplicar(decisoesCompletas)).rejects.toThrow('competência institucional');
    await p.competencia_unidades.update({ where: { id: competencia }, data: { fim: null } });
    const extra = await p.membro_orgao.create({ data: { igreja_id: igreja, orgao_id: unidade, pessoa_id: pessoa, inicio: civil('2023-01-01'), fim: civil('2023-02-01'), fim_ordem: 1 } });
    await expect(aplicar(decisoesCompletas)).rejects.toThrow('nova prévia');
    await p.membro_orgao.delete({ where: { id: extra.id } });
    const [a, b] = await Promise.all([aplicar(decisoesCompletas), aplicar(decisoesCompletas)]);
    expect(a.id).toBe(b.id);
    expect(a.impacto).toMatchObject({ revisao_orgaos: { operador_id: gestor, competencia_id: competencia, vinculos: todosDetalhes } });
    await expect(aplicar([parcial.id])).rejects.toThrow('Chave');
  });
});

import { SituacaoExercicioService } from '../src/oficiais/situacao-exercicio.service';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';
import { randomUUID } from 'crypto';
import { MandatoService } from '../src/oficiais/mandato.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AcessoSensivelService } from '../src/oficiais/acesso-sensivel.service';
import { CorrecaoMembresiaService } from '../src/oficiais/correcao-membresia.service';
import { CorrecaoConteudoService } from '../src/oficiais/correcao-conteudo.service';
import { OrdenacaoMembresiaService } from '../src/oficiais/ordenacao-membresia.service';
import { InsercaoRetroativaService } from '../src/oficiais/insercao-retroativa.service';
import { RevisaoEleitoralService } from '../src/oficiais/revisao-eleitoral.service';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', outra = 'e0000000-0000-4000-8000-000000000002', admin = 'e1000000-0000-4000-8000-000000000001';
integration('E02: decisão formal e sinalização eleitoral', () => {
  const p = new PrismaService(), acesso = new AcessoSensivelService(p), data = new CorrecaoMembresiaService(p);
  const service = new RevisaoEleitoralService(p, data, new CorrecaoConteudoService(p), new OrdenacaoMembresiaService(p), new InsercaoRetroativaService(p));
  const pessoa = randomUUID(), usuario = randomUUID(), oficial = randomUUID(), evento = randomUUID(), mandato = randomUUID(), politica = randomUUID(), conferencia = randomUUID();
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await p.$connect();
    await p.usuarios.create({ data: { id: usuario, igreja_id: igreja, nome_usuario: 'Secretário sintético', email_login: `${usuario}@example.invalid`, senha_hash: 'sem-senha', perfil: 'SECRETARIO', ativo: true } });
    await p.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Pessoa sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await p.eventos_membresia.create({ data: { id: evento, igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2024-01-01') } });
    await p.oficial.create({ data: { id: oficial, igreja_id: igreja, pessoa_id: pessoa, tipo: 'DIACONO' } });
    await p.politica_eleicao_oficial.create({ data: { id: politica, igreja_id: igreja, versao: randomUUID(), fonte: 'Livro', autoridade: 'Conselho', idade_minima: 18, aniversario_bissexto: 'DIA_28_FEVEREIRO', vigente_desde: new Date('2020-01-01'), criado_por_id: usuario } });
    await p.conferencia_eleicao_oficial.create({ data: { id: conferencia, igreja_id: igreja, pessoa_id: pessoa, politica_id: politica, data_eleicao: new Date('2024-02-01'), data_recepcao: new Date('2020-01-01'), evidencia_recepcao: 'Livro', capacidade_confirmada: true, evidencia_capacidade: 'Livro', resultado: { evento_membresia_id: evento }, criado_por_id: usuario } });
    await p.mandato_oficial.create({ data: { id: mandato, igreja_id: igreja, oficial_id: oficial, conferencia_id: conferencia, data_eleicao: new Date('2024-02-01'), data_posse: new Date('2024-02-01'), termino_previsto: new Date('2029-01-31'), autoridade: 'Conselho', evidencia: 'Livro', avaliacao_eleicao: {} } });
    await acesso.conceder(igreja, admin, { usuario_id: usuario, pode_consultar: true, pode_registrar: true, fundamento: 'Autorização sintética' });
  });
  afterAll(async () => {
    await p.logs_atividades.deleteMany({ where: { usuario_id: usuario } });
    await p.revisao_eleitoral_item.deleteMany({ where: { decisao: { pessoa_id: pessoa } } }); await p.decisao_revisao_eleitoral.deleteMany({ where: { pessoa_id: pessoa } });
    await p.correcao_data_membresia.deleteMany({ where: { evento_id: evento } }); await p.acesso_eventos_sensiveis.deleteMany({ where: { usuario_id: usuario } });
    await p.mandato_oficial.deleteMany({ where: { id: mandato } }); await p.conferencia_eleicao_oficial.deleteMany({ where: { id: conferencia } }); await p.politica_eleicao_oficial.deleteMany({ where: { id: politica } });
    await p.oficial.deleteMany({ where: { id: oficial } }); await p.eventos_membresia.deleteMany({ where: { pessoa_id: pessoa } }); await p.pessoas.deleteMany({ where: { id: pessoa } }); await p.usuarios.deleteMany({ where: { id: usuario } }); await p.$disconnect();
  });
  it('exige decisão vinculada à prévia e sinaliza atos preservados', async () => {
    const proposta = { evento_id: evento, nova_data: '2024-03-01' };
    const previa = await data.previa(igreja, usuario, pessoa, proposta, true); expect(previa.bloqueada).toBe(true);
    const aplicacao = { ...proposta, hash_previa: previa.hash, justificativa: 'Correção', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true as const };
    await expect(data.aplicar(igreja, usuario, pessoa, aplicacao, true)).rejects.toThrow('decisão formal');
    const entrada = { operacao: 'DATA' as const, proposta, hash_previa: previa.hash, autoridade: 'Concílio', evidencia: 'Ata formal', justificativa: 'Autoriza correção e revisão', idempotencia: randomUUID(), ciente: true as const };
    await expect(service.registrar(outra, usuario, pessoa, entrada)).rejects.toThrow();
    const anteriorFeature = process.env.FEATURE_GOVERNANCA; process.env.FEATURE_GOVERNANCA = 'true';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile(), app = mod.createNestApplication(); await app.init();
    let a: Awaited<ReturnType<typeof service.registrar>>;
    try {
      const cookie = `provisao_session=${await app.get(SessionService).create(usuario, igreja, 0)}`;
      const resposta = await request(app.getHttpServer()).post(`/oficiais/pessoas/${pessoa}/revisoes-eleitorais`).set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send(entrada).expect(201);
      a = await service.registrar(igreja, usuario, pessoa, entrada); expect(resposta.body.id).toBe(a.id);
      const listagem = await request(app.getHttpServer()).get(`/oficiais/pessoas/${pessoa}/revisoes-eleitorais`).set('Cookie', cookie).expect(200);
      expect(listagem.headers['cache-control']).toContain('no-store'); expect(listagem.body).toHaveLength(1);
    } finally { await app.close(); if (anteriorFeature === undefined) delete process.env.FEATURE_GOVERNANCA; else process.env.FEATURE_GOVERNANCA = anteriorFeature; }

    await expect(data.aplicar(igreja, usuario, pessoa, { ...aplicacao, decisao_id: randomUUID() }, true)).rejects.toThrow('Decisão');
    const previaOficial = await data.previa(igreja, usuario, oficial, proposta);
    const decisaoOficial = await service.registrar(igreja, usuario, pessoa, { ...entrada, oficial_id: oficial, hash_previa: previaOficial.hash, idempotencia: randomUUID() });
    await expect(data.aplicar(igreja, usuario, pessoa, { ...aplicacao, decisao_id: decisaoOficial.id }, true)).rejects.toThrow('Decisão');

    await p.eventos_membresia.update({ where: { id: evento }, data: { observacoes: 'Contexto atualizado' } });
    await expect(data.aplicar(igreja, usuario, pessoa, { ...aplicacao, decisao_id: a.id }, true)).rejects.toThrow('nova prévia');
    expect((await p.decisao_revisao_eleitoral.findUniqueOrThrow({ where: { id: a.id } })).aplicado_em).toBeNull();
    const novaPrevia = await data.previa(igreja, usuario, pessoa, proposta, true);
    const decisaoEfetiva = await service.registrar(igreja, usuario, pessoa, { ...entrada, hash_previa: novaPrevia.hash, idempotencia: randomUUID() });
    const aplicacaoAtual = { ...aplicacao, hash_previa: novaPrevia.hash, decisao_id: decisaoEfetiva.id };
    const resultado = await data.aplicar(igreja, usuario, pessoa, aplicacaoAtual, true);
    expect((await data.aplicar(igreja, usuario, pessoa, aplicacaoAtual, true)).id).toBe(resultado.id);
    expect(await p.conferencia_eleicao_oficial.count({ where: { id: conferencia } })).toBe(1);
    expect(await p.mandato_oficial.count({ where: { id: mandato } })).toBe(1);
    const itens = await p.revisao_eleitoral_item.findMany({ where: { decisao_id: decisaoEfetiva.id } });
    expect(itens.map(i => i.conferencia_id).filter(Boolean)).toEqual([conferencia]); expect(itens.map(i => i.mandato_id).filter(Boolean)).toEqual([mandato]);
    expect(itens.every(i => !i.revisado_em)).toBe(true);
    expect(await new SituacaoExercicioService(p).consultar(igreja, usuario, oficial, '2024-02-01')).toMatchObject({ revisao_pendente: true });
    expect((await service.listar(igreja, usuario, pessoa)).find(r => r.id === decisaoEfetiva.id)?.aplicado_em).toBeTruthy();
    const conferenciaItem = itens.find(i => i.conferencia_id === conferencia)!;
    const mandatoItem = itens.find(i => i.mandato_id === mandato)!;
    const registroMandato = { conferencia_id: conferencia, data_posse: '2024-02-01', autoridade: 'Conselho', evidencia: 'Livro', evidencia_capacidade_posse: 'Livro' };
    await expect(new MandatoService(p).registrar(igreja, usuario, oficial, registroMandato)).rejects.toThrow('sinalizada');
    const conclusao = { autoridade: 'Concílio', evidencia: 'Ata formal', conclusao: 'Ato revisado; uso não autorizado', permite_reutilizacao: false, ciente: true as const };
    await expect(service.concluir(outra, usuario, conferenciaItem.id, conclusao)).rejects.toThrow();
    const concluido = await service.concluir(igreja, usuario, conferenciaItem.id, conclusao);
    expect((await service.concluir(igreja, usuario, conferenciaItem.id, conclusao)).revisado_em).toEqual(concluido.revisado_em);
    await expect(service.concluir(igreja, usuario, conferenciaItem.id, { ...conclusao, permite_reutilizacao: true })).rejects.toThrow('já foi concluída');
    await expect(new MandatoService(p).registrar(igreja, usuario, oficial, registroMandato)).rejects.toThrow('sinalizada');
    await expect(service.concluir(igreja, usuario, mandatoItem.id, { ...conclusao, permite_reutilizacao: true })).rejects.toThrow('só se aplica');
    const featureAnterior = process.env.FEATURE_GOVERNANCA; process.env.FEATURE_GOVERNANCA = 'true';
    const modConclusao = await Test.createTestingModule({ imports: [AppModule] }).compile(), appConclusao = modConclusao.createNestApplication(); await appConclusao.init();
    try {
      const cookie = `provisao_session=${await appConclusao.get(SessionService).create(usuario, igreja, 0)}`;
      await request(appConclusao.getHttpServer()).post(`/oficiais/revisoes-eleitorais/${mandatoItem.id}/concluir`).set('Cookie', cookie).set('Origin', 'http://localhost:3001').set('X-Provisao-Request', '1').send(conclusao).expect(201);
    } finally { await appConclusao.close(); if (featureAnterior === undefined) delete process.env.FEATURE_GOVERNANCA; else process.env.FEATURE_GOVERNANCA = featureAnterior; }
    expect(await new SituacaoExercicioService(p).consultar(igreja, usuario, oficial, '2024-02-01')).toMatchObject({ revisao_pendente: false });
    const outroOficial = randomUUID(), outraConferencia = randomUUID();
    await p.oficial.create({ data: { id: outroOficial, igreja_id: igreja, pessoa_id: pessoa, tipo: 'PRESBITERO_REGENTE' } });
    await p.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: outroOficial, tipo: 'ORDENACAO', data_efeito: new Date('2020-01-01'), ordem: 1, autoridade: 'Concílio', evidencia: 'Livro' } });
    await p.conferencia_eleicao_oficial.create({ data: { id: outraConferencia, igreja_id: igreja, pessoa_id: pessoa, politica_id: politica, data_eleicao: new Date('2024-04-01'), data_recepcao: new Date('2020-01-01'), evidencia_recepcao: 'Livro', capacidade_confirmada: true, evidencia_capacidade: 'Livro', resultado: {}, criado_por_id: usuario } });
    const itemNovo = await p.revisao_eleitoral_item.create({ data: { igreja_id: igreja, decisao_id: decisaoEfetiva.id, conferencia_id: outraConferencia } });
    try {
      const propostaMandato = { conferencia_id: outraConferencia, data_posse: '2024-04-01', autoridade: 'Conselho', evidencia: 'Livro', evidencia_capacidade_posse: 'Livro' };
      await expect(new MandatoService(p).registrar(igreja, usuario, outroOficial, propostaMandato)).rejects.toThrow('sinalizada');
      await service.concluir(igreja, usuario, itemNovo.id, { ...conclusao, conclusao: 'Autorizado o uso', permite_reutilizacao: true });
      expect((await new MandatoService(p).registrar(igreja, usuario, outroOficial, propostaMandato)).conferencia_id).toBe(outraConferencia);
    } finally {
      await p.mandato_oficial.deleteMany({ where: { oficial_id: outroOficial } });
      await p.revisao_eleitoral_item.deleteMany({ where: { id: itemNovo.id } });
      await p.conferencia_eleicao_oficial.deleteMany({ where: { id: outraConferencia } });
      await p.evento_oficial.deleteMany({ where: { oficial_id: outroOficial } }); await p.oficial.deleteMany({ where: { id: outroOficial } });
    }


  });
});

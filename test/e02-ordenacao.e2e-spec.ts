import { RevisaoEleitoralService } from '../src/oficiais/revisao-eleitoral.service';
import { CorrecaoMembresiaService } from '../src/oficiais/correcao-membresia.service';
import { CorrecaoConteudoService } from '../src/oficiais/correcao-conteudo.service';
import { InsercaoRetroativaService } from '../src/oficiais/insercao-retroativa.service';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AcessoSensivelService } from '../src/oficiais/acesso-sensivel.service';
import { OrdenacaoMembresiaService } from '../src/oficiais/ordenacao-membresia.service';
import { eventoVigente } from '../src/eventos-membresia/estado-temporal';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', outra = 'e0000000-0000-4000-8000-000000000002', admin = 'e1000000-0000-4000-8000-000000000001';
integration('E02: ordenação conferida de atos no mesmo dia', () => {
  const p = new PrismaService(), acesso = new AcessoSensivelService(p), service = new OrdenacaoMembresiaService(p);
  const pessoa = randomUUID(), pessoaSemOficio = randomUUID(), eventoIsolado = randomUUID(), usuario = randomUUID(), oficial = randomUUID(), admissao = randomUUID(), mudanca = randomUUID(), mandato = randomUUID();
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await p.$connect();
    await p.usuarios.create({ data: { id: usuario, igreja_id: igreja, nome_usuario: 'Secretário sintético', email_login: `${usuario}@example.invalid`, senha_hash: 'sem-senha', perfil: 'COMUM', ativo: true } });
    await p.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Pessoa sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await p.pessoas.create({ data: { id: pessoaSemOficio, igreja_id: igreja, nome_completo: 'Outra pessoa sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await p.eventos_membresia.create({ data: { id: eventoIsolado, igreja_id: igreja, pessoa_id: pessoaSemOficio, tipo_evento: 'ADMISSAO', rol: 'NAO_COMUNGANTES', motivacao_evento: 'BATISMO_NA_INFANCIA', data_evento: new Date('2025-02-01') } });
    await p.eventos_membresia.create({ data: { id: admissao, igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'ADMISSAO', rol: 'NAO_COMUNGANTES', motivacao_evento: 'BATISMO_NA_INFANCIA', data_evento: new Date('2025-01-01'), ordem_dia: 1 } });
    await p.eventos_membresia.create({ data: { id: mudanca, igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'MUDANCA_DE_ROL', rol_origem: 'NAO_COMUNGANTES', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2025-01-01'), ordem_dia: 2 } });
    await p.oficial.create({ data: { id: oficial, igreja_id: igreja, pessoa_id: pessoa, tipo: 'DIACONO' } });
    await p.mandato_oficial.create({ data: { id: mandato, igreja_id: igreja, oficial_id: oficial, data_eleicao: new Date('2026-01-01'), data_posse: new Date('2026-01-01'), termino_previsto: new Date('2030-12-31'), autoridade: 'Conselho', evidencia: 'Ata sintética', avaliacao_eleicao: {} } });
    await acesso.conceder(igreja, admin, { usuario_id: usuario, pode_consultar: true, pode_registrar: true, fundamento: 'Autorização sintética' });
  });
  afterAll(async () => {
    const ordens = await p.ordenacao_membresia.findMany({ where: { pessoa_id: { in: [pessoa, pessoaSemOficio] } }, select: { id: true } });
    await p.logs_atividades.deleteMany({ where: { OR: [{ usuario_id: usuario }, { registro_id: { in: [oficial, admissao, mudanca, mandato, ...ordens.map(o => o.id)] } }] } });
    await p.item_ordenacao_membresia.deleteMany({ where: { pessoa_id: { in: [pessoa, pessoaSemOficio] } } }); await p.ordenacao_membresia.deleteMany({ where: { pessoa_id: { in: [pessoa, pessoaSemOficio] } } });
    await p.acesso_eventos_sensiveis.deleteMany({ where: { usuario_id: usuario } }); await p.mandato_oficial.deleteMany({ where: { id: mandato } }); await p.oficial.deleteMany({ where: { id: oficial } });
    await p.eventos_membresia.deleteMany({ where: { pessoa_id: { in: [pessoa, pessoaSemOficio] } } }); await p.pessoas.deleteMany({ where: { id: { in: [pessoa, pessoaSemOficio] } } }); await p.usuarios.deleteMany({ where: { id: usuario } }); await p.$disconnect();
  });
  it('exige todos os atos, bloqueia sequência incoerente e preserva auditoria em repetição concorrente', async () => {
    const proposta = { data_evento: '2025-01-01', itens: [{ evento_id: admissao, ordem: 10 }, { evento_id: mudanca, ordem: 20 }] };
    await expect(service.previa(outra, usuario, oficial, proposta)).rejects.toThrow();
    await expect(service.previa(igreja, usuario, oficial, { ...proposta, itens: [proposta.itens[0], { evento_id: randomUUID(), ordem: 2 }] })).rejects.toThrow();
    const inversa = await service.previa(igreja, usuario, oficial, { ...proposta, itens: [{ evento_id: admissao, ordem: 2 }, { evento_id: mudanca, ordem: 1 }] });
    expect(inversa.bloqueada).toBe(true);
    const previa = await service.previa(igreja, usuario, oficial, proposta);
    expect(previa.bloqueada).toBe(false);
    expect(previa.mandatos[0].rol_eleicao_antes).toBe('COMUNGANTES');
    expect(previa.mandatos[0].rol_eleicao_depois).toBe('COMUNGANTES');
    const payload = { ...proposta, hash_previa: previa.hash, justificativa: 'Livro conferido', autoridade: 'Conselho', evidencia: 'Livro externo', idempotencia: randomUUID(), ciente: true as const };
    const [a, b] = await Promise.all([service.aplicar(igreja, usuario, oficial, payload), service.aplicar(igreja, usuario, oficial, payload)]);
    expect(a.id).toBe(b.id);
    expect(await p.item_ordenacao_membresia.count({ where: { ordenacao_id: a.id } })).toBe(2);
    expect(await p.logs_atividades.count({ where: { tabela_afetada: 'ordenacao_membresia', registro_id: a.id } })).toBe(1);
    const eventos = await p.eventos_membresia.findMany({ where: { pessoa_id: pessoa } });
    const vigente = eventoVigente(eventos, new Date('2026-01-01'));
    expect(vigente.situacao === 'DEFINIDO' && vigente.evento.id).toBe(mudanca);
  });
  it('serializa inclusões simultâneas e rejeita rol de origem desatualizado', async () => {
    const entrada = (rol: 'COMUNGANTES' | 'NAO_COMUNGANTES') => p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'ADMISSAO', rol, motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2028-01-01') } });
    const tentativas = await Promise.allSettled([entrada('COMUNGANTES'), entrada('NAO_COMUNGANTES')]);
    expect(tentativas.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    const atual = await p.eventos_membresia.findFirstOrThrow({ where: { pessoa_id: pessoa, data_evento: new Date('2028-01-01') } });
    const incorreto = atual.rol === 'COMUNGANTES' ? 'NAO_COMUNGANTES' : 'COMUNGANTES';
    await expect(p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'MUDANCA_DE_ROL', rol: 'COMUNGANTES', rol_origem: incorreto, motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2029-01-01') } })).rejects.toThrow('Rol de origem desatualizado');
  });

  it('confere ato isolado de pessoa sem ofício e permite ato posterior no mesmo dia', async () => {
    const dados = { ordem: 1, justificativa: 'Livro conferido', autoridade: 'Conselho', evidencia: 'Livro externo', idempotencia: randomUUID(), ciente: true as const };
    await expect(service.ordenarUnico(outra, usuario, eventoIsolado, dados)).rejects.toThrow();
    const [a, b] = await Promise.all([service.ordenarUnico(igreja, usuario, eventoIsolado, dados), service.ordenarUnico(igreja, usuario, eventoIsolado, dados)]);
    expect(a.id).toBe(b.id);
    expect((await p.eventos_membresia.findUniqueOrThrow({ where: { id: eventoIsolado } })).ordem_dia).toBe(1);
    await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoaSemOficio, tipo_evento: 'MUDANCA_DE_ROL', rol_origem: 'NAO_COMUNGANTES', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2025-02-01'), ordem_dia: 2 } });
    await expect(p.eventos_membresia.update({ where: { id: eventoIsolado }, data: { ordem_dia: 9 } })).rejects.toThrow('conferência auditada');
  });

  it('confere sequência completa de pessoa sem ofício e mantém isolamento e repetição', async () => {
    const eventos = await service.eventosPessoa(igreja, usuario, pessoaSemOficio);
    expect(eventos).toHaveLength(2);
    const segundo = eventos.find(e => e.id !== eventoIsolado)!;
    const proposta = { data_evento: '2025-02-01', itens: [{ evento_id: eventoIsolado, ordem: 10 }, { evento_id: segundo.id, ordem: 20 }] };
    await expect(service.previa(outra, usuario, pessoaSemOficio, proposta, true)).rejects.toThrow();
    const previa = await service.previa(igreja, usuario, pessoaSemOficio, proposta, true);
    expect(previa.bloqueada).toBe(false);
    const dados = { ...proposta, hash_previa: previa.hash, justificativa: 'Livro conferido', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true as const };
    const [a, b] = await Promise.all([service.aplicar(igreja, usuario, pessoaSemOficio, dados, true), service.aplicar(igreja, usuario, pessoaSemOficio, dados, true)]);
    expect(a.id).toBe(b.id);
    expect(await p.item_ordenacao_membresia.count({ where: { ordenacao_id: a.id } })).toBe(2);
    expect(await service.listar(igreja, usuario, pessoaSemOficio, true)).toHaveLength(2);
    await expect(service.aplicar(igreja, usuario, pessoaSemOficio, dados)).rejects.toThrow();
  });

  it('bloqueia alteração do evento de referência da conferência mesmo quando o rol é igual', async () => {
    const pessoa2 = randomUUID();
    await p.pessoas.create({ data: { id: pessoa2, igreja_id: igreja, nome_completo: 'Pessoa sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    const politica = await p.politica_eleicao_oficial.create({ data: { igreja_id: igreja, versao: randomUUID(), fonte: 'Livro', autoridade: 'Conselho', idade_minima: 18, aniversario_bissexto: 'DIA_28_FEVEREIRO', vigente_desde: new Date('2020-01-01'), criado_por_id: usuario } });
    try {
      const primeiro = await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa2, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2024-01-01'), ordem_dia: 1 } });
      const ultimo = await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa2, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2024-01-01'), ordem_dia: 2 } });
      await p.conferencia_eleicao_oficial.create({ data: { igreja_id: igreja, pessoa_id: pessoa2, politica_id: politica.id, data_eleicao: new Date('2024-02-01'), data_recepcao: new Date('2020-01-01'), evidencia_recepcao: 'Livro', capacidade_confirmada: true, evidencia_capacidade: 'Livro', resultado: {}, criado_por_id: usuario } });
      const proposta = { data_evento: '2024-01-01', itens: [{ evento_id: primeiro.id, ordem: 2 }, { evento_id: ultimo.id, ordem: 1 }] };
      const previa = await service.previa(igreja, usuario, pessoa2, proposta, true);
      expect(previa.conferencia_alterada).toBe(true);
      expect(previa.bloqueada).toBe(true);
      await expect(service.aplicar(igreja, usuario, pessoa2, { ...proposta, hash_previa: previa.hash, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true }, true)).rejects.toThrow('revisão');
      const revisao = new RevisaoEleitoralService(p, new CorrecaoMembresiaService(p), new CorrecaoConteudoService(p), service, new InsercaoRetroativaService(p));
      const decisao = await revisao.registrar(igreja, usuario, pessoa2, { operacao: 'ORDEM', proposta, hash_previa: previa.hash, autoridade: 'Concílio', evidencia: 'Ata', justificativa: 'Autorizada', idempotencia: randomUUID(), ciente: true });
      await service.aplicar(igreja, usuario, pessoa2, { ...proposta, hash_previa: previa.hash, decisao_id: decisao.id, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true }, true);
      expect(await p.revisao_eleitoral_item.count({ where: { decisao_id: decisao.id, conferencia_id: { not: null } } })).toBe(1);

    } finally {
      await p.revisao_eleitoral_item.deleteMany({ where: { decisao: { pessoa_id: pessoa2 } } });
      await p.decisao_revisao_eleitoral.deleteMany({ where: { pessoa_id: pessoa2 } });
      await p.item_ordenacao_membresia.deleteMany({ where: { pessoa_id: pessoa2 } });
      await p.ordenacao_membresia.deleteMany({ where: { pessoa_id: pessoa2 } });
      await p.conferencia_eleicao_oficial.deleteMany({ where: { pessoa_id: pessoa2 } });
      await p.politica_eleicao_oficial.deleteMany({ where: { id: politica.id } });
      await p.eventos_membresia.deleteMany({ where: { pessoa_id: pessoa2 } });
      await p.pessoas.deleteMany({ where: { id: pessoa2 } });
    }
  });

});

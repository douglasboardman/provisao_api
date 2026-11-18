import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AcessoSensivelService } from '../src/oficiais/acesso-sensivel.service';
import { OrdenacaoMembresiaService } from '../src/oficiais/ordenacao-membresia.service';
import { CorrecaoMembresiaService } from '../src/oficiais/correcao-membresia.service';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', outra = 'e0000000-0000-4000-8000-000000000002', admin = 'e1000000-0000-4000-8000-000000000001';
integration('E02: correção retroativa de data de membresia', () => {
  const p = new PrismaService(), acesso = new AcessoSensivelService(p), service = new CorrecaoMembresiaService(p);
  const pessoa = randomUUID(), pessoaSemOficio = randomUUID(), eventoSemOficio = randomUUID(), usuario = randomUUID(), oficial = randomUUID(), evento = randomUUID(), mandato = randomUUID();
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await p.$connect();
    await p.usuarios.create({ data: { id: usuario, igreja_id: igreja, nome_usuario: 'Secretário sintético', email_login: `${usuario}@example.invalid`, senha_hash: 'sem-senha', perfil: 'SECRETARIO', ativo: true } });
    await p.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Pessoa sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await p.eventos_membresia.create({ data: { id: evento, igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2024-01-01') } });
    await p.pessoas.create({ data: { id: pessoaSemOficio, igreja_id: igreja, nome_completo: 'Pessoa sem ofício', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await p.eventos_membresia.create({ data: { id: eventoSemOficio, igreja_id: igreja, pessoa_id: pessoaSemOficio, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2024-01-01') } });
    await p.oficial.create({ data: { id: oficial, igreja_id: igreja, pessoa_id: pessoa, tipo: 'DIACONO' } });
    await p.mandato_oficial.create({ data: { id: mandato, igreja_id: igreja, oficial_id: oficial, data_eleicao: new Date('2026-01-01'), data_posse: new Date('2026-03-01'), termino_previsto: new Date('2031-02-28'), autoridade: 'Conselho', evidencia: 'Ata sintética', avaliacao_eleicao: {} } });
    await acesso.conceder(igreja, admin, { usuario_id: usuario, pode_consultar: true, pode_registrar: true, fundamento: 'Autorização sintética' });
  });
  afterAll(async () => {
    await p.logs_atividades.deleteMany({ where: { OR: [{ usuario_id: usuario }, { registro_id: { in: [oficial, evento, mandato] } }] } });
    await p.item_ordenacao_membresia.deleteMany({ where: { pessoa_id: pessoaSemOficio } }); await p.ordenacao_membresia.deleteMany({ where: { pessoa_id: pessoaSemOficio } });
    await p.correcao_data_membresia.deleteMany({ where: { evento: { pessoa_id: { in: [pessoa, pessoaSemOficio] } } } });
    await p.acesso_eventos_sensiveis.deleteMany({ where: { usuario_id: usuario } });
    await p.mandato_oficial.deleteMany({ where: { id: mandato } }); await p.oficial.deleteMany({ where: { id: oficial } });
    await p.eventos_membresia.deleteMany({ where: { pessoa_id: { in: [pessoa, pessoaSemOficio] } } }); await p.pessoas.deleteMany({ where: { id: { in: [pessoa, pessoaSemOficio] } } });
    await p.usuarios.deleteMany({ where: { id: usuario } }); await p.$disconnect();
  });
  it('simula, impede inelegibilidade e alterações obsoletas, e aplica uma única vez com auditoria', async () => {
    await expect(service.previa(outra, usuario, oficial, { evento_id: evento, nova_data: '2024-01-02' })).rejects.toThrow();
    const risco = await service.previa(igreja, usuario, oficial, { evento_id: evento, nova_data: '2026-02-01' });
    expect(risco.bloqueada).toBe(true);
    const justificacao = { justificativa: 'Correção conferida', autoridade: 'Conselho', evidencia: 'Livro sintético', ciente: true as const };
    await expect(service.aplicar(igreja, usuario, oficial, { evento_id: evento, nova_data: '2026-02-01', hash_previa: risco.hash, idempotencia: randomUUID(), ...justificacao })).rejects.toThrow();
    const previa = await service.previa(igreja, usuario, oficial, { evento_id: evento, nova_data: '2024-01-02' });
    expect(previa.bloqueada).toBe(false);
    const futuro = await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'DEMISSAO', rol: 'EXCLUIDOS', motivacao_evento: 'EXCLUSAO_A_PEDIDO', data_evento: new Date('2027-01-01') } });
    await expect(service.aplicar(igreja, usuario, oficial, { evento_id: evento, nova_data: '2024-01-02', hash_previa: previa.hash, idempotencia: randomUUID(), ...justificacao })).rejects.toThrow('nova prévia');
    await expect(service.previa(igreja, usuario, oficial, { evento_id: evento, nova_data: '2027-01-01' })).rejects.toThrow('ordem');
    expect((await service.previa(igreja, usuario, oficial, { evento_id: evento, nova_data: '2028-01-01' })).bloqueada).toBe(true);
    await p.eventos_membresia.delete({ where: { id: futuro.id } });
    const atual = await service.previa(igreja, usuario, oficial, { evento_id: evento, nova_data: '2024-01-02' });
    const dados = { evento_id: evento, nova_data: '2024-01-02', hash_previa: atual.hash, idempotencia: randomUUID(), ...justificacao };
    const [a, b] = await Promise.all([service.aplicar(igreja, usuario, oficial, dados), service.aplicar(igreja, usuario, oficial, dados)]);
    expect(a.id).toBe(b.id);
    expect((await p.eventos_membresia.findUniqueOrThrow({ where: { id: evento } })).data_evento.toISOString().slice(0, 10)).toBe('2024-01-02');
    expect(await p.correcao_data_membresia.count({ where: { evento_id: evento } })).toBe(1);
    expect(await p.logs_atividades.count({ where: { tabela_afetada: 'correcao_data_membresia', registro_id: a.id } })).toBe(1);
    // A exceção de trigger não pode ser usada para alterar outra informação no mesmo UPDATE.
    await expect(p.$transaction(async tx => {
      const tentativa = await tx.correcao_data_membresia.create({ data: { igreja_id: igreja, evento_id: evento, data_anterior: new Date('2024-01-02'), data_nova: new Date('2024-01-03'), impacto: {}, justificativa: 'Teste', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), criado_por_id: usuario } });
      await tx.$queryRaw`SELECT set_config('provisao.correcao_id', ${tentativa.id}, true), set_config('provisao.correcao_evento', ${evento}, true), set_config('provisao.correcao_data', '2024-01-03', true)`;
      await tx.eventos_membresia.update({ where: { id: evento }, data: { data_evento: new Date('2024-01-03'), observacoes: 'alteração indevida' } });
    })).rejects.toThrow();
    expect((await p.eventos_membresia.findUniqueOrThrow({ where: { id: evento } })).data_evento.toISOString().slice(0, 10)).toBe('2024-01-02');
  });
  it('confere a data de pessoa sem ofício com isolamento e repetição idempotente', async () => {
    const proposta = { evento_id: eventoSemOficio, nova_data: '2024-01-02' };
    await expect(service.previa(outra, usuario, pessoaSemOficio, proposta, true)).rejects.toThrow();
    await expect(service.previa(igreja, usuario, pessoa, proposta, true)).rejects.toThrow();
    const previa = await service.previa(igreja, usuario, pessoaSemOficio, proposta, true);
    expect(previa.bloqueada).toBe(false);
    const dados = { ...proposta, hash_previa: previa.hash, idempotencia: randomUUID(), justificativa: 'Livro conferido', autoridade: 'Conselho', evidencia: 'Livro', ciente: true as const };
    const [a, b] = await Promise.all([service.aplicar(igreja, usuario, pessoaSemOficio, dados, true), service.aplicar(igreja, usuario, pessoaSemOficio, dados, true)]);
    expect(a.id).toBe(b.id);
    expect(await service.listarCorrecoes(igreja, usuario, pessoaSemOficio, true)).toHaveLength(1);
    await expect(service.aplicar(igreja, usuario, pessoaSemOficio, dados)).rejects.toThrow();
  });

  it('bloqueia correção que mudaria o evento usado pela conferência eleitoral', async () => {
    const politica = await p.politica_eleicao_oficial.create({ data: { igreja_id: igreja, versao: randomUUID(), fonte: 'Livro', autoridade: 'Conselho', idade_minima: 18, aniversario_bissexto: 'DIA_28_FEVEREIRO', vigente_desde: new Date('2020-01-01'), criado_por_id: usuario } });
    const conferencia = await p.conferencia_eleicao_oficial.create({ data: { igreja_id: igreja, pessoa_id: pessoaSemOficio, politica_id: politica.id, data_eleicao: new Date('2024-01-15'), data_recepcao: new Date('2020-01-01'), evidencia_recepcao: 'Livro', capacidade_confirmada: true, evidencia_capacidade: 'Livro', resultado: {}, criado_por_id: usuario } });
    try {
      const proposta = { evento_id: eventoSemOficio, nova_data: '2024-02-01' };
      const previa = await service.previa(igreja, usuario, pessoaSemOficio, proposta, true);
      expect(previa.conferencia_alterada).toBe(true);
      expect(previa.bloqueada).toBe(true);
      await expect(service.aplicar(igreja, usuario, pessoaSemOficio, { ...proposta, hash_previa: previa.hash, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true }, true)).rejects.toThrow('revisão');
    } finally {
      await p.conferencia_eleicao_oficial.delete({ where: { id: conferencia.id } });
      await p.politica_eleicao_oficial.delete({ where: { id: politica.id } });
    }
  });

  it('corrige data atravessando outro ato e aceita destino com ordem posterior conferida', async () => {
    const outro = await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoaSemOficio, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2025-01-01'), ordem_dia: 2 } });
    await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoaSemOficio, tipo_evento: 'MUDANCA_DE_ROL', rol_origem: 'COMUNGANTES', rol: 'NAO_COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2026-01-01') } });
    const movimento = { evento_id: eventoSemOficio, nova_data: '2025-06-01' };
    const previa = await service.previa(igreja, usuario, pessoaSemOficio, movimento, true);
    expect(previa.bloqueada).toBe(false);
    await service.aplicar(igreja, usuario, pessoaSemOficio, { ...movimento, hash_previa: previa.hash, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true }, true);
    const ordenacao = new OrdenacaoMembresiaService(p);
    await ordenacao.ordenarUnico(igreja, usuario, eventoSemOficio, { ordem: 1, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true });
    const mesmaData = { evento_id: outro.id, nova_data: '2025-06-01' };
    const previa2 = await service.previa(igreja, usuario, pessoaSemOficio, mesmaData, true);
    expect(previa2.bloqueada).toBe(false);
    await service.aplicar(igreja, usuario, pessoaSemOficio, { ...mesmaData, hash_previa: previa2.hash, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true }, true);
    const eventos = await p.eventos_membresia.findMany({ where: { pessoa_id: pessoaSemOficio, data_evento: new Date('2025-06-01') }, orderBy: { ordem_dia: 'asc' } });
    expect(eventos.map(e => e.ordem_dia)).toEqual([1, 2]);
  });

  it('bloqueia correção que tornaria incoerente o rol de origem de outro ato', async () => {
    const posterior = await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoaSemOficio, tipo_evento: 'ADMISSAO', rol: 'NAO_COMUNGANTES', motivacao_evento: 'BATISMO_NA_INFANCIA', data_evento: new Date('2027-01-01') } });
    const movimento = { evento_id: posterior.id, nova_data: '2025-07-01' };
    const previa = await service.previa(igreja, usuario, pessoaSemOficio, movimento, true);
    expect(previa.origens_invalidadas).toHaveLength(1); expect(previa.bloqueada).toBe(true);
    await expect(service.aplicar(igreja, usuario, pessoaSemOficio, { ...movimento, hash_previa: previa.hash, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true }, true)).rejects.toThrow('origem');
  });

});

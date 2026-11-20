import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PoliticaEleicaoService } from '../src/elegibilidade/politica-eleicao.service';
import { ConferenciaEleicaoService } from '../src/elegibilidade/conferencia-eleicao.service';
import { OficiaisService } from '../src/oficiais/oficiais.service';
import { MandatoService } from '../src/oficiais/mandato.service';
import { AlertasOficiaisService } from '../src/oficiais/alertas.service';
import { SituacaoExercicioService } from '../src/oficiais/situacao-exercicio.service';
import { ImpactoRetroativoService } from '../src/oficiais/impacto-retroativo.service';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', outra = 'e0000000-0000-4000-8000-000000000002';
const usuario = 'e1000000-0000-4000-8000-000000000001';
integration('E02: políticas e conferências no banco descartável', () => {
  const prisma = new PrismaService();
  const politicaService = new PoliticaEleicaoService(prisma);
  const conferenciaService = new ConferenciaEleicaoService(prisma);
  const oficiais = new OficiaisService(prisma);
  const mandatos = new MandatoService(prisma);
  const alertas = new AlertasOficiaisService(prisma);
  const impactos = new ImpactoRetroativoService(prisma);
  const exercicio = new SituacaoExercicioService(prisma);
  let oficialId: string;
  const sufixo = randomUUID();
  let politicaId: string;
  const pessoa = randomUUID(), eventoId = randomUUID();
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await prisma.$connect();
    await prisma.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Pessoa E02 Sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await prisma.eventos_membresia.create({ data: { id: eventoId, igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2024-01-01') } });
  });
  afterAll(async () => {
    if (oficialId) {
      const itens = await prisma.mandato_oficial.findMany({ where: { oficial_id: oficialId }, select: { id: true } });
      const eventos = await prisma.evento_oficial.findMany({ where: { oficial_id: oficialId }, select: { id: true } });
      await prisma.logs_atividades.deleteMany({ where: { registro_id: { in: [oficialId, ...itens.map(x => x.id), ...eventos.map(x => x.id)] } } });
      await prisma.mandato_oficial.deleteMany({ where: { oficial_id: oficialId } });
      await prisma.evento_oficial.deleteMany({ where: { oficial_id: oficialId } });
      await prisma.oficial.deleteMany({ where: { id: oficialId } });
    }
    if (politicaId) {
      await prisma.conferencia_eleicao_oficial.deleteMany({ where: { politica_id: politicaId } });
      await prisma.logs_atividades.deleteMany({ where: { tabela_afetada: { in: ['politica_eleicao_oficial', 'conferencia_eleicao_oficial'] }, igreja_id: igreja, created_at: { gte: new Date('2020-01-01') }, dados_novos: { path: ['politica_id'], equals: politicaId } } });
      await prisma.logs_atividades.deleteMany({ where: { tabela_afetada: 'politica_eleicao_oficial', registro_id: politicaId } });
      await prisma.politica_eleicao_oficial.deleteMany({ where: { id: politicaId } });
    }
    await prisma.eventos_membresia.deleteMany({ where: { id: eventoId } });
    await prisma.pessoas.deleteMany({ where: { id: pessoa } });
    await prisma.$disconnect();
  });
  it('persiste política, rejeita sobreposição e registra conferência auditada no escopo correto', async () => {
    const policy = { versao: sufixo, fonte: 'Fonte sintética', autoridade: 'Autoridade sintética', idade_minima: 18, aniversario_bissexto: 'DIA_28_FEVEREIRO' as const, vigente_desde: '2024-01-01', vigente_ate: '2029-12-31' };
    const criada = await politicaService.registrar(igreja, usuario, policy);
    politicaId = criada.id;
    await expect(politicaService.registrar(igreja, usuario, { ...policy, versao: randomUUID() })).rejects.toThrow();
    const input = { pessoa_id: pessoa, politica_id: politicaId, data_eleicao: '2026-01-01', data_recepcao: '2024-02-01', evidencia_recepcao: 'Livro sintético', capacidade_confirmada: true, evidencia_capacidade: 'Evidência sintética' };
    const conferencia = await conferenciaService.registrar(igreja, usuario, input);
    expect(conferencia.data_recepcao.toISOString().slice(0, 10)).toBe('2024-01-01');
    expect(conferencia.resultado).toMatchObject({ situacao: 'REQUISITOS_CONFERIDOS', evento_recepcao_id: eventoId });
    expect(await prisma.logs_atividades.count({ where: { registro_id: conferencia.id, tabela_afetada: 'conferencia_eleicao_oficial' } })).toBe(1);
    await expect(conferenciaService.registrar(outra, usuario, input)).rejects.toThrow();
    const oficial = await oficiais.cadastrar(igreja, usuario, { pessoa_id: pessoa, tipo: 'PRESBITERO_REGENTE' });
    oficialId = oficial.id;
    await oficiais.registrarEvento(igreja, usuario, oficialId, { tipo: 'ORDENACAO', data_efeito: '2026-01-01', ordem: 1, autoridade: 'Conselho', evidencia: 'Ata sintética' });
    const mandatoInput = { conferencia_id: conferencia.id, data_posse: '2026-01-01', autoridade: 'Assembleia', evidencia: 'Ata sintética', evidencia_capacidade_posse: 'Declaração sintética' };
    // Uma alteração de membresia obtém o bloqueio primeiro; o mandato deve reler o rol após o commit.
    const concorrenteId = randomUUID();
    let liberar!: () => void, notificar!: () => void;
    const aguardando = new Promise<void>(resolve => { liberar = resolve; });
    const pronto = new Promise<void>(resolve => { notificar = resolve; });
    const alteracao = prisma.$transaction(async tx => {
      await tx.eventos_membresia.create({ data: { id: concorrenteId, igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'DEMISSAO', rol: 'EXCLUIDOS', motivacao_evento: 'EXCLUSAO_A_PEDIDO', data_evento: new Date('2025-01-01') } });
      notificar(); await aguardando;
    });
    await pronto;
    const tentativa = mandatos.registrar(igreja, usuario, oficialId, mandatoInput).then(() => false, () => true);
    await new Promise(resolve => setTimeout(resolve, 100));
    liberar(); await alteracao;
    expect(await tentativa).toBe(true);
    await prisma.eventos_membresia.delete({ where: { id: concorrenteId } });
    // Na ordem inversa, a alteração de membresia aguarda e deve enxergar o mandato recém-confirmado.
    const transitorioId = randomUUID(), eventoConcorrente = randomUUID();
    let liberarMandato!: () => void, mandatoPronto!: () => void;
    const esperaMandato = new Promise<void>(resolve => { liberarMandato = resolve; });
    const inseriuMandato = new Promise<void>(resolve => { mandatoPronto = resolve; });
    const transacaoMandato = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${pessoa} AND igreja_id = ${igreja} FOR UPDATE`;
      await tx.mandato_oficial.create({ data: { id: transitorioId, igreja_id: igreja, oficial_id: oficialId, conferencia_id: conferencia.id, data_eleicao: new Date('2026-01-01'), data_posse: new Date('2026-01-01'), termino_previsto: new Date('2030-12-31'), autoridade: 'Autoridade sintética', evidencia: 'Evidência sintética', avaliacao_eleicao: {} } });
      mandatoPronto(); await esperaMandato;
    });
    await inseriuMandato;
    const tentativaRol = prisma.eventos_membresia.create({ data: { id: eventoConcorrente, igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'DEMISSAO', rol: 'EXCLUIDOS', motivacao_evento: 'EXCLUSAO_A_PEDIDO', data_evento: new Date('2025-01-01') } }).then(() => '', (erro: Error) => erro.message);
    await new Promise(resolve => setTimeout(resolve, 100));
    liberarMandato(); await transacaoMandato;
    expect(await tentativaRol).toContain('conferência de impacto');
    await prisma.mandato_oficial.delete({ where: { id: transitorioId } });
    const mandato = await mandatos.registrar(igreja, usuario, oficialId, mandatoInput);
    expect(mandato.termino_previsto.toISOString().slice(0, 10)).toBe('2030-12-31');
    expect((await exercicio.consultar(igreja, usuario, oficialId, '2026-06-01')).situacao).toBe('EM_EXERCICIO');
    await expect(exercicio.consultar(outra, usuario, oficialId, '2026-06-01')).rejects.toThrow();
    const afastamentoMembro = await prisma.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'DEMISSAO', rol: 'EXCLUIDOS', motivacao_evento: 'EXCLUSAO_A_PEDIDO', data_evento: new Date('2026-07-01') } });
    expect((await exercicio.consultar(igreja, usuario, oficialId, '2026-07-01')).motivo).toBe('MEMBRESIA_NAO_COMUNGANTE');
    await prisma.eventos_membresia.delete({ where: { id: afastamentoMembro.id } });
    await expect(mandatos.registrar(igreja, usuario, oficialId, mandatoInput)).rejects.toThrow();
    expect((await impactos.membresia(igreja, usuario, pessoa, '2026-06-01')).mandatos.map(m => m.id)).toContain(mandato.id);
    await expect(impactos.membresia(outra, usuario, pessoa, '2026-01-01')).rejects.toThrow();
    await expect(prisma.conferencia_eleicao_oficial.update({ where: { id: conferencia.id }, data: { evidencia_recepcao: 'Modificada' } })).rejects.toThrow();
    await expect(prisma.politica_eleicao_oficial.update({ where: { id: politicaId }, data: { idade_minima: 1 } })).rejects.toThrow();
    await expect(prisma.eventos_membresia.update({ where: { id: eventoId }, data: { rol: 'EXCLUIDOS' } })).rejects.toThrow();
    await expect(prisma.pessoas.update({ where: { id: pessoa }, data: { data_nascimento: new Date('1991-01-01') } })).rejects.toThrow();
    const fim = { data_efeito: '2027-01-01', motivo: 'Pedido', autoridade: 'Conselho', evidencia: 'Ata sintética' };
    await expect(mandatos.encerrar(outra, usuario, mandato.id, fim)).rejects.toThrow();
    const encerrado = await mandatos.encerrar(igreja, usuario, mandato.id, fim);
    expect(encerrado.termino_efetivo?.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect((await exercicio.consultar(igreja, usuario, oficialId, '2027-01-02')).motivo).toBe('SEM_MANDATO_VIGENTE');
    expect((await alertas.mandatos(igreja, usuario, '2027-01-01', 0)).find(x => x.id === mandato.id)?.natureza).toBe('ENCERRAMENTO_REGISTRADO');
    expect((await alertas.mandatos(igreja, usuario, '2027-01-02', 366)).find(x => x.id === mandato.id)).toBeUndefined();
    await expect(alertas.mandatos(outra, usuario, '2027-01-01', 0)).rejects.toThrow();
    await expect(mandatos.encerrar(igreja, usuario, mandato.id, fim)).rejects.toThrow();
    // Mesmo após o fim, a mesma conferência não pode fabricar uma nova eleição.
    await expect(mandatos.registrar(igreja, usuario, oficialId, { ...mandatoInput, data_posse: '2028-01-01' })).rejects.toThrow();
  });
});

import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AcervoHistoricoService } from '../src/oficiais/acervo-historico.service';
import { SituacaoExercicioService } from '../src/oficiais/situacao-exercicio.service';
import { OficiaisService } from '../src/oficiais/oficiais.service';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', outra = 'e0000000-0000-4000-8000-000000000002';
const usuario = 'e1000000-0000-4000-8000-000000000001';
integration('E02: comandos de oficiais no banco descartável', () => {
  const prisma = new PrismaService(), service = new OficiaisService(prisma), acervo = new AcervoHistoricoService(prisma), exercicio = new SituacaoExercicioService(prisma), pessoaId = randomUUID();
  const ids: string[] = [];
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await prisma.$connect();
    await prisma.pessoas.create({ data: { id: pessoaId, igreja_id: igreja, nome_completo: 'Pessoa Oficial Sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
  });
  afterAll(async () => {
    const eventos = await prisma.evento_oficial.findMany({ where: { oficial_id: { in: ids } }, select: { id: true } });
    const historicos = await prisma.registro_historico_oficial.findMany({ where: { oficial_id: { in: ids } }, select: { id: true } });
    const vinculos = await prisma.vinculo_pastoral.findMany({ where: { oficial_id: { in: ids } }, select: { id: true } });
    await prisma.logs_atividades.deleteMany({ where: { igreja_id: igreja, registro_id: { in: [...ids, ...eventos.map(e => e.id), ...vinculos.map(v => v.id), ...historicos.map(h => h.id)] } } });
    await prisma.evento_oficial.deleteMany({ where: { oficial_id: { in: ids }, tipo: 'RESTAURACAO' } });
    await prisma.evento_oficial.deleteMany({ where: { oficial_id: { in: ids } } });
    await prisma.registro_historico_oficial.deleteMany({ where: { oficial_id: { in: ids } } });
    await prisma.vinculo_pastoral.deleteMany({ where: { oficial_id: { in: ids } } });
    await prisma.oficial.deleteMany({ where: { id: { in: ids } } });
    await prisma.pessoas.deleteMany({ where: { id: pessoaId } });
    await prisma.$disconnect();
  });
  it('conserva atos separados, impede igreja alheia e restaura o afastamento correto', async () => {
    const oficial = await service.cadastrar(igreja, usuario, { pessoa_id: pessoaId, tipo: 'DIACONO' }); ids.push(oficial.id);
    await expect(service.cadastrar(outra, usuario, { pessoa_id: pessoaId, tipo: 'DIACONO' })).rejects.toThrow();
    const base = { data_efeito: '2026-01-01', ordem: 1, autoridade: 'Conselho', evidencia: 'Ata externa' };
    const suspensao = await service.registrarEvento(igreja, usuario, oficial.id, { ...base, tipo: 'SUSPENSAO' });
    await expect(service.registrarEvento(igreja, usuario, oficial.id, { ...base, tipo: 'ORDENACAO' })).rejects.toThrow();
    const restauracao = await service.registrarEvento(igreja, usuario, oficial.id, { ...base, tipo: 'RESTAURACAO', ordem: 2, evento_restaurado_id: suspensao.id });
    expect(restauracao.evento_restaurado_id).toBe(suspensao.id);
    expect(await prisma.logs_atividades.count({ where: { registro_id: { in: [oficial.id, suspensao.id, restauracao.id] } } })).toBe(3);
  });
  it('restringe vínculo pastoral a docente e não exige eleição local', async () => {
    const diacono = ids[0];
    const dados = { modalidade: 'Designação', concilio: 'Presbitério', ato: 'Ato externo', data_inicio: '2026-01-01', exercicio_institucional: true, evidencia: 'Documento externo' };
    await expect(service.registrarVinculoPastoral(igreja, usuario, diacono, dados)).rejects.toThrow();
    const oficioDocente = { pessoa_id: pessoaId, tipo: 'PRESBITERO_DOCENTE' as const };
    await expect(service.cadastrar(igreja, usuario, oficioDocente)).rejects.toThrow('já tem um ofício ativo');
    const docente = await service.cadastrar(igreja, usuario, { ...oficioDocente, ativo: false }); ids.push(docente.id);
    await expect(service.cadastrar(igreja, usuario, { ...oficioDocente, ativo: false })).rejects.toMatchObject({ code: 'P2002' });
    await expect(service.alterarSituacao(igreja, usuario, docente.id, { ativo: true })).rejects.toThrow('já tem um ofício ativo');
    await expect(service.alterarSituacao(outra, usuario, diacono, { ativo: false })).rejects.toThrow();
    await service.alterarSituacao(igreja, usuario, diacono, { ativo: false });
    expect(await service.alterarSituacao(igreja, usuario, docente.id, { ativo: true })).toEqual({ id: docente.id, ativo: true });
    expect(await prisma.evento_oficial.count({ where: { oficial_id: diacono } })).toBe(2);
    const vinculo = await service.registrarVinculoPastoral(igreja, usuario, docente.id, dados);
    expect(vinculo.data_fim).toBeNull();
    await expect(service.registrarVinculoPastoral(igreja, usuario, docente.id, dados)).rejects.toThrow();
    const fim = { data_fim: '2026-02-01', motivo: 'Encerramento', autoridade: 'Presbitério', evidencia: 'Ato externo' };
    await expect(service.encerrarVinculoPastoral(outra, usuario, vinculo.id, fim)).rejects.toThrow();
    const encerrado = await service.encerrarVinculoPastoral(igreja, usuario, vinculo.id, fim);
    expect(encerrado.data_fim?.toISOString().slice(0, 10)).toBe('2026-02-01');
    expect(encerrado.autoridade_fim).toBe('Presbitério');
    await expect(service.encerrarVinculoPastoral(igreja, usuario, vinculo.id, fim)).rejects.toThrow();
    await expect(service.registrarVinculoPastoral(outra, usuario, docente.id, dados)).rejects.toThrow();
  });
  it('mantém somente um ofício ativo quando registros distintos são reativados em paralelo', async () => {
    const [diacono, docente] = ids;
    await service.alterarSituacao(igreja, usuario, docente, { ativo: false });
    const resultados = await Promise.allSettled([
      service.alterarSituacao(igreja, usuario, diacono, { ativo: true }),
      service.alterarSituacao(igreja, usuario, docente, { ativo: true }),
    ]);
    expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.oficial.count({ where: { igreja_id: igreja, pessoa_id: pessoaId } })).toBe(2);
    expect(await prisma.oficial.count({ where: { igreja_id: igreja, pessoa_id: pessoaId, ativo: true } })).toBe(1);
  });
  it('reconhece o exercício do docente após registrar a ordenação só com a data', async () => {
    const [diacono, docente] = ids;
    const dados = { tipo: 'ORDENACAO' as const, data_efeito: '2020-01-01' };
    await expect(service.registrarEvento(igreja, usuario, docente, { ...dados, data_efeito: '' })).rejects.toThrow('Dados do evento inválidos');
    await expect(service.registrarEvento(igreja, usuario, diacono, dados)).rejects.toThrow('presbítero docente');
    await expect(service.registrarEvento(outra, usuario, docente, dados)).rejects.toThrow();
    const resultados = await Promise.allSettled([
      service.registrarEvento(igreja, usuario, docente, dados),
      service.registrarEvento(igreja, usuario, docente, dados),
    ]);
    expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const registros = await prisma.evento_oficial.findMany({ where: { igreja_id: igreja, oficial_id: docente, tipo: dados.tipo } });
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ ordem: 1, autoridade: 'Não informada', evidencia: 'Referência documental não informada.' });
    expect(await exercicio.consultar(igreja, usuario, docente, '2026-01-15')).toMatchObject({ situacao: 'EM_EXERCICIO' });
  });
  it('preserva afastamento referenciado mesmo com atualização concorrente', async () => {
    const oficialId = ids[0];
    const suspensao = await service.registrarEvento(igreja, usuario, oficialId, { tipo: 'SUSPENSAO', data_efeito: '2026-03-01', ordem: 1, autoridade: 'Conselho', evidencia: 'Ata externa' });
    let liberar!: () => void, inserido!: () => void;
    const aguardando = new Promise<void>(resolve => { liberar = resolve; });
    const pronto = new Promise<void>(resolve => { inserido = resolve; });
    const restauracaoId = randomUUID();
    const primeiro = prisma.$transaction(async tx => {
      await tx.evento_oficial.create({ data: { id: restauracaoId, igreja_id: igreja, oficial_id: oficialId, tipo: 'RESTAURACAO', data_efeito: new Date('2026-03-02'), ordem: 1, autoridade: 'Conselho', evidencia: 'Ata externa', evento_restaurado_id: suspensao.id } });
      inserido(); await aguardando;
    });
    await pronto;
    const segundo = prisma.evento_oficial.update({ where: { id: suspensao.id }, data: { tipo: 'ORDENACAO' } }).then(() => false, () => true);
    await new Promise(resolve => setTimeout(resolve, 100));
    liberar(); await primeiro;
    expect(await segundo).toBe(true);
    expect((await prisma.evento_oficial.findUniqueOrThrow({ where: { id: suspensao.id } })).tipo).toBe('SUSPENSAO');
  });

  it('importa lacunas sem inferir autoridade e repete o pedido de forma idempotente', async () => {
    const oficial = ids[0], chave = randomUUID();
    const dados = { tipo: 'ELEICAO' as const, data_evento: null, data_descricao: 'Década de 1980', situacao_documental: 'EXTERNO_CONFERIDO' as const, referencia_externa: 'Livro externo, volume 1', autoridade: null, idempotencia: chave };
    const [a, b] = await Promise.all([acervo.registrar(igreja, usuario, oficial, dados), acervo.registrar(igreja, usuario, oficial, dados)]);
    expect(a.id).toBe(b.id); expect(a.data_evento).toBeNull();
    expect(await prisma.logs_atividades.count({ where: { tabela_afetada: 'registro_historico_oficial', registro_id: a.id } })).toBe(1);
    await expect(acervo.registrar(igreja, usuario, oficial, { ...dados, data_descricao: 'Outra década' })).rejects.toThrow();
    await expect(acervo.registrar(outra, usuario, oficial, dados)).rejects.toThrow();
    await expect(acervo.detalhe(igreja, usuario, a.id)).rejects.toThrow();
    const lista = await acervo.listar(igreja, oficial);
    expect(lista[0]).not.toHaveProperty('referencia_externa');
    expect((await exercicio.consultar(igreja, usuario, oficial, '2020-01-01')).situacao).toBe('FORA_DE_EXERCICIO');
  });

});

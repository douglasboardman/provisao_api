import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AcessoSensivelService } from '../src/oficiais/acesso-sensivel.service';
import { InsercaoRetroativaOficialService } from '../src/oficiais/insercao-retroativa-oficial.service';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', outra = 'e0000000-0000-4000-8000-000000000002', admin = 'e1000000-0000-4000-8000-000000000001';
integration('E02: evento retroativo de oficial', () => {
  const p = new PrismaService(), acesso = new AcessoSensivelService(p), service = new InsercaoRetroativaOficialService(p);
  const pessoa = randomUUID(), usuario = randomUUID(), oficial = randomUUID(), mandato = randomUUID(), posterior = randomUUID();
  let eventoCriado = '';
  const proposta = { tipo: 'SUSPENSAO' as const, data_efeito: '2026-01-01', ordem: 1, autoridade: 'Conselho', evidencia: 'Livro', observacoes: null, evento_restaurado_id: null };
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await p.$connect();
    await p.usuarios.create({ data: { id: usuario, igreja_id: igreja, nome_usuario: 'Secretário sintético', email_login: `${usuario}@example.invalid`, senha_hash: 'sem-senha', perfil: 'SECRETARIO', ativo: true } });
    await p.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Pessoa sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await p.oficial.create({ data: { id: oficial, igreja_id: igreja, pessoa_id: pessoa, tipo: 'DIACONO' } });
    await p.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial, tipo: 'ORDENACAO', data_efeito: new Date('2020-01-01'), ordem: 1, autoridade: 'Conselho', evidencia: 'Livro' } });
    await p.evento_oficial.create({ data: { id: posterior, igreja_id: igreja, oficial_id: oficial, tipo: 'LICENCA', data_efeito: new Date('2028-01-01'), ordem: 1, autoridade: 'Conselho', evidencia: 'Livro' } });
    await p.mandato_oficial.create({ data: { id: mandato, igreja_id: igreja, oficial_id: oficial, data_eleicao: new Date('2025-01-01'), data_posse: new Date('2025-01-01'), termino_previsto: new Date('2029-12-31'), autoridade: 'Conselho', evidencia: 'Livro', avaliacao_eleicao: {} } });
    await acesso.conceder(igreja, admin, { usuario_id: usuario, pode_consultar: true, pode_registrar: true, fundamento: 'Autorização sintética' });
  });
  afterAll(async () => {
    await p.logs_atividades.deleteMany({ where: { usuario_id: usuario } });
    await p.insercao_retroativa_oficial.deleteMany({ where: { oficial_id: oficial } });
    await p.evento_oficial.deleteMany({ where: { oficial_id: oficial, tipo: 'RESTAURACAO' } });
    await p.evento_oficial.deleteMany({ where: { oficial_id: oficial } });
    await p.acesso_eventos_sensiveis.deleteMany({ where: { usuario_id: usuario } });
    await p.mandato_oficial.deleteMany({ where: { id: mandato } }); await p.oficial.deleteMany({ where: { id: oficial } });
    await p.pessoas.deleteMany({ where: { id: pessoa } }); await p.usuarios.deleteMany({ where: { id: usuario } }); await p.$disconnect();
  });
  it('rejeita posse incompatível e aplica evento com prévia atualizada e repetição segura', async () => {
    await expect(service.previa(outra, usuario, oficial, proposta)).rejects.toThrow();
    await expect(service.previa(igreja, usuario, oficial, { ...proposta, data_efeito: '2028-01-01', ordem: 1 })).rejects.toThrow('ocupada');
    const risco = await service.previa(igreja, usuario, oficial, { ...proposta, data_efeito: '2024-01-01' });
    expect(risco.posse_invalida).toBe(true);
    await expect(service.aplicar(igreja, usuario, oficial, { ...proposta, data_efeito: '2024-01-01', hash_previa: risco.hash, justificativa: 'Livro', idempotencia: randomUUID(), ciente: true })).rejects.toThrow('revisão');
    const previa = await service.previa(igreja, usuario, oficial, proposta);
    expect(previa.bloqueada).toBe(false);
    expect(previa.alteracoes.some(a => a.data === '2026-01-01' && a.antes.em_exercicio && !a.depois.em_exercicio)).toBe(true);
    const dados = { ...proposta, hash_previa: previa.hash, justificativa: 'Livro', idempotencia: randomUUID(), ciente: true as const };
    await p.evento_oficial.update({ where: { id: posterior }, data: { observacoes: 'Conferido' } });
    await expect(service.aplicar(igreja, usuario, oficial, dados)).rejects.toThrow('nova prévia');
    dados.hash_previa = (await service.previa(igreja, usuario, oficial, proposta)).hash;
    const [a, b] = await Promise.all([service.aplicar(igreja, usuario, oficial, dados), service.aplicar(igreja, usuario, oficial, dados)]);
    expect(a.id).toBe(b.id); eventoCriado = a.evento_id;
    expect(await service.listar(igreja, usuario, oficial)).toHaveLength(1);
    await expect(service.aplicar(igreja, usuario, oficial, { ...dados, justificativa: 'Outra' })).rejects.toThrow('Chave');
  });
  it('restaura afastamento retroativamente sem produzir nova ordenação', async () => {
    const restauracao = { ...proposta, tipo: 'RESTAURACAO' as const, data_efeito: '2027-01-01', evento_restaurado_id: eventoCriado };
    const previa = await service.previa(igreja, usuario, oficial, restauracao);
    expect(previa.bloqueada).toBe(false);
    expect(previa.alteracoes.some(a => a.data === '2027-01-01' && !a.antes.em_exercicio && a.depois.em_exercicio)).toBe(true);
    const r = await service.aplicar(igreja, usuario, oficial, { ...restauracao, hash_previa: previa.hash, justificativa: 'Livro', idempotencia: randomUUID(), ciente: true });
    expect((await p.evento_oficial.findUniqueOrThrow({ where: { id: r.evento_id } })).evento_restaurado_id).toBe(eventoCriado);
    expect(await p.evento_oficial.count({ where: { oficial_id: oficial, tipo: 'ORDENACAO' } })).toBe(1);
  });
  it('compara exercício de vínculo pastoral sem presumir mandato eleitoral', async () => {
    const pessoaDocente = randomUUID(), docente = randomUUID();
    await p.pessoas.create({ data: { id: pessoaDocente, igreja_id: igreja, nome_completo: 'Docente sintético', data_nascimento: new Date('1980-01-01'), sexo: 'MASCULINO' } });
    await p.oficial.create({ data: { id: docente, igreja_id: igreja, pessoa_id: pessoaDocente, tipo: 'PRESBITERO_DOCENTE' } });
    try {
      await p.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: docente, tipo: 'ORDENACAO', data_efeito: new Date('2020-01-01'), ordem: 1, autoridade: 'Concílio', evidencia: 'Livro' } });
      await p.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: docente, tipo: 'LICENCA', data_efeito: new Date('2028-01-01'), ordem: 1, autoridade: 'Concílio', evidencia: 'Livro' } });
      const vinculo = await p.vinculo_pastoral.create({ data: { igreja_id: igreja, oficial_id: docente, modalidade: 'Pastor', concilio: 'Concílio', ato: 'Ato', data_inicio: new Date('2025-01-01'), exercicio_institucional: true, evidencia: 'Livro' } });
      const previa = await service.previa(igreja, usuario, docente, proposta);
      expect(previa.alteracoes.some(a => a.id === vinculo.id && a.tipo === 'VINCULO_PASTORAL' && a.data === '2026-01-01' && a.antes.em_exercicio && !a.depois.em_exercicio)).toBe(true);
      expect(previa.posse_invalida).toBe(false);
    } finally {
      await p.logs_atividades.deleteMany({ where: { registro_id: docente } });
      await p.vinculo_pastoral.deleteMany({ where: { oficial_id: docente } }); await p.evento_oficial.deleteMany({ where: { oficial_id: docente } });
      await p.oficial.deleteMany({ where: { id: docente } }); await p.pessoas.deleteMany({ where: { id: pessoaDocente } });
    }
  });

  it('aguarda alteração do período e recusa prévia anterior ao encerramento', async () => {
    const candidata = { ...proposta, tipo: 'LICENCA' as const, ordem: 2 };
    const previa = await service.previa(igreja, usuario, oficial, candidata);
    let liberar!: () => void, bloqueado!: () => void, terminou = false;
    const espera = new Promise<void>(resolve => { liberar = resolve; });
    const pronto = new Promise<void>(resolve => { bloqueado = resolve; });
    const encerramento = p.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM oficial WHERE id = ${oficial} AND igreja_id = ${igreja} FOR UPDATE`;
      await tx.mandato_oficial.update({ where: { id: mandato }, data: { termino_efetivo: new Date('2027-12-31'), motivo_encerramento: 'Livro' } });
      bloqueado(); await espera;
    });
    await pronto;
    const aplicacao = service.aplicar(igreja, usuario, oficial, { ...candidata, hash_previa: previa.hash, justificativa: 'Livro', idempotencia: randomUUID(), ciente: true }).then(() => { terminou = true; return null; }, e => { terminou = true; return e; });
    try { await new Promise(resolve => setTimeout(resolve, 100)); expect(terminou).toBe(false); } finally { liberar(); }
    await encerramento;
    expect((await aplicacao).message).toContain('nova prévia');
  });

});

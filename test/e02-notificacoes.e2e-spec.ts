import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificacoesMandatoService } from '../src/oficiais/notificacoes-mandato.service';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', outra = 'e0000000-0000-4000-8000-000000000002';
const admin = 'e1000000-0000-4000-8000-000000000001';
integration('E02: notificações operacionais de mandato', () => {
  const p = new PrismaService(), service = new NotificacoesMandatoService(p), pessoa = randomUUID(), oficial = randomUUID(), mandato = randomUUID(), destinatario = randomUUID();
  const inicioTeste = new Date();
  const config = { ativo: true, dias_antecedencia: 30, dias_apos_termino: 15, fuso_iana: 'America/Sao_Paulo', autoridade: 'Conselho sintético', fundamento: 'Ato sintético' };
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await p.$connect();
    await p.usuarios.create({ data: { id: destinatario, igreja_id: igreja, nome_usuario: 'Secretário de teste', email_login: `${destinatario}@example.invalid`, senha_hash: 'sem-senha', perfil: 'SECRETARIO', ativo: true } });
    await p.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Pessoa sintética alerta', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await p.oficial.create({ data: { id: oficial, igreja_id: igreja, pessoa_id: pessoa, tipo: 'DIACONO' } });
    await p.mandato_oficial.create({ data: { id: mandato, igreja_id: igreja, oficial_id: oficial, data_eleicao: new Date('2025-12-01'), data_posse: new Date('2026-01-01'), termino_previsto: new Date('2030-12-31'), autoridade: 'Conselho', evidencia: 'Ata sintética', avaliacao_eleicao: {} } });
  });
  afterAll(async () => {
    await p.alerta_mandato.deleteMany({ where: { mandato_id: mandato } });
    const inscricoes = await p.inscricao_alerta_oficial.findMany({ where: { usuario_id: destinatario }, select: { id: true } });
    await p.logs_atividades.deleteMany({ where: { OR: [{ registro_id: { in: inscricoes.map(i => i.id) } }, { tabela_afetada: 'politica_alerta_oficiais', registro_id: igreja, created_at: { gte: inicioTeste } }] } });
    await p.inscricao_alerta_oficial.deleteMany({ where: { usuario_id: destinatario } }); await p.execucao_alerta_oficiais.deleteMany({ where: { igreja_id: igreja } }); await p.politica_alerta_oficiais.deleteMany({ where: { igreja_id: igreja } });
    await p.mandato_oficial.deleteMany({ where: { id: mandato } }); await p.oficial.deleteMany({ where: { id: oficial } }); await p.pessoas.deleteMany({ where: { id: pessoa } }); await p.usuarios.deleteMany({ where: { id: destinatario } }); await p.$disconnect();
  });
  it('respeita fuso, destinatário explícito, idempotência e término efetivo', async () => {
    await expect(service.configurar(igreja, admin, { ...config, fuso_iana: 'Fuso/Inexistente' })).rejects.toThrow();
    await expect(service.adicionarDestinatario(outra, admin, { usuario_id: destinatario })).rejects.toThrow();
    await service.configurar(igreja, admin, config);
    const inscricao = await service.adicionarDestinatario(igreja, admin, { usuario_id: destinatario });
    expect((await service.adicionarDestinatario(igreja, admin, { usuario_id: destinatario })).id).toBe(inscricao.id);
    expect((await service.gerar(new Date('2030-12-01T02:30:00Z'))).criados).toBe(0);
    const agora = new Date('2030-12-01T03:30:00Z');
    const resultados = await Promise.all([service.gerar(agora), service.gerar(agora)]);
    expect(resultados.reduce((n, r) => n + r.criados, 0)).toBe(1);
    expect((await service.configuracao(igreja, admin)).execucao?.ultimo_sucesso).not.toBeNull();
    const avisos = await service.minhas(igreja, destinatario, agora);
    expect(avisos).toHaveLength(1);
    expect(await service.minhas(igreja, admin, agora)).toEqual([]);
    await expect(service.marcarLida(igreja, admin, avisos[0].id)).rejects.toThrow();
    await service.marcarLida(igreja, destinatario, avisos[0].id);
    expect((await service.minhas(igreja, destinatario, agora))[0].lido_em).not.toBeNull();
    await service.removerDestinatario(igreja, admin, inscricao.id);
    expect(await service.minhas(igreja, destinatario, agora)).toEqual([]);
    await service.adicionarDestinatario(igreja, admin, { usuario_id: destinatario });
    expect((await service.gerar(agora)).criados).toBe(1);
    expect((await service.minhas(igreja, destinatario, agora))[0].lido_em).toBeNull();
    await p.mandato_oficial.update({ where: { id: mandato }, data: { termino_efetivo: new Date('2030-12-15'), motivo_encerramento: 'A pedido' } });
    expect(await service.minhas(igreja, destinatario, agora)).toEqual([]);
    expect((await service.gerar(agora)).criados).toBe(1);
    expect((await service.minhas(igreja, destinatario, agora))[0].data_termino.toISOString().slice(0, 10)).toBe('2030-12-15');
    // Simula worker ausente até o dia posterior: dentro da tolerância configurada, retoma o aviso.
    await p.alerta_mandato.deleteMany({ where: { mandato_id: mandato, data_termino: new Date('2030-12-15') } });
    const atrasado = new Date('2030-12-16T04:00:00Z');
    expect((await service.gerar(atrasado)).criados).toBe(1);
    expect((await service.minhas(igreja, destinatario, atrasado))[0].data_termino.toISOString().slice(0, 10)).toBe('2030-12-15');
    expect(await service.minhas(igreja, destinatario, new Date('2031-01-01T04:00:00Z'))).toEqual([]);
    await service.configurar(igreja, admin, { ...config, ativo: false });
    expect(await service.minhas(igreja, destinatario, agora)).toEqual([]);
  });
  it('worker compilado executa a geração no ambiente descartável', async () => {
    await service.configurar(igreja, admin, config);
    await p.execucao_alerta_oficiais.deleteMany({ where: { igreja_id: igreja } });
    const child = spawn(process.execPath, ['dist/src/worker.js'], { cwd: process.cwd(), env: { ...process.env,
      DATABASE_URL: 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public', NODE_ENV: 'test', FEATURE_GOVERNANCA: 'true', JWT_SECRET: 'e00-local-only',
      EMAIL_OUTBOX_KEY: '1'.repeat(64), MFA_ENCRYPTION_KEY: '2'.repeat(64), FRONTEND_URL: 'http://localhost:3001', SMTP_HOST: '127.0.0.1', SMTP_PORT: '51025', SMTP_FROM: 'teste@example.invalid' }, stdio: 'ignore' });
    const encerrado = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    try {
      let executou = false;
      for (let i = 0; i < 50 && !executou; i++) { await new Promise(resolve => setTimeout(resolve, 100)); executou = !!(await p.execucao_alerta_oficiais.findUnique({ where: { igreja_id: igreja } }))?.ultimo_sucesso; }
      expect(executou).toBe(true);
    } finally { child.kill('SIGTERM'); await encerrado; }
  }, 15000);

});

import { RevisaoEleitoralService } from '../src/oficiais/revisao-eleitoral.service';
import { CorrecaoMembresiaService } from '../src/oficiais/correcao-membresia.service';
import { CorrecaoConteudoService } from '../src/oficiais/correcao-conteudo.service';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdenacaoMembresiaService } from '../src/oficiais/ordenacao-membresia.service';
import { eventoVigente } from '../src/eventos-membresia/estado-temporal';
import { AcessoSensivelService } from '../src/oficiais/acesso-sensivel.service';
import { ConferenciaEleicaoService } from '../src/elegibilidade/conferencia-eleicao.service';
import { InsercaoRetroativaService } from '../src/oficiais/insercao-retroativa.service';
const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;
const igreja = 'e0000000-0000-4000-8000-000000000001', outra = 'e0000000-0000-4000-8000-000000000002', admin = 'e1000000-0000-4000-8000-000000000001';
integration('E02: inclusão retroativa auditada', () => {
  const p = new PrismaService(), acesso = new AcessoSensivelService(p), service = new InsercaoRetroativaService(p);
  const pessoa = randomUUID(), usuario = randomUUID(), posterior = randomUUID();
  const regrasCriadas: string[] = [];
  const proposta = { data_evento: '2024-01-01', tipo_evento: 'ADMISSAO' as const, rol: 'COMUNGANTES' as const, motivacao_evento: 'PROFISSAO_DE_FE' as const, igreja_origem: null, igreja_destino: null, observacoes: null };
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public') throw new Error('Exige banco descartável E00.');
    await p.$connect();
    for (const [nome, destino] of [['Motivações de Admissão', 'PROFISSAO_DE_FE'], ['Rols de Admissão', 'COMUNGANTES']]) {
      const existente = await p.regras_relacao_enum.findUnique({ where: { modulo_nome: { modulo: 'membresia', nome } } });
      if (!existente) {
        const regra = await p.regras_relacao_enum.create({ data: { modulo: 'membresia', nome, tipo_regra: 'FILTRO', enum_classificador: 'membresia_tipo_evento', enum_classificado: nome.startsWith('Rols') ? 'membresia_rol' : 'membresia_motivacao_evento', valores: { create: { valor_classificador: 'ADMISSAO', valor_classificado: destino } } } });
        regrasCriadas.push(regra.id);
      }
    }
    await p.usuarios.create({ data: { id: usuario, igreja_id: igreja, nome_usuario: 'Secretário sintético', email_login: `${usuario}@example.invalid`, senha_hash: 'sem-senha', perfil: 'SECRETARIO', ativo: true } });
    await p.pessoas.create({ data: { id: pessoa, igreja_id: igreja, nome_completo: 'Pessoa sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    await p.eventos_membresia.create({ data: { id: posterior, igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'DEMISSAO', rol: 'EXCLUIDOS', motivacao_evento: 'EXCLUSAO_A_PEDIDO', data_evento: new Date('2025-01-01') } });
    await acesso.conceder(igreja, admin, { usuario_id: usuario, pode_consultar: true, pode_registrar: true, fundamento: 'Autorização sintética' });
  });
  afterAll(async () => {
    await p.relacao_enum_valores.deleteMany({ where: { regra_id: { in: regrasCriadas } } }); await p.regras_relacao_enum.deleteMany({ where: { id: { in: regrasCriadas } } });
    await p.logs_atividades.deleteMany({ where: { usuario_id: usuario } });
    await p.item_ordenacao_membresia.deleteMany({ where: { pessoa_id: pessoa } });
    await p.ordenacao_membresia.deleteMany({ where: { pessoa_id: pessoa } });
    await p.insercao_retroativa_membresia.deleteMany({ where: { pessoa_id: pessoa } });
    await p.acesso_eventos_sensiveis.deleteMany({ where: { usuario_id: usuario } });
    await p.eventos_membresia.deleteMany({ where: { pessoa_id: pessoa } });
    await p.pessoas.deleteMany({ where: { id: pessoa } }); await p.usuarios.deleteMany({ where: { id: usuario } }); await p.$disconnect();
  });
  it('exige conferência, rejeita dados obsoletos e conserva trilha na repetição concorrente', async () => {
    await expect(service.previa(outra, usuario, pessoa, proposta)).rejects.toThrow();
    await expect(p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa, tipo_evento: proposta.tipo_evento, rol: proposta.rol, motivacao_evento: proposta.motivacao_evento, data_evento: new Date(proposta.data_evento) } })).rejects.toThrow('exige correção retroativa');
    await expect(p.$transaction(async tx => {
      const eventoId = randomUUID();
      const registro = await tx.insercao_retroativa_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa, evento_id: eventoId, data_evento: new Date(proposta.data_evento), dados_evento: { tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', rol_origem: null, motivacao_evento: 'PROFISSAO_DE_FE', ordem_dia: null, igreja_origem: null, igreja_destino: null, observacoes: null }, impacto: {}, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), criado_por_id: usuario } });
      await tx.$queryRaw`SELECT set_config('provisao.insercao_retroativa_id', ${registro.id}, true)`;
      await tx.eventos_membresia.create({ data: { id: eventoId, igreja_id: igreja, pessoa_id: pessoa, tipo_evento: 'ADMISSAO', rol: 'NAO_COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date(proposta.data_evento) } });
    })).rejects.toThrow('exige correção retroativa');
    const previa = await service.previa(igreja, usuario, pessoa, proposta);
    expect(previa.bloqueada).toBe(false);
    const dados = { ...proposta, hash_previa: previa.hash, justificativa: 'Livro conferido', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true as const };
    await p.eventos_membresia.update({ where: { id: posterior }, data: { observacoes: 'Atualizado' } });
    await expect(service.aplicar(igreja, usuario, pessoa, dados)).rejects.toThrow('nova prévia');
    dados.hash_previa = (await service.previa(igreja, usuario, pessoa, proposta)).hash;
    const [a, b] = await Promise.all([service.aplicar(igreja, usuario, pessoa, dados), service.aplicar(igreja, usuario, pessoa, dados)]);
    expect(a.id).toBe(b.id);
    expect((await service.aplicar(igreja, usuario, pessoa, { ...dados, ordem_dia: null })).id).toBe(a.id);
    expect(await p.eventos_membresia.count({ where: { pessoa_id: pessoa } })).toBe(2);
    expect(await service.listar(igreja, usuario, pessoa)).toHaveLength(1);
    await expect(service.aplicar(igreja, usuario, pessoa, { ...dados, evidencia: 'Outra' })).rejects.toThrow();
  });
  it('bloqueia alteração do evento usado em conferência eleitoral mesmo com o mesmo rol', async () => {
    const politica = await p.politica_eleicao_oficial.create({ data: { igreja_id: igreja, versao: randomUUID(), fonte: 'Livro', autoridade: 'Conselho', idade_minima: 18, aniversario_bissexto: 'DIA_28_FEVEREIRO', vigente_desde: new Date('2020-01-01'), criado_por_id: usuario } });
    const conferencia = await p.conferencia_eleicao_oficial.create({ data: { igreja_id: igreja, pessoa_id: pessoa, politica_id: politica.id, data_eleicao: new Date('2024-07-01'), data_recepcao: new Date('2020-01-01'), evidencia_recepcao: 'Livro', capacidade_confirmada: true, evidencia_capacidade: 'Livro', resultado: {}, criado_por_id: usuario } });
    try {
      const candidata = { ...proposta, data_evento: '2024-06-01' };
      const previa = await service.previa(igreja, usuario, pessoa, candidata);
      expect(previa.conferencia_alterada).toBe(true);
      expect(previa.bloqueada).toBe(true);
      expect(previa.conferencias[0]).toMatchObject({ rol_antes: 'COMUNGANTES', rol_depois: 'COMUNGANTES' });
      await expect(service.aplicar(igreja, usuario, pessoa, { ...candidata, hash_previa: previa.hash, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true })).rejects.toThrow('revisão');
      const revisao = new RevisaoEleitoralService(p, new CorrecaoMembresiaService(p), new CorrecaoConteudoService(p), new OrdenacaoMembresiaService(p), service);
      const decisao = await revisao.registrar(igreja, usuario, pessoa, { operacao: 'INSERCAO', proposta: candidata, hash_previa: previa.hash, autoridade: 'Concílio', evidencia: 'Ata', justificativa: 'Autorizada', idempotencia: randomUUID(), ciente: true });
      await service.aplicar(igreja, usuario, pessoa, { ...candidata, hash_previa: previa.hash, decisao_id: decisao.id, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true });
      expect(await p.revisao_eleitoral_item.count({ where: { decisao_id: decisao.id, conferencia_id: conferencia.id } })).toBe(1);

    } finally {
      await p.revisao_eleitoral_item.deleteMany({ where: { decisao: { pessoa_id: pessoa } } });
      await p.decisao_revisao_eleitoral.deleteMany({ where: { pessoa_id: pessoa } });
      await p.conferencia_eleicao_oficial.delete({ where: { id: conferencia.id } });
      await p.politica_eleicao_oficial.delete({ where: { id: politica.id } });
    }
  });

  it('serializa conferência eleitoral com alteração de membresia e lê o estado confirmado', async () => {
    const politica = await p.politica_eleicao_oficial.create({ data: { igreja_id: igreja, versao: randomUUID(), fonte: 'Livro', autoridade: 'Conselho', idade_minima: 18, aniversario_bissexto: 'DIA_28_FEVEREIRO', vigente_desde: new Date('2020-01-01'), criado_por_id: usuario } });
    let liberar!: () => void, bloqueado!: () => void, concluiu = false;
    const espera = new Promise<void>(resolve => { liberar = resolve; });
    const pronto = new Promise<void>(resolve => { bloqueado = resolve; });
    const alteracao = p.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${pessoa} AND igreja_id = ${igreja} FOR UPDATE`;
      await tx.eventos_membresia.update({ where: { id: posterior }, data: { rol: 'COMUNGANTES' } });
      bloqueado(); await espera;
    });
    await pronto;
    const consulta = new ConferenciaEleicaoService(p).registrar(igreja, usuario, { pessoa_id: pessoa, politica_id: politica.id, data_eleicao: '2025-06-01', data_recepcao: '2020-01-01', evidencia_recepcao: 'Livro', capacidade_confirmada: true, evidencia_capacidade: 'Livro' }).then(r => { concluiu = true; return r; });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(concluiu).toBe(false);
    } finally { liberar(); }
    await alteracao;
    const conferencia = await consulta;
    expect(conferencia.resultado).toMatchObject({ rol: 'COMUNGANTES', evento_membresia_id: posterior });
    await p.conferencia_eleicao_oficial.delete({ where: { id: conferencia.id } });
    await p.politica_eleicao_oficial.delete({ where: { id: politica.id } });
  });

  it('inclui em data existente apenas com sequência completa e posição livre', async () => {
    const mesmaData = { ...proposta, data_evento: '2025-01-01', ordem_dia: 1 };
    await expect(service.previa(igreja, usuario, pessoa, mesmaData)).rejects.toThrow('ordem');
    const ordem = new OrdenacaoMembresiaService(p);
    await ordem.ordenarUnico(igreja, usuario, posterior, { ordem: 2, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true });
    await expect(service.previa(igreja, usuario, pessoa, { ...mesmaData, ordem_dia: null })).rejects.toThrow('ordem');
    await expect(service.previa(igreja, usuario, pessoa, { ...mesmaData, ordem_dia: 2 })).rejects.toThrow('distintas');
    await expect(service.previa(igreja, usuario, pessoa, { ...mesmaData, ordem_dia: 3 })).rejects.toThrow('inclusão comum');
    const previa = await service.previa(igreja, usuario, pessoa, mesmaData);
    expect(previa.bloqueada).toBe(false);
    const dados = { ...mesmaData, hash_previa: previa.hash, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true as const };
    const registrado = await service.aplicar(igreja, usuario, pessoa, dados);
    expect((await service.aplicar(igreja, usuario, pessoa, dados)).id).toBe(registrado.id);
    await expect(service.aplicar(igreja, usuario, pessoa, { ...dados, ordem_dia: undefined })).rejects.toThrow('Chave');
    const eventos = await p.eventos_membresia.findMany({ where: { pessoa_id: pessoa } });
    expect(eventos.find(e => e.id === registrado.evento_id)?.ordem_dia).toBe(1);
    const vigente = eventoVigente(eventos, new Date('2025-01-01'));
    expect(vigente.situacao === 'DEFINIDO' && vigente.evento.id).toBe(posterior);
  });

  it('bloqueia inclusão que tornaria incoerente o rol de origem de ato posterior no mesmo dia', async () => {
    const pessoa2 = randomUUID();
    const regra = await p.regras_relacao_enum.findUniqueOrThrow({ where: { modulo_nome: { modulo: 'membresia', nome: 'Rols de Admissão' } } });
    const existe = await p.relacao_enum_valores.findFirst({ where: { regra_id: regra.id, valor_classificador: 'ADMISSAO', valor_classificado: 'NAO_COMUNGANTES' } });
    const extra = existe ?? await p.relacao_enum_valores.create({ data: { regra_id: regra.id, valor_classificador: 'ADMISSAO', valor_classificado: 'NAO_COMUNGANTES' } });
    await p.pessoas.create({ data: { id: pessoa2, igreja_id: igreja, nome_completo: 'Outra pessoa sintética', data_nascimento: new Date('1990-01-01'), sexo: 'MASCULINO' } });
    try {
      await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa2, tipo_evento: 'ADMISSAO', rol: 'COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2024-01-01') } });
      await p.eventos_membresia.create({ data: { igreja_id: igreja, pessoa_id: pessoa2, tipo_evento: 'MUDANCA_DE_ROL', rol_origem: 'COMUNGANTES', rol: 'NAO_COMUNGANTES', motivacao_evento: 'PROFISSAO_DE_FE', data_evento: new Date('2025-01-01'), ordem_dia: 3 } });
      const nova = { ...proposta, data_evento: '2025-01-01', ordem_dia: 2, rol: 'NAO_COMUNGANTES' as const };
      const previa = await service.previa(igreja, usuario, pessoa2, nova);
      expect(previa.origem_seguinte_invalida).toBe(true);
      expect(previa.bloqueada).toBe(true);
      await expect(service.aplicar(igreja, usuario, pessoa2, { ...nova, hash_previa: previa.hash, justificativa: 'Livro', autoridade: 'Conselho', evidencia: 'Livro', idempotencia: randomUUID(), ciente: true })).rejects.toThrow('revisão');
    } finally {
      await p.logs_atividades.deleteMany({ where: { registro_id: pessoa2 } });
      await p.eventos_membresia.deleteMany({ where: { pessoa_id: pessoa2 } });
      await p.pessoas.deleteMany({ where: { id: pessoa2 } });
      if (!existe) await p.relacao_enum_valores.delete({ where: { id: extra.id } });
    }
  });

});

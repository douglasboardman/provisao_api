import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { IgrejaService } from '../src/igreja/igreja.service';
import { UnidadesService } from '../src/orgaos/unidades.service';
import { StorageService } from '../src/storage/storage.service';
import { SecretariaBaseService } from '../src/secretaria/secretaria-base.service';
import { AtuacaoModeloService } from '../src/secretaria/atuacao-modelo.service';

const integration = process.env.E00_INTEGRATION === '1' ? describe : describe.skip;

integration('Instalação da estrutura institucional', () => {
  const db = new PrismaService();
  const igrejas = new IgrejaService(db, {} as StorageService);
  const unidades = new UnidadesService(db);
  const secretaria = new SecretariaBaseService(db, {} as AtuacaoModeloService);
  const hoje = new Date().toISOString().slice(0, 10);
  const instalar = (id: string) => db.$executeRaw`SELECT instalar_estrutura_institucional(${id})`;
  const ler = (igreja_id: string) => db.orgao_interno.findMany({
    where: { igreja_id }, orderBy: { id: 'asc' },
    include: { contexto_secretaria: true, versoes_institucionais: true, cargos: { orderBy: { codigo: 'asc' } } },
  });
  const criarIgreja = () => igrejas.create({ nome: 'Igreja de ensaio', congregacao: false });
  const criarLegada = () => db.igreja.create({ data: { nome: 'Cadastro anterior' } });

  async function operador(igreja_id: string, perfil: 'COMUM' | 'ADMINISTRADOR') {
    const email = randomUUID() + '@example.invalid';
    const pessoa = await db.pessoas.create({ data: {
      igreja_id, nome_completo: 'Pessoa de ensaio', sexo: 'FEMININO', data_nascimento: new Date('1990-01-01'),
    } });
    return db.usuarios.create({ data: {
      igreja_id, pessoa_id: pessoa.id, ativo: true, nome_usuario: email,
      email_login: email, senha_hash: 'inutilizavel', perfil,
    } });
  }

  beforeAll(() => {
    if (process.env.DATABASE_URL !== 'postgresql://provisao_test:provisao_test@127.0.0.1:55439/provisao_test?schema=public')
      throw new Error('Exige banco descartável E00.');
  });
  afterAll(() => db.$disconnect());

  it('cria oito identidades, contextos e configurações na criação da igreja, sem atribuir autoridade', async () => {
    const { id: igreja_id } = await criarIgreja();
    const orgaos = await ler(igreja_id);
    expect(orgaos.filter(o => o.ativo).map(o => o.tipo_padrao).sort()).toEqual(['ASSEMBLEIA_GERAL', 'CONSELHO', 'JUNTA']);
    expect(orgaos.filter(o => !o.ativo).map(o => o.tipo_padrao).sort()).toEqual(['SAF', 'UCP', 'UMP', 'UPA', 'UPH']);
    for (const o of orgaos) {
      expect(o).toMatchObject({ origem: 'CATALOGO', data_criacao: null, criador_id: null, instituidor_id: null,
        categoria: o.ativo ? 'ORGAO_OFICIAL' : 'SOCIEDADE' });
      expect(o.contexto_secretaria).toMatchObject({ igreja_id, orgao_id: o.id, tipo: o.tipo === 'ASSEMBLEIA_GERAL' ? 'ASSEMBLEIA_GERAL' : 'ORGAO' });
      expect(o.versoes_institucionais).toHaveLength(1);
      expect(o.versoes_institucionais[0]).toMatchObject({ numero: 1, fim: null, igreja_id, fonte: expect.any(String),
        configuracao: { cargos: o.cargos.map(c => expect.objectContaining({ id: c.id, codigo: c.codigo })) } });
    }
    const assembleia = orgaos.find(o => o.tipo === 'ASSEMBLEIA_GERAL')!;
    expect(assembleia.versoes_institucionais[0].configuracao).toMatchObject({ funcoes_reuniao: ['PRESIDENTE_MESA', 'SECRETARIO_MESA'] });
    expect(await Promise.all([db.usuarios.count({ where: { igreja_id } }), db.ato_orgao.count({ where: { igreja_id } }),
      db.ocupacao_cargo.count({ where: { igreja_id } }), db.competencia_secretaria.count({ where: { igreja_id } })])).toEqual([0, 0, 0, 0]);
    await instalar(igreja_id);
    expect(await ler(igreja_id)).toEqual(orgaos);
  });

  it('complementa em concorrência conservando órgão, primeiro secretário local e contexto da Assembleia', async () => {
    const { id: igreja_id } = await criarLegada();
    const admin = await operador(igreja_id, 'ADMINISTRADOR');
    const conselho = await db.orgao_interno.create({ data: { igreja_id, tipo: 'CONSELHO', constituicao: 'OFICIAL',
      data_criacao: new Date('1980-01-01'), nome: 'Conselho local', finalidade: 'Conselho', criador_id: admin.id } });
    const cargo = await db.cargo_orgao.create({ data: { igreja_id, orgao_id: conselho.id, nome: 'Secretaria local', codigo: 'PRIMEIRO_SECRETARIO' } });
    const contexto = await db.contexto_secretaria.create({ data: { igreja_id, tipo: 'ASSEMBLEIA_GERAL', nome: 'Assembleia local', sigla: 'AL' } });
    await Promise.all([instalar(igreja_id), instalar(igreja_id)]);
    const orgaos = await ler(igreja_id);
    expect(orgaos).toHaveLength(8);
    const oficial = orgaos.find(o => o.id === conselho.id)!;
    expect(oficial).toMatchObject({ origem: 'CADASTRO', tipo_padrao: 'CONSELHO', criador_id: admin.id });
    expect(oficial.cargos.map(c => c.codigo)).toEqual(['PRIMEIRO_SECRETARIO', 'SEGUNDO_SECRETARIO', 'TESOUREIRO', 'VICE_PRESIDENTE']);
    expect(oficial.cargos[0]).toEqual(cargo);
    expect(orgaos.find(o => o.tipo === 'ASSEMBLEIA_GERAL')!.contexto_secretaria).toEqual(contexto);
    await instalar(igreja_id);
    expect(await ler(igreja_id)).toEqual(orgaos);
  });

  it('desfaz o lote ao falhar na última sociedade e permite nova tentativa completa', async () => {
    const { id: igreja_id } = await criarLegada();
    await expect(db.$transaction(async tx => {
      // A restrição de ensaio é revertida com o próprio lote.
      await tx.$executeRaw`ALTER TABLE orgao_interno ADD CONSTRAINT falhar_ao_instalar_uph CHECK (tipo_padrao <> 'UPH') NOT VALID`;
      await tx.$executeRaw`SELECT instalar_estrutura_institucional(${igreja_id})`;
    })).rejects.toThrow(/falhar_ao_instalar_uph/);
    expect(await ler(igreja_id)).toEqual([]);
    expect(await db.contexto_secretaria.count({ where: { igreja_id } })).toBe(0);
    await instalar(igreja_id);
    expect(await ler(igreja_id)).toHaveLength(8);
  });

  it('impede vigências sobrepostas e preserva a versão local após nova instalação', async () => {
    const { id: igreja_id } = await criarIgreja();
    const conselho = (await ler(igreja_id)).find(o => o.tipo_padrao === 'CONSELHO')!;
    const primeira = conselho.versoes_institucionais[0];
    const inicio = new Date(primeira.inicio.getTime() + 86400000);
    const proxima = { igreja_id, orgao_id: conselho.id, inicio, numero: 2, fonte: 'Regimento local de ensaio',
      configuracao: { cargo_prazo_sugerido_meses: 24 } };
    await expect(db.versao_orgao.create({ data: proxima })).rejects.toThrow(/exclusion constraint/);
    await db.$transaction([
      db.versao_orgao.update({ where: { id: primeira.id }, data: { fim: inicio } }),
      db.versao_orgao.create({ data: proxima }),
    ]);
    await instalar(igreja_id);
    const versoes = await db.versao_orgao.findMany({ where: { orgao_id: conselho.id }, orderBy: { numero: 'asc' } });
    expect(versoes).toHaveLength(2);
    expect(versoes[0]).toMatchObject({ ...primeira, fim: inicio });
    expect(versoes[1]).toMatchObject(proxima);
  });

  it('mantém órgãos históricos ambíguos individualizados para reconciliação', async () => {
    const { id: igreja_id } = await criarLegada();
    const admin = await operador(igreja_id, 'ADMINISTRADOR');
    for (const nome of ['Junta anterior', 'Outra Junta']) {
      await db.orgao_interno.create({ data: { igreja_id, tipo: 'JUNTA', constituicao: 'OFICIAL', nome, finalidade: 'Junta',
        data_criacao: new Date('1990-01-01'), ativo: false, criador_id: admin.id } });
    }
    await instalar(igreja_id);
    const juntas = (await ler(igreja_id)).filter(o => o.tipo === 'JUNTA');
    expect(juntas).toHaveLength(2);
    for (const o of juntas) {
      expect(o).toMatchObject({ ativo: false, tipo_padrao: null, origem: 'CADASTRO' });
      expect(o.contexto_secretaria?.orgao_id).toBe(o.id);
    }
  });

  it('cria o contexto e a versão do ministério junto com o ato e conserva ambos na repetição', async () => {
    const { id: igreja_id } = await criarIgreja();
    const gestor = await operador(igreja_id, 'COMUM'), admin = await operador(igreja_id, 'ADMINISTRADOR');
    await unidades.registrarCompetencia(igreja_id, admin.id, { usuario_id: gestor.id, inicio: '2020-01-01',
      autoridade: 'Conselho', evidencia: 'Registro de ensaio', idempotencia: randomUUID() });
    const dados = { nome: 'Ministério local', sigla: 'ML', finalidade: 'Participação local', constituicao: 'DESIGNACAO' as const,
      data_criacao: hoje, evidencia: 'Ato de instituição', idempotencia: randomUUID() };
    const orgao = await unidades.criar(igreja_id, gestor.id, dados);
    expect(await unidades.criar(igreja_id, gestor.id, dados)).toEqual(orgao);
    const registros = await ler(igreja_id);
    expect(registros).toHaveLength(9);
    expect(registros.find(o => o.id === orgao.id)).toMatchObject({
      categoria: 'MINISTERIO', origem: 'CADASTRO', tipo_padrao: null, criador_id: gestor.id,
      contexto_secretaria: { igreja_id, nome: dados.nome, sigla: dados.sigla },
      versoes_institucionais: [{ numero: 1, configuracao: { composicao: 'DESIGNACAO', cargos: [
        expect.objectContaining({ codigo: 'LIDER' }), expect.objectContaining({ codigo: 'VICE_LIDER' }),
      ] } }],
    });
    const inativo = registros.find(o => o.tipo_padrao === 'UMP')!.contexto_secretaria!;
    const juvenil = registros.find(o => o.tipo_padrao === 'UPA')!.contexto_secretaria!;
    const ator = { sub: gestor.id, igreja_id, perfil: gestor.perfil };
    await expect(secretaria.contexto(db, ator, juvenil.id)).rejects.toThrow('Contexto indisponível');
    await expect(secretaria.contexto(db, ator, inativo.id)).resolves.toMatchObject({ id: inativo.id });
    await expect(secretaria.preparar(db, ator, inativo.id)).rejects.toThrow('inativo');
    const outra = await criarLegada();
    await expect(db.contexto_secretaria.update({ where: { id: inativo.id }, data: { igreja_id: outra.id } })).rejects.toThrow();
  });
});

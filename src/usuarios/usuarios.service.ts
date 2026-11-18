import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';
import * as bcrypt from 'bcrypt';
import { Prisma, logs_atividades_acao } from '@prisma/client';
import { randomBytes } from 'crypto';

/** Número de rounds do bcrypt para hash de senhas. */
const BCRYPT_SALT_ROUNDS = 10;

/**
 * Serviço responsável pela lógica de negócio relacionada a Usuários.
 * Todas as operações são isoladas por `igreja_id` para garantir a separação
 * de dados entre tenants (igrejas).
 */
@Injectable()
export class UsuariosService {
  constructor(
    private prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  /**
   * Cria um novo usuário vinculado à igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param createUsuarioDto Dados para criação do usuário.
   * @returns O usuário criado, sem o hash da senha.
   */
  async create(igreja_id: string, createUsuarioDto: CreateUsuarioDto, actorId: string) {
    const hashedPassword = await bcrypt.hash(randomBytes(32).toString('hex'), BCRYPT_SALT_ROUNDS);
    try {
      return await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${actorId} AND igreja_id = ${igreja_id} FOR UPDATE`;
      const actor = await tx.usuarios.findFirst({ where: { id: actorId, igreja_id, ativo: true, perfil: 'ADMINISTRADOR' }, select: { id: true } });
      if (!actor) throw new ForbiddenException('Ação não autorizada.');
      const usuario = await tx.usuarios.create({ data: {
        nome_usuario: createUsuarioDto.nome_usuario, email_login: createUsuarioDto.email_login,
        url_imagem_perfil: createUsuarioDto.url_imagem_perfil, perfil: createUsuarioDto.perfil,
        ativo: false, senha_hash: hashedPassword, igreja_id,
      } });
      const { senha_hash, auth_version, ...result } = usuario;
      return result;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Já existe uma conta com este e-mail na igreja.');
      throw error;
    }
  }

  /**
   * Retorna todos os usuários da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @returns Lista de usuários sem o hash da senha.
   */
  async findAll(igreja_id: string) {
    return this.prisma.usuarios.findMany({
      where: { igreja_id },
      select: {
        id: true,
        nome_usuario: true,
        url_imagem_perfil: true,
        email_login: true,
        perfil: true,
        ativo: true,
        pessoa_id: true,
        created_at: true,
        updated_at: true,
      },
    });
  }

  /**
   * Encontra um usuário pelo ID, garantindo que pertence à mesma igreja.
   * @param id UUID do usuário.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se o usuário não existir nesta igreja.
   */
  async findOne(id: string, igreja_id: string) {
    const usuario = await this.prisma.usuarios.findFirst({
      where: { id, igreja_id },
      select: {
        id: true,
        nome_usuario: true,
        email_login: true,
        url_imagem_perfil: true,
        perfil: true,
        ativo: true,
        pessoa_id: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!usuario) {
      throw new NotFoundException(`Usuário com ID ${id} não encontrado.`);
    }
    return usuario;
  }

  /**
   * Atualiza um usuário, verificando que pertence à mesma igreja.
   * @param id UUID do usuário.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updateUsuarioDto Dados para atualização.
   * @returns O usuário atualizado, sem o hash da senha.
   */
  private async revokeAccessCompetence(tx: Prisma.TransactionClient, churchId: string, userId: string, actorId: string, reason: string) {
    const current = await tx.competencia_acesso.findMany({ where: { igreja_id: churchId, usuario_id: userId, revogado_em: null }, select: { id: true } });
    if (!current.length) return;
    await tx.competencia_acesso.updateMany({ where: { igreja_id: churchId, usuario_id: userId, revogado_em: null }, data: { revogado_por: actorId, revogado_em: new Date() } });
    for (const authority of current) await tx.logs_atividades.create({ data: { igreja_id: churchId, usuario_id: actorId, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'competencia_acesso', registro_id: authority.id, dados_novos: { revogada: true, motivo: reason } } });
  }

  async update(id: string, igreja_id: string, updateUsuarioDto: UpdateUsuarioDto, actorId: string) {
    try {
      return await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${actorId} AND igreja_id = ${igreja_id} FOR UPDATE`;
      const actor = await tx.usuarios.findFirst({ where: { id: actorId, igreja_id, ativo: true }, select: { id: true, perfil: true } });
      if (!actor) throw new ForbiddenException('Ação não autorizada.');
      const isImageOnly = Object.keys(updateUsuarioDto).every(key => key === 'url_imagem_perfil');
      if (actor.perfil !== 'ADMINISTRADOR' && !(actor.id === id && isImageOnly)) throw new ForbiddenException('Ação não autorizada.');
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${id} AND igreja_id = ${igreja_id} FOR UPDATE`;
      const atual = await tx.usuarios.findFirst({ where: { id, igreja_id } });
      if (!atual) throw new NotFoundException(`Usuário com ID ${id} não encontrado.`);
      if (updateUsuarioDto.ativo === true && !atual.ativo) throw new BadRequestException('Use o fluxo de ativação para enviar o convite.');
      if (actor.id === id && ((updateUsuarioDto.perfil !== undefined && updateUsuarioDto.perfil !== atual.perfil) || updateUsuarioDto.ativo === false)) throw new ForbiddenException('Não é permitido alterar o próprio perfil ou desativar a própria conta.');
      const dataToUpdate: Record<string, unknown> = { ...updateUsuarioDto };
      if ((updateUsuarioDto.email_login !== undefined && updateUsuarioDto.email_login !== atual.email_login) || (updateUsuarioDto.ativo !== undefined && updateUsuarioDto.ativo !== atual.ativo)) dataToUpdate.auth_version = { increment: 1 };
      if ((updateUsuarioDto.perfil !== undefined && updateUsuarioDto.perfil !== atual.perfil) || (updateUsuarioDto.ativo === false && atual.ativo)) {
        await this.revokeAccessCompetence(tx, igreja_id, id, actorId, 'perfil_ou_atividade_alterado');
      }
      const usuario = await tx.usuarios.update({ where: { id }, data: dataToUpdate });
      const { senha_hash, auth_version, ...result } = usuario;
      return result;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Já existe uma conta com este e-mail na igreja.');
      throw error;
    }
  }

  /** Vínculo conferido, com auditoria na mesma transação da alteração. */
  async vincularPessoa(id: string, igrejaId: string, pessoaId: string | null, actorId: string) {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${actorId} AND igreja_id = ${igrejaId} FOR UPDATE`;
        const actor = await tx.usuarios.findFirst({ where: { id: actorId, igreja_id: igrejaId, ativo: true, perfil: 'ADMINISTRADOR' }, select: { id: true } });
        if (!actor) throw new ForbiddenException('Ação não autorizada.');
        await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${id} AND igreja_id = ${igrejaId} FOR UPDATE`;
        const user = await tx.usuarios.findFirst({ where: { id, igreja_id: igrejaId }, select: { id: true, pessoa_id: true } });
        if (!user) throw new NotFoundException('Usuário não encontrado.');
        if (pessoaId && !await tx.pessoas.findFirst({ where: { id: pessoaId, igreja_id: igrejaId }, select: { id: true } })) {
          throw new NotFoundException('Pessoa não encontrada.');
        }
        if (user.pessoa_id === pessoaId) return { pessoa_id: pessoaId };
        await this.revokeAccessCompetence(tx, igrejaId, id, actorId, 'vinculo_pessoa_alterado');
        await tx.usuarios.update({ where: { id }, data: { pessoa_id: pessoaId } });
        await tx.logs_atividades.create({ data: {
          igreja_id: igrejaId, usuario_id: actorId, acao: logs_atividades_acao.ATUALIZACAO,
          tabela_afetada: 'usuarios', registro_id: id,
          dados_antigos: { pessoa_id: user.pessoa_id }, dados_novos: { pessoa_id: pessoaId },
        } });
        return { pessoa_id: pessoaId };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Pessoa já vinculada a outro usuário.');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new ConflictException('A pessoa selecionada não está disponível para vínculo.');
      }
      throw error;
    }
  }

  /**
   * Remove um usuário, verificando que pertence à mesma igreja.
   * @param id UUID do usuário.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @returns Mensagem de confirmação.
   */
  async remove(id: string, igreja_id: string, actorId: string): Promise<{ message: string }> {
    if (id === actorId) throw new ForbiddenException('Não é permitido excluir a própria conta.');
    try {
      return await this.prisma.$transaction(async tx => {
      // A trava da igreja serializa operações concorrentes sobre o último administrador.
      await tx.$queryRaw`SELECT id FROM igreja WHERE id = ${igreja_id} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${actorId} AND igreja_id = ${igreja_id} FOR UPDATE`;
      const actor = await tx.usuarios.findFirst({ where: { id: actorId, igreja_id, ativo: true, perfil: 'ADMINISTRADOR' }, select: { id: true } });
      if (!actor) throw new ForbiddenException('Ação não autorizada.');
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${id} AND igreja_id = ${igreja_id} FOR UPDATE`;
      const target = await tx.usuarios.findFirst({ where: { id, igreja_id }, select: { id: true, perfil: true, ativo: true } });
      if (!target) throw new NotFoundException('Usuário não encontrado.');
      if (target.ativo && target.perfil === 'ADMINISTRADOR' && await tx.usuarios.count({ where: { igreja_id, ativo: true, perfil: 'ADMINISTRADOR' } }) <= 1) throw new ConflictException('A igreja precisa manter um administrador ativo.');
      await tx.usuarios.delete({ where: { id } });
      return { message: 'Usuário removido com sucesso.' };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') throw new ConflictException('A conta possui registros que precisam ser preservados; desative-a em vez de excluí-la.');
      throw error;
    }
  }

  async reissueInvite(id: string, igrejaId: string, actorId: string): Promise<void> {
    await this.authService.reissueSetup(id, igrejaId, actorId);
  }

  /**
   * Ativa a conta de um usuário pendente e aciona o envio do e-mail de boas-vindas
   * com o link para definição de senha. Restrito ao ADMINISTRADOR da mesma igreja.
   * @param id UUID do usuário a ser ativado.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @returns Mensagem de confirmação.
   */
  async activate(id: string, igreja_id: string, actorId: string): Promise<{ message: string }> {
    await this.authService.activateAndQueue(id, igreja_id, actorId);
    return { message: 'Aprovação registrada. O convite será enviado pela fila de e-mail.' };
  }
}

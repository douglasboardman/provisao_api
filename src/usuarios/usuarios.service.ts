import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';
import * as bcrypt from 'bcrypt';

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
  async create(igreja_id: string, createUsuarioDto: CreateUsuarioDto) {
    const saltRounds = BCRYPT_SALT_ROUNDS;
    const hashedPassword = await bcrypt.hash(createUsuarioDto.senha, saltRounds);

    const usuario = await this.prisma.usuarios.create({
      data: {
        nome_usuario: createUsuarioDto.nome_usuario,
        email_login: createUsuarioDto.email_login,
        url_imagem_perfil: createUsuarioDto.url_imagem_perfil,
        perfil: createUsuarioDto.perfil,
        ativo: createUsuarioDto.ativo,
        senha_hash: hashedPassword,
        igreja_id,
      },
    });

    const { senha_hash, ...result } = usuario;
    return result;
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
  async update(id: string, igreja_id: string, updateUsuarioDto: UpdateUsuarioDto) {
    await this.findOne(id, igreja_id);

    const dataToUpdate: Record<string, unknown> = { ...updateUsuarioDto };

    if (updateUsuarioDto.senha) {
      const saltRounds = BCRYPT_SALT_ROUNDS;
      dataToUpdate.senha_hash = await bcrypt.hash(updateUsuarioDto.senha, saltRounds);
      delete dataToUpdate.senha;
    }

    const usuario = await this.prisma.usuarios.update({
      where: { id },
      data: dataToUpdate,
    });

    const { senha_hash, ...result } = usuario;
    return result;
  }

  /**
   * Remove um usuário, verificando que pertence à mesma igreja.
   * @param id UUID do usuário.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @returns Mensagem de confirmação.
   */
  async remove(id: string, igreja_id: string): Promise<{ message: string }> {
    await this.findOne(id, igreja_id);
    await this.prisma.usuarios.delete({ where: { id } });
    return { message: `Usuário com ID ${id} removido com sucesso.` };
  }

  /**
   * Ativa a conta de um usuário pendente e aciona o envio do e-mail de boas-vindas
   * com o link para definição de senha. Restrito ao ADMINISTRADOR da mesma igreja.
   * @param id UUID do usuário a ser ativado.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @returns Mensagem de confirmação.
   */
  async activate(id: string, igreja_id: string): Promise<{ message: string }> {
    const usuario = await this.findOne(id, igreja_id);

    await this.prisma.usuarios.update({ where: { id: usuario.id }, data: { ativo: true } });

    try {
      await this.authService.sendPasswordSetupEmail(id, igreja_id);
    } catch (error) {
      // Reverte a ativação se o envio de e-mail falhar para manter consistência de estado
      await this.prisma.usuarios.update({ where: { id: usuario.id }, data: { ativo: false } });
      throw error;
    }

    return {
      message: `Usuário ativado com sucesso. E-mail de boas-vindas enviado para ${usuario.email_login}.`,
    };
  }
}

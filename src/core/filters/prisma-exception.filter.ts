import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

/**
 * Filtro global que intercepta erros conhecidos do cliente Prisma e os converte
 * em respostas HTTP semânticas, evitando que erros de banco "vazem" como 500.
 *
 * Códigos Prisma tratados:
 *  P2002 — Violação de constraint UNIQUE  → 409 Conflict
 *  P2003 — Violação de FK (record nulo)   → 422 Unprocessable Entity
 *  P2025 — Record não encontrado          → 404 Not Found
 *  P2014 — Violação de relação            → 422 Unprocessable Entity
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    this.logger.warn(
      `Prisma error ${exception.code} — ${exception.message}`,
    );

    switch (exception.code) {
      case 'P2002': {
        // Unique constraint violation
        const fields = (exception.meta?.target as string[]) ?? [];
        const fieldNames = fields.join(', ');
        const fieldLabel = this.translateFields(fieldNames);

        return response.status(HttpStatus.CONFLICT).json({
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          message: `Já existe um registro com o mesmo valor para: ${fieldLabel}. Verifique os dados e tente novamente.`,
          fields,
        });
      }

      case 'P2025': {
        // Record not found (e.g. update/delete on non-existent record)
        const cause = (exception.meta?.cause as string) ?? 'Registro não encontrado.';
        return response.status(HttpStatus.NOT_FOUND).json({
          statusCode: HttpStatus.NOT_FOUND,
          error: 'Not Found',
          message: cause,
        });
      }

      case 'P2003': {
        // Foreign key constraint failed
        const field = (exception.meta?.field_name as string) ?? 'referência';
        return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          error: 'Unprocessable Entity',
          message: `O campo "${field}" referencia um registro que não existe. Verifique os dados relacionados.`,
        });
      }

      case 'P2014': {
        // Relation violation
        return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          error: 'Unprocessable Entity',
          message: 'Operação inválida: viola uma relação obrigatória entre registros.',
        });
      }

      default: {
        // Demais erros Prisma não mapeados — log detalhado, resposta genérica segura
        this.logger.error(`Unhandled Prisma error: ${exception.code}`, exception.stack);
        return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Internal Server Error',
          message: 'Erro interno ao processar a operação no banco de dados.',
        });
      }
    }
  }

  /** Traduz nomes técnicos de campo para labels legíveis */
  private translateFields(fields: string): string {
    const map: Record<string, string> = {
      cpf: 'CPF',
      email: 'E-mail',
      email_login: 'E-mail de login',
      cnpj: 'CNPJ',
      nome: 'Nome',
      nome_familia: 'Nome da família',
      num_conta: 'Número de conta',
    };
    return fields
      .split(', ')
      .map((f) => map[f.trim()] ?? f.trim())
      .join(', ');
  }
}

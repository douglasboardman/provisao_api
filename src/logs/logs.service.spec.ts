import { Test } from '@nestjs/testing';
import { LogsService } from './logs.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { logs_atividades_acao } from '@prisma/client';

describe('LogsService.registrar', () => {
  let service: LogsService;
  let prisma: { logs_atividades: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      logs_atividades: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        LogsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(LogsService);
  });

  it('chama prisma.create com os dados corretos', async () => {
    await service.registrar({
      igreja_id: 'church-1',
      usuario_id: 'user-1',
      acao: logs_atividades_acao.CRIACAO,
      tabela_afetada: 'acoes',
      registro_id: 'entity-1',
      ip_address: '127.0.0.1',
      dados_novos: { endpoint: '/acoes' },
    });

    expect(prisma.logs_atividades.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        igreja_id: 'church-1',
        usuario_id: 'user-1',
        acao: logs_atividades_acao.CRIACAO,
        tabela_afetada: 'acoes',
        registro_id: 'entity-1',
      }),
    });
  });

  it('não lança exceção quando Prisma falha', async () => {
    prisma.logs_atividades.create.mockRejectedValue(new Error('DB offline'));

    await expect(
      service.registrar({
        igreja_id: 'church-1',
        usuario_id: 'user-1',
        acao: logs_atividades_acao.CRIACAO,
        tabela_afetada: 'acoes',
        registro_id: null,
      }),
    ).resolves.toBeUndefined();
  });
});

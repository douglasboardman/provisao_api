import { Injectable } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { usuarios_perfil } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import type { Servico } from './catalogo-servicos';

@Injectable()
export class RotasServicosService {
  constructor(private readonly discovery: DiscoveryService, private readonly scanner: MetadataScanner) {}

  listar() {
    return this.catalogo().flatMap(r => r.acao ? [{ ...r, acao: r.acao }] : []);
  }

  retiradas(acao: Servico) {
    return this.catalogo().filter(r => r.retirada === acao);
  }

  legado(perfil: usuarios_perfil) {
    return this.catalogo().filter(r => !r.acao && r.perfis.includes(perfil))
      .map(r => r.rota);
  }

  private catalogo() {
    return this.discovery.getControllers().flatMap(({ instance }) => {
      if (!instance) return [];
      const classe = instance.constructor;
      const base = Reflect.getMetadata(PATH_METADATA, classe) as string;
      return this.scanner.getAllMethodNames(Object.getPrototypeOf(instance)).flatMap(nome => {
        const metodo = instance[nome];
        const metodoHttp = Reflect.getMetadata(METHOD_METADATA, metodo) as RequestMethod | undefined;
        if (metodoHttp === undefined) return [];
        const acao = (Reflect.getMetadata('servico_da_rota', metodo) ?? Reflect.getMetadata('servico_em_contexto', metodo)) as Servico | undefined;
        const perfis = (Reflect.getMetadata(ROLES_KEY, metodo) ?? Reflect.getMetadata(ROLES_KEY, classe) ?? []) as usuarios_perfil[];
        const verbo = RequestMethod[metodoHttp];
        const caminho = [base, Reflect.getMetadata(PATH_METADATA, metodo)].map(p => String(p ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
        return [{ acao, retirada: Reflect.getMetadata('rota_legada_de', metodo) as Servico | undefined, contextual: !!Reflect.getMetadata('servico_em_contexto', metodo), perfis, rota: verbo + ' /' + caminho }];
      });
    }).sort((a, b) => a.rota.localeCompare(b.rota));
  }
}

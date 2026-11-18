import { Module } from '@nestjs/common';
import { AccessRequestsController } from './access-requests.controller';
import { AccessAuthorityService } from './access-authority.service';
import { AccessRequestsService } from './access-requests.service';
@Module({ controllers: [AccessRequestsController], providers: [AccessRequestsService, AccessAuthorityService], exports: [AccessRequestsService] })
export class AccessRequestsModule {}

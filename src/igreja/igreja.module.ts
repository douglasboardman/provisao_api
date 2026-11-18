import { Module } from '@nestjs/common';
import { IgrejaService } from './igreja.service';
import { IgrejaController } from './igreja.controller';
import { AdminKeyGuard } from './guards/admin-key.guard';
import { StorageModule } from 'src/storage/storage.module';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [StorageModule, AuthModule],
  controllers: [IgrejaController],
  providers: [IgrejaService, AdminKeyGuard],
})
export class IgrejaModule {}

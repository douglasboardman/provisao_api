import { Module } from '@nestjs/common';
import { PrivateStorageService } from './private-storage.service';
import { PrivateStorageController } from './private-storage.controller';
@Module({ controllers: [PrivateStorageController], providers: [PrivateStorageService], exports: [PrivateStorageService] })
export class PrivateStorageModule {}

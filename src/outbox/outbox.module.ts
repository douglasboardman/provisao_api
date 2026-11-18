import { Global, Module } from '@nestjs/common';
import { EmailModule } from 'src/email/email.module';
import { OutboxService } from './outbox.service';
@Global()
@Module({ imports: [EmailModule], providers: [OutboxService], exports: [OutboxService] })
export class OutboxModule {}
